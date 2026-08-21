"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { anthropic, DRAFT_MODEL } from "@/lib/ai/anthropic";
import { buildProfileSummary, CHANNEL_DESCRIPTIONS } from "@/lib/channel-match";
import { screenProspect, type ScreeningRule } from "@/lib/screening";
import { channelLabel, type Channel } from "@/lib/prospects";
import { bestEffortLookup } from "@/lib/propublica";
import type { OrgProfile } from "@/lib/organization";
import { upsertContact } from "@/lib/contacts";

// Root cause of the scope-3 reliability problem was traced to
// web_search_20260318 defaulting to routing through an internal
// code-execution "dynamic filtering" caller; allowed_callers:
// ["direct"] below bypasses it. Foundation (previously failed twice
// at 3) succeeded cleanly once that was added, so scope 3 is now the
// default across all channels pending a full per-channel retest.
const SEARCH_SCOPE_BY_CHANNEL: Partial<Record<Channel, number>> = {};
const DEFAULT_SEARCH_SCOPE = 3;

type FoundCandidate = {
  name: string;
  organization?: string;
  website?: string;
  contact_name?: string;
  contact_email?: string;
  location?: string;
  rationale: string;
};

async function cachedProPublicaLookup(supabase: SupabaseClient, name: string) {
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

// Strips a leading "The " and normalizes case/whitespace so "The
// Maclellan Foundation" and "Maclellan Foundation" compare equal.
function normalizeOrgName(s: string): string {
  return s.trim().toLowerCase().replace(/^the\s+/, "");
}

// Two names/orgs are the same real thing if they're equal after
// normalizing, or one contains the other (e.g. "Assemblies of God"
// vs. "Assemblies of God World Missions (AGWM)"). Guarded to at
// least 4 characters so a short generic word doesn't false-positive
// against everything.
function isSameOrg(a: string, b: string): boolean {
  const na = normalizeOrgName(a);
  const nb = normalizeOrgName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length < 4 || nb.length < 4) return false;
  return na.includes(nb) || nb.includes(na);
}

type KnownOrg = { name: string; organization: string | null };

// Best-effort, not a hard uniqueness guarantee: catches exact and
// near-exact name/organization variants (see isSameOrg), but two
// genuinely differently-worded names for the same funder with no
// organization field set on either side (e.g. an abbreviation like
// "2PC Foundation" vs. "Second Presbyterian Church Foundation") can
// still slip through -- there's no EIN to key off for orgs
// ProPublica doesn't have.
function isAlreadyKnown(known: KnownOrg[], name: string, organization?: string | null): boolean {
  return known.some((row) => {
    if (isSameOrg(row.name, name)) return true;
    if (organization && row.organization && isSameOrg(row.organization, organization)) return true;
    return false;
  });
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

  await executeChannelSearch(supabase, runId, channel);
}

