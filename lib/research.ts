import type { SupabaseClient } from "@supabase/supabase-js";

export const RESEARCH_RUN_STATUSES = ["researching", "extracting", "ready", "error"] as const;
export type ResearchRunStatus = (typeof RESEARCH_RUN_STATUSES)[number];

export type ResearchClaimType = "fact" | "hypothesis";
export type ResearchConfidence = "high" | "medium" | "low";
export type ResearchVerificationStatus = "unverified" | "human_confirmed" | "human_disputed";

// The controlled vocabulary for research_claims.claim_key /
// research_expected_facts.claim_key -- this is the actual comparison key
// the evaluation protocol joins on (category is free-text grouping/display
// only, never a join key). Enforced at the strongest available layer: the
// extraction tool's own input schema (see lib/ai/research-extract.ts)
// declares claim_key as an enum built from this exact list, so the model
// structurally cannot emit a key outside it -- not just a shared-constant
// convention that could silently drift between the extraction prompt and
// wherever expected facts get hand-authored.
//
// Atomicity rule (v2, revised after the first real run bundled unrelated
// facts under one key): one key = one independently confirmable/disputable
// fact. If reviewing a claim would require checking more than one distinct
// piece of source evidence, split it into more keys. `application.process`
// and `funding.typical_grant_size` were removed for exactly this reason --
// each used to bundle several unrelated facts (invitation status,
// submission method, required documents, multi-year rules, and a phone
// number all lived under `application.process` alone). Old claim rows
// keep whatever claim_key they were written with (it's `text`, not a DB
// enum) and just fall back to category "Other" in the lookup below --
// no migration needed when this list changes.
export const RESEARCH_CLAIM_KEYS = [
  { key: "identity.legal_name", category: "Identity", label: "Legal name", description: "The funder's full legal/incorporated name, if it differs from the common name it's known by, e.g. 'The Maclellan Foundation, Inc.'" },
  { key: "identity.location", category: "Identity", label: "Location", description: "City/state/country the funder is based in" },
  { key: "identity.ein", category: "Identity", label: "EIN", description: "The funder's IRS Employer Identification Number, if determinable" },
  { key: "identity.website", category: "Identity", label: "Website", description: "The funder's official website" },
  { key: "identity.phone", category: "Identity", label: "Phone", description: "A publicly listed phone number for the funder or its grants office" },
  { key: "funding.funder_type", category: "Funding profile", label: "Funder type", description: "e.g. private foundation, corporate giving program, family foundation, denominational fund, individual/DAF" },
  { key: "funding.geographic_focus", category: "Funding profile", label: "Geographic focus", description: "Where this funder's grants have HISTORICALLY gone, as a description of past behaviour, e.g. 'primarily Tennessee, Georgia, and Florida' -- use geographic_restriction instead if the source states a rule about where it WILL fund. Not whether it also funds internationally (see international_reach)" },
  // Split from geographic_focus deliberately. "Grants only to organizations
  // in the Southeast" and "most grants have gone to the Southeast" read
  // almost identically and mean entirely different things: one disqualifies
  // us, the other colours the pitch. The distinction is visible at
  // extraction, where a model is looking at the sentence, and invisible
  // downstream -- so it is recorded as two keys rather than left for a
  // consumer to infer from wording.
  { key: "funding.geographic_restriction", category: "Funding profile", label: "Geographic eligibility restriction", description: "A stated RULE limiting where a grantee may be based or where funded work may happen, e.g. 'grants are made only to organizations located in Georgia' or 'does not fund outside the United States'. Only use when the source states a limit, not merely a pattern of past giving" },
  { key: "funding.international_reach", category: "Funding profile", label: "International reach", description: "Whether/how this funder gives outside its home country -- a distinct fact from its domestic geographic priority" },
  { key: "funding.grant_count_annual", category: "Funding profile", label: "Annual grant count", description: "Number of grants awarded in a specific, named reporting period, e.g. '160 grants in Tax Year 2024'" },
  { key: "funding.total_annual_giving", category: "Funding profile", label: "Total annual giving (sum of listed grants)", description: "Total dollar amount of grants awarded/listed in a specific, named reporting period -- this is a sum of individual grants, NOT the same figure as charitable_disbursements (a filing-level total that can legitimately differ); never conflate the two into one generic figure" },
  { key: "funding.charitable_disbursements", category: "Funding profile", label: "Charitable disbursements", description: "The filing-level total charitable disbursements figure (e.g. from a 990-PF), for a specific named reporting period -- keep distinct from total_annual_giving (sum of listed grants); these can be different numbers reflecting different accounting categories" },
  { key: "funding.total_assets", category: "Funding profile", label: "Total assets", description: "Total assets reported for a specific, named reporting period -- if multiple sources disagree, submit one claim per source's figure (each low confidence, reason 'conflicting sources') rather than picking one" },
  { key: "funding.total_revenue", category: "Funding profile", label: "Total revenue", description: "Total revenue reported for a specific, named reporting period" },
  { key: "funding.total_expenses", category: "Funding profile", label: "Total expenses", description: "Total expenses reported for a specific, named reporting period" },
  { key: "funding.median_grant_size", category: "Funding profile", label: "Median grant size", description: "The median individual grant/gift amount, with its reporting period if stated" },
  { key: "funding.grant_size_range", category: "Funding profile", label: "Grant size range", description: "The smallest-to-largest individual grant/gift amount publicly documented" },
  { key: "funding.multiyear_grant_stats", category: "Funding profile", label: "Multi-year grant stats", description: "Any grant statistic (count, total, median) that spans multiple years rather than one reporting period -- keep separate from single-period stats above" },
  { key: "funding.focus_areas", category: "Funding profile", label: "Focus areas", description: "One cause or program area this funder supports -- submit ONE claim per distinct focus area, not a combined list; multiple claims may share this same key within one run" },
  { key: "funding.recent_grants", category: "Funding profile", label: "Recent grants", description: "One specific recent grant (recipient, amount, purpose, and year if known) -- submit ONE claim per individual grant, not a combined list; multiple claims may share this same key within one run" },
  { key: "application.accepts_unsolicited", category: "Application", label: "Accepts unsolicited applications", description: "Whether the funder accepts cold/unsolicited applications, or is invitation-only/referral-only" },
  { key: "application.invitation_mechanism", category: "Application", label: "Invitation mechanism", description: "For invitation-only funders: the specific mechanism by which an invited application actually begins, e.g. 'a direct application link sent by email' -- distinct from accepts_unsolicited (whether cold outreach works at all) and submission_method (how to submit once you have access)" },
  { key: "application.submission_method", category: "Application", label: "Submission method", description: "How to submit an application once eligible/invited -- online portal, LOI, mail, etc." },
  { key: "application.required_documents", category: "Application", label: "Required documents", description: "One specific document/material required with an application, e.g. 'a project budget using the funder's template' -- submit ONE claim per distinct required item, not a combined list; note if a requirement is specific to one related entity and shouldn't be generalized" },
  { key: "application.multiyear_grant_rules", category: "Application", label: "Multi-year grant rules", description: "Any distinct process or eligibility rule that applies specifically to multi-year grants" },
  { key: "application.deadline", category: "Application", label: "Deadlines / windows", description: "Application windows or key dates, if publicly known" },
  { key: "application.decision_timeframe", category: "Application", label: "Decision timeframe", description: "How long after submission a decision is typically made, e.g. 'approximately two months for complete proposals' -- distinct from application.deadline (when to apply, not how long the decision takes)" },
  { key: "application.eligible_org_types", category: "Application", label: "Eligible organization types", description: "What kind of organization/tax status is eligible, e.g. '501(c)(3) public charity, 509(a)(1) or 509(a)(2)'" },
  { key: "application.foreign_org_eligibility", category: "Application", label: "Foreign organization eligibility", description: "Specific rules for non-U.S. organizations, e.g. an equivalency-determination certificate requirement" },
  { key: "application.fiscal_sponsorship_rules", category: "Application", label: "Fiscal sponsorship rules", description: "Specific rules for organizations applying through a fiscal sponsor, e.g. who must submit the request" },
  { key: "application.mission_alignment_requirement", category: "Application", label: "Mission alignment requirement", description: "Any required alignment with the funder's own mission/values (e.g. an explicitly Christian mission requirement) -- distinct from org-type eligibility" },
  { key: "application.excluded_recipients", category: "Application", label: "Excluded/ineligible recipients", description: "One specific category of recipient or organization type explicitly excluded/ineligible, e.g. 'private foundations', 'for-profit organizations', 'individuals' -- submit ONE claim per excluded category, not a combined list" },
  { key: "application.prohibited_activities", category: "Application", label: "Prohibited activities", description: "One specific activity a grant cannot be used for, e.g. 'lobbying', 'political intervention', 'voter registration' -- submit ONE claim per distinct prohibited activity, not a combined list; distinct from excluded_recipients (who can't apply, not what a grant can't fund)" },
  { key: "people.key_contacts", category: "People", label: "Key contacts", description: "One named person and their role, e.g. 'Jane Doe, Executive Director' -- submit ONE claim per person, not a combined list; multiple claims may share this same key within one run" },
] as const;

export type ResearchClaimKey = (typeof RESEARCH_CLAIM_KEYS)[number]["key"];

export type ResearchRun = {
  id: string;
  prospect_id: string;
  version: number;
  retry_of: string | null;
  status: ResearchRunStatus;
  status_message: string | null;
  findings: string | null;
  model: string | null;
  prompt_version: string | null;
  extraction_schema_version: string | null;
  code_version: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_by: string;
  created_at: string;
};

export type ResearchClaim = {
  id: string;
  research_run_id: string;
  prospect_id: string;
  claim_type: ResearchClaimType;
  claim_key: string;
  category: string;
  claim: string;
  source_url: string | null;
  source_excerpt: string | null;
  retrieved_at: string;
  confidence: ResearchConfidence;
  confidence_reason: string | null;
  reporting_period: string | null;
  verification_status: ResearchVerificationStatus;
  verified_by: string | null;
  verified_at: string | null;
  recheck_at: string | null;
  created_at: string;
};

export type ResearchSourceType = "official_website" | "irs_filing" | "annual_report" | "secondary_source" | "other";

// Evidence-first redesign: a trust CLASSIFICATION per source, not a
// pass/fail filter -- most legitimate corroborating sources never state an
// EIN, and a source stating a *different* EIN isn't automatically wrong
// (an affiliated sibling foundation, a fiscal sponsor, a grantee are all
// real, relevant, differently-EIN'd entities). Only entity_mismatch and
// unrelated_excluded withhold a source's evidence from extraction; the
// other five stay usable, labeled with their trust level. Text, not an
// enum -- this vocabulary, like citation_consistency's, is still being
// worked out. See docs/decisions/0002-research-agent.md.
export const RESEARCH_ENTITY_VALIDATION_STATUSES = [
  "ein_confirmed",
  "official_domain_confirmed",
  "legal_name_confirmed",
  // A source whose EIN differs from the confirmed entity's. We know it is a
  // DIFFERENT legal entity; we have not established any relationship to the
  // prospect. The old name for this ("affiliate_related_entity") asserted an
  // affiliation that was never shown -- a family foundation's sibling and an
  // unrelated organization that happens to share a name are indistinguishable
  // on the evidence we hold. Its evidence is withheld from extraction by
  // code, not by asking the model to treat it "as context only".
  "different_entity_unverified_relation",
  // Retained so historical rows (classifier version 1) stay readable. Never
  // emitted by current logic -- see ENTITY_CLASSIFICATION_VERSION.
  "affiliate_related_entity",
  "identity_unresolved",
  "entity_mismatch",
  "unrelated_excluded",
] as const;
export type ResearchEntityValidationStatus = (typeof RESEARCH_ENTITY_VALIDATION_STATUSES)[number];

