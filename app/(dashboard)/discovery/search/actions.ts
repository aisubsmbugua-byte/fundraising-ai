"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { anthropic, DRAFT_MODEL } from "@/lib/ai/anthropic";
import { buildProfileSummary, CHANNEL_DESCRIPTIONS } from "@/lib/channel-match";
import { screenProspect, type ScreeningRule } from "@/lib/screening";
import { channelLabel, type Channel } from "@/lib/prospects";
import { bestEffortLookup } from "@/lib/propublica";
import type { OrgProfile } from "@/lib/organization";

type FoundCandidate = {
  name: string;
  organization?: string;
  website?: string;
  contact_name?: string;
  contact_email?: string;
  location?: string;
  rationale: string;
};

async function cachedProPublicaLookup(supabase: ReturnType<typeof createClient>, name: string) {
  // Best-effort org-name match against our own cache first (instant,
  // free) before hitting ProPublica's API. Cache entries never
  // expire here -- financial data only updates annually anyway.
  const { data: cached } = await supabase
    .from("nonprofit_data_cache")
    .select("*")
    .ilike("name", name)
    .limit(1)
    .maybeSingle();
  if (cached) return cached;

  const detail = await bestEffortLookup(name);
  if (!detail) return null;

  const { data: saved } = await supabase
    .from("nonprofit_data_cache")
    .upsert(
      {
        ein: detail.ein,
        name: detail.name,
        city: detail.city,
        state: detail.state,
        ntee_code: detail.ntee_code,
        raw: detail,
      },
      { onConflict: "ein" }
    )
    .select("*")
    .single();

  return saved ?? null;
}

// Creates the run row and returns immediately -- the actual search is
// kicked off separately (see runDiscoverySearch) so the browser isn't
// stuck holding one request open for however long the AI call takes.
export async function startDiscoverySearch(channel: Channel): Promise<string> {
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) redirect("/login");

    const { data: profile } = await supabase.from("org_profile").select("*").limit(1).maybeSingle<OrgProfile>();
    if (!profile) throw new Error("Fill in the Organization Profile before running a discovery search.");

    const { data: run, error } = await supabase
      .from("discovery_search_runs")
      .insert({
        channel,
        status: "searching",
        status_message: `Searching the web for ${channelLabel(channel)} candidates...`,
        created_by: user.id,
      })
      .select("id")
      .single();
    if (error || !run) throw new Error(error?.message ?? "Failed to start discovery search");

    return run.id as string;
  } catch (err) {
    // Logged explicitly since an uncaught throw here previously
    // surfaced as an opaque full-page crash with no diagnosable
    // client-side detail -- channel=church reproduced this
    // consistently and this is the only path that could explain it.
    // redirect() throws internally too (digest starts with
    // NEXT_REDIRECT) -- that's expected control flow, not a bug.
    const digest = (err as { digest?: string })?.digest;
    if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT")) {
      console.error(`[discovery-search] startDiscoverySearch failed for channel=${channel}:`, err);
    }
    throw err;
  }
}

