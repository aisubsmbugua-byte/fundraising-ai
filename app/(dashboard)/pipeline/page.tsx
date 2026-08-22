import Link from "next/link";
import { LayoutGrid, List, Plus, DollarSign, Users2, TriangleAlert } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import {
  STAGES,
  CHANNELS,
  channelLabel,
  stageLabel,
  formatAmountCompact,
  computeHealthStatus,
  type Prospect,
  type StageChange,
} from "@/lib/prospects";
import type { ScreeningResult } from "@/lib/screening";
import { spacing, colors, type as typeScale, radiusSm, cardStyle, fieldStyle, buttonPrimary, buttonSecondary } from "@/lib/ui";
import ProspectRow from "./prospect-row";
import BoardView from "./board-view";

const MS_PER_DAY = 86400000;

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: { view?: string; stage?: string; q?: string; channel?: string };
}) {
  const supabase = createClient();
  const view = searchParams.view === "list" ? "list" : "board";
  const stageFilter = STAGES.find((s) => s.value === searchParams.stage)?.value;

  const { data: prospects, error } = await supabase
    .from("prospects")
    .select("*")
    .order("updated_at", { ascending: false })
    .returns<Prospect[]>();

  if (error) {
    return <p style={{ color: colors.danger }}>Error loading pipeline: {error.message}</p>;
  }

  const { data: screenings } = await supabase
    .from("screening_results")
    .select("*")
    .order("created_at", { ascending: false })
    .returns<ScreeningResult[]>();
  const latestTierByProspect = new Map<string, number>();
  for (const s of screenings ?? []) {
    if (!latestTierByProspect.has(s.prospect_id)) latestTierByProspect.set(s.prospect_id, s.tier);
  }

  // "Days in stage" needs when a prospect entered its *current*
  // stage -- the latest stage_changes row that landed them there, or
  // created_at if they've never moved since being accepted.
  const { data: changes } = await supabase
    .from("stage_changes")
    .select("prospect_id, to_stage, created_at")
    .order("created_at", { ascending: false })
    .returns<Pick<StageChange, "prospect_id" | "to_stage" | "created_at">[]>();
  const latestChangeByProspect = new Map<string, { to_stage: string; created_at: string }>();
  for (const c of changes ?? []) {
    if (!latestChangeByProspect.has(c.prospect_id)) latestChangeByProspect.set(c.prospect_id, c);
  }

  const now = Date.now();
  function daysInStage(p: Prospect) {
    const latest = latestChangeByProspect.get(p.id);
    const since = latest && latest.to_stage === p.stage ? latest.created_at : p.created_at;
    return (now - new Date(since).getTime()) / MS_PER_DAY;
  }

  const all = prospects ?? [];
  const byStage = new Map<string, Prospect[]>();
  for (const s of STAGES) byStage.set(s.value, []);
  for (const p of all) byStage.get(p.stage)?.push(p);

  const stageStats = STAGES.map((s) => {
    const items = byStage.get(s.value) ?? [];
    const avgDays = items.length ? items.reduce((sum, p) => sum + daysInStage(p), 0) / items.length : 0;
    const potential = items.reduce((sum, p) => sum + (p.ask_amount ?? 0), 0);
    return { ...s, count: items.length, avgDays, potential };
  });
  const totalPotential = all.reduce((sum, p) => sum + (p.ask_amount ?? 0), 0);

  const stuckLongest = all
    .map((p) => ({ p, days: daysInStage(p) }))
    .sort((a, b) => b.days - a.days)
    .slice(0, 3)
    .filter((x) => x.days >= 1);

  const needsAttentionCount = all.filter((p) => {
    const h = computeHealthStatus(p.next_action_due);
    return h === "due_soon" || h === "stalled";
  }).length;
  const mostStuck = stuckLongest[0] ?? null;

  // BoardView is a Client Component (drag-and-drop needs interactive
  // state), so only plain serializable data can cross that boundary
  // -- not the Map/function versions used above.
  const tierByProspect: Record<string, number> = {};
  latestTierByProspect.forEach((tier, id) => (tierByProspect[id] = tier));
  const daysInStageByProspect: Record<string, number> = {};
  for (const p of all) daysInStageByProspect[p.id] = daysInStage(p);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: spacing.md }}>
        <div>
          <h1 style={{ fontSize: typeScale.pageTitle }}>Pipeline</h1>
          <p style={{ color: colors.textMuted, fontSize: 14, marginTop: spacing.xs }}>
            Move relationships forward from discovery to stewardship.
          </p>
        </div>
        <div style={{ display: "flex", gap: spacing.sm, flexShrink: 0 }}>
          <Link href="/pipeline" style={{ ...(view === "board" ? buttonPrimary : buttonSecondary), display: "flex", alignItems: "center", gap: 8 }}>
            <LayoutGrid size={15} /> Board
          </Link>
          <Link href="/pipeline?view=list" style={{ ...(view === "list" ? buttonPrimary : buttonSecondary), display: "flex", alignItems: "center", gap: 8 }}>
            <List size={15} /> List
          </Link>
          <Link href="/prospects/new" style={{ ...buttonPrimary, display: "flex", alignItems: "center", gap: 8, textDecoration: "none" }}>
            <Plus size={15} /> New Prospect
          </Link>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: spacing.md, marginTop: spacing.lg }}>
        <StatTile icon={DollarSign} value={formatAmountCompact(totalPotential)} label="Total potential" />
        <StatTile icon={Users2} value={String(all.length)} label="Active prospects" />
        <StatTile icon={TriangleAlert} value={String(needsAttentionCount)} label="Need attention" tone={needsAttentionCount > 0 ? "amber" : undefined} />
      </div>

      {mostStuck && (
        <div
          style={{
            ...cardStyle,
            display: "flex",
            alignItems: "center",
            gap: spacing.sm,
            marginTop: spacing.md,
            background: colors.amber100,
            borderColor: colors.amber700,
          }}
        >
          <TriangleAlert size={16} color={colors.amber700} style={{ flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: colors.text }}>
            <strong>{mostStuck.p.name}</strong> has been in {stageLabel(mostStuck.p.stage)} for{" "}
            {Math.round(mostStuck.days)} days —{" "}
            <Link href={`/prospects/${mostStuck.p.id}`} style={{ color: colors.amber700, fontWeight: 600 }}>
              Review next action →
            </Link>
          </span>
        </div>
      )}

      <div style={{ display: "flex", gap: spacing.xl, flexWrap: "wrap", marginTop: spacing.lg }}>
        {stageStats.map((s) => (
          <Link
            key={s.value}
            href={`/pipeline?stage=${s.value}`}
            style={{ textDecoration: "none", color: colors.text, minWidth: 100 }}
          >
            <div style={{ fontSize: 22, fontWeight: 700 }}>{s.count}</div>
            <div style={{ fontSize: 12, color: colors.textMuted }}>{s.label}</div>
            {s.count > 0 && (
              <div style={{ fontSize: 11, color: colors.textFaint }}>
                {s.avgDays.toFixed(0)}d avg
                {s.potential > 0 ? ` · ${formatAmountCompact(s.potential)}` : ""}
              </div>
            )}
          </Link>
        ))}
      </div>

      {view === "list" ? (
        <ListView prospects={all} searchParams={searchParams} />
      ) : stageFilter ? (
        <FilteredStageView
          stage={stageFilter}
          prospects={byStage.get(stageFilter) ?? []}
          latestTierByProspect={latestTierByProspect}
          daysInStage={daysInStage}
        />
      ) : (
        <BoardView prospects={all} tierByProspect={tierByProspect} daysInStageByProspect={daysInStageByProspect} />
      )}
    </div>
  );
}

