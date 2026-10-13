// The assistant's reads (STATE item 87, ruling 0037 clauses 1, 3 and 5).
//
// Three properties, each enforced in code rather than asked of the model:
//
//   1. Session client only. Every read goes through the client handed in --
//      the signed-in user's own cookie-session client -- so a member sees
//      through the assistant exactly what they see on the page (clause 1).
//      This file never imports a service-role client; a source scan asserts
//      it.
//
//   2. A fixed projection per ability (clause 5). Each read selects named
//      columns (never `*` of a contact-bearing table), builds its result
//      from a hand-written projection, and the dispatcher strips any key not
//      on the ability's allowlist as a second line. No email address, phone
//      number, free-text note, interaction summary, network connection or
//      supporter pledge particular appears in any result. A supporter's
//      pledge is READ only to compute its tier label and is never emitted.
//
//   3. Figures come from here, not from the model's sentence (clause 3).
//      Every read returns a `modelResult` (what the model is shown) AND a
//      `card` (what the client renders), both built from the same projected
//      data in the same function, so they cannot disagree.
//
// The numbers reuse the platform's existing pure functions
// (countStrategiesReadyForReview, isClosedToWork, isRevisitDue,
// computeHealthStatus, selectNurtureQueue, selectSupporterStewardshipQueue,
// totalForecastAmount). The dashboard and follow-up pages compute some of
// their numbers inline; the filters below MIRROR those pages and
// scripts/test-assistant.ts pins the equivalences and scans the pages for
// drift. STATE item 90 would extract one shared module.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  STAGES,
  CHANNELS,
  channelLabel,
  stageLabel,
  formatAmountCompact,
  computeHealthStatus,
  healthStatusLabel,
  type Prospect,
} from "@/lib/prospects";
import { countStrategiesReadyForReview } from "@/lib/strategy";
import { loadOutcomeIndex, loadProspectOutcome, isClosedToWork, isRevisitDue, describeDisposition, type ProspectOutcome } from "@/lib/prospect-outcomes";
import { selectNurtureQueue, NURTURE_QUIET_DAYS } from "@/lib/nurture";
import {
  selectSupporterStewardshipQueue,
  totalForecastAmount,
  supporterTierLabel,
  type Supporter,
  type SupporterGift,
  type SupporterInteraction,
} from "@/lib/supporters";
import { loadApprovedIntelligence } from "@/lib/prospect-intelligence";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import type { Interaction } from "@/lib/interactions";
import { draftKindLabel } from "@/lib/drafts";
import type { Card, CardRow, DraftReviewItem, Result } from "./types";
import { draftFingerprint, normalizeIntel, normalizeStrategy, strategyFingerprint } from "./fingerprint";
import { asEnum, asIntInRange, asOptionalBoundedString, asUuid, rejectUnknownKeys } from "./validate";

const MS_PER_DAY = 86400000;

// Row caps. Each is a number of rows the model is shown; the true total is
// always reported beside it so a capped list never reads as the whole.
export const MAX_LIST_ROWS = 20;
export const MAX_SEARCH_ROWS = 25;
export const MAX_CLAIMS = 12;
export const MAX_CLAIM_CHARS = 300;
export const MAX_NAME_CHARS = 120;
export const MAX_ACTION_CHARS = 200;
export const RECENT_LIMIT = 8;

export type ReadOutcome =
  | { ok: true; modelResult: Record<string, unknown>; card: Card }
  | { ok: false; error: string };

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Every row, not the first thousand. PostgREST caps an unbounded select at
// 1000 rows with no error and no marker (see lib/fetch-all-rows.ts), and a
// short list read as complete is how a quiet-supporters answer goes wrong
// without anyone seeing it. The pages this file mirrors do not page; where the
// two differ, this one is the one that is right, and STATE item 90 would move
// the pages onto the same read. Ordered by id so pages of the scan are stable.
async function selectAll(
  supabase: SupabaseClient,
  table: string,
  columns: string
): Promise<{ data: Record<string, unknown>[] | null; error: { message: string } | null }> {
  try {
    const rows = await fetchAllRows<Record<string, unknown>>(
      // The builder is structurally what fetchAllRows needs (rangeable and
      // awaitable); its generic signature is deliberately not restated here.
      () => supabase.from(table).select(columns).order("id", { ascending: true }) as never,
      null,
      `assistant read of ${table}`
    );
    return { data: rows, error: null };
  } catch (err) {
    return { data: null, error: { message: err instanceof Error ? err.message : "read failed" } };
  }
}

function readFailed(what: string): { ok: false; error: string } {
  // Not "zero results": a failed read is "not evaluated", and the model is
  // told so rather than shown an empty list it would read as a clean answer.
  return { ok: false, error: `Could not read ${what} just now, so no answer was produced for it.` };
}

// Every prospect's id and name, for the one question add_prospect asks before
// it writes: is there already a prospect by this exact name? Paged like every
// other whole-table read here; the comparison is done in code, never by
// interpolating a model's text into a PostgREST filter.
export async function listProspectNames(
  supabase: SupabaseClient
): Promise<{ ok: true; rows: { id: string; name: string }[] } | { ok: false }> {
  const { data, error } = await selectAll(supabase, "prospects", "id, name");
  if (error) return { ok: false };
  return { ok: true, rows: ((data ?? []) as { id: string; name: string }[]).map((r) => ({ id: r.id, name: String(r.name) })) };
}

