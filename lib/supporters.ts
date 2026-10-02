import type { InteractionKind } from "@/lib/interactions";

// STATE item 80, ruling 0034. A supporter is not a prospect -- see
// docs/ledger/rulings/0034-a-supporter-is-not-a-prospect-being-courted.md.
// This module mirrors lib/nurture.ts's architecture deliberately: a PURE
// selection function (no database, no clock -- `now` is a parameter, so the
// boundary cases are testable offline), named/exported/owner-tunable
// thresholds instead of one hidden number, and the same strict (">"),
// never-touched-sorts-first boundary convention lib/nurture.ts already
// established. It does not import from or modify lib/nurture.ts or any
// prospect-side behavior -- ruling 0034 is explicit that the existing
// Nurture queue for prospects is unchanged.

export const SOURCE_TYPES = [
  { value: "event", label: "Event" },
  { value: "website", label: "Website" },
  { value: "other", label: "Other" },
] as const;
export type SupporterSourceType = (typeof SOURCE_TYPES)[number]["value"];
export function sourceTypeLabel(value: string) {
  return SOURCE_TYPES.find((s) => s.value === value)?.label ?? value;
}

export const PLEDGE_FREQUENCIES = [
  { value: "one_time", label: "One-time" },
  { value: "monthly", label: "Monthly" },
  { value: "annual", label: "Annual" },
] as const;
export type PledgeFrequency = (typeof PLEDGE_FREQUENCIES)[number]["value"];
export function pledgeFrequencyLabel(value: string) {
  return PLEDGE_FREQUENCIES.find((f) => f.value === value)?.label ?? value;
}