const GENERIC_NAME_SUFFIXES = /\b(foundation|fund|trust|inc\.?|incorporated|family|charitable|charity|ministries|ministry|organization|corp\.?|llc)\b/gi;
const EIN_PATTERN = /\b\d{2}-\d{7}\b/g;

// The distinctive core of a funder's name, used as a substring check
// against a candidate source -- e.g. "Maclellan Foundation" -> "Maclellan".
// Deliberately a substring check, not fuzzy/edit-distance similarity: a
// fuzzy score would likely rate "McClellan" close enough to "Maclellan" to
// pass, which is exactly the false-negative that let a real, unrelated
// organization (marymcclellanfoundation.org) sit unflagged in a real run.
export function deriveEntityNameToken(name: string): string {
  const stripped = name.replace(GENERIC_NAME_SUFFIXES, "").replace(/[^a-zA-Z0-9\s]/g, "").trim();
  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length === 0) return name.trim();
  return words.reduce((longest, w) => (w.length > longest.length ? w : longest), words[0]);
}

export function extractEinCandidates(text: string): string[] {
  return text.match(EIN_PATTERN) ?? [];
}

// URLs routinely encode an EIN with no dash (ProPublica's
// .../organizations/626041468, CauseIQ's ...,582218044/), which the dashed
// EIN_PATTERN can't see. Scanning URLs specifically -- not free text --
// keeps this reasonably safe: a bare 9-digit run in a URL path is very
// often an EIN, whereas free text is full of unrelated 9-digit numbers.
export function extractEinCandidatesFromUrl(url: string): string[] {
  const dashed = url.match(EIN_PATTERN) ?? [];
  const undashed = (url.match(/(?<!\d)\d{9}(?!\d)/g) ?? []).map((d) => `${d.slice(0, 2)}-${d.slice(2)}`);
  return [...dashed, ...undashed];
}

// Whether a source plausibly refers to the prospect at all, by the
// distinctive core token of its name. Shared by the EIN vote below and by
// classifySourceEntity, so both agree on what "this source is about the
// right organization" means.
// How far a source's own organization name sits from the prospect's, in
// extra words. Used ONLY to order candidates for human review -- never to
// confirm identity, which it proved unfit for (see resolveRunEntity). "Maclellan Foundation" vs "The Maclellan Foundation Inc" is
// close (1-2 filler words); vs "Robert L And Kathrina H Maclellan
// Foundation" is far (5 extra words naming different people).
//
// This is what separates the entity being researched from its affiliates
// when BOTH legitimately carry the family name and BOTH appear in IRS
// filings -- the case that made a straight "any matching filing may vote"
// rule unable to ever resolve a family-foundation cluster. Returns null
// when the source states no usable name.
export function nameMatchDistance(prospectName: string, sourceTitle: string | null): number | null {
  if (!sourceTitle) return null;
  // Aggregators append their own branding ("... - Nonprofit Explorer -
  // ProPublica", "... | Cause IQ"); the organization's name is the first
  // segment. Cutting there keeps site names out of the distance.
  const orgSegment = sourceTitle.split(/\s+[-|—·]\s+/)[0];
  const tokenize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  const prospectTokens = new Set(tokenize(prospectName));
  const sourceTokens = tokenize(orgSegment);
  if (sourceTokens.length === 0) return null;
  return sourceTokens.filter((t) => !prospectTokens.has(t)).length;
}

export function sourceMatchesName(sourceUrl: string, sourceTexts: string[], nameToken: string): boolean {
  if (nameToken.length === 0) return false;
  const token = nameToken.toLowerCase();
  return sourceTexts.join(" ").toLowerCase().includes(token) || sourceUrl.toLowerCase().includes(token);
}

// How identity was established for a run. Recorded on research_runs so the
// decision is auditable rather than implicit -- "which entity did we
// research, and what settled it". Text validated here, not a Postgres enum,
// same reasoning as the status vocabularies above.
export const RESEARCH_ENTITY_RESOLUTION_METHODS = [
  "stored_ein",
  "authoritative_filing",
  "official_domain",
  "ambiguous_filings",
  "unresolved",
] as const;
export type ResearchEntityResolutionMethod = (typeof RESEARCH_ENTITY_RESOLUTION_METHODS)[number];

// Bumped whenever the classification rules change meaning, and recorded on
// every run. Historical rows are NOT rewritten -- a stored verdict is a
// record of what that version of the logic actually decided, and rewriting
// it would destroy the audit trail the evidence ledger exists to provide.
// Readers use entityStatusMeaning() to render an old value in current terms.
export const ENTITY_CLASSIFICATION_VERSION = 2;

// How much retrieval a run is allowed to spend.
//
//   identity a preflight pass: two searches, no fetching, and only the four
//            identity keys. Its job is to establish WHICH organization this
//            is -- or to enumerate the candidates when it cannot -- before
//            any expensive retrieval is spent on the wrong one. 45% of
//            Stage-1-era spend went on runs that resolved no identity and so
//            produced no usable dossier; this exists to stop paying full
//            price to discover that.
//   screen   search only, no page fetching. Enough for identity, focus
//            areas, geography and funder type -- what triage actually needs.
//            Measured at roughly $0.10-0.15 per organization.
//   dossier  search plus fetching and reading filings and the funder's own
//            guidelines in full. The only way to get dated financial figures
//            and application rules. Roughly $0.65-0.78 and 3-4 minutes.
//
// Null on pre-Stage-1 rows, which were all full-depth by definition.
export const RESEARCH_DEPTHS = ["identity", "screen", "dossier"] as const;
export type ResearchDepth = (typeof RESEARCH_DEPTHS)[number];

// Depth follows pipeline stage, because the product already places the
// commitment decision there: accepting a candidate out of Discovery is
// "a commitment to do the work of pursuing it" (see CLAUDE.md). Spending
// dossier-level money before that point means paying full price for every
// candidate that surfaces, most of which are never pursued.
// What a person decided about a claim they were shown.
//
// approved_with_note is the important one: a reviewer accepting a claim the
// evidence does not support is overriding the system on their own knowledge,
// which is legitimate and must be recorded with a reason -- otherwise the
// override outlives the reasoning and nobody later can tell whether it was
// judgement or haste.
export const RESEARCH_APPROVAL_DECISIONS = ["approved", "approved_with_note", "corrected", "excluded", "research_requested"] as const;
export type ResearchApprovalDecision = (typeof RESEARCH_APPROVAL_DECISIONS)[number];

// Decisions that let a claim reach an automated consumer.
export const APPROVED_FOR_DOWNSTREAM = new Set<ResearchApprovalDecision>(["approved", "approved_with_note", "corrected"]);

// Stage 5 lifecycle for a run. A verification failure must leave the
// research intact and retryable -- losing a dossier because a check failed
// would be worse than not checking it.
export const RESEARCH_VERIFICATION_STATES = ["pending", "in_progress", "complete", "failed", "skipped"] as const;
export type ResearchVerificationState = (typeof RESEARCH_VERIFICATION_STATES)[number];

// What a fundraiser needs to know is present, judged on what the run
// OBTAINED rather than on which pages it opened. Reading a page proves
// nothing about whether the wanted information came back.
export const RESEARCH_INFORMATION_SECTIONS = [
  { section: "identity", label: "Identity", keys: ["identity.legal_name", "identity.ein", "identity.location"] },
  { section: "funding_priorities", label: "Funding priorities", keys: ["funding.focus_areas", "funding.geographic_focus", "funding.international_reach", "funding.funder_type"] },
  { section: "financial_capacity", label: "Financial capacity", keys: ["funding.total_assets", "funding.total_annual_giving", "funding.charitable_disbursements", "funding.grant_size_range", "funding.median_grant_size", "funding.grant_count_annual"] },
  { section: "recent_grants", label: "Recent grants", keys: ["funding.recent_grants"] },
  { section: "eligibility", label: "Eligibility", keys: ["application.eligible_org_types", "application.foreign_org_eligibility", "application.fiscal_sponsorship_rules", "application.mission_alignment_requirement", "application.excluded_recipients", "application.prohibited_activities", "funding.geographic_restriction"] },
  { section: "application_access", label: "Application access", keys: ["application.accepts_unsolicited", "application.invitation_mechanism", "application.submission_method", "application.deadline"] },
  { section: "leadership", label: "Leadership", keys: ["people.key_contacts"] },
] as const;

export type ResearchInformationSection = (typeof RESEARCH_INFORMATION_SECTIONS)[number]["section"];

// Sections this run obtained nothing for. A claim counts only if it carries
// evidence: an uncited finding is visible to a human but cannot make a
// section count as covered.
export function missingInformationSections(claims: { claim_key: string; evidence_missing?: boolean | null }[]): string[] {
  const have = new Set(claims.filter((c) => !c.evidence_missing).map((c) => c.claim_key));
  return RESEARCH_INFORMATION_SECTIONS.filter((s) => !s.keys.some((k) => have.has(k))).map((s) => s.section);
}

// Source classes a private-foundation dossier is expected to have read.
// Each is required only when it actually exists for that funder -- a prospect
// with no website cannot be marked incomplete for failing to read one.
export const RESEARCH_SOURCE_CLASSES = ["authoritative_filing", "grant_schedule", "official_site"] as const;
export type ResearchSourceClass = (typeof RESEARCH_SOURCE_CLASSES)[number];

// Only states with a genuine enforcement purpose survive.
//
//   blocked           identity unresolved -- nothing here can be trusted to
//                     describe the intended organization, so nothing may be
//                     used downstream
//   ready_for_review  research finished; a human sees section-level coverage
//                     and gaps and decides what is usable
//
// "complete" was removed deliberately. It claimed a universal sufficiency
// that no single flag can carry, and it hid real gaps: three runs carried it
// while holding no grant information whatsoever.
export const RESEARCH_COMPLETION_STATES = ["blocked", "ready_for_review"] as const;
export type ResearchCompletionState = (typeof RESEARCH_COMPLETION_STATES)[number];

// A filing's own detail page -- where the grant schedule lives. ProPublica
// exposes it as .../organizations/<ein>/<filingId>/full; the summary page for
// the same organization carries totals but never the recipient list.
export function isGrantSchedulePage(url: string): boolean {
  return /propublica\.org\/nonprofits\/organizations\/\d+\/\d+\/full/i.test(url);
}

// Judges what a dossier actually took FROM its sources, not how much it
// produced and not merely what it opened.
//
// Two distinctions, both learned from real runs. A class counts as MISSING
// only when it was available and not read -- a funder with no website is not
// incomplete for lacking one. And "read" means the page CONTRIBUTED CAPTURED
// EVIDENCE, not that the fetch returned 200: one run fetched the grant
// schedule successfully, cited nothing from it, produced zero named grants,
// and was still marked complete. A page opened and taken nothing from is not
// a source the dossier read.
// Identity is the only foundational condition that can prevent use: research
// about an organization we could not identify is not a partial dossier, it is
// an unusable one. Everything else is a gap for a human to weigh, not a
// blocker -- which is why section coverage is reported rather than scored.
export function assessDossierState({ dossierConfirmed }: { dossierConfirmed: boolean }): ResearchCompletionState {
  return dossierConfirmed ? "ready_for_review" : "blocked";
}