function StatTile({
  icon: Icon,
  value,
  label,
  tone,
}: {
  icon: typeof DollarSign;
  value: string;
  label: string;
  tone?: "amber";
}) {
  return (
    <div style={cardStyle}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          borderRadius: radiusSm,
          background: tone === "amber" ? colors.amber100 : colors.teal100,
          color: tone === "amber" ? colors.amber700 : colors.teal700,
        }}
      >
        <Icon size={15} />
      </span>
      <div style={{ fontSize: 26, fontWeight: 700, marginTop: spacing.sm }}>{value}</div>
      <div style={{ fontSize: 13, color: colors.textMuted }}>{label}</div>
    </div>
  );
}

function FilteredStageView({
  stage,
  prospects,
  latestTierByProspect,
  daysInStage,
}: {
  stage: string;
  prospects: Prospect[];
  latestTierByProspect: Map<string, number>;
  daysInStage: (p: Prospect) => number;
}) {
  return (
    <div style={{ marginTop: spacing.lg }}>
      <Link href="/pipeline" style={{ fontSize: 13, color: colors.textMuted, textDecoration: "none" }}>
        ← All stages
      </Link>
      <h2 style={{ fontSize: 16, marginTop: spacing.sm }}>
        {stageLabel(stage)} ({prospects.length})
      </h2>
      <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.md }}>
        {prospects.map((p) => (
          <ProspectRow key={p.id} prospect={p} tier={latestTierByProspect.get(p.id)} daysInStage={daysInStage(p)} />
        ))}
        {prospects.length === 0 && <p style={{ fontSize: 13, color: colors.textMuted }}>No prospects in this stage.</p>}
      </div>
    </div>
  );
}

