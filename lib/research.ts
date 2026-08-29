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
  { key: "funding.geographic_focus", category: "Funding profile", label: "Geographic focus", description: "Domestic priority region(s) this funder gives to, e.g. 'primarily Tennessee, Georgia, and Florida' -- not whether it also funds internationally (see international_reach)" },
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
// What a fundraiser needs to know is present, judged on what the run
// OBTAINED rather than on which pages it opened. Reading a page proves
// nothing about whether the wanted information came back.
export const RESEARCH_INFORMATION_SECTIONS = [
  { section: "identity", label: "Identity", keys: ["identity.legal_name", "identity.ein", "identity.location"] },
  { section: "funding_priorities", label: "Funding priorities", keys: ["funding.focus_areas", "funding.geographic_focus", "funding.international_reach", "funding.funder_type"] },
  { section: "financial_capacity", label: "Financial capacity", keys: ["funding.total_assets", "funding.total_annual_giving", "funding.charitable_disbursements", "funding.grant_size_range", "funding.median_grant_size", "funding.grant_count_annual"] },
  { section: "recent_grants", label: "Recent grants", keys: ["funding.recent_grants"] },
  { section: "eligibility", label: "Eligibility", keys: ["application.eligible_org_types", "application.foreign_org_eligibility", "application.fiscal_sponsorship_rules", "application.mission_alignment_requirement", "application.excluded_recipients", "application.prohibited_activities"] },
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

// What Stage 5 checks. Verification costs a model call, so it is pointed at
// the claims a fundraiser would actually act on or be embarrassed by --
// identity, eligibility, restrictions, financial capacity, application
// access, recent giving. Focus areas, funder type and geography are
// deliberately excluded: they are numerous, low-stakes, and a wrong one
// costs a wasted conversation rather than a wasted application.
export const MATERIAL_CLAIM_KEYS = new Set<string>([
  // Identity -- wrong here invalidates everything downstream
  "identity.legal_name",
  "identity.ein",
  "identity.location",
  "identity.website",
  // Eligibility -- whether we can apply at all
  "application.eligible_org_types",
  "application.foreign_org_eligibility",
  "application.fiscal_sponsorship_rules",
  "application.mission_alignment_requirement",
  // Restrictions -- what would disqualify us
  "application.excluded_recipients",
  "application.prohibited_activities",
  // Financial capacity -- whether an ask of our size is plausible
  "funding.total_assets",
  "funding.total_annual_giving",
  "funding.charitable_disbursements",
  "funding.grant_size_range",
  "funding.median_grant_size",
  // Application access -- how and when to approach
  "application.accepts_unsolicited",
  "application.invitation_mechanism",
  "application.submission_method",
  "application.deadline",
  // Recent giving -- evidence of actual behaviour
  "funding.recent_grants",
  "funding.grant_count_annual",
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

  // 2. An EIN stated by an authoritative filing source that also matches the
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

  // 3. An EIN stated on the prospect's own official domain.
  if (prospectWebsite) {
    try {
      const prospectHost = new URL(prospectWebsite).hostname.replace(/^www\./, "");
      for (const s of sources) {
        if (new URL(s.url).hostname.replace(/^www\./, "") !== prospectHost) continue;
        const candidates = Array.from(new Set(sourceEinCandidates(s.url, s.texts)));
        if (candidates.length === 1) return { ein: candidates[0], method: "official_domain" };
      }
    } catch {
      // malformed url -- fall through to unresolved
    }
  }

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
