import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { STAGES, CHANNELS, channelLabel, stageLabel, type Prospect, type StageChange } from "@/lib/prospects";
import type { ScreeningResult } from "@/lib/screening";
import { spacing, colors, sectionStyle, buttonPrimary, buttonSecondary } from "@/lib/ui";
import ProspectCard from "./prospect-card";
import ProspectRow from "./prospect-row";

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
    return { ...s, count: items.length, avgDays };
  });

  const stuckLongest = all
    .map((p) => ({ p, days: daysInStage(p) }))
    .sort((a, b) => b.days - a.days)
    .slice(0, 3)
    .filter((x) => x.days >= 1);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Pipeline</h1>
        <div style={{ display: "flex", gap: spacing.sm }}>
          <Link href="/pipeline" style={view === "board" ? buttonPrimary : buttonSecondary}>
            Board
          </Link>
          <Link href="/pipeline?view=list" style={view === "list" ? buttonPrimary : buttonSecondary}>
            List
          </Link>
          {view === "list" && (
            <Link href="/prospects/new" style={buttonPrimary}>
              + New Prospect
            </Link>
          )}
        </div>
      </div>

      <div style={{ ...sectionStyle, marginTop: spacing.lg }}>
        <div style={{ display: "flex", gap: spacing.xl, flexWrap: "wrap" }}>
          {stageStats.map((s) => (
            <Link
              key={s.value}
              href={`/pipeline?stage=${s.value}`}
              style={{ textDecoration: "none", color: colors.text, minWidth: 100 }}
            >
              <div style={{ fontSize: 22, fontWeight: 700 }}>{s.count}</div>
              <div style={{ fontSize: 12, color: colors.textMuted }}>{s.label}</div>
              {s.count > 0 && (
                <div style={{ fontSize: 11, color: colors.textFaint }}>{s.avgDays.toFixed(0)}d avg</div>
              )}
            </Link>
          ))}
        </div>
        {stuckLongest.length > 0 && (
          <div style={{ fontSize: 13 }}>
            <span style={{ color: colors.textMuted }}>Stuck longest: </span>
            {stuckLongest.map(({ p, days }, i) => (
              <span key={p.id}>
                {i > 0 && ", "}
                <Link href={`/prospects/${p.id}`}>{p.name}</Link> ({Math.round(days)}d in {stageLabel(p.stage)})
              </span>
            ))}
          </div>
        )}
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
        <BoardView byStage={byStage} latestTierByProspect={latestTierByProspect} daysInStage={daysInStage} />
      )}
    </div>
  );
}

function BoardView({
  byStage,
  latestTierByProspect,
  daysInStage,
}: {
  byStage: Map<string, Prospect[]>;
  latestTierByProspect: Map<string, number>;
  daysInStage: (p: Prospect) => number;
}) {
  return (
    <div style={{ overflowX: "auto", marginTop: spacing.lg, paddingBottom: 16 }}>
      <div
        style={{
          display: "grid",
          // The 140px floor (not "auto") is load-bearing: a grid
          // track's default min size is its content's intrinsic
          // width, so without an explicit fixed floor here, one long
          // unwrapped prospect name blows a column -- and the
          // ellipsis truncation meant to prevent that -- out past its
          // fair 1/6 share. 140px keeps columns readable on narrow
          // viewports (scrolling instead) without ever letting
          // content dictate width on normal ones.
          gridTemplateColumns: "repeat(6, minmax(140px, 1fr))",
          gap: 10,
          minWidth: 900,
        }}
      >
        {STAGES.map((s) => (
          <div key={s.value} style={{ minWidth: 0 }}>
            <Link
              href={`/pipeline?stage=${s.value}`}
              style={{ fontSize: 13, fontWeight: 600, color: colors.text, textDecoration: "none" }}
            >
              {s.label} ({byStage.get(s.value)?.length ?? 0})
            </Link>
            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 6, marginTop: spacing.sm, minWidth: 0 }}>
              {byStage.get(s.value)?.map((p) => (
                <ProspectCard
                  key={p.id}
                  prospect={p}
                  tier={latestTierByProspect.get(p.id)}
                  daysInStage={daysInStage(p)}
                />
              ))}
              {byStage.get(s.value)?.length === 0 && (
                <p style={{ fontSize: 12, color: colors.textFaint }}>No prospects</p>
              )}
            </div>
          </div>
        ))}
      </div>
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
          style={{
            padding: spacing.sm,
            flex: 1,
            border: `1px solid ${colors.borderStrong}`,
            borderRadius: 4,
            boxSizing: "border-box",
          }}
        />
        <select
          name="channel"
          defaultValue={searchParams.channel ?? ""}
          style={{ padding: spacing.sm, border: `1px solid ${colors.borderStrong}`, borderRadius: 4 }}
        >
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