// Shared by the user-triggered flow above and the overnight
// auto-search cron route -- takes whatever client the caller already
// resolved (cookie-based for a real user, admin/service-role for the
// cron route, which has no user session at all) rather than touching
// auth itself.
async function executeChannelSearch(supabase: SupabaseClient, runId: string, channel: Channel) {
  try {
    const { data: profile } = await supabase.from("org_profile").select("*").limit(1).maybeSingle<OrgProfile>();

    const churchTactic =
      channel === "church"
        ? `\n\nThis nonprofit has existing notable funders (see profile below). If any of them are individual churches, check whether they belong to a broader denomination or network, and if so, actively look for sibling churches within that same network as strong candidates -- an existing supporting relationship is a warm signal for the rest of that network. Note: individual churches are generally exempt from IRS Form 990 filing, so they won't show up in tax-filing databases -- rely on web search, denominational directories, and network/association websites instead.`
        : "";

    const scope = SEARCH_SCOPE_BY_CHANNEL[channel] ?? DEFAULT_SEARCH_SCOPE;

    const searchResponse = await anthropic.messages.create(
      {
        model: DRAFT_MODEL,
        max_tokens: 3000,
        // web_search_20260318 is a _20260209-or-later tool version --
        // those default to routing through an internal code-execution
        // "dynamic filtering" caller rather than calling search
        // directly, which is real, documented extra latency-variance
        // machinery (confirmed against current Anthropic docs). Forcing
        // "direct" bypasses it -- primary suspect for why this call
        // times out so much more than its scope alone would suggest.
        tools: [
          { type: "web_search_20260318", name: "web_search", max_uses: scope, allowed_callers: ["direct"] },
        ],
        messages: [
          {
            role: "user",
            content: `Search the web for up to ${scope} real, currently-operating candidate funders for this nonprofit within the "${channelLabel(channel)}" channel (${CHANNEL_DESCRIPTIONS[channel]}).${churchTactic}

Each must be a genuine strategic fit, not just any organization that happens to exist in this channel -- pick matches based on real evidence of alignment with this nonprofit's mission, programs, or focus areas (see profile below), not just category membership. Only include an organization if you found real evidence for it via search -- do not invent names. Try to find: organization name, website, a contact name/email if publicly listed (e.g. a "contact us" or staff page), a general location, and a short rationale grounded in specific alignment with this nonprofit's profile, not a generic description. Work efficiently -- a couple of well-chosen searches, not exhaustive research.

Nonprofit profile:
${profile ? buildProfileSummary(profile) : "(no profile data provided)"}`,
          },
        ],
      },
      { timeout: 240_000 }
    );

    console.log(
      `[discovery-search] channel=${channel} search call resolved, stop_reason=${searchResponse.stop_reason} content_blocks=${searchResponse.content.length}`
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

    console.log(`[discovery-search] channel=${channel} scope=${scope} findings_chars=${findings.length} ai_found=${found.length}`);

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

    // Fetched once and appended to as candidates get inserted below,
    // rather than re-querying both tables on every iteration --
    // within-run duplicates (the same funder turning up twice in one
    // search) still get caught since each insert updates this list
    // before the next candidate is checked.
    const [{ data: knownCandidates }, { data: knownProspects }] = await Promise.all([
      supabase.from("candidates").select("name, organization").returns<KnownOrg[]>(),
      supabase.from("prospects").select("name, organization").returns<KnownOrg[]>(),
    ]);
    const known: KnownOrg[] = [...(knownCandidates ?? []), ...(knownProspects ?? [])];

    let inserted = 0;
    let skippedDuplicates = 0;
    for (const found_candidate of found) {
      if (isAlreadyKnown(known, found_candidate.name, found_candidate.organization)) {
        skippedDuplicates++;
        continue;
      }

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

      const { data: insertedRow, error } = await supabase
        .from("candidates")
        .insert({ ...candidate, suggested_tier: tier, status: "pending" })
        .select("id")
        .single();
      if (error) {
        console.error(`[discovery-search] insert failed for "${found_candidate.name}":`, error.message, error.details, error.hint);
      } else {
        // No interactive user in the overnight cron path (see
        // runAutoDiscoverySearchForChannel) -- created_by on the
        // contact row is attribution-only, so it's fine to leave it
        // unset there rather than threading a userId through here.
        await upsertContact(supabase, {
          name: candidate.contact_name,
          email: candidate.contact_email,
          organization: candidate.organization,
          candidateId: insertedRow.id,
        });
        known.push({ name: candidate.name, organization: candidate.organization });
        inserted++;
      }
    }

    console.log(`[discovery-search] channel=${channel} inserted=${inserted} skipped_duplicates=${skippedDuplicates}`);

    await supabase
      .from("discovery_search_runs")
      .update({
        status: "done",
        status_message:
          skippedDuplicates > 0
            ? `Found ${inserted} candidate${inserted === 1 ? "" : "s"} (${skippedDuplicates} already known, skipped)`
            : `Found ${inserted} candidate${inserted === 1 ? "" : "s"}`,
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

// Called by the overnight auto-search cron route (app/api/cron/...),
// once per channel, with an admin client (no user session to read --
// created_by is whichever team member last saved the auto-search
// settings, since that's the closest thing to a real "who turned this
// on" attribution available). Creates and claims its own run row
// directly rather than going through startDiscoverySearch, since
// there's no browser session invoking this at all. Returns how many
// candidates this channel actually inserted, so the caller can stop
// once it's found enough for the night.
export async function runAutoDiscoverySearchForChannel(
  supabase: SupabaseClient,
  channel: Channel,
  userId: string
): Promise<number> {
  const { data: run, error } = await supabase
    .from("discovery_search_runs")
    .insert({
      channel,
      status: "searching",
      status_message: `Searching the web for ${channelLabel(channel)} candidates... (overnight auto-search)`,
      created_by: userId,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !run) {
    console.error(`[auto-discovery-search] failed to create run for channel=${channel}:`, error?.message);
    return 0;
  }

  await executeChannelSearch(supabase, run.id, channel);

  const { data: finished } = await supabase
    .from("discovery_search_runs")
    .select("found_count")
    .eq("id", run.id)
    .maybeSingle();
  return finished?.found_count ?? 0;
}
