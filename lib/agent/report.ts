// The fundraising report (STATE item 98, ruling 0039 clause 3: "A read ... is
// rendered by code from platform data").
//
// READABLE TEXT built entirely by code from the assistant's own reads -- the
// dashboard numbers, what is due, what awaits the owner's review or approval,
// who has gone quiet, recent activity -- plus the same facts as structured
// data. There is no model call and no sentence invented here: every figure,
// name and date comes from a read result, and the words around them are fixed
// templates. Every read it uses already honours the assistant's allowlists
// (no email, phone, notes, interaction text; a supporter's pledge only as a
// tier), and the structured copy is cut to those allowlists again here.
//
// COMPACT by design (field note: results over ~20 KB are hard-capped, and a
// cut-off result reads like a dropped connection): headline numbers, the top
// MAX_REPORT_ROWS of each list and the count of the rest. A section whose read
// failed says so -- "could not be read just now" is not "nothing is due".

import type { SupabaseClient } from "@supabase/supabase-js";
import { formatAmountCompact } from "@/lib/prospects";
import { draftKindLabel } from "@/lib/drafts";
import { enforceAllowlist } from "@/lib/assistant/dispatch";
import {
  DASHBOARD_SUMMARY_ALLOWLIST,
  FOLLOWUPS_ALLOWLIST,
  RECENT_ACTIVITY_ALLOWLIST,
  SUPPORTER_STEWARDSHIP_ALLOWLIST,
  getDashboardSummary,
  listFollowUpsDue,
  listRecentActivity,
  listSupportersNeedingStewardship,
  type ReadOutcome,
} from "@/lib/assistant/reads";
import { MAX_REPORT_ROWS } from "./limits";

// Keys the report's own review-queue block may carry.
export const REVIEW_QUEUE_ALLOWLIST = ["strategiesAwaiting", "strategies", "draftsAwaiting", "drafts", "prospectId", "name", "draftId", "prospectName", "kindLabel"] as const;

// The union of every key the report's structured data may contain.
export const REPORT_ALLOWLIST: readonly string[] = [
  "asOf",
  "unavailable",
  "dashboard",
  "followUps",
  "supporters",
  "recent",
  "review",
  ...DASHBOARD_SUMMARY_ALLOWLIST,
  ...FOLLOWUPS_ALLOWLIST,
  ...SUPPORTER_STEWARDSHIP_ALLOWLIST,
  ...RECENT_ACTIVITY_ALLOWLIST,
  ...REVIEW_QUEUE_ALLOWLIST,
];

export type ReviewQueue = {
  strategiesAwaiting: number;
  strategies: { prospectId: string; name: string }[];
  draftsAwaiting: number;
  drafts: { draftId: string; prospectId: string; prospectName: string; kindLabel: string }[];
};

