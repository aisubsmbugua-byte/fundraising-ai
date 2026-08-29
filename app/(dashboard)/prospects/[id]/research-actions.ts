"use server";

import { createHash } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { requireSuperadmin } from "@/lib/auth";
import { estimateCostUsd } from "@/lib/ai/model-select";
import { searchFunderWeb } from "@/lib/ai/funder-search";
import { verifyResearchClaims } from "@/lib/ai/research-verify";
import {
  extractResearchClaims,
  buildIndexedSources,
  buildEvidenceFragments,
  EXCLUDED_ENTITY_STATUSES,
  type EvidenceFragment,
} from "@/lib/ai/research-extract";
import {
  allocateResearchRunVersion,
  classifyRunSources,
  isConfirmedDossier,
  ENTITY_CLASSIFICATION_VERSION,
  defaultDepthForStage,
  claimKeysForDepth,
  isMaterialClaimKey,
  assessDossierState,
  missingInformationSections,
  isGrantSchedulePage,
  type ResearchDepth,
  deriveEntityNameToken,
  resolveRunEntity,
  RESEARCH_CLAIM_KEYS,
  type ResearchEntityValidationStatus,
  type ResearchKeyCoverageStatus,
  type ResearchSourceType,
} from "@/lib/research";

// Bump these when the extraction prompt or the tool's input schema shape
// changes -- they're recorded per-run so evaluation results stay
// interpretable after either one drifts. v5: evidence-first redesign --
// extraction cites evidence_ids into a pre-captured, entity-validated
// fragment list instead of writing its own source_excerpt; see
// docs/decisions/0002-research-agent.md.
// v6 (A'): retrieval depth. The search step may now fetch and read
// authoritative pages in full rather than relying on ~150-char search
// snippets, and both prompts require a reporting period on every financial
// figure. Schema version moves with it because evidence gained a third
// kind (fetched_page_excerpt).
const PROMPT_VERSION = "v6";
const EXTRACTION_SCHEMA_VERSION = "v6";

// Approximate published Claude Sonnet pricing at the time this was written
// -- not read from a live source. Good enough for comparing runs to each
// other; re-check against current Anthropic pricing before trusting the
// dollar figure for anything else.
// Priced per model -- research runs on a different (cheaper) model than the
// live workflow, so a fixed rate would silently misreport cost. See
// MODEL_PRICING in lib/ai/model-select.ts.

// Cheap, deterministic heuristic -- no extra model round-trip. A model
// override could be added later if this proves too coarse; not needed yet.
function classifySourceType(url: string, prospectWebsite: string | null): ResearchSourceType {
  const lower = url.toLowerCase();
  if (/propublica\.org|guidestar\.org|irs\.gov|990finder|candid\.org/.test(lower)) return "irs_filing";
  if (/annualreport|annual-report/.test(lower)) return "annual_report";
  if (prospectWebsite) {
    try {
      const prospectHost = new URL(prospectWebsite).hostname.replace(/^www\./, "");
      const urlHost = new URL(url).hostname.replace(/^www\./, "");
      if (urlHost === prospectHost) return "official_website";
    } catch {
      // malformed prospect.website or url -- fall through
    }
  }
  return "secondary_source";
}

// Tags a thrown Error with a stable, safe-to-display code (stored in
// research_runs.error_code) separately from its full message (stored in
// error_message, DB/logs-only -- see SAFE_ERROR_MESSAGES in
// app/admin/research/page.tsx). Keeps SDK/implementation detail (header
// names, auth internals -- the exact thing the real v1 Maclellan error
// leaked) out of the default UI text without losing it for debugging.
class ResearchError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Shared by startResearch and retryResearch -- the only difference between
// a first run and a retry is whether retryOfRunId is set.
async function createResearchRun(prospectId: string, retryOfRunId: string | null): Promise<string> {
  const user = await requireSuperadmin();
  const supabase = createClient();

  const { data: prospect } = await supabase.from("prospects").select("name").eq("id", prospectId).single();
  if (!prospect) throw new Error("Prospect not found");

  return allocateResearchRunVersion(supabase, prospectId, retryOfRunId, user.id, `Researching ${prospect.name}...`);
}