export type Supporter = {
  id: string;
  organization_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  source_type: SupporterSourceType;
  source_detail: string | null;
  pledged_amount: number | null;
  pledged_frequency: PledgeFrequency | null;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

// Append-only (migration 0078: no update policy, no delete policy, at all).
export type SupporterGift = {
  id: string;
  supporter_id: string;
  amount: number;
  gift_date: string;
  note: string | null;
  recorded_by: string;
  created_at: string;
};

// The supporter-side parallel to lib/interactions.ts's Interaction, same
// kind vocabulary (interaction_kind, migration 0031), its own FK.
export type SupporterInteraction = {
  id: string;
  supporter_id: string;
  kind: InteractionKind;
  summary: string;
  occurred_at: string;
  created_by: string;
  created_at: string;
};

export function formatPledge(supporter: Pick<Supporter, "pledged_amount" | "pledged_frequency">): string {
  if (supporter.pledged_amount == null) return "No pledge on file";
  const amount = `$${supporter.pledged_amount.toLocaleString("en-US")}`;
  if (!supporter.pledged_frequency || supporter.pledged_frequency === "one_time") return `${amount} one-time`;
  return `${amount}/${supporter.pledged_frequency === "monthly" ? "mo" : "yr"}`;
}

// ---------------------------------------------------------------------------
// Tiering. Ruling 0034 clause 3: stewardship care scales with size,
// operationalized as three named, owner-tunable tiers, each its own
// quiet-threshold -- not one fixed number for everyone.
//
// Dollar boundaries (build's reasoned choice, per STATE item 80), stated by
// MONTHLY-EQUIVALENT pledge size:
//   light:    under $25/mo-equivalent
//   standard: $25 to just under $100/mo-equivalent
//   priority: $100/mo-equivalent or more, OR any single ONE-TIME pledge of
//             $1,000 or more
//
// A monthly pledge's monthly-equivalent is itself. An annual pledge's is
// amount / 12 (a $300/yr pledge is the same size of commitment as $25/mo).
// A one-time pledge has no natural "monthly" rate, so below the explicit
// $1,000+ priority carve-out it is normalized the same way an annual pledge
// is (amount / 12) -- a defensible apples-to-apples size comparison rather
// than inventing a fourth scale. The carve-out exists because a four-figure
// one-time gift deserves priority attention even though it will not recur:
// $1,000 / 12 ~= $83/mo, which the formula alone would land in "standard",
// under-weighting a gift that size.
//
// A supporter with no pledge recorded at all (pledged_amount or
// pledged_frequency null/non-positive) is "light" -- the lightest-touch
// tier, not an error -- until the team records a real pledge. This matches
// ruling 0034 clause 2: a pledge the team hasn't captured yet is a legible,
// honest gap, not grounds for guessing a size.
//
// Quiet-thresholds, in days (owner-tunable, same boundary convention as
// lib/nurture.ts's NURTURE_QUIET_DAYS: STRICTLY greater than is quiet; equal
// to the threshold is not yet):
//   light:    365 days -- checked on once a year
//   standard: 180 days -- checked on twice a year
//   priority: 90 days  -- checked on every three months
export const SUPPORTER_TIER_LIGHT_THRESHOLD_DAYS = 365;
export const SUPPORTER_TIER_STANDARD_THRESHOLD_DAYS = 180;
export const SUPPORTER_TIER_PRIORITY_THRESHOLD_DAYS = 90;

export const SUPPORTER_TIER_STANDARD_MIN_MONTHLY_EQUIVALENT = 25;
export const SUPPORTER_TIER_PRIORITY_MIN_MONTHLY_EQUIVALENT = 100;
export const SUPPORTER_TIER_PRIORITY_ONE_TIME_PLEDGE_THRESHOLD = 1000;

export const SUPPORTER_TIERS = [
  { value: "light", label: "Light", thresholdDays: SUPPORTER_TIER_LIGHT_THRESHOLD_DAYS },
  { value: "standard", label: "Standard", thresholdDays: SUPPORTER_TIER_STANDARD_THRESHOLD_DAYS },
  { value: "priority", label: "Priority", thresholdDays: SUPPORTER_TIER_PRIORITY_THRESHOLD_DAYS },
] as const;
export type SupporterTier = (typeof SUPPORTER_TIERS)[number]["value"];
export function supporterTierLabel(tier: SupporterTier) {
  return SUPPORTER_TIERS.find((t) => t.value === tier)!.label;
}
export function supporterTierThresholdDays(tier: SupporterTier) {
  return SUPPORTER_TIERS.find((t) => t.value === tier)!.thresholdDays;
}

function monthlyEquivalent(amount: number, frequency: PledgeFrequency): number {
  if (frequency === "monthly") return amount;
  // one_time and annual are both normalized by spreading over a year -- see
  // the comment above this block for why.
  return amount / 12;
}

// Pure: classifies a pledge into its tier. Exported so the UI can show which
// tier a pledge WOULD land in while a form is being filled out, without
// re-deriving the thresholds.
export function classifySupporterTier(pledgedAmount: number | null, pledgedFrequency: PledgeFrequency | null): SupporterTier {
  if (pledgedAmount == null || pledgedAmount <= 0 || !pledgedFrequency) return "light";
  if (pledgedFrequency === "one_time" && pledgedAmount >= SUPPORTER_TIER_PRIORITY_ONE_TIME_PLEDGE_THRESHOLD) return "priority";
  const eq = monthlyEquivalent(pledgedAmount, pledgedFrequency);
  if (eq >= SUPPORTER_TIER_PRIORITY_MIN_MONTHLY_EQUIVALENT) return "priority";
  if (eq >= SUPPORTER_TIER_STANDARD_MIN_MONTHLY_EQUIVALENT) return "standard";
  return "light";
}

export type SupporterStewardshipRow = {
  supporter: Supporter;
  tier: SupporterTier;
  thresholdDays: number;
  // Whole calendar days since the most recent gift or interaction; null when
  // the supporter has neither ("never touched" is a different fact from "0
  // days", same distinction lib/nurture.ts makes).
  daysSinceLastTouch: number | null;
};

const MS_PER_DAY = 86400000;

// Both gift_date and occurred_at are calendar dates (YYYY-MM-DD); truncating
// to the date keeps both shapes in the same unit. Mirrors lib/nurture.ts's
// utcDay exactly -- duplicated rather than imported so this module has no
// dependency on the prospect-side one, per ruling 0034's separation.
function utcDay(iso: string): number {
  return Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / MS_PER_DAY);
}