// What a screen-depth run is asked to extract.
//
// An earlier version of this list held 9 identity/fit keys, justified by the
// claim that a page-blind run "cannot answer" financial or application keys.
// A real run disproved that: screen depth asked the full vocabulary found 26
// keys, including dated, correct financial figures pulled from search
// snippets (total revenue $13.8M Tax Year 2024, 161 grants Tax Year 2024) --
// and it correctly reported a conflicting assets figure as two separate
// claims rather than blending them.
//
// So the real question is not what screen CAN answer, it is what triage
// NEEDS in order to decide "is this funder worth pursuing". That needs
// capacity as well as fit: a perfectly aligned funder whose grants top out
// at $5k is not worth pursuing for a $50k ask, and you cannot see that from
// focus areas alone. Hence identity, fit, capacity, and who to talk to.
//
// Still excluded, and left to dossier depth: accounting detail (revenue,
// expenses, charitable disbursements, multi-year aggregates) and the
// application.* mechanics beyond whether you can apply at all. Those matter
// when writing the ask, not when deciding whether to pursue -- and they live
// on guidelines pages that screen depth genuinely cannot fetch.
// Stage 5 verdicts: does the claim's WORDING follow from the evidence it
// cites? Deliberately distinct from the entity and evidence guarantees --
// "the evidence is real and describes the right organization" and "the claim
// says what the evidence says" are different questions, and conflating them
// is what made earlier verification work unreliable.
export const RESEARCH_VERIFICATION_VERDICTS = [
  "supported",
  // The evidence backs part of it -- the claim generalises, adds a qualifier
  // the evidence does not carry, or states as policy what the evidence shows
  // as a single instance. The most common real failure, and invisible unless
  // it has its own verdict.
  "partially_supported",
  "unsupported",
  "contradicted",
] as const;
export type ResearchVerificationVerdict = (typeof RESEARCH_VERIFICATION_VERDICTS)[number];

// Whether a financial claim's reporting period is actually established by
// its evidence, judged separately from whether the AMOUNT is.
//
//   stated          the evidence names the period for this figure
//   unverified      the figure is there but its period is inferred -- from a
//                   nearby heading, table position or page order -- rather
//                   than stated. The amount may still be sound.
//   not_applicable  the claim is not a time-varying figure
//
// Separate because a claim whose amount is supported and whose year is
// guessed is not the same as one that is simply wrong, and treating them
// alike either discards a good figure or publishes a bad date.
export const RESEARCH_PERIOD_VERDICTS = ["stated", "unverified", "not_applicable"] as const;
export type ResearchPeriodVerdict = (typeof RESEARCH_PERIOD_VERDICTS)[number];

// How each field may be used by a given consumer. Three states, chosen
// because each is something code can act on:
//
//   required  must be approved and supported, or it is withheld
//   advisory  may be used, labelled, and never presented as verified
//   unused    excluded from this consumer entirely
//
// Materiality is a property of a claim FOR A USE, not of the claim alone.
// The same key is graded differently by different consumers: key contacts
// are context when planning an approach and material when addressing an
// email. The previous single MATERIAL_CLAIM_KEYS set collapsed those into
// one answer and so had to be wrong for at least one of them.
//
// Identity is deliberately not in here. It gates the RUN -- if we cannot say
// which organization this is, no consumer gets anything, however well
// evidenced the individual claims are. Grading it per-consumer would imply
// a strategy could proceed on unidentified research.
export const STRATEGY_FIELD_POLICIES = ["required", "advisory", "unused"] as const;
export type StrategyFieldPolicy = (typeof STRATEGY_FIELD_POLICIES)[number];

export const IDENTITY_GATE_KEYS = new Set<string>([
  "identity.legal_name",
  "identity.ein",
  "identity.location",
  "identity.website",
]);

// Identity is two questions, not one, and they resolve on different evidence.
//
//   operating -- WHICH ORGANIZATION is this, in practice? Settled by an
//                official page that names the opportunity, or by a scored
//                match over everything already known about the prospect.
//   legal     -- WHICH LEGAL ENTITY is it, by EIN? Settled only by
//                deterministic evidence tying that organization to a filing.
//
// Collapsing them is what produced a three-way choice between organizations
// where one was plainly right: the resolver could not say "I know who this is
// but not their EIN", so it said nothing at all and asked the user to pick.
// Splitting them lets research proceed on a known organization while the
// claims that genuinely depend on a legal entity stay withheld.
export const IDENTITY_LAYERS = ["operating", "legal"] as const;
export type IdentityLayer = (typeof IDENTITY_LAYERS)[number];

// How the operating organization was established. Text, not a Postgres enum --
// this vocabulary is new and expected to move.
export const OPERATING_IDENTITY_METHODS = [
  // The opportunity page on the organization's own domain. Deterministic --
  // the funder is describing its own programme, so nothing is inferred.
  "official_opportunity_page",
  // Won on score, by a required margin, over every other candidate.
  "scored_match",
  "user_selected",
  "unresolved",
] as const;
export type OperatingIdentityMethod = (typeof OPERATING_IDENTITY_METHODS)[number];

// Claims that are meaningless -- or actively misleading -- attached to the
// wrong legal entity, and so stay withheld while only the operating identity
// is known.
//
// The test is not "is this a number". It is "does this fact belong to an EIN".
// A programme's deadline or geographic restriction is published by the
// operating organization and is safe without a filing. Assets, giving figures
// and the legal name are read OFF a filing, and attaching those to an
// unconfirmed entity is exactly how a figure ends up describing a different
// organization that merely shares a word with this one.
export const LEGAL_ENTITY_DEPENDENT_KEYS = new Set<string>([
  "identity.ein",
  "identity.legal_name",
  "funding.total_assets",
  "funding.total_annual_giving",
  "funding.charitable_disbursements",
  "funding.median_grant_size",
  "funding.grant_size_range",
  "funding.grant_count_annual",
  "funding.total_revenue",
  "funding.total_expenses",
  "funding.multiyear_grant_stats",
  "funding.recent_grants",
  // 990-PF versus public charity is a filing classification, not an
  // observation about how the funder behaves.
  "funding.funder_type",
]);

export function claimRequiresLegalEntity(claimKey: string): boolean {
  return LEGAL_ENTITY_DEPENDENT_KEYS.has(claimKey);
}

// Strategy is currently the only implemented consumer, so this is the only
// policy map. Ask-sizing and outreach get their own when they become real
// consumers -- the notes below mark where they are already known to differ,
// so the split is visible before it is built.
export const STRATEGY_FIELD_POLICY: Record<string, StrategyFieldPolicy> = {
  // Eligibility -- whether we can apply at all
  "application.eligible_org_types": "required",
  "application.foreign_org_eligibility": "required",
  "application.fiscal_sponsorship_rules": "required",
  "application.mission_alignment_requirement": "required",
  // Restrictions -- what would disqualify us
  "application.excluded_recipients": "required",
  "application.prohibited_activities": "required",
  "funding.geographic_restriction": "required",
  // Access -- whether and how an approach is even possible
  "application.accepts_unsolicited": "required",
  "application.invitation_mechanism": "required",
  "application.deadline": "required",
  // Capacity -- whether an ask of our size is plausible
  "funding.total_assets": "required",
  "funding.total_annual_giving": "required",
  "funding.charitable_disbursements": "required",
  "funding.median_grant_size": "required",
  "funding.grant_size_range": "required",
  // Channel -- wrong here means the whole approach is wrong, not just weaker
  "funding.funder_type": "required",
  "funding.international_reach": "required",

  // Advisory -- shapes framing, cannot disqualify or mis-size an ask
  "funding.focus_areas": "advisory",
  "funding.geographic_focus": "advisory",
  "funding.recent_grants": "advisory", // required for outreach: naming a real past grant
  "funding.grant_count_annual": "advisory",
  "funding.total_revenue": "advisory",
  "funding.total_expenses": "advisory",
  "funding.multiyear_grant_stats": "advisory",
  "application.submission_method": "advisory", // required at proposal stage
  "application.required_documents": "advisory",
  "application.multiyear_grant_rules": "advisory",
  "application.decision_timeframe": "advisory",
  "people.key_contacts": "advisory", // required for outreach: addressing a person

  // Unused -- contact data with no bearing on approach or sizing
  "identity.phone": "unused",
};

// Identity keys answer "identity_gate" rather than a policy, because the
// question "how may Strategy use this" does not apply to them.
export function strategyFieldPolicy(claimKey: string): StrategyFieldPolicy | "identity_gate" {
  if (IDENTITY_GATE_KEYS.has(claimKey)) return "identity_gate";
  // An unmapped key is treated as advisory, never required: a claim key
  // added to the vocabulary without a policy must not silently acquire the
  // authority to size an ask. The test suite asserts the map is complete, so
  // this is a safety net rather than a normal path.
  return STRATEGY_FIELD_POLICY[claimKey] ?? "advisory";
}

// What Stage 5 checks: everything a consumer requires, plus identity.
// Derived rather than listed, so verification coverage cannot drift away
// from the policy that depends on it -- the previous hand-maintained set
// verified submission_method and recent_grants while never verifying
// funder_type, which no policy asked for either way.
export const MATERIAL_CLAIM_KEYS = new Set<string>([
  ...IDENTITY_GATE_KEYS,
  ...Object.entries(STRATEGY_FIELD_POLICY)
    .filter(([, policy]) => policy === "required")
    .map(([key]) => key),
]);

export function isMaterialClaimKey(claimKey: string): boolean {
  return MATERIAL_CLAIM_KEYS.has(claimKey);
}

// Numbers in a claim that ought to appear in the evidence backing it.
//
// Deliberately excludes bare years: 2023 turns up in almost any filing page,
// so matching on it would pass a claim whose actual figure is absent. What
// remains -- amounts, counts, medians -- is distinctive enough that its
// absence from every cited fragment means the claim is citing the wrong
// evidence.
export function distinctiveNumbers(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/\d[\d,.]*/g) ?? []) {
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 3) continue;
    const n = Number(digits);
    // A bare 4-digit year is not distinctive.
    if (digits.length === 4 && n >= 1900 && n <= 2099) continue;
    out.push(digits);
  }
  return out;
}

// Whether a claim's figures actually appear in the evidence it cites.
//
// This catches a failure the evidence-first design created rather than
// removed. Making evidence_ids REQUIRED eliminated unevidenced claims, but
// when no captured fragment supports a specific detail the model must still
// cite something -- so it attaches the nearest fragment instead. One real run
// produced ten named grants with amounts ("Grant to Mariners Church of
// $190,000 in fiscal year 2023") each citing a fragment containing the
// foundation's mission statement and no grant at all. Missing citations were
// traded for wrong ones, and every upstream guarantee still passed: the
// fragment was real, exactly captured, and from the confirmed entity.
//
// Digits are compared with separators stripped, so "$17,408,962" matches
// "17408962" in a filing table. A claim with no distinctive numbers is not
// judged here -- prose claims are Stage 5's job, not arithmetic's.
export function claimFiguresAppearInEvidence(claim: string, evidenceTexts: string[]): boolean {
  const wanted = distinctiveNumbers(claim);
  if (wanted.length === 0) return true;
  const haystack = evidenceTexts.join(" ").replace(/\D/g, "");
  return wanted.some((n) => haystack.includes(n));
}

// Claim keys whose value is meaningless without the period it covers. A
// funder's assets, giving and grant sizes all move year to year, so "total
// assets $167M" with no year attached cannot be checked, compared, or safely
// used in an ask -- it is worse than no figure at all, because it looks like
// knowledge.
export const FINANCIAL_CLAIM_KEYS = new Set<string>([
  "funding.grant_count_annual",
  "funding.total_annual_giving",
  "funding.charitable_disbursements",
  "funding.total_assets",
  "funding.total_revenue",
  "funding.total_expenses",
  "funding.median_grant_size",
  "funding.grant_size_range",
  "funding.multiyear_grant_stats",
]);