export async function startResearch(prospectId: string): Promise<string> {
  return createResearchRun(prospectId, null);
}

export async function retryResearch(prospectId: string, previousRunId: string): Promise<string> {
  return createResearchRun(prospectId, previousRunId);
}

// The heavy-lifting call. Dark/superadmin-only -- this is evaluation
// infrastructure, not a feature soft-launched to real tenant users, so the
// authorization boundary is enforced here structurally, not just by the
// absence of a UI entry point. started_at acts as a claim-lock, same
// pattern as runDeepDive, so a duplicate trigger (e.g. a page refresh
// mid-run) can't start the same run twice.
export async function runResearch(runId: string, prospectId: string, depthOverride?: ResearchDepth) {
  await requireSuperadmin();
  const supabase = createClient();

  const { data: claimed } = await supabase
    .from("research_runs")
    .update({ started_at: new Date().toISOString() })
    .eq("id", runId)
    .is("started_at", null)
    .select("id")
    .maybeSingle();
  if (!claimed) return;

  const startedAt = Date.now();

  try {
    const { data: prospect } = await supabase.from("prospects").select("*").eq("id", prospectId).single();
    if (!prospect) throw new ResearchError("prospect_not_found", "Prospect not found");

    // Depth follows pipeline stage unless the caller overrides it: a
    // Discovery candidate gets a cheap screen, anything accepted gets the
    // full dossier. See defaultDepthForStage in lib/research.ts.
    const depth: ResearchDepth = depthOverride ?? defaultDepthForStage(prospect.stage ?? null);

    const {
      findings,
      usage: searchUsage,
      citedSources,
      searchedSources,
      fetchedSources,
      fetchedCitations,
      fetchAvailable,
      model: searchModel,
      searchesUsed,
      fetchAttempts,
      fetchFailures,
    } = await searchFunderWeb(prospect, "research_only", depth).catch((err) => {
      throw new ResearchError("search_failed", err instanceof Error ? err.message : "Web search step failed");
    });

    await supabase
      .from("research_runs")
      .update({
        status: "extracting",
        status_message: "Extracting structured facts from research findings...",
      })
      .eq("id", runId);

    const indexedSources = buildIndexedSources(citedSources, searchedSources, fetchedSources);

    // --- Entity validation: classify every source BEFORE any evidence is
    // built or shown to extraction. Deterministic, code-only -- see
    // docs/decisions/0002-research-agent.md for the full decision tree.
    const textsByUrl = new Map<string, string[]>();
    for (const s of indexedSources) {
      if (s.title) textsByUrl.set(s.url, [s.title]);
    }
    // Fetched page text is included here deliberately: a page read in full
    // states the EIN and legal name that a search snippet (or a bare-domain
    // title) never carried, which is what lets an authoritative filing page
    // reach ein_confirmed instead of falling through the name check.
    for (const c of [...citedSources, ...fetchedCitations]) {
      if (!c.citedText) continue;
      const list = textsByUrl.get(c.url) ?? [];
      list.push(c.citedText);
      textsByUrl.set(c.url, list);
    }
    // Identity is resolved BEFORE any source is classified, by priority of
    // evidence quality rather than by counting mentions. A stored EIN on the
    // prospect short-circuits it entirely, making repeat runs deterministic.
    const nameToken = deriveEntityNameToken(
      [prospect.name, prospect.legal_name, ...(prospect.aliases ?? [])].filter(Boolean).join(" ")
    );
    const { ein: confirmedEin, method: entityResolutionMethod } = resolveRunEntity({
      storedEin: prospect.ein ?? null,
      prospectName: prospect.legal_name || prospect.name,
      prospectWebsite: prospect.website,
      nameToken,
      sources: indexedSources.map((s) => ({
        url: s.url,
        texts: textsByUrl.get(s.url) ?? [],
        title: s.title,
        sourceType: classifySourceType(s.url, prospect.website),
      })),
    });

    // Classified per ENTITY, not per URL: sources describing the same EIN
    // pool their captured text and share one verdict, so a page whose title
    // came back as a bare domain inherits the identity its siblings
    // establish instead of failing the name check alone.
    const classified = classifyRunSources({
      sources: indexedSources.map((s) => ({ url: s.url, texts: textsByUrl.get(s.url) ?? [] })),
      prospectWebsite: prospect.website,
      prospectLocation: prospect.location ?? null,
      nameToken,
      confirmedEin,
    });
    const entityStatusByUrl = new Map<string, ResearchEntityValidationStatus>(classified.map((c) => [c.url, c.status]));
    const sourceEinByUrl = new Map<string, string | null>(classified.map((c) => [c.url, c.sourceEin]));

    // Written before extraction's own writes -- captures what was actually
    // searched (and how it was classified) even if extraction fails
    // afterward, and answers "what sources were checked" for
    // research_key_coverage rows that end up not_found/not_public
    // regardless of what gets extracted.
    let sourceIdByUrl = new Map<string, string>();
    if (indexedSources.length > 0) {
      const { data: sourceRows, error: sourcesError } = await supabase
        .from("research_sources")
        .insert(
          indexedSources.map((s) => ({
            research_run_id: runId,
            url: s.url,
            title: s.title,
            source_type: classifySourceType(s.url, prospect.website),
            page_age: s.pageAge,
            entity_validation_status: entityStatusByUrl.get(s.url) ?? null,
            source_ein: sourceEinByUrl.get(s.url) ?? null,
          }))
        )
        .select("id");
      if (sourcesError) throw new ResearchError("sources_insert_failed", sourcesError.message);
      sourceIdByUrl = new Map(indexedSources.map((s, i) => [s.url, (sourceRows ?? [])[i]?.id as string]));
    }

    // --- Evidence ledger: every distinct captured text fragment (a
    // citation instance or a title), including ones from excluded sources
    // -- excluded evidence is never shown to extraction (see filtering
    // below) but IS still persisted, for audit, never silently dropped.
    const allFragments: EvidenceFragment[] = buildEvidenceFragments(citedSources, searchedSources, entityStatusByUrl, fetchedCitations);
    let evidenceIds: string[] = [];
    if (allFragments.length > 0) {
      const { data: evidenceRows, error: evidenceError } = await supabase
        .from("research_evidence")
        .insert(
          allFragments.map((f) => ({
            research_run_id: runId,
            source_id: sourceIdByUrl.get(f.url),
            url: f.url,
            kind: f.kind,
            exact_text: f.exactText,
            content_hash: createHash("sha256").update(f.exactText).digest("hex"),
          }))
        )
        .select("id");
      if (evidenceError) throw new ResearchError("evidence_insert_failed", evidenceError.message);
      evidenceIds = (evidenceRows ?? []).map((r) => r.id as string);
    }

    // Only usable-trust fragments (and their real DB ids) are offered to
    // extraction -- entity_mismatch/unrelated_excluded evidence never
    // reaches the prompt at all. usableFragments/usableRealIds stay
    // index-aligned: extraction's evidence_ids index into usableFragments,
    // resolved back to usableRealIds[i] for storage.
    const usableIndices = allFragments.map((_, i) => i).filter((i) => !EXCLUDED_ENTITY_STATUSES.has(allFragments[i].entityStatus));
    const usableFragments = usableIndices.map((i) => allFragments[i]);
    const usableRealIds = usableIndices.map((i) => evidenceIds[i]);

    const scopedKeys = claimKeysForDepth(depth, { knownWebsite: !!prospect.website });
    const extraction = await extractResearchClaims({ prospectName: prospect.name, findings, evidence: usableFragments, claimKeys: scopedKeys }).catch((err) => {
      throw new ResearchError("extraction_failed", err instanceof Error ? err.message : "Extraction call failed");
    });
    const { claims, model } = extraction;

    // Claim rows are inserted next, while status is still "extracting" --
    // the status flip to "ready" below is the LAST write. A consumer that
    // correctly gates on status = "ready" before trusting any claims never
    // observes a partial set: if any insert below fails partway, the run
    // never reaches "ready" -- it falls into the outer catch as "error"
    // instead. See docs/decisions/0002-research-agent.md.
    let insertedClaimIds: string[] = [];
    if (claims.length > 0) {
      const { data: claimRows, error: claimsError } = await supabase
        .from("research_claims")
        .insert(
          claims.map((c) => {
            const primaryFragment = c.evidence_ids.length > 0 ? usableFragments[c.evidence_ids[0]] : undefined;
            return {
              research_run_id: runId,
              prospect_id: prospectId,
              claim_type: c.claim_type,
              claim_key: c.claim_key,
              category: RESEARCH_CLAIM_KEYS.find((k) => k.key === c.claim_key)?.category ?? "Other",
              claim: c.claim,
              // Legacy single-value display fields, now always a copy of a
              // REAL captured evidence fragment -- never model-typed. The
              // full multi-evidence list lives in research_claim_sources.
              source_url: primaryFragment?.url ?? null,
              source_excerpt: primaryFragment?.exactText ?? null,
              confidence: c.confidence,
              // Visible to a human, barred from downstream use.
              evidence_missing: c.evidence_missing ?? false,
              confidence_reason: c.confidence_reason ?? null,
              reporting_period: c.reporting_period ?? null,
            };
          })
        )
        .select("id");
      if (claimsError) throw new ResearchError("claims_insert_failed", claimsError.message);
      insertedClaimIds = (claimRows ?? []).map((r) => r.id as string);

      const claimSourceRows = claims.flatMap((c, i) => {
        const claimId = insertedClaimIds[i];
        return c.evidence_ids
          .filter((idx) => !!usableRealIds[idx])
          .map((idx) => {
            const fragment = usableFragments[idx];
            return {
              claim_id: claimId,
              source_id: sourceIdByUrl.get(fragment.url),
              evidence_id: usableRealIds[idx],
              research_run_id: runId,
              // Copied directly from the evidence record -- never
              // model-supplied, always exact by construction. Superseded
              // citation_consistency check (Stage 4) is intentionally left
              // null for new rows: there's nothing left to probabilistically
              // verify once the quote IS the evidence record.
              cited_text: fragment.exactText,
              supports_directly: c.supports_directly,
              citation_consistency: null,
              content_hash: createHash("sha256").update(fragment.exactText).digest("hex"),
            };
          });
      });
      if (claimSourceRows.length > 0) {
        const { error: claimSourcesError } = await supabase.from("research_claim_sources").insert(claimSourceRows);
        if (claimSourcesError) throw new ResearchError("claim_sources_insert_failed", claimSourcesError.message);
      }
    }

    // Derive full per-key coverage server-side rather than trusting the
    // model's own coverage array as complete: a "found" entry with no
    // matching valid claim (dropped by the filter above) becomes
    // extraction_failed; any key the model's coverage array omitted
    // entirely (and that has no matching claim either) becomes
    // not_attempted. This is what keeps a key from disappearing into a
    // clean-looking result just because the model skipped it or answered
    // it in a shape validation rejected.
    //
    // "found" is always derived from whether a valid claim actually
    // exists for that key, never from the model's separate self-reported
    // coverage entry -- the claim itself is the stronger, harder-to-fake
    // signal.
    const foundKeys = new Set(claims.map((c) => c.claim_key));
    const modelCoverageByKey = new Map(extraction.coverage.map((c) => [c.claim_key, c]));
    const coverageRows: {
      research_run_id: string;
      claim_key: string;
      status: ResearchKeyCoverageStatus;
      notes: string | null;
      retry_recommended: boolean;
    }[] = [];
    const inScope = new Set(scopedKeys.map((k) => k.key));
    for (const { key } of RESEARCH_CLAIM_KEYS) {
      const modelEntry = modelCoverageByKey.get(key);
      let status: ResearchKeyCoverageStatus;
      // Deliberately not asked at this depth -- distinct from not_attempted,
      // which means the model WAS asked and skipped it. A row is still
      // written for every key so coverage stays comparable across depths.
      if (!inScope.has(key) && !foundKeys.has(key)) {
        coverageRows.push({ research_run_id: runId, claim_key: key, status: "not_in_scope", notes: null, retry_recommended: false });
        continue;
      }
      if (foundKeys.has(key)) {
        status = "found";
      } else if (modelEntry) {
        status = modelEntry.status === "found" ? "extraction_failed" : modelEntry.status;
      } else {
        status = "not_attempted";
      }
      // Never silently false: a key with no model-authored coverage entry
      // (not_attempted) or a malformed one (extraction_failed) defaults to
      // retry-recommended, since there was no real attempt to trust either way.
      const retryRecommended = status === "found" ? true : modelEntry?.retry_recommended ?? true;
      coverageRows.push({ research_run_id: runId, claim_key: key, status, notes: modelEntry?.notes ?? null, retry_recommended: retryRecommended });
    }
    const { error: coverageError } = await supabase.from("research_key_coverage").insert(coverageRows);
    if (coverageError) throw new ResearchError("coverage_insert_failed", coverageError.message);

    const inputTokens = searchUsage.inputTokens + extraction.usage.inputTokens;
    const outputTokens = searchUsage.outputTokens + extraction.usage.outputTokens;
    // Priced per call, because search and extraction deliberately run on
    // different models. Pricing the combined token totals at one model's rate
    // overstated cost by roughly 20% on the first split run -- and every
    // economic decision here rests on these numbers being right.
    const costUsd =
      estimateCostUsd(searchModel, searchUsage.inputTokens, searchUsage.outputTokens) +
      estimateCostUsd(model, extraction.usage.inputTokens, extraction.usage.outputTokens);

    // --- Retrieval instrumentation. The specific failure this exists to
    // surface: a funder's own guidelines page listed as a source but never
    // read. Application rules, eligibility and exclusions live only there and
    // never in a filing, so that miss silently costs a whole class of fact --
    // and it previously took three runs and a stored-evidence investigation
    // to notice.
    const fetchedHosts = new Set(
      fetchedSources
        .map((f) => {
          try {
            return new URL(f.url).hostname.replace(/^www\./, "");
          } catch {
            return null;
          }
        })
        .filter((h): h is string => h !== null)
    );
    let officialSiteFetched: boolean | null = null;
    if (prospect.website) {
      try {
        officialSiteFetched = fetchedHosts.has(new URL(prospect.website).hostname.replace(/^www\./, ""));
      } catch {
        officialSiteFetched = null;
      }
    }
    const filingFetched = fetchedSources.some((f) => classifySourceType(f.url, prospect.website) === "irs_filing");
    const capturedChars = allFragments.reduce((n, f) => n + f.exactText.length, 0);

    // A grant schedule counts as missing only when one was actually there:
    // "found the page and never opened it" is the failure worth flagging,
    // and it is exactly what cost 20 named grant recipients between two runs.
    // Retrieval diagnostics -- operational. These explain WHY a gap exists;
    // they do not tell a fundraiser whether the dossier holds what they need,
    // and they are no longer allowed to decide that. The pattern-matching
    // approach that drove state never once recognised the source that
    // actually supplied 20 named grants.
    const readUrls = new Set(
      allFragments
        .filter((f) => f.kind === "fetched_page_excerpt" && !EXCLUDED_ENTITY_STATUSES.has(f.entityStatus))
        .map((f) => f.url)
    );
    const grantSchedulePresent = indexedSources.some((s) => isGrantSchedulePage(s.url));
    const grantScheduleRead = Array.from(readUrls).some((u) => isGrantSchedulePage(u));
    const retrievalDiagnostics = grantSchedulePresent && !grantScheduleRead ? ["grant_schedule"] : [];

    const excludedCount = allFragments.length - usableFragments.length;
    const statusMessage = extraction.truncated
      ? `Extraction response was truncated (hit the token limit) -- results below are incomplete. Found ${claims.length} fact${claims.length === 1 ? "" : "s"} before truncation; retry likely to find more.`
      : !extraction.evidenceAvailable
        ? "Research completed, but no usable captured evidence this run -- claims below have no verifiable source."
        : claims.length > 0
          ? depth === "identity"
            ? `Identity preflight: ${claims.length} identity fact${claims.length === 1 ? "" : "s"}${
                confirmedEin ? ` — resolved to EIN ${confirmedEin}` : " — identity NOT resolved; confirm which entity below before running a dossier"
              }`
            : depth === "screen"
            ? `Screen: found ${claims.length} fact${claims.length === 1 ? "" : "s"} from search only${excludedCount > 0 ? ` (${excludedCount} evidence fragment${excludedCount === 1 ? "" : "s"} excluded for entity mismatch)` : ""}`
            : `Found ${claims.length} fact${claims.length === 1 ? "" : "s"} from ${fetchedSources.length} page${fetchedSources.length === 1 ? "" : "s"} read in full${
              fetchAvailable ? "" : " (page fetch unavailable this run -- search snippets only)"
            }${(() => {
              const gaps = depth === "dossier" ? missingInformationSections(claims.map((c) => ({ claim_key: c.claim_key, evidence_missing: c.evidence_missing }))) : [];
              return gaps.length ? ` -- no ${gaps.map((g) => g.replace(/_/g, " ")).join(", ")}` : "";
            })()}${excludedCount > 0 ? ` (${excludedCount} evidence fragment${excludedCount === 1 ? "" : "s"} excluded for entity mismatch)` : ""}`
          : "Research completed, but found nothing extractable";

    await supabase
      .from("research_runs")
      .update({
        status: "ready",
        status_message: statusMessage,
        findings,
        model,
        prompt_version: PROMPT_VERSION,
        extraction_schema_version: EXTRACTION_SCHEMA_VERSION,
        // Proposed, never written back to the prospect automatically: an
        // AI-derived identity landing straight in the CRM would be AI output
        // in a non-review state (hard rule 3). The admin UI offers a
        // one-click save, and once saved it drives every later run.
        confirmed_ein: confirmedEin,
        entity_resolution_method: entityResolutionMethod,
        entity_classification_version: ENTITY_CLASSIFICATION_VERSION,
        // Recorded because cost, latency and coverage are only interpretable
        // alongside the depth that produced them.
        depth,
        searches_used: searchesUsed,
        fetch_attempts: fetchAttempts,
        fetch_failures: fetchFailures,
        official_site_fetched: officialSiteFetched,
        filing_fetched: filingFetched,
        captured_chars: capturedChars,
        // Only a foundational blocker, or ready for a human to judge.
        completion_state: depth === "dossier" ? assessDossierState({ dossierConfirmed: isConfirmedDossier({ entity_resolution_method: entityResolutionMethod }) }) : null,
        // What a fundraiser needs to know is present, judged on what was
        // obtained rather than which pages were opened.
        missing_information: depth === "dossier" ? missingInformationSections(claims.map((c) => ({ claim_key: c.claim_key, evidence_missing: c.evidence_missing }))) : null,
        missing_source_classes: depth === "dossier" ? retrievalDiagnostics : null,
        // Backend state, not a convention: when identity was refused, several
        // competing organizations sit at the same trust level and only the
        // model's reading separates them. Such a run stays as candidate
        // intelligence but must not advance into Strategy/Outreach until a
        // human confirms the entity.
        dossier_confirmed: isConfirmedDossier({ entity_resolution_method: entityResolutionMethod }),
        code_version: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: costUsd,
        latency_ms: Date.now() - startedAt,
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);
  } catch (err) {
    await supabase
      .from("research_runs")
      .update({
        status: "error",
        status_message: "Research failed",
        error_code: err instanceof ResearchError ? err.code : "unknown_error",
        error_message: err instanceof Error ? err.message : "Something went wrong during research",
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);
  }
}

// Stage 5: verify that material claims say what their evidence says.
//
// A separate action rather than part of runResearch, for three reasons: a
// research run already sits close to its function-duration ceiling, the cost
// of verification should be visible on its own rather than folded into a
// run's figure, and a claim set may need re-verifying (a new model, a revised
// prompt) without re-researching.
//
// Only runs on a confirmed dossier. Verifying claims about an entity we could
// not identify would be checking whether the wording matches evidence that
// may describe the wrong organization -- a precise answer to the wrong
// question, and the more dangerous for looking rigorous.
export async function verifyRunClaims(runId: string) {
  await requireSuperadmin();
  const supabase = createClient();

  const { data: run } = await supabase
    .from("research_runs")
    .select("id, prospect_id, status, dossier_confirmed, prospects(name)")
    .eq("id", runId)
    .single();
  if (!run) throw new ResearchError("run_not_found", "Research run not found");
  if (run.status !== "ready") throw new ResearchError("run_not_ready", "Only a completed run can be verified");
  if (!run.dossier_confirmed) {
    throw new ResearchError(
      "identity_unresolved",
      "This run's entity was never confirmed, so its claims cannot be meaningfully verified. Confirm the EIN and re-run first."
    );
  }
  const prospect = run.prospects as unknown as { name: string };

  const { data: claims } = await supabase
    .from("research_claims")
    .select("id, claim_key, claim, reporting_period")
    .eq("research_run_id", runId);

  const material = (claims ?? []).filter((c) => isMaterialClaimKey(c.claim_key));
  if (material.length === 0) return { verified: 0, verdicts: {} as Record<string, number> };

  // Each claim's own cited evidence, and nothing else -- this is what the
  // verifier is given.
  const { data: links } = await supabase
    .from("research_claim_sources")
    .select("claim_id, cited_text")
    .in(
      "claim_id",
      material.map((c) => c.id)
    );
  const evidenceByClaim = new Map<string, string[]>();
  for (const l of links ?? []) {
    if (!l.cited_text) continue;
    evidenceByClaim.set(l.claim_id as string, [...(evidenceByClaim.get(l.claim_id as string) ?? []), l.cited_text as string]);
  }

  const result = await verifyResearchClaims({
    prospectName: prospect.name,
    claims: material.map((c) => ({
      claimId: c.id as string,
      claimKey: c.claim_key as string,
      claim: c.claim as string,
      reportingPeriod: (c.reporting_period as string | null) ?? null,
      evidence: evidenceByClaim.get(c.id as string) ?? [],
    })),
  }).catch((err) => {
    throw new ResearchError("verification_failed", err instanceof Error ? err.message : "Verification call failed");
  });

  if (result.verdicts.length > 0) {
    const { error } = await supabase.from("research_claim_verifications").insert(
      result.verdicts.map((v) => ({
        research_run_id: runId,
        claim_id: v.claimId,
        verdict: v.verdict,
        period_verdict: v.periodVerdict,
        reason: v.reason || null,
        model: result.model,
        evidence_count: v.evidenceCount,
      }))
    );
    if (error) throw new ResearchError("verification_insert_failed", error.message);
  }

  const counts: Record<string, number> = {};
  for (const v of result.verdicts) counts[v.verdict] = (counts[v.verdict] ?? 0) + 1;
  return { verified: result.verdicts.length, verdicts: counts };
}
