export const CHANNELS = [
  { value: "foundation", label: "Foundation & Family Trust" },
  { value: "regranting", label: "Regranting Ministry" },
  { value: "christian_business", label: "Christian Business" },
  { value: "denomination", label: "Denomination & Network Fund" },
  { value: "church", label: "Individual Church" },
  { value: "daf", label: "Donor-Advised Fund (DAF)" },
  { value: "major_donor", label: "Major Donor" },
] as const;

export type Channel = (typeof CHANNELS)[number]["value"];

export function channelLabel(channel: string) {
  return CHANNELS.find((c) => c.value === channel)?.label ?? channel;
}

// A cool-toned categorical palette, deliberately clear of red/amber/
// green -- those hues already carry status meaning elsewhere (needs
// review, warning, accepted), so a channel tag never gets misread as
// a status.
const CHANNEL_COLORS: Record<Channel, string> = {
  foundation: "#6366f1",
  regranting: "#0ea5e9",
  christian_business: "#8b5cf6",
  denomination: "#d946ef",
  church: "#14b8a6",
  daf: "#3b82f6",
  major_donor: "#a855f7",
};

export function channelColor(channel: string) {
  return CHANNEL_COLORS[channel as Channel] ?? "#94a3b8";
}

export const STAGES = [
  { value: "discovery", label: "Discovery" },
  { value: "outreach", label: "Outreach" },
  { value: "proposal", label: "Proposal" },
  { value: "decision", label: "Decision" },
  { value: "awarding", label: "Awarding" },
  { value: "stewardship", label: "Stewardship" },
] as const;

export type Stage = (typeof STAGES)[number]["value"];

export function stageLabel(stage: string) {
  return STAGES.find((s) => s.value === stage)?.label ?? stage;
}

