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
import { attestationCorpus, candidateDedupeKey, candidateDisplayName, isAttested, safeHostname, type WebsiteStatus } from "@/lib/candidates";
import { isAlreadyKnown, type KnownOrg } from "@/lib/candidate-intake";
import { isAggregatorUrl } from "@/lib/research";

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
  // The legal organization, separate from the program. Research resolves
  // identity against this -- a name with the program glued on cannot be
  // matched to a filing.
  funder_name?: string;
  opportunity_name?: string;
  // Index into the search results actually visited. Required by the schema;
  // anything that does not resolve marks the candidate source_missing.
  source_index?: number;
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
// pattern as runStrategy -- the panel polls /api/discovery-search-runs
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
// auth itself. organizationId is only passed on the admin-client path:
// RLS has no auth.uid() to filter by there, so every query below that
// would otherwise span every org's data gets an explicit .eq() instead.
// The session-client path leaves it undefined and relies on RLS, same
// as everywhere else in the app.
async function executeChannelSearch(supabase: SupabaseClient, runId: string, channel: Channel, organizationId?: string) {
  try {
    let profileQuery = supabase.from("org_profile").select("*").limit(1);
    if (organizationId) profileQuery = profileQuery.eq("organization_id", organizationId);
    const { data: profile } = await profileQuery.maybeSingle<OrgProfile>();

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

    // The URLs the search actually visited, kept rather than discarded.
    // Previously only the prose survived this step, so `website` was whatever
    // the model could recall -- usually nothing -- and a wholly invented
    // candidate was indistinguishable from a found one.
    const searchResults: { url: string; title: string | null }[] = [];
    const seenUrls = new Set<string>();
    for (const block of searchResponse.content as unknown as Record<string, unknown>[]) {
      if (block.type !== "web_search_tool_result") continue;
      const results = block.content;
      if (!Array.isArray(results)) continue;
      for (const r of results as Record<string, unknown>[]) {
        if (typeof r.url !== "string" || seenUrls.has(r.url)) continue;
        seenUrls.add(r.url);
        searchResults.push({ url: r.url, title: typeof r.title === "string" ? r.title : null });
      }
    }
    console.log(`[discovery-search] channel=${channel} captured ${searchResults.length} source urls`);

    await supabase
      .from("discovery_search_runs")
      .update({ status: "extracting", status_message: "Extracting names, websites, and contact info..." })
      .eq("id", runId);

    const extractResponse = await anthropic.messages.create(
      {
        model: DRAFT_MODEL,
        // Raised with the capture contract: each candidate now also carries
        // funder_name, opportunity_name and source_index. At 2500 the tool
        // call truncated mid-JSON, which surfaced as
        // "(_.input.candidates ?? []).filter is not a function" -- a partial
        // tool input is not the array the schema promises. The Research
        // Agent hit this same wall and the lesson had not been carried over.
        max_tokens: 8000,
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
                      name: { type: "string", description: "Display name for this opportunity, as you would show it in a list" },
                      funder_name: {
                        type: "string",
                        description:
                          "The LEGAL ORGANIZATION only -- e.g. 'Presbyterian Mission Agency'. Never include a program or grant name here; those go in opportunity_name. This is what identity research resolves against.",
                      },
                      opportunity_name: {
                        type: "string",
                        description:
                          "The program, fund or grant AS THE FUNDER THEMSELVES NAMES IT -- e.g. '1001 New Worshiping Communities'. This is a proper name you saw on the source, not a description of the opportunity and never a suggested approach to them. Omit it when the funder itself is the opportunity, or when you did not see a named program. This field is checked against the cited source's own text, so a phrase you composed will be discarded.",
                      },
                      source_index: {
                        type: "integer",
                        description:
                          "REQUIRED. The index, from the numbered source list below, of the search result this candidate came from. Do not guess: if no listed source supports this candidate, omit the candidate entirely rather than inventing an index.",
                      },
                      organization: { type: "string" },
                      website: { type: "string", description: "The funder's OWN website if you saw it. Do not put a directory, filing or news URL here -- leave it blank instead." },
                      contact_name: { type: "string" },
                      contact_email: { type: "string" },
                      location: { type: "string" },
                      rationale: { type: "string" },
                    },
                    required: ["name", "funder_name", "source_index", "rationale"],
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

Every candidate must cite the numbered source it came from via source_index. Sources actually visited by the search:
${searchResults.map((r, i) => `[${i}] ${r.url}${r.title ? ` -- ${r.title}` : ""}`).join("\n") || "(none captured)"}

Separate the ORGANIZATION from the PROGRAM. "Presbyterian Mission Agency -- 1001 New Worshiping Communities / Mission Program Grants" is funder_name "Presbyterian Mission Agency" and opportunity_name "1001 New Worshiping Communities / Mission Program Grants". A name that runs them together cannot be identified later.

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

    // A truncated tool call yields a PARTIAL input object, so `candidates`
    // may be a half-written string or absent entirely -- calling .filter on
    // it threw a TypeError that told the user nothing. Say what actually
    // happened instead, and name truncation when that is what it was.
    const rawCandidates = (toolUse.input as { candidates?: unknown }).candidates;
    if (!Array.isArray(rawCandidates)) {
      console.error(
        `[discovery-search] channel=${channel} malformed tool input: stop_reason=${extractResponse.stop_reason}, candidates=${typeof rawCandidates}`
      );
      throw new Error(
        extractResponse.stop_reason === "max_tokens"
          ? "The search found more than could be written out in one response. Try a narrower channel, or run it again."
          : "The AI returned a result we could not read. Running the search again usually clears it."
      );
    }

    const rawFound = (rawCandidates as FoundCandidate[]).filter((c) => c && c.name);

    // Attribute every candidate to a URL the search actually visited, and
    // classify that URL deterministically. A directory or news page is not
    // the funder's website, and must never be stored as though it were --
    // entity resolution now consults a prospect's domain ahead of filing
    // ambiguity, so an aggregator URL here would be read as the organization
    // speaking about itself.
    //
    // A candidate whose source_index matches nothing is the fabrication
    // signal. It is kept for audit and excluded from the queue, never
    // dropped silently and never turned into a prospect.
    const found = rawFound.map((c) => {
      const idx = typeof c.source_index === "number" ? c.source_index : -1;
      const source = idx >= 0 && idx < searchResults.length ? searchResults[idx] : null;
      const sourceDomain = source ? safeHostname(source.url) : null;
      const modelWebsiteHost = c.website ? safeHostname(c.website) : null;

      // Official only when the model named a site of its own that is not a
      // known aggregator. The cited source domain is provenance, not identity.
      const officialCandidate = modelWebsiteHost && !isAggregatorUrl(c.website ?? "") ? modelWebsiteHost : null;
      const websiteStatus: WebsiteStatus | null = officialCandidate
        ? "official_candidate"
        : source
          ? "third_party_source"
          : null;

      // Test what the model TYPED against what the search CAPTURED. Only
      // meaningful where a source was actually captured -- with no corpus,
      // every field would fail, and "we could not check" must not be recorded
      // as "we checked and it failed" (asserted_fields stays null).
      const corpus = attestationCorpus(source);
      const funderAttested = source ? isAttested(c.funder_name ?? c.name, corpus) : true;
      const opportunityAttested = source ? isAttested(c.opportunity_name, corpus) : true;
      const assertedFields: string[] | null = source
        ? [...(funderAttested ? [] : ["funder_name"]), ...(opportunityAttested ? [] : ["opportunity_name"])]
        : null;

      return {
        ...c,
        // Derived, not retyped -- the display name can no longer contradict
        // the structured fields it is built from.
        name: candidateDisplayName({
          funderName: c.funder_name,
          opportunityName: c.opportunity_name,
          opportunityAttested,
          fallback: c.name,
        }),
        // Only a website we believe is the funder's own is carried forward as
        // `website`; everything else stays in source_url as provenance.
        website: officialCandidate ? `https://${officialCandidate}` : null,
        source_url: source?.url ?? null,
        source_domain: sourceDomain,
        source_title: source?.title ?? null,
        official_website_candidate: officialCandidate,
        website_status: websiteStatus,
        capture_status: source ? "captured" : "source_missing",
        asserted_fields: assertedFields,
        dedupe_key: candidateDedupeKey({
          sourceDomain,
          funderName: c.funder_name,
          opportunityName: c.opportunity_name,
          opportunityAttested,
          name: c.name,
        }),
      };
    });

    const unattested = found.filter((c) => c.asserted_fields && c.asserted_fields.length > 0);
    if (unattested.length > 0) {
      console.log(
        `[discovery-search] channel=${channel} ${unattested.length} candidate(s) with unattested fields: ` +
          unattested.map((c) => `${c.funder_name ?? c.name} [${c.asserted_fields!.join(",")}]`).join("; ")
      );
    }

    const sourceless = found.filter((c) => c.capture_status === "source_missing").length;
    if (sourceless > 0) {
      console.log(`[discovery-search] channel=${channel} ${sourceless} candidate(s) cited no captured source -- audit only`);
    }

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

    let rulesQuery = supabase.from("screening_rules").select("*").eq("active", true);
    if (organizationId) rulesQuery = rulesQuery.eq("organization_id", organizationId);
    const { data: rulesData } = await rulesQuery;
    const rules = (rulesData ?? []) as ScreeningRule[];

    // Fetched once and appended to as candidates get inserted below,
    // rather than re-querying both tables on every iteration --
    // within-run duplicates (the same funder turning up twice in one
    // search) still get caught since each insert updates this list
    // before the next candidate is checked.
    let candidatesQuery = supabase.from("candidates").select("name, organization, dedupe_key");
    let prospectsQuery = supabase.from("prospects").select("name, organization");
    if (organizationId) {
      candidatesQuery = candidatesQuery.eq("organization_id", organizationId);
      prospectsQuery = prospectsQuery.eq("organization_id", organizationId);
    }
    const [{ data: knownCandidates }, { data: knownProspects }] = await Promise.all([
      candidatesQuery.returns<(KnownOrg & { dedupe_key: string | null })[]>(),
      prospectsQuery.returns<KnownOrg[]>(),
    ]);
    const known: KnownOrg[] = [...(knownCandidates ?? []), ...(knownProspects ?? [])];
    // Exact-key matching runs ALONGSIDE name matching, not instead of it.
    // Prospects carry no dedupe_key (they have no source domain), and rows
    // predating 0055 have none either -- dropping the name check would stop
    // catching both. The key is the precise instrument; the name check is the
    // net underneath it.
    const knownKeys = new Set((knownCandidates ?? []).map((c) => c.dedupe_key).filter((k): k is string => !!k));

    let inserted = 0;
    let skippedDuplicates = 0;
    for (const found_candidate of found) {
      if (knownKeys.has(found_candidate.dedupe_key) || isAlreadyKnown(known, found_candidate.name, found_candidate.organization)) {
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
        // Provenance, kept separate from identity. source_url is where this
        // was found; website (above) is only ever the funder's own site.
        funder_name: found_candidate.funder_name || found_candidate.name,
        opportunity_name: found_candidate.opportunity_name || null,
        source_url: found_candidate.source_url,
        source_domain: found_candidate.source_domain,
        source_title: found_candidate.source_title,
        official_website_candidate: found_candidate.official_website_candidate,
        website_status: found_candidate.website_status,
        capture_status: found_candidate.capture_status,
        asserted_fields: found_candidate.asserted_fields,
        dedupe_key: found_candidate.dedupe_key,
      };

      const { tier } = screenProspect(candidate, rules);

      const { data: insertedRow, error } = await supabase
        .from("candidates")
        .insert({
          ...candidate,
          suggested_tier: tier,
          status: "pending",
          ...(organizationId ? { organization_id: organizationId } : {}),
        })
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
          organizationId,
        });
        known.push({ name: candidate.name, organization: candidate.organization });
        if (candidate.dedupe_key) knownKeys.add(candidate.dedupe_key);
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
  userId: string,
  organizationId: string
): Promise<number> {
  const { data: run, error } = await supabase
    .from("discovery_search_runs")
    .insert({
      channel,
      status: "searching",
      status_message: `Searching the web for ${channelLabel(channel)} candidates... (overnight auto-search)`,
      created_by: userId,
      started_at: new Date().toISOString(),
      organization_id: organizationId,
    })
    .select("id")
    .single();
  if (error || !run) {
    console.error(`[auto-discovery-search] failed to create run for channel=${channel}:`, error?.message);
    return 0;
  }

  await executeChannelSearch(supabase, run.id, channel, organizationId);

  const { data: finished } = await supabase
    .from("discovery_search_runs")
    .select("found_count")
    .eq("id", run.id)
    .maybeSingle();
  return finished?.found_count ?? 0;
}