type Failed = { ok: false; error: string };
function modelOf(r: ReadOutcome | Failed): Record<string, any> | null {
  return r.ok ? (r as Extract<ReadOutcome, { ok: true }>).modelResult : null;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export type ReportInputs = {
  now: Date;
  dashboard: ReadOutcome;
  followUps: ReadOutcome;
  supporters: ReadOutcome;
  recent: ReadOutcome;
  review: { ok: true; value: ReviewQueue } | { ok: false };
};

export type RenderedReport = { text: string; data: Record<string, unknown>; unavailable: string[] };

const more = (shown: number, total: number) => (total > shown ? ` …and ${total - shown} more.` : "");

export function renderReport(inputs: ReportInputs): RenderedReport {
  const asOf = inputs.now.toISOString().slice(0, 10);
  const unavailable: string[] = [];
  const lines: string[] = [`Fundraising report — as of ${asOf}`, ""];
  const data: Record<string, unknown> = { asOf };

  // --- headline numbers
  const d = modelOf(inputs.dashboard);
  lines.push("HEADLINE NUMBERS");
  if (!d) {
    unavailable.push("headline numbers");
    lines.push("- Could not be read just now.");
  } else {
    lines.push(`- Active prospects: ${d.activeProspects}`);
    lines.push(`- New opportunities waiting for review: ${d.opportunitiesPending}`);
    lines.push(`- Follow-ups due in the next 7 days: ${d.followUpsDueNext7Days}`);
    lines.push(`- Strategies awaiting review: ${d.strategiesAwaitingReview}`);
    lines.push(`- Supporters: ${d.supporters} (projected annual giving ${formatAmountCompact(d.supporterForecastAnnualAmount)}, not yet collected)`);
    lines.push(`- Total pipeline potential: ${formatAmountCompact(d.pipelineTotalPotentialAmount)}`);
    const stages = (d.pipelineByStage as { stage: string; count: number; potentialAmount: number }[]).filter((s) => s.count > 0);
    if (stages.length) {
      lines.push(`- By pipeline step: ${stages.map((s) => `${s.stage} ${s.count}${s.potentialAmount > 0 ? ` (${formatAmountCompact(s.potentialAmount)})` : ""}`).join(" · ")}`);
    }
    data.dashboard = enforceAllowlist(d, new Set(DASHBOARD_SUMMARY_ALLOWLIST), []);
  }

  // --- waiting on the owner
  lines.push("", "WAITING ON YOU");
  if (!inputs.review.ok) {
    unavailable.push("what is waiting for review");
    lines.push("- Could not be read just now.");
  } else {
    const r = inputs.review.value;
    lines.push(
      r.strategiesAwaiting === 0
        ? "- No strategy is waiting for review."
        : `- Strategies waiting for review (${r.strategiesAwaiting}): ${r.strategies.map((s) => s.name).join("; ")}.${more(r.strategies.length, r.strategiesAwaiting)}`
    );
    lines.push(
      r.draftsAwaiting === 0
        ? "- No draft is waiting for review."
        : `- Drafts waiting for review (${r.draftsAwaiting}): ${r.drafts.map((x) => `${x.prospectName} (${x.kindLabel})`).join("; ")}.${more(r.drafts.length, r.draftsAwaiting)}`
    );
    data.review = r;
  }

  // --- follow-ups
  const f = modelOf(inputs.followUps);
  lines.push("", "DUE NOW");
  if (!f) {
    unavailable.push("follow-ups");
    lines.push("- Could not be read just now.");
  } else {
    const due = (f.dueNow as any[]).slice(0, MAX_REPORT_ROWS);
    if (f.dueNowTotal === 0) lines.push("- Nothing is due.");
    for (const p of due) {
      lines.push(`- ${p.name} — ${p.nextAction ?? "no next action written"}${p.nextActionDue ? ` (due ${p.nextActionDue})` : ""} · ${p.stage}${p.health ? ` · ${p.health}` : ""}`);
    }
    if (f.dueNowTotal > due.length) lines.push(`- …and ${f.dueNowTotal - due.length} more.`);

    const revisits = (f.revisitsDue as any[]).slice(0, MAX_REPORT_ROWS);
    lines.push("", `REVISITS DUE (${f.revisitsDueTotal})`);
    if (f.revisitsDueTotal === 0) lines.push("- None.");
    for (const r of revisits) lines.push(`- ${r.name} — declined funder, revisit date ${r.revisitOn} has arrived`);
    if (f.revisitsDueTotal > revisits.length) lines.push(`- …and ${f.revisitsDueTotal - revisits.length} more.`);

    const quiet = (f.goneQuiet as any[]).slice(0, MAX_REPORT_ROWS);
    lines.push("", `PROSPECTS WHO HAVE GONE QUIET (${f.goneQuietTotal}; quiet after ${f.goneQuietAfterDays} days)`);
    if (f.goneQuietTotal === 0) lines.push("- None.");
    for (const q of quiet) lines.push(`- ${q.name} — ${q.stage}, ${q.daysSinceLastTouch === null ? "no contact on record since they said yes" : `${q.daysSinceLastTouch} days since the last contact`}`);
    if (f.goneQuietTotal > quiet.length) lines.push(`- …and ${f.goneQuietTotal - quiet.length} more.`);

    data.followUps = enforceAllowlist(
      { ...f, dueNow: due, revisitsDue: revisits, goneQuiet: quiet },
      new Set(FOLLOWUPS_ALLOWLIST),
      []
    );
  }

  // --- supporters
  const s = modelOf(inputs.supporters);
  lines.push("", s ? `SUPPORTERS WHO HAVE GONE QUIET (${s.total})` : "SUPPORTERS WHO HAVE GONE QUIET");
  if (!s) {
    unavailable.push("supporter stewardship");
    lines.push("- Could not be read just now.");
  } else {
    const shown = (s.supporters as any[]).slice(0, MAX_REPORT_ROWS);
    if (s.total === 0) lines.push("- None.");
    for (const x of shown) lines.push(`- ${x.name} — ${x.tier} tier, ${x.daysSinceLastTouch === null ? "no gift or contact on record" : `${x.daysSinceLastTouch} days since the last gift or contact`}`);
    if (s.total > shown.length) lines.push(`- …and ${s.total - shown.length} more.`);
    data.supporters = enforceAllowlist({ ...s, supporters: shown }, new Set(SUPPORTER_STEWARDSHIP_ALLOWLIST), []);
  }

  // --- recent activity
  const a = modelOf(inputs.recent);
  lines.push("", "RECENT ACTIVITY");
  if (!a) {
    unavailable.push("recent activity");
    lines.push("- Could not be read just now.");
  } else {
    const runs = (a.searchRuns as any[]).slice(0, MAX_REPORT_ROWS);
    const reviewed = (a.reviewedCandidates as any[]).slice(0, MAX_REPORT_ROWS);
    if (runs.length === 0 && reviewed.length === 0) lines.push("- No searches or reviews yet.");
    for (const r of runs) lines.push(`- Search: ${r.channel} — ${r.foundCount === null ? r.status : `${r.foundCount} found`} (${String(r.startedAt).slice(0, 10)})`);
    for (const c of reviewed) lines.push(`- Reviewed: ${c.name} — ${c.status}, ${c.channel} (${String(c.updatedAt).slice(0, 10)})`);
    data.recent = enforceAllowlist({ searchRuns: runs, reviewedCandidates: reviewed }, new Set(RECENT_ACTIVITY_ALLOWLIST), []);
  }

  if (unavailable.length) {
    lines.push("", `NOT AVAILABLE JUST NOW: ${unavailable.join("; ")}. These are unknown, not zero.`);
  }
  lines.push("", "Approving a strategy or a draft is the owner's decision, made on the platform: ask for an approval link.");
  data.unavailable = unavailable;
  return { text: lines.join("\n"), data, unavailable };
}

// --- the review queue (names only; no content) ----------------------------------------

export async function loadReviewQueue(supabase: SupabaseClient): Promise<{ ok: true; value: ReviewQueue } | { ok: false }> {
  const [runsRes, draftsRes] = await Promise.all([
    supabase.from("strategy_runs").select("prospect_id, status, approved_strategy, created_at").order("created_at", { ascending: false }),
    supabase
      .from("drafts")
      .select("id, prospect_id, kind, created_at", { count: "exact" })
      .eq("status", "draft")
      .is("sent_at", null)
      .order("created_at", { ascending: false })
      .limit(MAX_REPORT_ROWS),
  ]);
  if (runsRes.error || draftsRes.error) return { ok: false };

  // The latest run per prospect, as the dashboard counts it.
  const seen = new Set<string>();
  const awaiting: string[] = [];
  for (const run of (runsRes.data ?? []) as { prospect_id: string; status: string; approved_strategy: unknown }[]) {
    if (seen.has(run.prospect_id)) continue;
    seen.add(run.prospect_id);
    if (run.status === "ready_for_review" && !run.approved_strategy) awaiting.push(run.prospect_id);
  }
  const topStrategies = awaiting.slice(0, MAX_REPORT_ROWS);
  const draftRows = (draftsRes.data ?? []) as { id: string; prospect_id: string; kind: string }[];
  const ids = [...new Set([...topStrategies, ...draftRows.map((x) => x.prospect_id)])];
  const names = new Map<string, string>();
  if (ids.length) {
    const { data, error } = await supabase.from("prospects").select("id, name").in("id", ids);
    if (error) return { ok: false };
    for (const p of (data ?? []) as { id: string; name: string }[]) names.set(p.id, clip(String(p.name), 120));
  }
  return {
    ok: true,
    value: {
      strategiesAwaiting: awaiting.length,
      strategies: topStrategies.map((id) => ({ prospectId: id, name: names.get(id) ?? "(unnamed)" })),
      draftsAwaiting: draftsRes.count ?? draftRows.length,
      drafts: draftRows.map((x) => ({ draftId: x.id, prospectId: x.prospect_id, prospectName: names.get(x.prospect_id) ?? "(unnamed)", kindLabel: draftKindLabel(x.kind) })),
    },
  };
}

export async function buildFundraisingReport(supabase: SupabaseClient, now: Date): Promise<RenderedReport> {
  const [dashboard, followUps, supporters, recent, review] = await Promise.all([
    getDashboardSummary(supabase, now),
    listFollowUpsDue(supabase, now),
    listSupportersNeedingStewardship(supabase, now),
    listRecentActivity(supabase),
    loadReviewQueue(supabase),
  ]);
  return renderReport({ now, dashboard, followUps, supporters, recent, review });
}