// The heavy-lifting call. Triggered by the search page itself (which
// stays mounted for the duration) via a fire-and-forget call, same
// pattern as runDeepDive -- the panel polls /api/discovery-search-runs
// for progress instead of awaiting this directly. started_at is a
// lock so a duplicate trigger (e.g. re-render) doesn't run it twice.
export async function runDiscoverySearch(runId: string, channel: Channel) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const { data: claimed } = await supabase
    .from("discovery_search_runs")
    .update({ started_at: new Date().toISOString() })
    .eq("id", runId)
    .is("started_at", null)
    .select("id")
    .maybeSingle();
  if (!claimed) return; // already started (or started elsewhere) -- don't run it twice

  try {
    const { data: profile } = await supabase.from("org_profile").select("*").limit(1).maybeSingle<OrgProfile>();

    const churchTactic =
      channel === "church"
        ? `\n\nThis nonprofit has existing notable funders (see profile below). If any of them are individual churches, check whether they belong to a broader denomination or network, and if so, actively look for sibling churches within that same network as strong candidates -- an existing supporting relationship is a warm signal for the rest of that network. Note: individual churches are generally exempt from IRS Form 990 filing, so they won't show up in tax-filing databases -- rely on web search, denominational directories, and network/association websites instead.`
        : "";

    const searchResponse = await anthropic.messages.create(
      {
        model: DRAFT_MODEL,
        max_tokens: 3000,
        // max_uses is the main latency lever -- each search round-trip
        // adds real time. Kept at 4 (down from 6) for a real chance of
        // surfacing several candidates without an excessive number of
        // round-trips; the timeout below is now the primary defense
        // against a genuinely slow run, not a hard cap that cuts off
        // otherwise-successful searches.
        tools: [{ type: "web_search_20260318", name: "web_search", max_uses: 4 }],
        messages: [
          {
            role: "user",
            content: `Search the web for up to 10 real, currently-operating candidate funders for this nonprofit within the "${channelLabel(channel)}" channel (${CHANNEL_DESCRIPTIONS[channel]}).${churchTactic}

Only include organizations you found real evidence for via search -- do not invent names. For each, try to find: organization name, website, a contact name/email if publicly listed (e.g. a "contact us" or staff page), a general location, and a short rationale for why it could be a fit given this nonprofit's profile.

Nonprofit profile:
${profile ? buildProfileSummary(profile) : "(no profile data provided)"}`,
          },
        ],
      },
      // 150s was consistently too tight for real runs -- this was
      // landing on "Request timed out" far more often than it was
      // landing on real results, defeating the point of the feature.
      // 240s (route maxDuration is 450s, leaving room for the
      // extraction call and ProPublica lookups after) gives the
      // search genuine room to finish.
      { timeout: 240_000 }
    );

    const findings = searchResponse.content
      .filter((block) => block.type === "text")
      .map((block) => (block as { text: string }).text)
      .join("\n");

    await supabase
      .from("discovery_search_runs")
      .update({ status: "extracting", status_message: "Extracting names, websites, and contact info..." })
      .eq("id", runId);

    const extractResponse = await anthropic.messages.create(
      {
        model: DRAFT_MODEL,
        max_tokens: 2500,
        tools: [
          {
            name: "submit_candidates",
            description: "Submit the structured list of candidate funders found.",
            input_schema: {
              type: "object",
              properties: {
                candidates: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      organization: { type: "string" },
                      website: { type: "string" },
                      contact_name: { type: "string" },
                      contact_email: { type: "string" },
                      location: { type: "string" },
                      rationale: { type: "string" },
                    },
                    required: ["name", "rationale"],
                  },
                },
              },
              required: ["candidates"],
            },
          },
        ],
        tool_choice: { type: "tool", name: "submit_candidates" },
        messages: [
          {
            role: "user",
            content: `Extract a structured list of candidate organizations from the research notes below. Only include real, named organizations. Leave a field blank/omit it if not actually found -- do not invent contact info or websites.

Research notes:
${findings || "(no findings)"}`,
          },
        ],
      },
      { timeout: 60_000 }
    );

    const toolUse = extractResponse.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("AI did not return a structured result. Try again.");
    }

    const found = ((toolUse.input as { candidates?: FoundCandidate[] }).candidates ?? []).filter(
      (c) => c && c.name
    );

    console.log(`[discovery-search] channel=${channel} findings_chars=${findings.length} ai_found=${found.length}`);

    await supabase
      .from("discovery_search_runs")
      .update({
        status: "screening",
        status_message:
          found.length > 0
            ? `Cross-referencing ${found.length} candidate${found.length === 1 ? "" : "s"} against public IRS filing data...`
            : "No candidates found -- wrapping up...",
      })
      .eq("id", runId);

    const { data: rulesData } = await supabase.from("screening_rules").select("*").eq("active", true);
    const rules = (rulesData ?? []) as ScreeningRule[];

    let inserted = 0;
    for (const found_candidate of found) {
      const propublica = await cachedProPublicaLookup(supabase, found_candidate.name);

      const latestFiling = propublica?.raw?.filings_with_data?.[0];
      const funder_type = propublica ? "Nonprofit organization (per IRS filing)" : null;
      const typical_grant_size =
        latestFiling?.totcntrbgfts != null
          ? `Annual contributions/gifts made: ~$${Number(latestFiling.totcntrbgfts).toLocaleString("en-US")}`
          : null;

      const candidate = {
        name: found_candidate.name,
        channel,
        organization: found_candidate.organization || null,
        website: found_candidate.website || null,
        contact_name: found_candidate.contact_name || null,
        contact_email: found_candidate.contact_email || null,
        location: found_candidate.location || propublica?.city || null,
        funder_type,
        geographic_focus: null,
        typical_grant_size,
        focus_areas: null,
        source: "ai_search",
        raw: { rationale: found_candidate.rationale, propublica_ein: propublica?.ein ?? null },
      };

      const { tier } = screenProspect(candidate, rules);

      const { error } = await supabase.from("candidates").insert({ ...candidate, suggested_tier: tier, status: "pending" });
      if (error) {
        console.error(`[discovery-search] insert failed for "${found_candidate.name}":`, error.message, error.details, error.hint);
      } else {
        inserted++;
      }
    }

    await supabase
      .from("discovery_search_runs")
      .update({
        status: "done",
        status_message: `Found ${inserted} candidate${inserted === 1 ? "" : "s"}`,
        found_count: inserted,
      })
      .eq("id", runId);

    revalidatePath("/discovery");
  } catch (err) {
    await supabase
      .from("discovery_search_runs")
      .update({
        status: "error",
        status_message: "Search failed",
        error_message: err instanceof Error ? err.message : "Something went wrong during the search",
      })
      .eq("id", runId);
  }
}

export async function retryDiscoverySearch(channel: Channel): Promise<string> {
  return startDiscoverySearch(channel);
}