// Latest of every gift's gift_date and every interaction's occurred_at, or
// null if the supporter has neither.
function lastTouchDay(gifts: readonly SupporterGift[], interactions: readonly SupporterInteraction[]): number | null {
  let best: number | null = null;
  for (const g of gifts) {
    const d = utcDay(g.gift_date);
    if (!Number.isNaN(d) && (best === null || d > best)) best = d;
  }
  for (const i of interactions) {
    const d = utcDay(i.occurred_at);
    if (!Number.isNaN(d) && (best === null || d > best)) best = d;
  }
  return best;
}

// For display outside the stewardship queue (e.g. the Supporters list, which
// shows every supporter's last touch, not only the overdue ones) -- the same
// derivation the queue uses internally, exposed on its own so the list and
// the queue can never disagree about what "last touch" means.
export function daysSinceSupporterTouch(
  gifts: readonly SupporterGift[],
  interactions: readonly SupporterInteraction[],
  now: Date,
): number | null {
  const last = lastTouchDay(gifts, interactions);
  if (last === null) return null;
  return utcDay(now.toISOString()) - last;
}

// Selection, in order: every supporter's tier is computed from their pledge;
// their last touch is the latest of any gift or any interaction, or null;
// they are included when days-since-last-touch STRICTLY EXCEEDS their own
// tier's threshold (never touched always qualifies, since null never fails
// that check) -- matching lib/nurture.ts's exact boundary convention, just
// evaluated against a per-supporter threshold instead of one global number.
//
// Order: stalest first across the WHOLE queue (not grouped by tier first) --
// a priority supporter 95 days quiet and a light supporter 400 days quiet
// are both overdue by their own clock, and the 400-days case is the more
// neglected relationship, so it leads. Never-touched supporters (no last
// touch at all) sort before every touched one, matching lib/nurture.ts.
// Ties break by name, then id, for a deterministic order.
export function selectSupporterStewardshipQueue(
  supporters: readonly Supporter[],
  giftsBySupporter: Readonly<Record<string, readonly SupporterGift[]>>,
  interactionsBySupporter: Readonly<Record<string, readonly SupporterInteraction[]>>,
  now: Date,
): SupporterStewardshipRow[] {
  const today = utcDay(now.toISOString());
  const rows: SupporterStewardshipRow[] = [];

  for (const supporter of supporters) {
    const tier = classifySupporterTier(supporter.pledged_amount, supporter.pledged_frequency);
    const thresholdDays = supporterTierThresholdDays(tier);

    const last = lastTouchDay(giftsBySupporter[supporter.id] ?? [], interactionsBySupporter[supporter.id] ?? []);
    const days = last === null ? null : today - last;
    if (days !== null && !(days > thresholdDays)) continue;

    rows.push({ supporter, tier, thresholdDays, daysSinceLastTouch: days });
  }

  return rows.sort((a, b) => {
    const da = a.daysSinceLastTouch;
    const db = b.daysSinceLastTouch;
    if (da === null && db !== null) return -1;
    if (da !== null && db === null) return 1;
    if (da !== null && db !== null && da !== db) return db - da;
    return a.supporter.name.localeCompare(b.supporter.name) || a.supporter.id.localeCompare(b.supporter.id);
  });
}