export function isFinancialClaimKey(claimKey: string): boolean {
  return FINANCIAL_CLAIM_KEYS.has(claimKey);
}

// Every financial key above promises a figure for ONE period, with the single
// deliberate exception of multiyear_grant_stats, which exists to span them.
const PERIOD_BOUND_CLAIM_KEYS = new Set<string>(
  [...FINANCIAL_CLAIM_KEYS].filter((k) => k !== "funding.multiyear_grant_stats")
);

// Phrases in which a claim states outright that its own figure aggregates
// several periods.
//
// Found on a real run: "Total grants paid across all years on record: 122
// grants totaling $3.4M (multi-year cumulative)" was filed under
// total_annual_giving, whose definition requires a specific named period.
// The wording was honest; the key was not. A reader gets it right, a
// consumer reading by key gets a figure roughly 2x the funder's actual
// annual giving.
//
// Deliberately narrow. "Multi-year", "lifetime" and "to date" are NOT here:
// "makes multi-year grants of $25K-$100K" under grant_size_range is a
// correct claim about grant terms, and "to date" usually means "as of now"
// on an assets figure. These phrases say the FIGURE spans periods, not that
// the funder's grants do -- precision over recall, since the undated rule
// below already catches the case where no period is claimed at all.
const CUMULATIVE_FIGURE_LANGUAGE = /\b(cumulative|across all years|all years on record|since inception|combined across|summed across)\b/i;

// True when a claim's own wording contradicts the period its key promises.
// Kept here beside the vocabulary it checks, so the rule and the key
// definitions cannot drift apart.
export function claimSpansMultiplePeriods(claimKey: string, claim: string): boolean {
  if (!PERIOD_BOUND_CLAIM_KEYS.has(claimKey)) return false;
  return CUMULATIVE_FIGURE_LANGUAGE.test(claim);
}

// Claims whose substance IS a figure, and where a number appearing nowhere in
// the cited evidence means the claim is attached to the wrong fragment.
//
// Narrower than "any claim containing a digit", on evidence: a focus-areas
// claim reading "(NTEE-designated 501(c)(3) private grantmaking foundation)"
// yielded "501" and was wrongly flagged, because its cited fragment quite
// reasonably contained no digits at all. Incidental numbers -- legal forms,
// NTEE codes, percentages, addresses -- are not what the claim asserts.
// Where a number is not the point, prose support is Stage 5's job.
const QUANTITATIVE_CLAIM_KEYS = new Set<string>([...FINANCIAL_CLAIM_KEYS, "funding.recent_grants"]);

export function isQuantitativeClaimKey(claimKey: string): boolean {
  return QUANTITATIVE_CLAIM_KEYS.has(claimKey);
}

// reporting_period is a REQUIRED field so that "no period" is a deliberate
// answer rather than a silent omission -- omission was indistinguishable
// from forgetting, and compliance measured 52-80% across repeated runs on
// identical evidence when the field was optional.
//
// Three answers are possible, and the distinction matters for audit:
//   "Tax Year 2024"   the evidence states the period
//   "unstated"        the fact DOES vary by period, but the evidence gives
//                     none. The figure is real and unusable as-is.
//   "not_time_bound"  the fact genuinely does not vary by time -- a legal
//                     name, a location, a focus area.
//
// A financial figure can never legitimately be not_time_bound: assets,
// giving and grant sizes all move year to year, so "no period applies" is
// never true of them, only "no period was stated". Collapsing the two would
// hide a real gap behind a label that reads as fine.
export const NO_REPORTING_PERIOD = "not_time_bound";
export const UNSTATED_REPORTING_PERIOD = "unstated";

// Whether a stored reporting_period actually pins the fact to a period.
export function hasStatedPeriod(reportingPeriod: string | null | undefined): boolean {
  return !!reportingPeriod && reportingPeriod !== NO_REPORTING_PERIOD && reportingPeriod !== UNSTATED_REPORTING_PERIOD;
}

// ---------------------------------------------------------------------------
// Candidate identity
//
// The disambiguation list was not a shortlist, it was a byproduct: every
// distinct EIN the run touched anywhere, unfiltered, labelled with a page
// title or -- when no title was captured -- a bare aggregator URL. On a
// generic name it produced twenty rows, most of them unchoosable, each
// claiming one source.
//
// That asks the person who does not know the organization to identify it by
// EIN, which is exactly the knowledge they came here lacking. A candidate is
// only worth offering if it can be RECOGNISED, so each one has to carry
// enough to recognise it: a real name, where it is, its website, what kind
// of body it is, and why we think it might be the one.

// Sites that aggregate filings. Their domains are never a funder's own, and
// their titles carry boilerplate that has to come off a name before it reads
// like an organization.
const AGGREGATOR_DOMAINS = [
  "propublica.org",
  "causeiq.com",
  "guidestar.org",
  "charitynavigator.org",
  "getholdings.com",
  "grantmakers.io",
  "candid.org",
  "irs.gov",
  "taxexemptworld.com",
  "nonprofitlight.com",
  "opencorporates.com",
];

// Free mailbox providers. A contact at one of these tells us about a person,
// not an organization.
const CONSUMER_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "comcast.net",
  "verizon.net",
  "att.net",
  "msn.com",
]);

// The organization's domain, inferred from a contact we already hold.
//
// Found on a real prospect: the page asked "which of these twenty
// organizations is this?" while the contact record read
// chris.romine@pcusa.org. The answer was already in the CRM. Asking a user
// for a website we could have derived is asking them to supply what we are
// sitting on -- and identity resolution treats a domain as its strongest
// signal, so this is not a hint, it is the resolution.
export function contactEmailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const domain = email.trim().toLowerCase().split("@")[1];
  if (!domain || !domain.includes(".")) return null;
  if (CONSUMER_EMAIL_DOMAINS.has(domain)) return null;
  return domain;
}

export function isAggregatorUrl(url: string): boolean {
  return AGGREGATOR_DOMAINS.some((d) => url.toLowerCase().includes(d));
}

// "Servants Heart Foundation Inc - Full Filing - Nonprofit Explorer -
// ProPublica" is a page title, not a name. Everything after the first
// separator is the publisher describing itself.
export function cleanEntityName(title: string | null | undefined): string | null {
  if (!title) return null;
  const head = title.split(/\s+[-|–—]\s+/)[0].trim();
  if (/^https?:/i.test(head)) return null;
  // Words, ignoring identifiers. "EIN 13-3462549" has a space and so passed a
  // two-word test, and was then shown to a user as the organization's name --
  // above a line repeating the same EIN. An identifier is not a name however
  // many spaces it contains.
  const words = head
    .split(/\s+/)
    .filter((w) => /[A-Za-z]{2}/.test(w))
    .filter((w) => !/^ein$/i.test(w));
  if (words.length < 2) return null;
  return head;
}

const US_STATES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC";

// "Newport Beach, CA" out of whatever prose the evidence happens to be.
const STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

