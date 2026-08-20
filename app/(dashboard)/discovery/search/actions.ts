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

export async function runDiscoverySearch(formData: FormData) {
  const channel = formData.get("channel") as Channel;

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("org_profile").select("*").limit(1).maybeSingle<OrgProfile>();
  if (!profile) throw new Error("Fill in the Organization Profile before running a discovery search.");

  const churchTactic =
    channel === "church"
      ? `\n\nThis nonprofit has existing notable funders (see profile below). If any of them are individual churches, check whether they belong to a broader denomination or network, and if so, actively look for sibling churches within that same network as strong candidates -- an existing supporting relationship is a warm signal for the rest of that network. Note: individual churches are generally exempt from IRS Form 990 filing, so they won't show up in tax-filing databases -- rely on web search, denominational directories, and network/association websites instead.`
      : "";

  const searchResponse = await anthropic.messages.create(
    {
      model: DRAFT_MODEL,
      max_tokens: 3000,
      // max_uses is the main latency lever -- each search round-trip
      // adds real time. 6 was letting single runs regularly exceed
      // two minutes; 4 is still enough to surface several candidates.
      tools: [{ type: "web_search_20260318", name: "web_search", max_uses: 4 }],
      messages: [
        {
          role: "user",
          content: `Search the web for up to 10 real, currently-operating candidate funders for this nonprofit within the "${channelLabel(channel)}" channel (${CHANNEL_DESCRIPTIONS[channel]}).${churchTactic}

Only include organizations you found real evidence for via search -- do not invent names. For each, try to find: organization name, website, a contact name/email if publicly listed (e.g. a "contact us" or staff page), a general location, and a short rationale for why it could be a fit given this nonprofit's profile.

Nonprofit profile:
${buildProfileSummary(profile) || "(no profile data provided)"}`,
        },
      ],
    },
    { timeout: 150_000 }
  );

  const findings = searchResponse.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n");

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

  revalidatePath("/discovery");
  redirect(`/discovery/search?found=${inserted}&channel=${channel}`);
}