// ---------------------------------------------------------------------------
// CSV bulk import (STATE item 81, ruling 0034 clause 4): the pure per-row
// parse/validate/dedupe step behind importSupportersCsv
// (app/(dashboard)/supporters/actions.ts). Factored out from the server
// action itself -- which, like importCandidatesCsv
// (app/(dashboard)/discovery/actions.ts), the pattern item 81 is required to
// mirror, does real database reads and writes -- so the one thing that
// actually needs proving (what makes a row get skipped, and which bucket it
// lands in) is testable with no database. Same testability discipline this
// file already follows above (classifySupporterTier and the stewardship
// queue take `now` as a parameter for the identical reason).
//
// Required column: name. Optional: email, phone, source_type, source_detail,
// pledged_amount, pledged_frequency, notes.
//
// Invalid-value choice, matched to importCandidatesCsv's OWN precedent for
// an invalid channel, not invented fresh: discovery/actions.ts's
// importCandidatesCsv skips the WHOLE row on an invalid channel --
// `if (!name || !channel || !validChannels.has(channel))` -- it never
// imports the row with the field left null. An invalid source_type or
// pledged_frequency here gets the identical treatment: the row is skipped
// and counted as an error, never imported with that field silently nulled.
// An unparseable or negative pledged_amount is treated the same way, for the
// same reason and for consistency with createSupporter's own rule that a
// negative pledge is rejected, not silently zeroed.
//
// Duplicate matching deliberately does NOT reuse isSameOrg
// (lib/candidate-intake.ts) even though importCandidatesCsv uses it for
// candidates: isSameOrg's substring-containment rule is calibrated for
// ORGANIZATION names, where "Maclellan Foundation" correctly matches "The
// Maclellan Foundation". Applied to PERSON names it would misfire --
// "Jon" is contained in "Jonathan Smith", two different people. A supporter
// name match here is exact (trimmed, case-insensitive); email, when both
// rows have one, is the second signal, also exact and case-insensitive.
export type SupporterCsvOutcome =
  | { kind: "error" }
  | { kind: "duplicate" }
  | {
      kind: "insert";
      supporter: {
        name: string;
        email: string | null;
        phone: string | null;
        source_type: SupporterSourceType;
        source_detail: string | null;
        pledged_amount: number | null;
        pledged_frequency: PledgeFrequency | null;
        notes: string | null;
      };
    };

function normalizeSupporterName(s: string): string {
  return s.trim().toLowerCase();
}

export function parseSupporterCsvRow(
  row: Record<string, string>,
  known: readonly { name: string; email: string | null }[],
): SupporterCsvOutcome {
  const name = (row.name ?? "").trim();
  if (!name) return { kind: "error" };

  const sourceType = (row.source_type ?? "").trim() || "other";
  if (!SOURCE_TYPES.some((s) => s.value === sourceType)) return { kind: "error" };

  const pledgedFrequencyRaw = (row.pledged_frequency ?? "").trim();
  if (pledgedFrequencyRaw && !PLEDGE_FREQUENCIES.some((f) => f.value === pledgedFrequencyRaw)) {
    return { kind: "error" };
  }
  const pledgedFrequency = (pledgedFrequencyRaw || null) as PledgeFrequency | null;

  let pledgedAmount: number | null = null;
  const pledgedAmountRaw = (row.pledged_amount ?? "").trim();
  if (pledgedAmountRaw) {
    const n = Number(pledgedAmountRaw);
    if (!Number.isFinite(n) || n < 0) return { kind: "error" };
    pledgedAmount = n;
  }

  const email = (row.email ?? "").trim() || null;
  const normalizedName = normalizeSupporterName(name);
  const normalizedEmail = email ? email.toLowerCase() : null;
  const isDuplicate = known.some((k) => {
    if (normalizeSupporterName(k.name) === normalizedName) return true;
    if (normalizedEmail && k.email && k.email.toLowerCase() === normalizedEmail) return true;
    return false;
  });
  if (isDuplicate) return { kind: "duplicate" };

  return {
    kind: "insert",
    supporter: {
      name,
      email,
      phone: (row.phone ?? "").trim() || null,
      source_type: sourceType as SupporterSourceType,
      source_detail: (row.source_detail ?? "").trim() || null,
      pledged_amount: pledgedAmount,
      pledged_frequency: pledgedFrequency,
      notes: (row.notes ?? "").trim() || null,
    },
  };
}