function ListView({
  prospects,
  searchParams,
}: {
  prospects: Prospect[];
  searchParams: { q?: string; channel?: string };
}) {
  const q = searchParams.q?.trim().toLowerCase();
  const filtered = prospects.filter((p) => {
    if (q && !p.name.toLowerCase().includes(q)) return false;
    if (searchParams.channel && p.channel !== searchParams.channel) return false;
    return true;
  });

  return (
    <div style={{ marginTop: spacing.lg }}>
      <form style={{ display: "flex", gap: spacing.sm, marginBottom: spacing.lg }}>
        <input type="hidden" name="view" value="list" />
        <input
          type="text"
          name="q"
          placeholder="Search by name..."
          defaultValue={searchParams.q}
          style={{ ...fieldStyle, marginTop: 0, flex: 1 }}
        />
        <select name="channel" defaultValue={searchParams.channel ?? ""} style={{ ...fieldStyle, marginTop: 0, width: 200 }}>
          <option value="">All channels</option>
          {CHANNELS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <button type="submit" style={buttonSecondary}>
          Filter
        </button>
      </form>

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: `1px solid ${colors.border}` }}>
            <th style={{ padding: spacing.sm }}>Name</th>
            <th style={{ padding: spacing.sm }}>Stage</th>
            <th style={{ padding: spacing.sm }}>Channel</th>
            <th style={{ padding: spacing.sm }}>Organization</th>
            <th style={{ padding: spacing.sm }}>Contact</th>
            <th style={{ padding: spacing.sm }}>Ask</th>
            <th style={{ padding: spacing.sm }}>Next action</th>
            <th style={{ padding: spacing.sm }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((p) => (
            <tr key={p.id} style={{ borderBottom: `1px solid ${colors.bgSubtle}` }}>
              <td style={{ padding: spacing.sm }}>
                <Link href={`/prospects/${p.id}`}>{p.name}</Link>
              </td>
              <td style={{ padding: spacing.sm }}>{stageLabel(p.stage)}</td>
              <td style={{ padding: spacing.sm }}>{channelLabel(p.channel)}</td>
              <td style={{ padding: spacing.sm }}>{p.organization ?? "—"}</td>
              <td style={{ padding: spacing.sm }}>{p.contact_name ?? p.contact_email ?? "—"}</td>
              <td style={{ padding: spacing.sm }}>{p.ask_amount != null ? formatAmountCompact(p.ask_amount) : "—"}</td>
              <td style={{ padding: spacing.sm }}>{p.next_action ?? "—"}</td>
              <td style={{ padding: spacing.sm }}>
                <Link href={`/prospects/${p.id}?edit=1`}>Edit</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {filtered.length === 0 && <p style={{ color: colors.textMuted, marginTop: spacing.xl }}>No prospects found.</p>}
    </div>
  );
}