// "$25K" / "$1.2M" for tight spaces (compact cards, stat tiles);
// spelled out in full ($25,000) wherever there's room, e.g. the
// prospect detail page.
export function formatAmountCompact(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(amount % 1_000_000 === 0 ? 0 : 1)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(amount % 1_000 === 0 ? 0 : 1)}K`;
  return `$${amount.toLocaleString("en-US")}`;
}

export type Prospect = {
  id: string;
  name: string;
  channel: Channel;
  organization: string | null;
  contact_name: string | null;
  contact_email: string | null;
  website: string | null;
  // Whether `website` is the funder's own site or a third party's page about
  // them. Null means hand-entered or pre-dating source capture, and is
  // trusted. See WEBSITE_STATUSES in lib/candidates.ts.
  website_status: string | null;
  notes: string | null;
  owner_id: string;
  stage: Stage;
  // Authoritative identity, hand-entered or promoted from a research run by
  // an explicit human action (never written automatically -- hard rule 3).
  // A set ein makes the Research Agent's entity resolution deterministic;
  // see resolveRunEntity in lib/research.ts.
  ein: string | null;
  // EINs this prospect previously operated under, after a merger or rename.
  // Supplied by a person -- a merged predecessor and an unrelated namesake are
  // indistinguishable in search results, so this is knowledge, not inference.
  predecessor_eins: string[] | null;
  // A human-supplied detail that identifies this funder when its name is
  // ambiguous. Reaches the research search verbatim.
  identity_hint: string | null;
  // WHICH ORGANIZATION a person confirmed this is -- the operating layer.
  // Deliberately parallel to ein/predecessor_eins and never merged with them:
  // recognising a funder's own website is a thing a fundraiser can do, and
  // recognising its EIN is not.
  operating_identity_domain: string | null;
  operating_identity_name: string | null;
  operating_identity_confirmed_at: string | null;
  operating_identity_confirmed_by: string | null;
  legal_name: string | null;
  aliases: string[] | null;
  // Funder intelligence -- populated from AI research when
  // a human approves the strategy, not hand-entered.
  location: string | null;
  funder_type: string | null;
  geographic_focus: string | null;
  typical_grant_size: string | null;
  focus_areas: string[] | null;
  ask_amount: number | null;
  next_action: string | null;
  next_action_due: string | null;
  // AI-suggested next step -- a proposal, never applied automatically.
  // See suggestNextStep/useSuggestedNextStep in
  // app/(dashboard)/revisit/actions.ts.
  suggested_next_action: string | null;
  suggested_next_action_due: string | null;
  suggested_reasoning: string | null;
  suggested_at: string | null;
  created_at: string;
  updated_at: string;
};

export const HEALTH_STATUSES = ["on_track", "due_soon", "stalled"] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export function healthStatusLabel(status: HealthStatus) {
  if (status === "on_track") return "On track";
  if (status === "due_soon") return "Due soon";
  return "Stalled";
}

const DUE_SOON_WINDOW_DAYS = 3;

// Derived from next_action_due rather than stored -- a health label
// that isn't recomputed against "today" every render would silently
// go stale the moment a day passes. No next action set at all means
// no status to show, not a false "on track".
export function computeHealthStatus(nextActionDue: string | null): HealthStatus | null {
  if (!nextActionDue) return null;
  const due = new Date(nextActionDue + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysUntilDue = (due.getTime() - today.getTime()) / 86400000;
  if (daysUntilDue < 0) return "stalled";
  if (daysUntilDue <= DUE_SOON_WINDOW_DAYS) return "due_soon";
  return "on_track";
}

export type StageChange = {
  id: string;
  prospect_id: string;
  from_stage: Stage;
  to_stage: Stage;
  changed_by: string;
  changed_by_email: string;
  note: string | null;
  created_at: string;
};

// ---------------------------------------------------------------------------
// Giving history (STATE item 83, ruling 0035): the institutional-funder half
// of the append-only gift ledger ruling 0034 already settled for individual
// supporters (lib/supporters.ts's SupporterGift/parseGiftCsvRow). Mirrored
// field-for-field, keyed to prospects instead of supporters -- see migration
// 0079 (prospect_gifts): INSERT and SELECT only, no update, no delete.
export type ProspectGift = {
  id: string;
  prospect_id: string;
  amount: number;
  gift_date: string;
  note: string | null;
  recorded_by: string;
  created_at: string;
};

// ---------------------------------------------------------------------------
// Gift-history CSV bulk import (STATE item 83, ruling 0035): the pure
// per-row parse/validate/match step behind importProspectGiftsCsv
// (app/(dashboard)/prospects/actions.ts). Mirrors lib/supporters.ts's
// parseGiftCsvRow exactly -- same matching discipline, same named error
// reasons, same isValidGiftDate-style helper -- with one deliberate
// difference: prospects don't carry a plain "email" column the way
// supporters do, they carry contact_email, so the identifier columns here are
// prospect_name / prospect_email and the match is against contact_email, not
// email.
//
// HARD BOUNDARY, stated plainly because it is easy to blur with a hypothetical
// prospect-creating importer: this function creates NO prospects, ever. A row
// that does not resolve to exactly one EXISTING prospect is an error -- never
// a new prospect, and never a silent skip into nothing.
//
// Required: an identifier -- prospect_email OR prospect_name, at least one
// present and resolving to existing prospects (see matching rule below);
// amount (numeric, > 0); gift_date (a valid calendar date). Optional: note.
//
// Matching rule: if the row carries a non-blank prospect_email, match
// existing prospects by exact case-insensitive contact_email first. Only
// when that yields zero candidates (no email given, or an email given that
// matches no one) does the row fall back to exact case-insensitive
// prospect_name matching -- an email that matches MORE than one existing
// prospect is reported ambiguous directly, it does not also try the name.
// Zero candidates after both steps is "no match"; more than one candidate at
// either step is "ambiguous" -- never guessed, matching parseGiftCsvRow's own
// exact (not substring/isSameOrg) matching discipline for person/entity
// names.
//
// Date validation reuses the identical rule lib/supporters.ts's
// isValidGiftDate established: valid only when slicing the raw value to its
// first 10 characters and parsing as a UTC midnight timestamp does not
// produce NaN. isValidProspectGiftDate is that same check, factored out here
// so this module has no dependency on lib/supporters.ts, per ruling 0035
// clause 2's separation (a prospect and a supporter are genuinely different
// entities, and this module does not import from or modify lib/supporters.ts
// or anything supporter-side).
export type ProspectGiftCsvErrorReason = "no match" | "ambiguous match" | "invalid amount" | "invalid date";

export type ProspectGiftCsvOutcome =
  | {
      kind: "insert";
      prospectId: string;
      amount: number;
      giftDate: string;
      note: string | null;
    }
  | { kind: "error"; reason: ProspectGiftCsvErrorReason };

export function isValidProspectGiftDate(raw: string): boolean {
  return !Number.isNaN(Date.parse(`${raw.slice(0, 10)}T00:00:00Z`));
}

function normalizeProspectName(s: string): string {
  return s.trim().toLowerCase();
}

export function parseProspectGiftCsvRow(
  row: Record<string, string>,
  existingProspects: readonly { id: string; name: string; contact_email: string | null }[],
): ProspectGiftCsvOutcome {
  const email = (row.prospect_email ?? "").trim();
  const name = (row.prospect_name ?? "").trim();

  let matches: { id: string; name: string; contact_email: string | null }[] = [];
  if (email) {
    const normalizedEmail = email.toLowerCase();
    matches = existingProspects.filter((p) => p.contact_email && p.contact_email.toLowerCase() === normalizedEmail);
  }
  // Falls back to name matching only when the email step found NOTHING -- an
  // email that matched two-plus prospects is reported ambiguous below, it is
  // not given a second chance via name.
  if (matches.length === 0 && name) {
    const normalizedName = normalizeProspectName(name);
    matches = existingProspects.filter((p) => normalizeProspectName(p.name) === normalizedName);
  }

  if (matches.length === 0) return { kind: "error", reason: "no match" };
  if (matches.length > 1) return { kind: "error", reason: "ambiguous match" };

  const amountRaw = (row.amount ?? "").trim();
  const amount = Number(amountRaw);
  if (!amountRaw || !Number.isFinite(amount) || amount <= 0) {
    return { kind: "error", reason: "invalid amount" };
  }

  const giftDateRaw = (row.gift_date ?? "").trim();
  if (!giftDateRaw || !isValidProspectGiftDate(giftDateRaw)) {
    return { kind: "error", reason: "invalid date" };
  }

  return {
    kind: "insert",
    prospectId: matches[0].id,
    amount,
    giftDate: giftDateRaw,
    note: (row.note ?? "").trim() || null,
  };
}