// --- Pure selectors (the offline-pinnable mirror of the pages) ---------------

export type ProspectDue = { id: string; next_action_due: string | null };

// The dashboard's "Follow-ups due" figure: next_action_due within
// [today, today+days], excluding prospects closed to work. Mirrors
// app/(dashboard)/dashboard/page.tsx (dueThisWeekProspects filter + the
// isClosedToWork pass).
export function countFollowUpsDueWithin(
  prospects: readonly ProspectDue[],
  outcomeIndex: ReadonlyMap<string, ProspectOutcome>,
  now: Date,
  days: number
): number {
  const todayStr = now.toISOString().slice(0, 10);
  const outStr = new Date(now.getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
  return prospects.filter(
    (p) => p.next_action_due !== null && p.next_action_due >= todayStr && p.next_action_due <= outStr && !isClosedToWork(outcomeIndex.get(p.id))
  ).length;
}

// The Follow-up page's "Due now" list (app/(dashboard)/revisit/page.tsx
// `dueNow`): not closed to work, not itself a due revisit (those are listed
// as revisits), and health due_soon or stalled.
export function selectDueNow<T extends ProspectDue>(
  prospects: readonly T[],
  outcomeIndex: ReadonlyMap<string, ProspectOutcome>,
  todayIso: string
): T[] {
  return prospects.filter((p) => {
    if (isClosedToWork(outcomeIndex.get(p.id))) return false;
    const outcome = outcomeIndex.get(p.id);
    if (outcome != null && isRevisitDue(outcome, todayIso)) return false;
    const h = computeHealthStatus(p.next_action_due);
    return h === "due_soon" || h === "stalled";
  });
}

// The page's `dueRevisits`: every prospect with an outcome in effect whose
// revisit date has arrived.
export function selectRevisitsDue<T extends { id: string }>(
  prospects: readonly T[],
  outcomeIndex: ReadonlyMap<string, ProspectOutcome>,
  todayIso: string
): { prospect: T; revisitOn: string }[] {
  const out: { prospect: T; revisitOn: string }[] = [];
  for (const p of prospects) {
    const outcome = outcomeIndex.get(p.id);
    if (outcome && isRevisitDue(outcome, todayIso) && outcome.current.revisitOn) {
      out.push({ prospect: p, revisitOn: outcome.current.revisitOn });
    }
  }
  return out;
}

// --- get_dashboard_summary ---------------------------------------------------

export const DASHBOARD_SUMMARY_ALLOWLIST = [
  "asOf",
  "opportunitiesPending",
  "activeProspects",
  "followUpsDueNext7Days",
  "strategiesAwaitingReview",
  "supporters",
  "supporterForecastAnnualAmount",
  "pipelineTotalPotentialAmount",
  "pipelineByStage",
  "stage",
  "count",
  "potentialAmount",
] as const;

export function validateNoArgs(raw: Record<string, unknown>): Result<Record<string, never>> {
  const unknown = rejectUnknownKeys(raw, []);
  if (unknown) return { ok: false, error: unknown };
  return { ok: true, value: {} };
}

export async function getDashboardSummary(supabase: SupabaseClient, now: Date): Promise<ReadOutcome> {
  const todayStr = now.toISOString().slice(0, 10);

  const [pending, readyForReview, prospectsRes, dueRes, outcomeIndex, supportersRes] = await Promise.all([
    supabase.from("candidates").select("id", { count: "exact", head: true }).eq("status", "pending"),
    countStrategiesReadyForReview(supabase),
    selectAll(supabase, "prospects", "id, stage, ask_amount"),
    selectAll(supabase, "prospects", "id, next_action_due"),
    loadOutcomeIndex(supabase),
    // pledged_amount/pledged_frequency feed only the aggregate forecast
    // total; no row-level pledge is ever emitted.
    selectAll(supabase, "supporters", "id, pledged_amount, pledged_frequency"),
  ]);
  if (pending.error) return readFailed("the opportunity count");
  if (prospectsRes.error) return readFailed("the pipeline");
  if (dueRes.error) return readFailed("the follow-up dates");
  if (supportersRes.error) return readFailed("the supporters");

  const prospects = (prospectsRes.data ?? []) as { id: string; stage: string; ask_amount: number | null }[];
  const byStage = STAGES.map((s) => {
    const inStage = prospects.filter((p) => p.stage === s.value);
    return {
      stage: s.label,
      count: inStage.length,
      potentialAmount: inStage.reduce((sum, p) => sum + (p.ask_amount ?? 0), 0),
    };
  });
  const totalPotential = prospects.reduce((sum, p) => sum + (p.ask_amount ?? 0), 0);
  const supporters = (supportersRes.data ?? []) as Pick<Supporter, "pledged_amount" | "pledged_frequency">[];
  const forecast = totalForecastAmount(supporters);
  const followUps = countFollowUpsDueWithin((dueRes.data ?? []) as ProspectDue[], outcomeIndex, now, 7);

  const modelResult = {
    asOf: todayStr,
    opportunitiesPending: pending.count ?? 0,
    activeProspects: prospects.length,
    followUpsDueNext7Days: followUps,
    strategiesAwaitingReview: readyForReview,
    supporters: supporters.length,
    supporterForecastAnnualAmount: forecast,
    pipelineTotalPotentialAmount: totalPotential,
    pipelineByStage: byStage,
  };

  const card: Card = {
    kind: "facts",
    ability: "get_dashboard_summary",
    title: `Dashboard summary, as of ${todayStr}`,
    items: [
      { label: "New opportunities waiting", value: String(modelResult.opportunitiesPending) },
      { label: "Active prospects", value: String(modelResult.activeProspects) },
      { label: "Follow-ups due in the next 7 days", value: String(followUps) },
      { label: "Strategies awaiting review", value: String(readyForReview) },
      { label: "Supporters", value: String(supporters.length) },
      { label: "Supporter forecast (projected annual giving, not yet collected)", value: formatAmountCompact(forecast) },
      { label: "Total pipeline potential", value: formatAmountCompact(totalPotential) },
      ...byStage.map((s) => ({
        label: `${s.stage} stage`,
        value: `${s.count} prospect${s.count === 1 ? "" : "s"}${s.potentialAmount > 0 ? ` · ${formatAmountCompact(s.potentialAmount)}` : ""}`,
      })),
    ],
    note: "Figures are read from your data and match the Dashboard.",
  };
  return { ok: true, modelResult, card };
}

// --- list_followups_due ------------------------------------------------------

export const FOLLOWUPS_ALLOWLIST = [
  "asOf",
  "dueNowTotal",
  "dueNow",
  "revisitsDueTotal",
  "revisitsDue",
  "goneQuietTotal",
  "goneQuietAfterDays",
  "goneQuiet",
  "prospectId",
  "name",
  "stage",
  "nextAction",
  "nextActionDue",
  "health",
  "revisitOn",
  "daysSinceLastTouch",
] as const;

export async function listFollowUpsDue(supabase: SupabaseClient, now: Date): Promise<ReadOutcome> {
  const todayIso = now.toISOString().slice(0, 10);
  const [prospectsRes, interactionsRes, outcomeIndex] = await Promise.all([
    selectAll(supabase, "prospects", "id, name, stage, next_action, next_action_due"),
    // No summary column: the nurture derivation needs only the dates.
    selectAll(supabase, "interactions", "id, prospect_id, kind, occurred_at, created_at"),
    loadOutcomeIndex(supabase),
  ]);
  if (prospectsRes.error) return readFailed("the pipeline");
  if (interactionsRes.error) return readFailed("the interaction dates");

  type Row = { id: string; name: string; stage: string; next_action: string | null; next_action_due: string | null };
  const prospects = (prospectsRes.data ?? []) as Row[];

  const dueNowAll = selectDueNow(prospects, outcomeIndex, todayIso).sort(
    (a, b) => (a.next_action_due ?? "").localeCompare(b.next_action_due ?? "") || a.name.localeCompare(b.name)
  );
  const revisitsAll = selectRevisitsDue(prospects, outcomeIndex, todayIso).sort(
    (a, b) => a.revisitOn.localeCompare(b.revisitOn) || a.prospect.name.localeCompare(b.prospect.name)
  );

  const byProspect: Record<string, Interaction[]> = {};
  for (const i of (interactionsRes.data ?? []) as Omit<Interaction, "summary" | "created_by">[]) {
    (byProspect[i.prospect_id] ??= []).push({ ...i, summary: "", created_by: "" });
  }
  const quietAll = selectNurtureQueue(prospects as unknown as Prospect[], byProspect, outcomeIndex, now);

  const dueNow = dueNowAll.slice(0, MAX_LIST_ROWS).map((p) => ({
    prospectId: p.id,
    name: clip(p.name, MAX_NAME_CHARS),
    stage: stageLabel(p.stage),
    nextAction: p.next_action ? clip(p.next_action, MAX_ACTION_CHARS) : null,
    nextActionDue: p.next_action_due,
    health: (() => {
      const h = computeHealthStatus(p.next_action_due);
      return h ? healthStatusLabel(h) : null;
    })(),
  }));
  const revisitsDue = revisitsAll.slice(0, MAX_LIST_ROWS).map((r) => ({
    prospectId: r.prospect.id,
    name: clip(r.prospect.name, MAX_NAME_CHARS),
    revisitOn: r.revisitOn,
  }));
  const goneQuiet = quietAll.slice(0, MAX_LIST_ROWS).map((q) => ({
    prospectId: q.prospect.id,
    name: clip(q.prospect.name, MAX_NAME_CHARS),
    stage: stageLabel(q.prospect.stage),
    daysSinceLastTouch: q.daysSinceLastTouch,
  }));

  const modelResult = {
    asOf: todayIso,
    dueNowTotal: dueNowAll.length,
    dueNow,
    revisitsDueTotal: revisitsAll.length,
    revisitsDue,
    goneQuietTotal: quietAll.length,
    goneQuietAfterDays: NURTURE_QUIET_DAYS,
    goneQuiet,
  };

  const rows: CardRow[] = [
    ...dueNow.map((r) => ({
      title: r.name,
      detail: `${r.nextAction ?? "No next action written"}${r.nextActionDue ? ` · due ${r.nextActionDue}` : ""}`,
      meta: [r.stage, r.health].filter(Boolean).join(" · "),
      href: `/prospects/${r.prospectId}`,
    })),
    ...revisitsDue.map((r) => ({
      title: r.name,
      detail: `Declined funder — revisit date ${r.revisitOn} has arrived`,
      meta: "Revisit due",
      href: `/prospects/${r.prospectId}`,
    })),
    ...goneQuiet.map((r) => ({
      title: r.name,
      detail:
        r.daysSinceLastTouch === null
          ? "No contact on record since they said yes"
          : `${r.daysSinceLastTouch} days since the last contact (quiet after ${NURTURE_QUIET_DAYS})`,
      meta: `${r.stage} · gone quiet`,
      href: `/prospects/${r.prospectId}`,
    })),
  ];
  const total = dueNowAll.length + revisitsAll.length + quietAll.length;
  const card: Card = {
    kind: "rows",
    ability: "list_followups_due",
    title: "Follow-ups",
    rows,
    total,
    emptyText: "Nothing is due or has gone quiet.",
    note: `Due now: ${dueNowAll.length} · Revisits due: ${revisitsAll.length} · Gone quiet: ${quietAll.length}.${
      total > rows.length ? ` Showing the first ${MAX_LIST_ROWS} of each.` : ""
    }`,
  };
  return { ok: true, modelResult, card };
}

// --- list_supporters_needing_stewardship -------------------------------------

export const SUPPORTER_STEWARDSHIP_ALLOWLIST = ["asOf", "total", "supporters", "supporterId", "name", "tier", "daysSinceLastTouch", "quietAfterDays"] as const;

export async function listSupportersNeedingStewardship(supabase: SupabaseClient, now: Date): Promise<ReadOutcome> {
  const [supportersRes, giftsRes, interactionsRes] = await Promise.all([
    // email, phone, notes, source_detail are deliberately not selected.
    selectAll(supabase, "supporters", "id, name, pledged_amount, pledged_frequency"),
    selectAll(supabase, "supporter_gifts", "id, supporter_id, gift_date"),
    selectAll(supabase, "supporter_interactions", "id, supporter_id, occurred_at"),
  ]);
  if (supportersRes.error) return readFailed("the supporters");
  if (giftsRes.error) return readFailed("the supporters' gift dates");
  if (interactionsRes.error) return readFailed("the supporters' contact dates");

  const supporters = ((supportersRes.data ?? []) as { id: string; name: string; pledged_amount: number | null; pledged_frequency: Supporter["pledged_frequency"] }[]).map(
    (s) => s as unknown as Supporter
  );
  const gifts: Record<string, SupporterGift[]> = {};
  for (const g of (giftsRes.data ?? []) as { supporter_id: string; gift_date: string }[]) {
    (gifts[g.supporter_id] ??= []).push(g as unknown as SupporterGift);
  }
  const interactions: Record<string, SupporterInteraction[]> = {};
  for (const i of (interactionsRes.data ?? []) as { supporter_id: string; occurred_at: string }[]) {
    (interactions[i.supporter_id] ??= []).push(i as unknown as SupporterInteraction);
  }

  const queue = selectSupporterStewardshipQueue(supporters, gifts, interactions, now);
  const shown = queue.slice(0, MAX_LIST_ROWS).map((r) => ({
    supporterId: r.supporter.id,
    name: clip(r.supporter.name, MAX_NAME_CHARS),
    tier: supporterTierLabel(r.tier),
    daysSinceLastTouch: r.daysSinceLastTouch,
    quietAfterDays: r.thresholdDays,
  }));
  const asOf = now.toISOString().slice(0, 10);
  const modelResult = { asOf, total: queue.length, supporters: shown };
  const card: Card = {
    kind: "rows",
    ability: "list_supporters_needing_stewardship",
    title: "Supporters who have gone quiet",
    rows: shown.map((s) => ({
      title: s.name,
      detail:
        s.daysSinceLastTouch === null
          ? "No gift or contact on record"
          : `${s.daysSinceLastTouch} days since the last gift or contact (quiet after ${s.quietAfterDays})`,
      meta: `${s.tier} tier`,
      href: "/supporters",
    })),
    total: queue.length,
    emptyText: "No supporter is overdue for a touch.",
    note: queue.length > shown.length ? `Showing the first ${shown.length} of ${queue.length}, quietest first.` : undefined,
  };
  return { ok: true, modelResult, card };
}

// --- search_prospects --------------------------------------------------------

export const SEARCH_PROSPECTS_ALLOWLIST = ["total", "shown", "prospects", "prospectId", "name", "channel", "stage"] as const;

export type SearchProspectsArgs = { query: string | null; stage: string | null; channel: string | null; limit: number };

const STAGE_VALUES = STAGES.map((s) => s.value) as readonly string[];
const CHANNEL_VALUES = CHANNELS.map((c) => c.value) as readonly string[];

export function validateSearchProspects(raw: Record<string, unknown>): Result<SearchProspectsArgs> {
  const unknown = rejectUnknownKeys(raw, ["query", "stage", "channel", "limit"]);
  if (unknown) return { ok: false, error: unknown };
  const query = asOptionalBoundedString(raw.query, "query", { max: 80 });
  if (!query.ok) return query;
  let stage: string | null = null;
  if (raw.stage !== undefined && raw.stage !== null && raw.stage !== "") {
    const s = asEnum(raw.stage, "stage", STAGE_VALUES);
    if (!s.ok) return s;
    stage = s.value;
  }
  let channel: string | null = null;
  if (raw.channel !== undefined && raw.channel !== null && raw.channel !== "") {
    const c = asEnum(raw.channel, "channel", CHANNEL_VALUES);
    if (!c.ok) return c;
    channel = c.value;
  }
  const limit = asIntInRange(raw.limit, "limit", { min: 1, max: MAX_SEARCH_ROWS, fallback: 10 });
  if (!limit.ok) return limit;
  return { ok: true, value: { query: query.value, stage, channel, limit: limit.value } };
}

export async function searchProspects(supabase: SupabaseClient, args: SearchProspectsArgs): Promise<ReadOutcome> {
  // Filtering happens here, after a column-limited read, rather than by
  // interpolating model text into a PostgREST filter.
  const { data, error } = await selectAll(supabase, "prospects", "id, name, channel, stage");
  if (error) return readFailed("the prospects");
  const needle = args.query?.toLowerCase() ?? null;
  const matches = ((data ?? []) as { id: string; name: string; channel: string; stage: string }[])
    .filter((p) => (needle ? p.name.toLowerCase().includes(needle) : true))
    .filter((p) => (args.stage ? p.stage === args.stage : true))
    .filter((p) => (args.channel ? p.channel === args.channel : true))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const shown = matches.slice(0, args.limit).map((p) => ({
    prospectId: p.id,
    name: clip(p.name, MAX_NAME_CHARS),
    channel: channelLabel(p.channel),
    stage: stageLabel(p.stage),
  }));
  const modelResult = { total: matches.length, shown: shown.length, prospects: shown };
  const card: Card = {
    kind: "rows",
    ability: "search_prospects",
    title: args.query ? `Prospects matching "${args.query}"` : "Prospects",
    rows: shown.map((p) => ({ title: p.name, detail: p.channel, meta: p.stage, href: `/prospects/${p.prospectId}` })),
    total: matches.length,
    emptyText: "No prospect matches.",
    note: matches.length > shown.length ? `Showing ${shown.length} of ${matches.length}.` : undefined,
  };
  return { ok: true, modelResult, card };
}

// --- get_prospect ------------------------------------------------------------

export const GET_PROSPECT_ALLOWLIST = [
  "prospectId",
  "name",
  "channel",
  "stage",
  "askAmount",
  "nextAction",
  "nextActionDue",
  "health",
  "outcome",
  "researchAvailable",
  "researchClaims",
  "researchClaimsOmitted",
  "claimKey",
  "claim",
  "reportingPeriod",
  "humanDecided",
] as const;

export type GetProspectArgs = { prospectId: string };

export function validateGetProspect(raw: Record<string, unknown>): Result<GetProspectArgs> {
  const unknown = rejectUnknownKeys(raw, ["prospect_id"]);
  if (unknown) return { ok: false, error: unknown };
  const id = asUuid(raw.prospect_id, "prospect_id");
  if (!id.ok) return id;
  return { ok: true, value: { prospectId: id.value } };
}

export async function getProspect(
  supabase: SupabaseClient,
  args: GetProspectArgs,
  // Injected so the claim projection can be exercised offline; the default is
  // the platform's own loader, which returns nothing until the funder's
  // identity is resolved.
  deps: { loadIntelligence?: typeof loadApprovedIntelligence } = {}
): Promise<ReadOutcome> {
  const loadIntelligence = deps.loadIntelligence ?? loadApprovedIntelligence;
  // Column-limited: contact_name, contact_email, notes, website and every
  // identity column stay in the database.
  const { data: row, error } = await supabase
    .from("prospects")
    .select("id, name, channel, stage, ask_amount, next_action, next_action_due")
    .eq("id", args.prospectId)
    .maybeSingle();
  if (error) return readFailed("that prospect");
  // An id the session cannot see is "not found" -- RLS decides, and the
  // answer is the same whether it does not exist or belongs to someone else.
  if (!row) return { ok: false, error: "No prospect with that id was found." };
  const p = row as { id: string; name: string; channel: string; stage: string; ask_amount: number | null; next_action: string | null; next_action_due: string | null };

  const [outcomeView, approved] = await Promise.all([
    loadProspectOutcome(supabase, p.id),
    loadIntelligence(supabase, p.id),
  ]);
  const outcome = outcomeView.effective ? `Declined · ${describeDisposition(outcomeView.effective.current).label}` : null;

  // Only claims that are confirmed enough to be stated as research: the
  // advisory ones ("unconfirmed context") are not returned -- they carry a
  // limitation label this projection would otherwise drop, and a claim shown
  // to the model without its caveat reads as fact. Four fields per claim.
  const confirmed = (approved?.claims ?? []).filter((c) => !c.advisory);
  const claims = confirmed.slice(0, MAX_CLAIMS).map((c) => ({
    claimKey: c.claimKey,
    claim: clip(c.claim, MAX_CLAIM_CHARS),
    reportingPeriod: c.reportingPeriod,
    humanDecided: c.humanDecided,
  }));
  const health = computeHealthStatus(p.next_action_due);

  const modelResult = {
    prospectId: p.id,
    name: clip(p.name, MAX_NAME_CHARS),
    channel: channelLabel(p.channel),
    stage: stageLabel(p.stage),
    askAmount: p.ask_amount,
    nextAction: p.next_action ? clip(p.next_action, MAX_ACTION_CHARS) : null,
    nextActionDue: p.next_action_due,
    health: health ? healthStatusLabel(health) : null,
    outcome,
    researchAvailable: approved !== null,
    researchClaims: claims,
    researchClaimsOmitted: Math.max(0, confirmed.length - claims.length),
  };

  const items: { label: string; value: string }[] = [
    { label: "Name", value: modelResult.name },
    { label: "Channel", value: modelResult.channel },
    { label: "Stage", value: modelResult.stage },
    { label: "Ask amount", value: p.ask_amount !== null ? formatAmountCompact(p.ask_amount) : "Not set" },
    { label: "Next action", value: modelResult.nextAction ?? "Not set" },
    { label: "Next action due", value: p.next_action_due ?? "Not set" },
    { label: "Health", value: modelResult.health ?? "No due date" },
  ];
  if (outcome) items.push({ label: "Outcome", value: outcome });
  items.push({
    label: "Confirmed research",
    value:
      approved === null
        ? "None yet — research has not been confirmed for this funder"
        : claims.length === 0
          ? "Research is confirmed, no claims cleared for use"
          : `${claims.length} claim${claims.length === 1 ? "" : "s"}${modelResult.researchClaimsOmitted > 0 ? ` shown, ${modelResult.researchClaimsOmitted} more not shown` : ""}`,
  });
  for (const c of claims) {
    items.push({
      label: c.claimKey,
      value: `${c.claim}${c.reportingPeriod ? ` (${c.reportingPeriod})` : ""}${c.humanDecided ? " · reviewed by a person" : ""}`,
    });
  }
  const card: Card = {
    kind: "facts",
    ability: "get_prospect",
    title: modelResult.name,
    items,
    href: `/prospects/${p.id}`,
  };
  return { ok: true, modelResult, card };
}

// --- list_recent_activity ----------------------------------------------------

export const RECENT_ACTIVITY_ALLOWLIST = [
  "searchRuns",
  "reviewedCandidates",
  "channel",
  "status",
  "foundCount",
  "startedAt",
  "name",
  "updatedAt",
] as const;

export async function listRecentActivity(supabase: SupabaseClient): Promise<ReadOutcome> {
  const [runsRes, reviewedRes] = await Promise.all([
    supabase
      .from("discovery_search_runs")
      .select("channel, status, found_count, created_at")
      .order("created_at", { ascending: false })
      .limit(RECENT_LIMIT),
    supabase
      .from("candidates")
      .select("name, status, channel, updated_at")
      .neq("status", "pending")
      .order("updated_at", { ascending: false })
      .limit(RECENT_LIMIT),
  ]);
  if (runsRes.error) return readFailed("the recent searches");
  if (reviewedRes.error) return readFailed("the recently reviewed opportunities");

  const searchRuns = ((runsRes.data ?? []) as { channel: string; status: string; found_count: number | null; created_at: string }[]).map((r) => ({
    channel: channelLabel(r.channel),
    status: r.status,
    foundCount: r.status === "done" ? (r.found_count ?? 0) : null,
    startedAt: r.created_at,
  }));
  const reviewedCandidates = ((reviewedRes.data ?? []) as { name: string; status: string; channel: string; updated_at: string }[]).map((c) => ({
    name: clip(c.name, MAX_NAME_CHARS),
    status: c.status,
    channel: channelLabel(c.channel),
    updatedAt: c.updated_at,
  }));

  const modelResult = { searchRuns, reviewedCandidates };
  const rows: CardRow[] = [
    ...searchRuns.map((r) => ({
      title: `Search: ${r.channel}`,
      detail: r.status === "done" ? `${r.foundCount} found` : r.status,
      meta: r.startedAt.slice(0, 10),
    })),
    ...reviewedCandidates.map((c) => ({
      title: c.name,
      detail: `${c.status} · ${c.channel}`,
      meta: c.updatedAt.slice(0, 10),
      href: "/discovery",
    })),
  ];
  const card: Card = {
    kind: "rows",
    ability: "list_recent_activity",
    title: "Recent search activity",
    rows,
    total: rows.length,
    emptyText: "No searches or reviews yet.",
  };
  return { ok: true, modelResult, card };
}

// --- get_strategy_for_review (ruling 0038 clause 3) --------------------------
//
// The prospect's LATEST strategy run only -- the one the panel, the drafting
// gate and the review count all treat as current -- with the proposed
// strategy and funder intelligence IN FULL, and the fingerprint of exactly
// that content. The card renders every field untruncated: what the user is
// shown must be what a later approval is pinned to.
//
// Allowlist (ruling 0038 clause 5): the content the user is asking to act on,
// nothing else of the row -- no findings (raw web text), no evidence ids, no
// model name, no creator, no error text.

export const STRATEGY_REVIEW_ALLOWLIST = [
  "prospectId",
  "prospectName",
  "hasRun",
  "runId",
  "status",
  "statusLabel",
  "approved",
  "canBeApproved",
  "strategy",
  "outreach_approach",
  "ask_positioning",
  "rationale",
  "key_talking_points",
  "evidence_to_highlight",
  "organizationIntel",
  "location",
  "funder_type",
  "geographic_focus",
  "typical_grant_size",
  "focus_areas",
  "fingerprint",
  "guidance",
] as const;

export type GetStrategyForReviewArgs = { prospectId: string };

export function validateGetStrategyForReview(raw: Record<string, unknown>): Result<GetStrategyForReviewArgs> {
  const unknown = rejectUnknownKeys(raw, ["prospect_id"]);
  if (unknown) return { ok: false, error: unknown };
  const id = asUuid(raw.prospect_id, "prospect_id");
  if (!id.ok) return id;
  return { ok: true, value: { prospectId: id.value } };
}

const STRATEGY_STATUS_LABELS: Record<string, string> = {
  researching: "Being built",
  analyzing: "Being built",
  ready_for_review: "Waiting for review",
  error: "Failed",
};

export async function getStrategyForReview(supabase: SupabaseClient, args: GetStrategyForReviewArgs): Promise<ReadOutcome> {
  const { data: prospect, error: prospectError } = await supabase.from("prospects").select("id, name").eq("id", args.prospectId).maybeSingle();
  if (prospectError) return readFailed("that prospect");
  if (!prospect) return { ok: false, error: "No prospect with that id was found." };
  const name = clip(String((prospect as { name: string }).name), MAX_NAME_CHARS);

  const { data: runs, error } = await supabase
    .from("strategy_runs")
    .select("id, prospect_id, status, strategy, organization_intel, approved_strategy, created_at")
    .eq("prospect_id", args.prospectId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return readFailed("that prospect's strategy");
  const run = ((runs ?? [])[0] ?? null) as {
    id: string;
    status: string;
    strategy: unknown;
    organization_intel: unknown;
    approved_strategy: unknown;
  } | null;
  const href = `/prospects/${args.prospectId}`;

  if (!run) {
    const modelResult = { prospectId: args.prospectId, prospectName: name, hasRun: false, canBeApproved: false, guidance: "No strategy has been built for this prospect yet." };
    const card: Card = {
      kind: "strategy_review",
      ability: "get_strategy_for_review",
      title: `Strategy for ${name}`,
      prospectId: args.prospectId,
      prospectName: name,
      hasRun: false,
      runId: null,
      status: null,
      statusLabel: "No strategy yet",
      approved: false,
      fingerprint: null,
      strategy: null,
      organizationIntel: null,
      href,
    };
    return { ok: true, modelResult, card };
  }

  const approved = run.approved_strategy !== null && run.approved_strategy !== undefined;
  const statusLabel = approved ? "Approved" : (STRATEGY_STATUS_LABELS[run.status] ?? run.status);
  const hasProposal = run.strategy !== null && run.strategy !== undefined && run.organization_intel !== null && run.organization_intel !== undefined;
  const canBeApproved = run.status === "ready_for_review" && !approved && hasProposal;

  // What is displayed: the approved text once approved (what is in force),
  // otherwise the proposal. The fingerprint exists only for the version a gate
  // could approve -- the proposal of a run that is waiting for review.
  const shownStrategy = hasProposal || approved ? normalizeStrategy(approved ? run.approved_strategy : run.strategy) : null;
  const shownIntel = hasProposal ? normalizeIntel(run.organization_intel) : null;
  const fingerprint = canBeApproved ? strategyFingerprint(run.strategy, run.organization_intel) : null;

  const modelResult: Record<string, unknown> = {
    prospectId: args.prospectId,
    prospectName: name,
    hasRun: true,
    runId: run.id,
    status: run.status,
    statusLabel,
    approved,
    canBeApproved,
    strategy: shownStrategy,
    organizationIntel: shownIntel,
    fingerprint,
    guidance: canBeApproved
      ? "This strategy is shown to the user in full on a card. It can be approved only if the user sees it first and then says to approve it in a LATER message; pass this runId and fingerprint to approve_strategy then."
      : approved
        ? "This strategy has already been approved."
        : "This strategy is not waiting for review, so it cannot be approved or pushed back on.",
  };
  const card: Card = {
    kind: "strategy_review",
    ability: "get_strategy_for_review",
    title: `Strategy for ${name}`,
    prospectId: args.prospectId,
    prospectName: name,
    hasRun: true,
    runId: run.id,
    status: run.status,
    statusLabel,
    approved,
    fingerprint,
    strategy: shownStrategy,
    organizationIntel: shownIntel,
    note: canBeApproved
      ? "This is exactly what approving would approve. Say so in your next message to approve it, or give feedback to push back."
      : undefined,
    href,
  };
  return { ok: true, modelResult, card };
}

// --- get_drafts (ruling 0038 clause 3) ---------------------------------------
//
// A prospect's drafts -- kind, status, subject and the text -- IN FULL on the
// card, each with the fingerprint of exactly that text. Allowlist: no
// recipient, no contact email, no send-attempt data, no provider message id:
// "has it been sent" is a single boolean, and the address it would go to is
// never read.

export const DRAFTS_ALLOWLIST = [
  "prospectId",
  "prospectName",
  "total",
  "shown",
  "drafts",
  "draftId",
  "kind",
  "kindLabel",
  "status",
  "sent",
  "subject",
  "content",
  "contentOmittedForSize",
  "fingerprint",
  "guidance",
] as const;

export const MAX_DRAFTS_LISTED = 6;
// The model is shown draft text up to this many characters in total; a draft
// that does not fit is flagged, not cut -- a half-shown draft is how an edit
// silently drops the rest. The CARD always carries the whole text.
export const MODEL_DRAFT_CONTENT_BUDGET = 12000;

export type GetDraftsArgs = { prospectId: string; draftId: string | null };

export function validateGetDrafts(raw: Record<string, unknown>): Result<GetDraftsArgs> {
  const unknown = rejectUnknownKeys(raw, ["prospect_id", "draft_id"]);
  if (unknown) return { ok: false, error: unknown };
  const id = asUuid(raw.prospect_id, "prospect_id");
  if (!id.ok) return id;
  let draftId: string | null = null;
  if (raw.draft_id !== undefined && raw.draft_id !== null && raw.draft_id !== "") {
    const d = asUuid(raw.draft_id, "draft_id");
    if (!d.ok) return d;
    draftId = d.value;
  }
  return { ok: true, value: { prospectId: id.value, draftId } };
}

export async function getDrafts(supabase: SupabaseClient, args: GetDraftsArgs): Promise<ReadOutcome> {
  const { data: prospect, error: prospectError } = await supabase.from("prospects").select("id, name").eq("id", args.prospectId).maybeSingle();
  if (prospectError) return readFailed("that prospect");
  if (!prospect) return { ok: false, error: "No prospect with that id was found." };
  const name = clip(String((prospect as { name: string }).name), MAX_NAME_CHARS);

  let query = supabase
    .from("drafts")
    .select("id, prospect_id, kind, status, subject, content, sent_at, created_at")
    .eq("prospect_id", args.prospectId);
  if (args.draftId) query = query.eq("id", args.draftId);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(MAX_DRAFTS_LISTED + 1);
  if (error) return readFailed("that prospect's drafts");
  const rows = (data ?? []) as { id: string; kind: string; status: string; subject: string | null; content: string | null; sent_at: string | null }[];
  const overflow = rows.length > MAX_DRAFTS_LISTED;
  const shown = rows.slice(0, MAX_DRAFTS_LISTED);

  const items: DraftReviewItem[] = shown.map((d) => {
    const content = typeof d.content === "string" ? d.content : "";
    return {
      draftId: d.id,
      kind: d.kind,
      kindLabel: draftKindLabel(d.kind),
      status: d.status,
      sent: Boolean(d.sent_at),
      subject: typeof d.subject === "string" ? d.subject : null,
      content,
      fingerprint: draftFingerprint({ kind: d.kind, subject: d.subject, content }),
    };
  });

  let budget = MODEL_DRAFT_CONTENT_BUDGET;
  const modelDrafts = items.map((d) => {
    const fits = d.content.length <= budget;
    if (fits) budget -= d.content.length;
    return {
      draftId: d.draftId,
      kind: d.kind,
      kindLabel: d.kindLabel,
      status: d.status,
      sent: d.sent,
      subject: d.subject,
      content: fits ? d.content : null,
      contentOmittedForSize: !fits,
      fingerprint: d.fingerprint,
    };
  });

  const modelResult = {
    prospectId: args.prospectId,
    prospectName: name,
    total: overflow ? shown.length + 1 : shown.length,
    shown: shown.length,
    drafts: modelDrafts,
    guidance:
      "Each draft is shown to the user in full on a card. A draft can be approved only if the user sees it first and then says to approve it in a LATER message; pass its draftId and fingerprint to approve_draft then. Approving does not deliver it to anyone.",
  };
  const card: Card = {
    kind: "draft_review",
    ability: "get_drafts",
    title: `Drafts for ${name}`,
    prospectId: args.prospectId,
    prospectName: name,
    drafts: items,
    total: modelResult.total,
    note: overflow ? `Showing the newest ${MAX_DRAFTS_LISTED}; there are more.` : undefined,
    href: `/prospects/${args.prospectId}`,
  };
  return { ok: true, modelResult, card };
}