// ---------------------------------------------------------------------------
// Gift-history CSV bulk import (STATE item 82, ruling 0034 clauses 2 and 4):
// the pure per-row parse/validate/match step behind importSupporterGiftsCsv
// (app/(dashboard)/supporters/actions.ts). Same separation-of-concerns
// discipline as parseSupporterCsvRow above: no database, no clock, a
// discriminated-union outcome, so the matching and validation rules are
// provable offline.
//
// HARD BOUNDARY, stated plainly because it is easy to blur with item 81's
// supporter importer right above: this function creates NO supporters, ever.
// A row that does not resolve to exactly one EXISTING supporter is an error
// -- never a new supporter, and never a silent skip into nothing.
//
// Required: an identifier -- supporter_email OR supporter_name, at least one
// present and resolving to existing supporters (see matching rule below);
// amount (numeric, > 0); gift_date (a valid calendar date). Optional: note.
//
// Matching rule: if the row carries a non-blank supporter_email, match
// existing supporters by exact case-insensitive email first. Only when that
// yields zero candidates (no email given, or an email given that matches no
// one) does the row fall back to exact case-insensitive supporter_name
// matching -- an email that matches MORE than one existing supporter is
// reported ambiguous directly, it does not also try the name. Zero
// candidates after both steps is "no match"; more than one candidate at
// either step is "ambiguous" -- never guessed, matching parseSupporterCsvRow's
// own exact (not substring/isSameOrg) matching discipline for person names.
//
// Date validation reuses this file's OWN existing precedent rather than
// inventing a second rule: utcDay (above) already treats a gift_date as
// valid only when slicing it to its first 10 characters and parsing as a
// UTC midnight timestamp does not produce NaN. isValidGiftDate below is that
// identical check, factored out so both can use it without one importing
// the other's internals.
export type GiftCsvErrorReason = "no match" | "ambiguous match" | "invalid amount" | "invalid date";

export type GiftCsvOutcome =
  | {
      kind: "insert";
      supporterId: string;
      amount: number;
      giftDate: string;
      note: string | null;
    }
  | { kind: "error"; reason: GiftCsvErrorReason };

// Same rule utcDay (above) applies to gift_date/occurred_at strings, exposed
// standalone so parseGiftCsvRow can validate a row BEFORE it has a known
// supporter_id to key utcDay's per-supporter maps by.
export function isValidGiftDate(raw: string): boolean {
  return !Number.isNaN(Date.parse(`${raw.slice(0, 10)}T00:00:00Z`));
}

export function parseGiftCsvRow(
  row: Record<string, string>,
  existingSupporters: readonly { id: string; name: string; email: string | null }[],
): GiftCsvOutcome {
  const email = (row.supporter_email ?? "").trim();
  const name = (row.supporter_name ?? "").trim();

  let matches: { id: string; name: string; email: string | null }[] = [];
  if (email) {
    const normalizedEmail = email.toLowerCase();
    matches = existingSupporters.filter((s) => s.email && s.email.toLowerCase() === normalizedEmail);
  }
  // Falls back to name matching only when the email step found NOTHING --
  // an email that matched two-plus supporters is reported ambiguous below,
  // it is not given a second chance via name.
  if (matches.length === 0 && name) {
    const normalizedName = normalizeSupporterName(name);
    matches = existingSupporters.filter((s) => normalizeSupporterName(s.name) === normalizedName);
  }

  if (matches.length === 0) return { kind: "error", reason: "no match" };
  if (matches.length > 1) return { kind: "error", reason: "ambiguous match" };

  const amountRaw = (row.amount ?? "").trim();
  const amount = Number(amountRaw);
  if (!amountRaw || !Number.isFinite(amount) || amount <= 0) {
    return { kind: "error", reason: "invalid amount" };
  }

  const giftDateRaw = (row.gift_date ?? "").trim();
  if (!giftDateRaw || !isValidGiftDate(giftDateRaw)) {
    return { kind: "error", reason: "invalid date" };
  }

  return {
    kind: "insert",
    supporterId: matches[0].id,
    amount,
    giftDate: giftDateRaw,
    note: (row.note ?? "").trim() || null,
  };
}