// Postal code or spelled out -- a source writing "Louisville, Kentucky" was
// invisible to a pattern that only knew "KY", which is why the real
// candidates showed no location at all.
export function extractLocation(texts: string[]): string | null {
  const abbrev = new RegExp(`\\b([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,2}),\\s*(${US_STATES})\\b`);
  // No "i" flag: it would make [A-Z] match lowercase too, so the city group
  // swallowed the words before it -- "Offices in Louisville, Kentucky" gave
  // "Offices in Louisville". State names are matched as written instead.
  const titleCase = (n: string) => n.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const spelled = new RegExp(
    `\\b([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,2}),\\s*(${Object.keys(STATE_NAMES).map(titleCase).join("|")})\\b`
  );
  for (const t of texts) {
    const m = t.match(abbrev);
    if (m) return `${m[1]}, ${m[2]}`;
  }
  for (const t of texts) {
    const m = t.match(spelled);
    if (m) return `${m[1]}, ${STATE_NAMES[m[2].toLowerCase()]}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Identity scoring
//
// The resolver used to take ONE token from the prospect's name -- "Discipleship"
// out of "Discipleship Ministries - Racial Ethnic Local Church Grants (UMC)" --
// and ask each candidate whether its name contained it. Three unrelated
// organizations all said yes, so all three tied, and the tiebreak went to
// whichever aggregator happened to be scraped twice. The answer was sitting in
// the discarded part of the query: "UMC".
//
// Everything below scores candidates against everything already known, weights
// tokens by how much they actually discriminate, and abstains unless one
// candidate wins by a margin.
// ---------------------------------------------------------------------------

// Words that describe what KIND of thing an organization is. Nearly every
// funder in this domain is a Foundation, Ministry, Church or Fund, so these
// carry structure but almost no identity. Down-weighted rather than dropped:
// "Church" still distinguishes a church from a foundation when nothing else
// does.
const STRUCTURAL_TOKENS = new Set([
  "foundation", "foundations", "fund", "funds", "trust", "trusts", "inc", "incorporated", "llc", "corp",
  "ministry", "ministries", "church", "churches", "chapel", "mission", "missions", "society", "association",
  "grant", "grants", "program", "programs", "programme", "fdn", "org", "institute", "center", "centre",
  "national", "international", "global", "america", "american", "usa", "the", "and", "for", "of", "inc.",
]);

const STRUCTURAL_TOKEN_WEIGHT = 0.25;
const OPPORTUNITY_TOKEN_WEIGHT = 1.5;
const ACRONYM_WEIGHT = 2.5;

function normalizeForTokens(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export function identityTokens(value: string | null | undefined): string[] {
  return normalizeForTokens(value).split(" ").filter((t) => t.length >= 3);
}

// Uppercase runs are how organizations write their own initialisms -- "(UMC)",
// "AGWM". Captured from the ORIGINAL casing, which is why this cannot run off
// the normalized string.
export function acronymsIn(value: string | null | undefined): string[] {
  return [...((value ?? "").match(/\b[A-Z]{2,6}\b/g) ?? [])].map((a) => a.toLowerCase());
}

// Does this name contain a run of words whose initials spell the acronym?
// "Board of Discipleship of the United Methodist Church" yields UMC from
// "United Methodist Church".
//
// Deliberately general rather than a lookup table of known initialisms: a
// table would have to be maintained per denomination and would silently fail
// on the first funder nobody thought of.
export function nameYieldsAcronym(name: string | null | undefined, acronym: string): boolean {
  const words = normalizeForTokens(name).split(" ").filter(Boolean);
  const target = acronym.toLowerCase();
  if (target.length < 2 || words.length < target.length) return false;
  for (let i = 0; i + target.length <= words.length; i++) {
    let hit = true;
    for (let j = 0; j < target.length; j++) {
      if (words[i + j][0] !== target[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

// How much a token DISCRIMINATES, measured against the candidates actually in
// front of us rather than a hand-maintained stoplist.
//
// A token present in every candidate has, by definition, zero power to choose
// between them -- log((N+1)/(df+1)) is exactly 0 when df = N. That is why
// "Discipleship" contributes nothing here while "Methodist" decides the
// question, and why no one had to write either word down.
export function tokenDiscrimination(candidateTexts: string[]): (token: string) => number {
  const n = candidateTexts.length;
  const docs = candidateTexts.map((t) => new Set(identityTokens(t)));
  return (token: string) => {
    const df = docs.filter((d) => d.has(token)).length;
    if (df === 0) return 0; // matches nothing here, so it cannot contribute
    return Math.log((n + 1) / (df + 1));
  };
}

export const SOURCE_DOMAIN_CLASSES = ["official", "affiliated", "third_party", "unverified"] as const;
export type SourceDomainClass = (typeof SOURCE_DOMAIN_CLASSES)[number];

// Does a hostname carry this entity's own name? "worship.calvin.edu" carries
// "calvin" and "worship"; "philanthropy.org" carries nothing of
// "International Discipleship Ministries".
function hostCarriesName(host: string, name: string | null | undefined): boolean {
  const flat = host.toLowerCase().replace(/[^a-z0-9]/g, "");
  return identityTokens(name).some((t) => !STRUCTURAL_TOKENS.has(t) && t.length >= 4 && flat.includes(t));
}

function hostCarriesAcronym(host: string, name: string | null | undefined): boolean {
  const flat = host.toLowerCase().replace(/[^a-z0-9]/g, "");
  const words = normalizeForTokens(name).split(" ").filter(Boolean);
  for (let len = 2; len <= 5; len++) {
    for (let i = 0; i + len <= words.length; i++) {
      const initials = words.slice(i, i + len).map((w) => w[0]).join("");
      if (initials.length >= 3 && flat.includes(initials)) return true;
    }
  }
  return false;
}

// Classify BEFORE scoring. A domain earns points for what it is, and an
// unrecognised domain earns none -- it does not get the benefit of the doubt.
//
// This is the inversion of the old rule. There was a denylist of eleven
// aggregators and anything absent from it was treated as the organization's
// own site, which is how google.com came to be displayed as a funder's
// homepage. A denylist defaults to trust; that default was the bug.
export function classifySourceDomain(
  host: string | null | undefined,
  opts: { entityName?: string | null; prospectHost?: string | null }
): SourceDomainClass {
  if (!host) return "unverified";
  const h = host.toLowerCase().replace(/^www\./, "");
  if (AGGREGATOR_DOMAINS.some((d) => h.includes(d)) || SEARCH_DOMAINS.some((d) => h.includes(d))) return "third_party";
  if (opts.prospectHost && h === opts.prospectHost.toLowerCase().replace(/^www\./, "")) return "official";
  if (hostCarriesName(h, opts.entityName)) return "official";
  // nccumc.org relative to "...United Methodist Church": a body within the
  // same denomination, not the entity itself. Real corroboration, weaker than
  // the organization speaking on its own domain.
  if (hostCarriesAcronym(h, opts.entityName)) return "affiliated";
  return "unverified";
}

// Search engines are not sources. A results page was displayed as an
// organization's website because nothing said otherwise.
const SEARCH_DOMAINS = ["google.", "bing.com", "duckduckgo.com", "search.yahoo.", "baidu.com"];

// The organization's own site, as opposed to the aggregator or search page we
// read about it on.
//
// Now requires the host to actually carry the entity's name. Previously any
// URL that was not on the aggregator denylist was returned as the official
// website, which put philanthropy.org and google.com in front of the user as
// two funders' homepages.
export function extractOfficialWebsite(urls: string[], texts: string[], entityName?: string | null): string | null {
  const candidates = [...urls, ...texts.flatMap((t) => t.match(/https?:\/\/[^\s"'<>)]+/g) ?? [])];
  for (const raw of candidates) {
    let host: string;
    try {
      host = new URL(raw).hostname.replace(/^www\./, "");
    } catch {
      continue;
    }
    if (classifySourceDomain(host, { entityName }) === "official") return host;
  }
  return null;
}

// Rough, and labelled as rough. "Private foundation" versus "public charity"
// is often the difference between two same-named entities, so it earns its
// place even when imprecise.
export function extractOrgType(texts: string[]): string | null {
  const joined = texts.join(" ");
  if (/\b990-?PF\b|private (?:grantmaking )?foundation/i.test(joined)) return "Private foundation";
  if (/\bdonor[- ]advised\b/i.test(joined)) return "Donor-advised fund sponsor";
  if (/\bpublic charity\b/i.test(joined)) return "Public charity";
  if (/\bchurch\b/i.test(joined)) return "Church";
  return null;
}

export type EntityCandidate = {
  ein: string;
  name: string | null;
  location: string | null;
  website: string | null;
  orgType: string | null;
  sourceCount: number;
  status: string | null;
  // Why this one is being offered, in the user's terms.
  whyMatch: string[];
  // How many independent identifying attributes it carries. Below two, a
  // person cannot tell it apart from any other row, so it is not a choice.
  attributeCount: number;
  // Everything captured about this entity -- titles and source text -- as one
  // haystack. A grant programme is named on the funder's PAGE, essentially
  // never in their registered legal name, so scoring against names alone can
  // never let the most specific thing we know corroborate anything.
  matchText: string;
  // Weighted total. Comparable only WITHIN one run -- token weights are
  // computed against this candidate set, so a score of 5 in one run means
  // nothing about a score of 5 in another.
  score: number;
  // The score, in the user's words. Built alongside the number from the same
  // branches, so a signal cannot contribute to the ranking without also
  // appearing here -- the old whyMatch was both explanation and sort key,
  // which let an unimplemented signal silently decide the order.
  evidence: string[];
};

// Never more than three. Beyond that a list stops being a decision and
// becomes a lottery -- which is the failure this replaces.
export const MAX_PRESENTED_CANDIDATES = 3;
export const MIN_CANDIDATE_ATTRIBUTES = 2;

export function buildEntityCandidates(input: {
  sources: { url: string; title: string | null; sourceEin: string | null; status: string | null; texts: string[] }[];
  nameToken: string;
  prospectLocation: string | null;
  prospectWebsite?: string | null;
  // Everything else already known about this prospect. All of it was on the
  // record when the resolver was offering a three-way guess; none of it was
  // being read.
  funderName?: string | null;
  opportunityName?: string | null;
  // The domain Donor Finder captured this prospect from. nccumc.org is a
  // United Methodist body, which is corroboration for a Methodist entity and
  // for no other candidate.
  captureDomain?: string | null;
  // city/state by EIN, from the filing cache. CORROBORATION ONLY -- see
  // scoreEntityCandidates.
  locationByEin?: Record<string, string | null>;
}): EntityCandidate[] {
  const { sources, nameToken, prospectLocation, prospectWebsite } = input;
  const prospectHost = (() => {
    if (!prospectWebsite) return null;
    try {
      return new URL(prospectWebsite).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  })();
  const byEin = new Map<string, typeof input.sources>();
  for (const s of sources) {
    if (!s.sourceEin) continue;
    byEin.set(s.sourceEin, [...(byEin.get(s.sourceEin) ?? []), s]);
  }

  const prospectState = prospectLocation?.match(new RegExp(`\\b(${US_STATES})\\b`))?.[1] ?? null;

  return [...byEin.entries()].map(([ein, group]) => {
    const texts = group.flatMap((s) => [s.title ?? "", ...s.texts]).filter(Boolean);
    const name = group.map((s) => cleanEntityName(s.title)).find(Boolean) ?? null;
    // A filing address corroborates; it is never the location of record. An
    // organization can operate from a different city than it files from, and
    // treating the filing as truth would overwrite something observed with
    // something merely administrative.
    const location = extractLocation(texts) ?? input.locationByEin?.[ein] ?? null;
    const website = extractOfficialWebsite(group.map((s) => s.url), texts, name);
    const orgType = extractOrgType(texts);

    const whyMatch: string[] = [];
    if (prospectHost && website === prospectHost) whyMatch.unshift("On this prospect's own website");
    if (nameToken && name && name.toLowerCase().includes(nameToken.toLowerCase())) {
      whyMatch.push(`Name contains "${nameToken}"`);
    }
    if (prospectState && location?.endsWith(prospectState)) whyMatch.push(`Same state as this prospect`);
    if (group.length > 1) whyMatch.push(`Appears in ${group.length} sources`);

    const attributeCount = [name, location, website, orgType].filter(Boolean).length;
    return {
      ein,
      name,
      location,
      website,
      orgType,
      sourceCount: group.length,
      status: group[0].status,
      whyMatch,
      attributeCount,
      matchText: [name ?? "", ...texts].join(" "),
      // Filled by scoreEntityCandidates, which needs the whole set at once --
      // token weights are relative to the candidates being chosen between.
      score: 0,
      evidence: [],
    };
  });
}

// Points. Tuned so that a single decisive signal (the funder's own domain, an
// initialism only one candidate can produce) outweighs any amount of generic
// name overlap -- which is the failure being corrected.
const SCORE_OFFICIAL_DOMAIN = 4;
const SCORE_AFFILIATED_DOMAIN = 2;
const SCORE_EXACT_OPPORTUNITY = 3;
const SCORE_LOCATION_CORROBORATION = 1.5;
const SCORE_PER_EXTRA_SOURCE = 0.5;
// A token found in a candidate's published material rather than its registered
// name. Real corroboration, but weaker: a page can mention anything.
const TEXT_MATCH_FACTOR = 0.4;
const SCORE_MAX_SOURCE_BONUS = 1;

// A leader must clear both. Either alone is insufficient: a high score with a
// close second is a coin flip between two plausible organizations, and a wide
// margin over nothing much is one weak candidate in an empty field.
export const MIN_LEADER_SCORE = 3;
export const MIN_LEADER_MARGIN = 1.5;

export type EntityRanking = {
  ranked: EntityCandidate[];
  leader: EntityCandidate | null;
  margin: number;
  // True only when the leader clears both thresholds. False means abstain --
  // fall through to the candidate list or a clarifying question.
  confident: boolean;
};

// Score every candidate against everything known, then decide whether the
// result is decisive enough to act on.
export function scoreEntityCandidates(
  candidates: EntityCandidate[],
  known: {
    prospectName: string;
    funderName?: string | null;
    opportunityName?: string | null;
    prospectWebsite?: string | null;
    prospectLocation?: string | null;
    captureDomain?: string | null;
  }
): EntityRanking {
  const prospectHost = (() => {
    try {
      return known.prospectWebsite ? new URL(known.prospectWebsite).hostname.replace(/^www\./, "") : null;
    } catch {
      return null;
    }
  })();
  const prospectState = known.prospectLocation?.match(new RegExp(`\\b(${US_STATES})\\b`))?.[1] ?? null;

  // Discrimination is measured over everything captured about the candidates
  // actually on offer, not just their names.
  const idf = tokenDiscrimination(candidates.map((c) => `${c.name ?? ""} ${c.matchText ?? ""}`));

  // Every token we hold, each with how much it ought to matter before
  // discrimination is applied.
  const weights = new Map<string, number>();
  const add = (text: string | null | undefined, weight: number) => {
    for (const t of identityTokens(text)) {
      weights.set(t, Math.max(weights.get(t) ?? 0, STRUCTURAL_TOKENS.has(t) ? STRUCTURAL_TOKEN_WEIGHT : weight));
    }
  };
  add(known.prospectName, 1);
  add(known.funderName, 1);
  // The grant's own name is the most specific thing a person knows about a
  // funding opportunity, and it was being discarded wholesale.
  add(known.opportunityName, OPPORTUNITY_TOKEN_WEIGHT);

  const acronyms = [...new Set([...acronymsIn(known.prospectName), ...acronymsIn(known.funderName), ...acronymsIn(known.opportunityName)])];

  const scored = candidates.map((c) => {
    let score = 0;
    const evidence: string[] = [];

    // 1. Weighted overlap, against the name first and their published material
    //    second. A match in the registered name is the stronger claim -- an
    //    organization's page can mention anything -- so a text-only match is
    //    discounted rather than treated as equivalent.
    const nameTokens = new Set(identityTokens(c.name));
    const textTokens = new Set(identityTokens(c.matchText));
    const inName: { t: string; pts: number }[] = [];
    const inText: { t: string; pts: number }[] = [];
    for (const [token, weight] of weights) {
      const power = idf(token);
      if (power <= 0) continue; // present in every candidate, so it decides nothing
      if (nameTokens.has(token)) {
        const pts = weight * power;
        score += pts;
        inName.push({ t: token, pts });
      } else if (textTokens.has(token)) {
        const pts = weight * power * TEXT_MATCH_FACTOR;
        score += pts;
        inText.push({ t: token, pts });
      }
    }
    // Ordered by how much each actually moved the score, so the reason a
    // person reads first is the reason that mattered most.
    const say = (list: { t: string; pts: number }[]) =>
      [...list].sort((a, b) => b.pts - a.pts).map((x) => `"${x.t}"`).join(", ");
    if (inName.length > 0) evidence.push(`Name matches ${say(inName)}`);
    if (inText.length > 0) evidence.push(`Their material mentions ${say(inText)}`);

    // 2. Initialisms. "UMC" is three characters of the prospect's name and the
    //    only thing that separates a Methodist agency from two unrelated
    //    ministries that also say "Discipleship".
    for (const a of acronyms) {
      if (!nameYieldsAcronym(c.name, a)) continue;
      const df = candidates.filter((o) => nameYieldsAcronym(o.name, a)).length;
      const power = Math.log((candidates.length + 1) / (df + 1));
      if (power <= 0) continue;
      score += ACRONYM_WEIGHT * power;
      evidence.push(`Name spells out "${a.toUpperCase()}"`);
    }

    // 3. The exact opportunity, named verbatim on this entity's material. The
    //    single most specific thing a fundraiser knows about a funding
    //    opportunity, and it was being thrown away with the rest of the name.
    if (known.opportunityName) {
      const phrase = normalizeForTokens(known.opportunityName);
      if (phrase && `${normalizeForTokens(c.name)} ${normalizeForTokens(c.matchText)}`.includes(phrase)) {
        score += SCORE_EXACT_OPPORTUNITY;
        evidence.push(`Runs the "${known.opportunityName}" programme`);
      }
    }

    // 4. Provenance -- but only after the domain has been classified. An
    //    unrecognised domain scores nothing rather than being read as the
    //    organization's own.
    const domainClass = classifySourceDomain(known.captureDomain, { entityName: c.name, prospectHost });
    if (domainClass === "official") {
      score += SCORE_OFFICIAL_DOMAIN;
      evidence.push(`Found on their own website (${known.captureDomain})`);
    } else if (domainClass === "affiliated") {
      score += SCORE_AFFILIATED_DOMAIN;
      evidence.push(`Found on an affiliated site (${known.captureDomain})`);
    }
    if (prospectHost && c.website === prospectHost) {
      score += SCORE_OFFICIAL_DOMAIN;
      evidence.push("Listed on this prospect's own website");
    }

    // 5. Location. Corroboration only, and never subtractive: a filing address
    //    can differ from where an organization actually operates, so a
    //    mismatch is uninformative rather than disqualifying.
    if (prospectState && c.location?.endsWith(prospectState)) {
      score += SCORE_LOCATION_CORROBORATION;
      evidence.push(`Based in ${c.location}, matching this prospect`);
    }

    // 6. Independent corroboration, capped -- being scraped twice by the same
    //    aggregator is not twice the evidence.
    if (c.sourceCount > 1) {
      score += Math.min((c.sourceCount - 1) * SCORE_PER_EXTRA_SOURCE, SCORE_MAX_SOURCE_BONUS);
      evidence.push(`Appears in ${c.sourceCount} independent sources`);
    }

    return { ...c, score: Math.round(score * 100) / 100, evidence };
  });

  const ranked = [...scored].sort((a, b) => b.score - a.score || b.attributeCount - a.attributeCount);
  const leader = ranked[0] ?? null;
  const margin = leader ? leader.score - (ranked[1]?.score ?? 0) : 0;
  const confident = !!leader && leader.score >= MIN_LEADER_SCORE && margin >= MIN_LEADER_MARGIN;

  return { ranked, leader, margin: Math.round(margin * 100) / 100, confident };
}

// What may actually be shown. Everything else stays in the audit view, where
// completeness matters more than legibility.
//
// Returns NOTHING when more than three survive, rather than the best three.
// Truncating would be the original failure in miniature: showing a short list
// asserts the answer is in it, and with eight near-identical Presbyterian
// entities that assertion is false. Too many to choose between is a real
// answer, and it routes to asking the user for a detail instead.
export function presentableCandidates(candidates: EntityCandidate[]): EntityCandidate[] {
  // Ordered by score, not by how many reasons the code managed to articulate.
  // The old sort was `whyMatch.length`, which meant three candidates carrying
  // the same single generic reason tied, and the tiebreak fell to source count
  // -- handing first place to whichever aggregator had been scraped twice.
  const credible = candidates
    .filter((c) => c.attributeCount >= MIN_CANDIDATE_ATTRIBUTES)
    .sort((a, b) => b.score - a.score || b.attributeCount - a.attributeCount || b.sourceCount - a.sourceCount);
  return credible.length > MAX_PRESENTED_CANDIDATES ? [] : credible;
}

// ---------------------------------------------------------------------------
// Entity lifecycle
//
// Every check in this pipeline asks whether a claim is true OF an organization.
// None asks whether that organization still exists. A 990 filed by a dissolved
// charity is structurally identical to one filed by a going concern, so
// evidence capture, entity gating, verification and reporting periods all pass
// cleanly on a funder that no longer operates.
//
// Found on Overseas Council International: filings stop at FY2017 with a
// short-period return, expenses fall 6.2M -> 5.75M -> 3.43M -> 815K, the
// address moves from Indianapolis to Charlotte, and the organization that
// absorbed it appears in the candidate list as a rival to be eliminated. Four
// independent signals, all captured, none with anywhere to go.
//
// These functions report SIGNALS, never a conclusion. "Stopped filing in 2017"
// is a fact; "this organization merged" is an inference a person makes with
// context we do not have -- a funder can go quiet for other reasons, and
// declaring a merger we cannot evidence would repeat the mistake this whole
// build has been correcting.

// A funder's most recent filing year is what says whether we are looking at a
// going concern. 990s are filed in arrears and aggregators lag further, so a
// two-year gap is normal and three starts to be a question.
export const ENTITY_LIFECYCLE_STALE_YEARS = 3;

export function reportingPeriodYear(reportingPeriod: string | null | undefined): number | null {
  if (!hasStatedPeriod(reportingPeriod)) return null;
  // Digit boundaries, not word boundaries. \b finds no boundary between the
  // "Y" and the "2" of "FY2024" -- both are word characters -- so the most
  // common period format in our own data parsed as having no year at all.
  // Guarding on adjacent digits instead also stops "202303199349108860"
  // (a ProPublica filing id) yielding a year.
  const years = [...reportingPeriod!.matchAll(/(?<!\d)(?:19|20)\d{2}(?!\d)/g)].map((m) => Number(m[0]));
  return years.length ? Math.max(...years) : null;
}

// Phrases that state a change of legal existence. Deliberately narrow, and
// deliberately not including bare "dissolved" or "acquired", which appear in
// grantmaking prose about OTHER organizations often enough to be noise -- a
// funder that "supports organizations dissolved by conflict" is not itself
// dissolved.
const SUCCESSION_LANGUAGE =
  /\b(merged (?:with|into)|merger with|now part of|formerly known as|formerly named|changed its name to|successor (?:to|organization)|ceased operations|final return|no longer operating|absorbed (?:by|into))\b/i;

export function mentionsSuccession(text: string): boolean {
  return SUCCESSION_LANGUAGE.test(text);
}

// A short accounting period is what an organization files when its fiscal year
// is cut off -- most often because it is being wound up or absorbed mid-year.
// On its own it means a fiscal-year change; followed by no further filings it
// is the shape of an ending.
export function mentionsShortPeriodReturn(text: string): boolean {
  return /\bshort[-\s]period\b/i.test(text);
}

export type EntityLifecycleSignal = {
  kind: "stale_filings" | "short_period_return" | "succession_language";
  detail: string;
};

export function assessEntityLifecycle(input: {
  claims: { claim: string; reporting_period?: string | null }[];
  currentYear: number;
}): { newestYear: number | null; signals: EntityLifecycleSignal[] } {
  const { claims, currentYear } = input;
  const years = claims.map((c) => reportingPeriodYear(c.reporting_period)).filter((y): y is number => y !== null);
  const newestYear = years.length ? Math.max(...years) : null;

  const signals: EntityLifecycleSignal[] = [];
  if (newestYear !== null && currentYear - newestYear >= ENTITY_LIFECYCLE_STALE_YEARS) {
    signals.push({
      kind: "stale_filings",
      detail: `The most recent financial year found anywhere in this research is ${newestYear}.`,
    });
  }

  const shortPeriod = claims.find((c) => mentionsShortPeriodReturn(c.claim));
  if (shortPeriod) {
    signals.push({
      kind: "short_period_return",
      detail: "A short-period return was found, which usually means a fiscal year was cut short.",
    });
  }

  const succession = claims.find((c) => mentionsSuccession(c.claim));
  if (succession) {
    signals.push({
      kind: "succession_language",
      detail: `A source refers to a change of name or organization: "${succession.claim.slice(0, 160)}${succession.claim.length > 160 ? "…" : ""}"`,
    });
  }

  return { newestYear, signals };
}

export const RESEARCH_TRIAGE_CLAIM_KEYS = [
  // Who they are
  "identity.legal_name",
  "identity.location",
  "identity.ein",
  "identity.website",
  // What and where they fund
  "funding.funder_type",
  "funding.focus_areas",
  "funding.geographic_focus",
  "funding.international_reach",
  // Capacity -- can they fund an ask of our size at all
  "funding.total_annual_giving",
  "funding.total_assets",
  "funding.grant_size_range",
  "funding.median_grant_size",
  "funding.grant_count_annual",
  // Whether we can approach them, and who to approach
  "application.accepts_unsolicited",
  "people.key_contacts",
] as const;

// The four keys an identity preflight asks for. Anything else would defeat
// the point: this pass exists to be cheap.
export const RESEARCH_IDENTITY_CLAIM_KEYS = [
  "identity.legal_name",
  "identity.ein",
  "identity.location",
  "identity.website",
] as const;

export function claimKeysForDepth(
  depth: ResearchDepth,
  opts: { knownWebsite?: boolean } = {}
): { key: string; description: string }[] {
  let all = RESEARCH_CLAIM_KEYS.map((k) => ({ key: k.key, description: k.description }));

  // Never ask the model to "find" the website we handed it. The prospect's
  // website is passed into the search prompt, so asking for identity.website
  // when one is already on file is circular: Stage 5 flagged that claim as
  // UNSUPPORTED on both runs it examined -- high confidence, five evidence
  // fragments, none of which mentioned a URL. The model was restating input.
  //
  // When no website is on file the key stays, because "this funder has no
  // public website" is then a real finding reached from evidence.
  if (opts.knownWebsite) all = all.filter((k) => k.key !== "identity.website");

  if (depth === "dossier") return all;
  const scope = new Set<string>(depth === "identity" ? RESEARCH_IDENTITY_CLAIM_KEYS : RESEARCH_TRIAGE_CLAIM_KEYS);
  return all.filter((k) => scope.has(k.key));
}

export function defaultDepthForStage(stage: string | null): ResearchDepth {
  return stage === "discovery" || stage === null ? "screen" : "dossier";
}

// How a stored status should be READ, given the classifier version that
// produced it. v1's "affiliate_related_entity" asserted a relationship it had
// not established and allowed that evidence into extraction; v2 states only
// what is known and withholds it.
export function entityStatusMeaning(
  status: ResearchEntityValidationStatus | null,
  classificationVersion: number | null
): { label: string; assertedRelationship: boolean } {
  if (status === "affiliate_related_entity") {
    return {
      label: "different entity (v1 called this an affiliate -- relationship was never verified)",
      assertedRelationship: true,
    };
  }
  if (status === "different_entity_unverified_relation") {
    return { label: "different legal entity -- relationship unverified", assertedRelationship: false };
  }
  return { label: (status ?? "not evaluated").replace(/_/g, " "), assertedRelationship: false };
}

// A run whose identity was never established may be kept and read as
// candidate intelligence, but it must not be treated as a confirmed dossier
// for the prospect: with no confirmed EIN, several competing organizations
// sit at the same trust level, and only the model's reading separates them.
// Enforced as backend state rather than convention -- any consumer that
// would advance research into Strategy/Outreach must gate on this.
export function isConfirmedDossier(run: {
  entity_resolution_method: string | null;
}): boolean {
  return run.entity_resolution_method === "stored_ein" || run.entity_resolution_method === "authoritative_filing" || run.entity_resolution_method === "official_domain";
}

// Every EIN a source appears to describe, from its captured text and its
// URL. One source can legitimately mention several (an aggregator page
// listing affiliated foundations), so callers treat this as candidates.
export function sourceEinCandidates(sourceUrl: string, sourceTexts: string[]): string[] {
  return [...sourceTexts.flatMap((t) => extractEinCandidates(t)), ...extractEinCandidatesFromUrl(sourceUrl)];
}

// The single EIN a source is *about*, when that's unambiguous -- used to
// group sources into entities. A source mentioning exactly one EIN is about
// that entity; one mentioning several (or none) can't be assigned on this
// evidence alone and stays ungrouped, classified on its own text.
export function primarySourceEin(sourceUrl: string, sourceTexts: string[]): string | null {
  const distinct = Array.from(new Set(sourceEinCandidates(sourceUrl, sourceTexts)));
  return distinct.length === 1 ? distinct[0] : null;
}

// US state, for the tolerant location check. Matches a two-letter code or a
// full state name; returns the code.
const STATE_CODES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};
const STATE_CODE_SET = new Set(Object.values(STATE_CODES));

// Deliberately STATE level only, never city. The prospect record for a real
// funder read "Irvine, CA" while the organization's filings say "Newport
// Beach, CA" -- adjacent cities, same metro, and a city-level match would
// have rejected the correct organization outright. State is the coarsest
// signal that still separates the cases we actually need separated
// (California vs Pennsylvania vs North Carolina vs South Dakota, all of
// which appear as distinct real "Servants Heart" organizations).
export function extractStateCodes(text: string): string[] {
  const found = new Set<string>();
  for (const [name, code] of Object.entries(STATE_CODES)) {
    if (new RegExp(`\\b${name}\\b`, "i").test(text)) found.add(code);
  }
  for (const m of text.match(/\b[A-Z]{2}\b/g) ?? []) {
    if (STATE_CODE_SET.has(m)) found.add(m);
  }
  return Array.from(found);
}

// True only when both sides state a location AND they share no state. Used
// to DOWNGRADE trust, never to exclude -- see classifyEntity.
export function locationConflicts(prospectLocation: string | null, entityText: string): boolean {
  if (!prospectLocation) return false;
  const prospectStates = extractStateCodes(prospectLocation);
  if (prospectStates.length === 0) return false;
  const entityStates = extractStateCodes(entityText);
  if (entityStates.length === 0) return false;
  return !entityStates.some((s) => prospectStates.includes(s));
}

// Establishes which entity a run is actually about, by priority of evidence
// quality -- NOT by counting mentions.
//
// Counting was the previous approach and it is not an identity
// determination. Two genuinely different, similarly-named real
// organizations both attract well-indexed sources, and whichever happens to
// state its EIN in more places wins: that is how a real run elevated the
// WRONG entity ("Servants Heart Family Foundation", Carlisle PA) to the
// highest trust tier while the researched entity ("Servants Heart
// Foundation Inc", Newport Beach CA) sat a tier lower. Adding a dominance
// ratio patched the symptom but kept the mechanism.
//
// The order below prefers evidence that is authoritative rather than
// frequent. Crucially, two competing authoritative filings do NOT get
// resolved by picking the more common one -- that is ambiguous_filings, and
// it deliberately returns no EIN. Returning null is always the safe
// direction: it withholds trust without excluding anything, so every
// name-matching source settles at legal_name_confirmed instead.
export function resolveRunEntity({
  storedEin,
  prospectName,
  prospectWebsite,
  nameToken,
  sources,
}: {
  storedEin: string | null;
  prospectName: string;
  prospectWebsite: string | null;
  nameToken: string;
  sources: { url: string; texts: string[]; title?: string | null; sourceType: ResearchSourceType }[];
}): { ein: string | null; method: ResearchEntityResolutionMethod } {
  // 1. A human-confirmed EIN on the prospect record beats everything and
  //    makes every future run of this prospect deterministic.
  if (storedEin) return { ein: storedEin, method: "stored_ein" };

  // 2. An EIN stated on the prospect's OWN domain. This is the organization
  //    speaking about itself, which outranks any number of third-party
  //    filings that merely share a word with its name.
  //
  //    It used to run last, reached only when nothing else matched -- so on
  //    "Presbyterian Mission Agency" the filing check found many same-named
  //    entities, returned ambiguous_filings immediately, and pcusa.org
  //    stating its own EIN was never consulted. The strongest signal we have
  //    was positioned as a fallback.
  //
  //    Still conservative: the host must match exactly, and the page must
  //    name exactly ONE EIN. A denomination's site listing its agencies
  //    resolves nothing, which is correct -- that page does not say which
  //    one this prospect is.
  if (prospectWebsite) {
    try {
      const prospectHost = new URL(prospectWebsite).hostname.replace(/^www\./, "");
      for (const s of sources) {
        if (new URL(s.url).hostname.replace(/^www\./, "") !== prospectHost) continue;
        const candidates = Array.from(new Set(sourceEinCandidates(s.url, s.texts)));
        if (candidates.length === 1) return { ein: candidates[0], method: "official_domain" };
      }
    } catch {
      // malformed url -- fall through
    }
  }

  // 3. An EIN stated by an authoritative filing source that also matches the
  //    prospect's name. Distinct competing answers here mean identity is
  //    genuinely contested and must not be guessed.
  //    A family foundation's siblings are themselves filing sources carrying
  //    the family name, so "any matching filing may vote" could never
  //    resolve such a cluster. Candidates are therefore ranked by how
  //    closely the filing's own organization name matches the prospect's,
  //    and only a TIE at the closest distance is genuinely ambiguous:
  //      "Maclellan Foundation Inc"                   -> 1 extra word  (wins)
  //      "Robert L And Kathrina H Maclellan Foundation" -> 5 extra words
  //    while two equally-close competitors stay unresolved, e.g.
  //      "Servants Heart Foundation Inc"   -> 1 extra word
  //      "Servants Heart Family Foundation" -> 1 extra word  (tie -> ask a human)
  //    Two independent signals must AGREE, or identity is not established.
  //
  //    Name distance alone is not safe, and this rule has now been wrong
  //    three times: too strict on a family cluster, tied on identically
  //    named entities, and -- worst -- confidently WRONG when a different
  //    organization happened to carry the shorter name. The real prospect
  //    was "Servants Heart Foundation Inc"; an unrelated charity is named
  //    exactly "Servants Heart Foundation", so it scored a perfect match,
  //    won outright, and the correct entity's own sources were then
  //    discarded as belonging to someone else.
  //
  //    Corroboration alone is not safe either -- that is mention-counting,
  //    which elevated the wrong entity before name gating was added.
  //
  //    So: the closest name match must ALSO be the best-corroborated
  //    candidate. When the two signals point at different organizations that
  //    is genuine ambiguity, and the honest answer is to refuse and ask,
  //    which costs a trust label rather than a wrong dossier.
  //    A single plausible candidate may be confirmed. More than one is
  //    refused outright -- no ranking, no tie-break, no heuristic.
  //
  //    Ranking was tried and was wrong three times: too strict on a family
  //    cluster, tied on identically named entities, and finally CONFIRMING
  //    an unrelated charity because it happened to carry the shorter name,
  //    which discarded 56 fragments of correct evidence and produced a
  //    dossier about the wrong organization. Both signals available here --
  //    name similarity and source corroboration -- come from the same
  //    uncertain search results, so agreement between them is weaker
  //    evidence than it looks.
  //
  //    A rule that never has to choose correctly cannot choose wrongly. The
  //    cost is that more prospects need a human to say which entity is
  //    meant, which is exactly what the cheap identity preflight and the
  //    candidate picker exist for.
  const plausibleEins = new Set<string>();
  for (const s of sources) {
    if (s.sourceType !== "irs_filing") continue;
    // The title counts toward the name check as well as the captured text --
    // callers usually seed one into the other, but a source's own title is
    // the most direct statement of who it is about and must never be missed.
    if (!sourceMatchesName(s.url, [...s.texts, s.title ?? ""], nameToken)) continue;
    for (const ein of sourceEinCandidates(s.url, s.texts)) plausibleEins.add(ein);
  }
  if (plausibleEins.size === 1) return { ein: Array.from(plausibleEins)[0], method: "authoritative_filing" };
  if (plausibleEins.size > 1) return { ein: null, method: "ambiguous_filings" };

  return { ein: null, method: "unresolved" };
}

// Deterministic, code-only classification for one source -- see the
// decision tree in docs/decisions/0002-research-agent.md. sourceTexts
// should be every piece of captured text for this source (its title plus
// every evidence fragment), so the name/EIN checks see everything actually
// captured, not just one field.
export function classifySourceEntity({
  sourceUrl,
  sourceTexts,
  prospectWebsite,
  nameToken,
  confirmedEin,
}: {
  sourceUrl: string;
  sourceTexts: string[];
  prospectWebsite: string | null;
  nameToken: string;
  confirmedEin: string | null;
}): ResearchEntityValidationStatus {
  if (prospectWebsite) {
    try {
      const prospectHost = new URL(prospectWebsite).hostname.replace(/^www\./, "");
      const sourceHost = new URL(sourceUrl).hostname.replace(/^www\./, "");
      if (sourceHost === prospectHost) return "official_domain_confirmed";
    } catch {
      // malformed prospectWebsite or sourceUrl -- fall through to the other checks
    }
  }

  const combinedText = sourceTexts.join(" ");
  const einsInSource = extractEinCandidates(combinedText);
  const nameMatches = sourceMatchesName(sourceUrl, sourceTexts, nameToken);

  // IRS-filing aggregators (e.g. ProPublica's Nonprofit Explorer) commonly
  // embed the EIN in the URL itself with no dash (.../organizations/626041468),
  // which EIN_PATTERN's dashed \d{2}-\d{7} never matches. Since confirmedEin
  // is already trusted (derived by majority vote over dashed mentions
  // elsewhere in the run), it's safe to also recognize it here in undashed
  // form -- this only widens what counts as "matches the known-good EIN,"
  // it doesn't add a new, riskier bare-9-digit EIN extractor.
  const confirmedEinMatches =
    confirmedEin !== null &&
    (einsInSource.includes(confirmedEin) ||
      combinedText.includes(confirmedEin.replace("-", "")) ||
      sourceUrl.includes(confirmedEin.replace("-", "")));

  if (confirmedEin) {
    if (confirmedEinMatches) return "ein_confirmed";
    if (einsInSource.length > 0) return nameMatches ? "different_entity_unverified_relation" : "entity_mismatch";
  }
  return nameMatches ? "legal_name_confirmed" : "unrelated_excluded";
}

// One source, grouped into an entity and given a verdict.
export type ClassifiedSource = {
  url: string;
  sourceEin: string | null;
  status: ResearchEntityValidationStatus;
};

// Classifies every source in a run, per ENTITY rather than per URL.
//
// Classifying URLs independently produced the defect this replaces: one
// affiliated foundation appeared at three URLs in a single real run and
// received two different verdicts, because two of its pages carried its full
// name in the title while its own summary page came back with a bare-domain
// title and a snippet that never repeated the name. Same organization,
// opposite verdicts, decided by how much text each URL happened to yield.
//
// Sources are therefore grouped by the EIN they describe, their captured
// text is POOLED, and the entity is classified once from everything known
// about it -- so a thin page inherits the identity its siblings establish.
// Sources with no single identifiable EIN can't be grouped and are still
// judged on their own text.
export function classifyRunSources({
  sources,
  prospectWebsite,
  prospectLocation,
  nameToken,
  confirmedEin,
}: {
  sources: { url: string; texts: string[] }[];
  prospectWebsite: string | null;
  prospectLocation: string | null;
  nameToken: string;
  confirmedEin: string | null;
}): ClassifiedSource[] {
  const einByUrl = new Map<string, string | null>();
  const pooledTextByEin = new Map<string, string[]>();
  const pooledUrlsByEin = new Map<string, string[]>();

  for (const s of sources) {
    const ein = primarySourceEin(s.url, s.texts);
    einByUrl.set(s.url, ein);
    if (!ein) continue;
    pooledTextByEin.set(ein, [...(pooledTextByEin.get(ein) ?? []), ...s.texts]);
    pooledUrlsByEin.set(ein, [...(pooledUrlsByEin.get(ein) ?? []), s.url]);
  }

  // One verdict per entity, computed from everything captured about it.
  const statusByEin = new Map<string, ResearchEntityValidationStatus>();
  for (const [ein, texts] of pooledTextByEin) {
    const urls = pooledUrlsByEin.get(ein) ?? [];
    const nameMatches = sourceMatchesName(urls.join(" "), texts, nameToken);

    // Grouping already established this entity's EIN, including from URLs
    // that state it without a dash -- so compare it directly rather than
    // re-deriving from text alone. This is what distinguishes a genuine
    // affiliate (different EIN, name still matches -- a family foundation's
    // sibling trust) from an unrelated organization that merely looks
    // similar, which text-only detection could not tell apart.
    let status: ResearchEntityValidationStatus;
    if (confirmedEin && ein === confirmedEin) {
      status = "ein_confirmed";
    } else if (confirmedEin) {
      status = nameMatches ? "different_entity_unverified_relation" : "entity_mismatch";
    } else {
      status = classifySourceEntity({
        // Pooled URLs so a name appearing in any of this entity's URLs counts.
        sourceUrl: urls.join(" "),
        sourceTexts: texts,
        prospectWebsite,
        nameToken,
        confirmedEin,
      });
    }

    // The prospect's own domain outranks EIN reasoning: if any of this
    // entity's pages is on it, this is the prospect itself.
    if (prospectWebsite) {
      try {
        const prospectHost = new URL(prospectWebsite).hostname.replace(/^www\./, "");
        if (urls.some((u) => new URL(u).hostname.replace(/^www\./, "") === prospectHost)) {
          status = confirmedEin && ein === confirmedEin ? "ein_confirmed" : "official_domain_confirmed";
        }
      } catch {
        // malformed url -- keep the status derived above
      }
    }

    // Location DOWNGRADES a name-only match, never excludes. A conflicting
    // state means the name matched a different organization somewhere else,
    // which is a reason to stop trusting the name -- not a reason to throw
    // the source away, since our own stored location can be imprecise.
    if (status === "legal_name_confirmed" && locationConflicts(prospectLocation, texts.join(" "))) {
      status = "identity_unresolved";
    }
    statusByEin.set(ein, status);
  }

  return sources.map((s) => {
    const ein = einByUrl.get(s.url) ?? null;
    if (ein && statusByEin.has(ein)) {
      return { url: s.url, sourceEin: ein, status: statusByEin.get(ein)! };
    }
    let status = classifySourceEntity({
      sourceUrl: s.url,
      sourceTexts: s.texts,
      prospectWebsite,
      nameToken,
      confirmedEin,
    });
    if (status === "legal_name_confirmed" && locationConflicts(prospectLocation, s.texts.join(" "))) {
      status = "identity_unresolved";
    }
    return { url: s.url, sourceEin: ein, status };
  });
}

export type ResearchSource = {
  id: string;
  research_run_id: string;
  url: string;
  title: string | null;
  source_type: ResearchSourceType;
  page_age: string | null;
  search_time_excerpts: string[];
  entity_validation_status: ResearchEntityValidationStatus | null;
  retrieved_at: string;
  created_at: string;
};

// Evidence-first redesign: one row per distinct captured text FRAGMENT,
// not per source -- a source cited three times plus its title yields four
// evidence records, each independently referenceable. Extraction cites by
// evidence_id, never writes its own quote; the exact_text here is always
// real, API-captured data, never model-typed. "Captured evidence," not a
// webpage -- this is a fragment (a citation span or a title), never
// implied to be a full page. See docs/decisions/0002-research-agent.md.
//
// fetched_page_excerpt is the A' addition: a citation span from a page the
// model actually FETCHED and read, rather than a ~150-char search-result
// snippet. Same guarantee as the others (real API-captured text, never
// model-typed), but drawn from full page content, which is what makes
// filing-level detail -- disbursements, grant counts, named grantees --
// reachable at all. Kept as a distinct kind rather than folded into
// citation_fragment so evidence depth stays visible and measurable.
export type ResearchEvidenceKind = "citation_fragment" | "page_title" | "fetched_page_excerpt";

export type ResearchEvidence = {
  id: string;
  research_run_id: string;
  source_id: string;
  url: string;
  kind: ResearchEvidenceKind;
  exact_text: string;
  provider: string;
  content_hash: string;
  retrieved_at: string;
  created_at: string;
};

// Stage 4 (Citation Consistency Validation) of the Research Department
// redesign -- deterministic, code-only, no model call. Compares an
// extraction claim's own source_excerpt against the SEARCH step's own
// citation text for that same source (real API-provided data, not
// model-typed). This proves the extraction step didn't drift from what
// was actually cited at search time -- it does NOT independently verify
// the live webpage still says that. See docs/decisions/0002-research-agent.md.
//
// Deliberately text, not a Postgres enum, per the same reasoning as the
// rest of the Research Department's still-evolving verification-state
// vocabulary: shared constant + app-level validation, not a rigid DB type,
// while this is still being worked out.
export const RESEARCH_CITATION_CONSISTENCY_STATUSES = ["consistent", "drifted", "unverifiable", "no_excerpt"] as const;
export type ResearchCitationConsistency = (typeof RESEARCH_CITATION_CONSISTENCY_STATUSES)[number];

function normalizeForCitationComparison(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

// Exact-or-substring only, deliberately -- a tunable fuzzy/word-overlap
// score would trade "exact and deterministic" for a heuristic, which isn't
// what this check is for. If exact/substring proves too strict against
// real data, that's a separate, later, explicitly-justified change.
export function assessCitationConsistency(
  claimExcerpt: string | null | undefined,
  sourceExcerpts: string[]
): ResearchCitationConsistency {
  if (!claimExcerpt || !claimExcerpt.trim()) return "no_excerpt";
  if (sourceExcerpts.length === 0) return "unverifiable";
  const normalizedClaim = normalizeForCitationComparison(claimExcerpt);
  for (const raw of sourceExcerpts) {
    const normalizedSource = normalizeForCitationComparison(raw);
    if (!normalizedSource) continue;
    if (normalizedClaim === normalizedSource) return "consistent";
    if (normalizedSource.includes(normalizedClaim) || normalizedClaim.includes(normalizedSource)) return "consistent";
  }
  return "drifted";
}

export type ResearchClaimSource = {
  id: string;
  claim_id: string;
  source_id: string;
  // Evidence-first redesign: the real link is to a specific evidence
  // fragment, not just "a source" -- null on v1-v9 rows (predates the
  // evidence ledger), always set on new rows. cited_text below is a
  // denormalized copy of evidence_id's exact_text for new rows (never
  // model-supplied); on old rows it's whatever the extraction model wrote,
  // kept as historical record.
  evidence_id: string | null;
  research_run_id: string;
  cited_text: string | null;
  supports_directly: boolean;
  citation_consistency: ResearchCitationConsistency | null;
  content_hash: string | null;
  created_at: string;
};

// Per-key completeness record for one run -- 'found'/'not_public'/
// 'not_found'/'conflicting' are model-authored; 'not_attempted' and
// 'extraction_failed' are always SERVER-derived (see runResearch), never
// trusted to model self-reporting, so a key the model silently skipped or
// answered with a malformed shape can't disappear into a clean-looking
// result. Only written for runs that reach 'ready' -- an 'error' run's own
// status already means "extraction failed" at the run level.
// not_in_scope: deliberately not asked at this depth (see claimKeysForDepth).
// Distinct from not_attempted, which means the model WAS asked and silently
// skipped it -- a failure signal that defaults to retry_recommended.
export type ResearchKeyCoverageStatus =
  | "found"
  | "not_public"
  | "not_found"
  | "conflicting"
  | "not_attempted"
  | "extraction_failed"
  | "not_in_scope";

export type ResearchKeyCoverage = {
  id: string;
  research_run_id: string;
  claim_key: string;
  status: ResearchKeyCoverageStatus;
  notes: string | null;
  retry_recommended: boolean;
  created_at: string;
};

export type ResearchExpectedFact = {
  id: string;
  prospect_id: string;
  claim_key: string;
  category: string;
  expected_claim: string;
  source: string | null;
  source_url: string | null;
  authored_by: string;
  valid_as_of: string;
  notes: string | null;
};

export type ResearchEvalVerdict =
  | "match"
  | "partial"
  | "miss"
  | "contradicted"
  | "plausible"
  | "unsupported"
  | "unclear"
  | "outdated";

export type ResearchEvalReview = {
  id: string;
  research_run_id: string;
  expected_fact_id: string | null;
  claim_id: string | null;
  verdict: ResearchEvalVerdict;
  reviewed_by: string;
  reviewed_at: string;
  notes: string | null;
};

// Shared by the real "use server" action (research-actions.ts, with a
// request-scoped cookie client) and scripts/test-research-concurrency.mjs
// (with a service-role client) -- parameterized by an already-constructed
// Supabase client so this same read-max/insert/retry-on-conflict logic is
// callable outside a Next.js request too. Version is computed in the same
// round-trip as the insert; unique(prospect_id, version) is the real
// backstop, not the optimistic read -- a 23505 (unique_violation) means
// another run raced ahead, so this re-reads the max and retries rather
// than surfacing a spurious error to a request that did nothing wrong.
export async function allocateResearchRunVersion(
  supabase: SupabaseClient,
  prospectId: string,
  retryOfRunId: string | null,
  createdBy: string,
  statusMessage: string
): Promise<string> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { data: last } = await supabase
      .from("research_runs")
      .select("version")
      .eq("prospect_id", prospectId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextVersion = (last?.version ?? 0) + 1;

    const { data: run, error } = await supabase
      .from("research_runs")
      .insert({
        prospect_id: prospectId,
        version: nextVersion,
        retry_of: retryOfRunId,
        status: "researching",
        status_message: statusMessage,
        created_by: createdBy,
      })
      .select("id")
      .single();

    if (!error && run) return run.id as string;

    // 23505 = unique_violation. Anything else is a real failure -- surface it.
    if (error?.code !== "23505") throw new Error(error?.message ?? "Failed to create research run");
  }
  throw new Error("Failed to allocate a research run version after several attempts -- try again.");
}
