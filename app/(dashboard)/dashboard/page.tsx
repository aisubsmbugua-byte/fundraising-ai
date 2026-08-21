import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { STAGES, channelLabel, type Prospect } from "@/lib/prospects";
import { countStrategiesReadyForReview } from "@/lib/deep-dive";
import type { DiscoverySearchRun } from "@/lib/discovery-search";
import type { Candidate } from "@/lib/candidates";
import { spacing, colors, cardStyle, sectionStyle } from "@/lib/ui";

const RECENT_LIMIT = 8;

export default async function DashboardPage() {
  const supabase = createClient();

  const [
    { count: pendingCandidateCount },
    readyForReviewCount,
    { data: prospects },
    { data: recentRuns },
    { data: recentReviewed },
  ] = await Promise.all([
    supabase.from("candidates").select("*", { count: "exact", head: true }).eq("status", "pending"),
    countStrategiesReadyForReview(supabase),
    supabase.from("prospects").select("stage").returns<Pick<Prospect, "stage">[]>(),
    supabase
      .from("discovery_search_runs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(RECENT_LIMIT)
      .returns<DiscoverySearchRun[]>(),
    supabase
      .from("candidates")
      .select("*")
      .neq("status", "pending")
      .order("updated_at", { ascending: false })
      .limit(RECENT_LIMIT)
      .returns<Candidate[]>(),
  ]);

  const byStage = new Map<string, number>();
  for (const s of STAGES) byStage.set(s.value, 0);
  for (const p of prospects ?? []) {
    byStage.set(p.stage, (byStage.get(p.stage) ?? 0) + 1);
  }
  const totalInPipeline = prospects?.length ?? 0;

  return (
    <div>
      <h1>Dashboard</h1>
      <p style={{ color: colors.textMuted, marginTop: spacing.xs }}>
        A snapshot of what's moving and what needs attention, in one place.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: spacing.md,
          marginTop: spacing.xl,
        }}
      >
        <StatCard href="/discovery" label="Donor Finder" value={pendingCandidateCount ?? 0} sub="awaiting review" />
        <StatCard
          href="/prospects/review"
          label="Strategy Staging"
          value={readyForReviewCount}
          sub="awaiting review"
        />
        <StatCard href="/pipeline" label="Pipeline" value={totalInPipeline} sub="active prospects" />
        <StatCard href="/people" label="People" value={undefined} sub="see full directory" />
      </div>

      <div style={{ ...sectionStyle, marginTop: spacing.xl }}>
        <h2 style={{ fontSize: 16 }}>Pipeline by stage</h2>
        <div style={{ display: "flex", gap: spacing.md, flexWrap: "wrap" }}>
          {STAGES.map((s) => (
            <div key={s.value} style={{ minWidth: 100 }}>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{byStage.get(s.value) ?? 0}</div>
              <div style={{ fontSize: 13, color: colors.textMuted }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: spacing.xl,
          marginTop: spacing.xl,
        }}
      >
        <div>
          <h2 style={{ fontSize: 16 }}>Recent search runs</h2>
          <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.md }}>
            {(recentRuns ?? []).map((r) => (
              <div key={r.id} style={cardStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                  <strong>{channelLabel(r.channel)}</strong>
                  <span style={{ color: r.status === "error" ? colors.danger : colors.textMuted }}>
                    {r.status === "done" ? `${r.found_count ?? 0} found` : r.status}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: colors.textFaint, marginTop: 2 }}>
                  {new Date(r.created_at).toLocaleString()}
                </div>
              </div>
            ))}
            {(recentRuns ?? []).length === 0 && (
              <p style={{ fontSize: 13, color: colors.textMuted }}>No search runs yet.</p>
            )}
          </div>
        </div>

        <div>
          <h2 style={{ fontSize: 16 }}>Recently reviewed candidates</h2>
          <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.md }}>
            {(recentReviewed ?? []).map((c) => (
              <div key={c.id} style={cardStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                  <strong>{c.name}</strong>
                  <span style={{ color: c.status === "accepted" ? colors.success : colors.textMuted }}>
                    {c.status}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: colors.textFaint, marginTop: 2 }}>
                  {channelLabel(c.channel)}
                </div>
              </div>
            ))}
            {(recentReviewed ?? []).length === 0 && (
              <p style={{ fontSize: 13, color: colors.textMuted }}>Nothing reviewed yet.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  href,
  label,
  value,
  sub,
}: {
  href: string;
  label: string;
  value: number | undefined;
  sub: string;
}) {
  return (
    <Link href={href} style={{ ...cardStyle, textDecoration: "none", color: colors.text, display: "block" }}>
      <div style={{ fontSize: 13, color: colors.textMuted }}>{label}</div>
      {value !== undefined && <div style={{ fontSize: 28, fontWeight: 700, marginTop: spacing.xs }}>{value}</div>}
      <div style={{ fontSize: 12, color: colors.textFaint, marginTop: value === undefined ? spacing.xs : 0 }}>
        {sub}
      </div>
    </Link>
  );
}
