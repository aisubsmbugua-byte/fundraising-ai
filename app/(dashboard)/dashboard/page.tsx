import Link from "next/link";
import {
  Search,
  Users,
  CalendarClock,
  ClipboardCheck,
  Star,
  BarChart3,
  Compass,
  Mail,
  FileText,
  Scale,
  Award,
  ArrowUp,
  Sparkles,
  Building2,
  type LucideIcon,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import {
  STAGES,
  channelLabel,
  formatAmountCompact,
  computeHealthStatus,
  type Prospect,
  type HealthStatus,
} from "@/lib/prospects";
import { countStrategiesReadyForReview } from "@/lib/deep-dive";
import { screenProspect, type ScreeningRule } from "@/lib/screening";
import type { DiscoverySearchRun } from "@/lib/discovery-search";
import type { Candidate } from "@/lib/candidates";
import type { OrgProfile } from "@/lib/organization";
import { spacing, colors, type as typeScale, radiusSm, cardStyle, sectionStyle, buttonPrimary, buttonSecondary } from "@/lib/ui";
import HealthChip from "@/components/HealthChip";
import FitScoreCircle from "@/components/FitScoreCircle";

const RECENT_LIMIT = 8;
const MS_PER_DAY = 86400000;

const STAGE_ICONS: Record<string, LucideIcon> = {
  discovery: Compass,
  outreach: Mail,
  proposal: FileText,
  decision: Scale,
  awarding: Award,
  stewardship: Users,
};

export default async function DashboardPage() {
  const supabase = createClient();

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * MS_PER_DAY).toISOString();
  const sevenDaysOut = new Date(now.getTime() + 7 * MS_PER_DAY).toISOString().slice(0, 10);
  const todayStr = now.toISOString().slice(0, 10);

  const [
    { data: user },
    { data: org },
    { count: pendingCandidateCount },
    { count: newCandidatesThisWeek },
    readyForReviewCount,
    { data: prospects },
    { count: newProspectsThisWeek },
    { count: followUpsDueThisWeek },
    { data: recentRuns },
    { data: recentReviewed },
    { data: dueProspects },
    { data: pendingCandidates },
    { data: rulesData },
  ] = await Promise.all([
    supabase.auth.getUser().then((r) => ({ data: r.data.user })),
    supabase.from("org_profile").select("*").limit(1).maybeSingle<OrgProfile>(),
    supabase.from("candidates").select("*", { count: "exact", head: true }).eq("status", "pending"),
    supabase
      .from("candidates")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending")
      .gte("created_at", sevenDaysAgo),
    countStrategiesReadyForReview(supabase),
    supabase.from("prospects").select("stage, ask_amount").returns<Pick<Prospect, "stage" | "ask_amount">[]>(),
    supabase.from("prospects").select("*", { count: "exact", head: true }).gte("created_at", sevenDaysAgo),
    supabase
      .from("prospects")
      .select("*", { count: "exact", head: true })
      .not("next_action_due", "is", null)
      .gte("next_action_due", todayStr)
      .lte("next_action_due", sevenDaysOut),
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
    supabase
      .from("prospects")
      .select("id, name, next_action, next_action_due")
      .not("next_action_due", "is", null)
      .order("next_action_due", { ascending: true })
      .limit(10)
      .returns<Pick<Prospect, "id" | "name" | "next_action" | "next_action_due">[]>(),
    supabase.from("candidates").select("*").eq("status", "pending").returns<Candidate[]>(),
    supabase.from("screening_rules").select("*").eq("active", true),
  ]);

  const firstName = (user?.email ?? "there").split("@")[0].replace(/[._]+/g, " ").trim();
  const greetingName = firstName ? firstName[0].toUpperCase() + firstName.slice(1) : "there";
  const hour = now.getHours();
  const timeGreeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  // Lead with due work, not metrics -- an on-track item isn't a
  // priority yet, only what's due soon or already overdue is.
  const priorityProspects = (dueProspects ?? [])
    .map((p) => ({ ...p, health: computeHealthStatus(p.next_action_due) }))
    .filter((p) => p.health === "due_soon" || p.health === "stalled")
    .slice(0, 3);

  const byStage = new Map<string, number>();
  const potentialByStage = new Map<string, number>();
  for (const s of STAGES) {
    byStage.set(s.value, 0);
    potentialByStage.set(s.value, 0);
  }
  for (const p of prospects ?? []) {
    byStage.set(p.stage, (byStage.get(p.stage) ?? 0) + 1);
    potentialByStage.set(p.stage, (potentialByStage.get(p.stage) ?? 0) + (p.ask_amount ?? 0));
  }
  const totalInPipeline = prospects?.length ?? 0;
  const totalPotential = (prospects ?? []).reduce((sum, p) => sum + (p.ask_amount ?? 0), 0);
  const maxStagePotential = Math.max(1, ...Array.from(potentialByStage.values()));

  const rules = (rulesData ?? []) as ScreeningRule[];
  const recommended = (pendingCandidates ?? [])
    .map((c) => ({ ...c, fitPercentage: screenProspect(c, rules).breakdown.percentage }))
    .sort((a, b) => (b.fitPercentage ?? -1) - (a.fitPercentage ?? -1))
    .slice(0, 3);

  const priorityCount = (readyForReviewCount > 0 ? 1 : 0) + priorityProspects.length + (pendingCandidateCount ? 1 : 0);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: spacing.lg, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: typeScale.pageTitle }}>
            {timeGreeting}, {greetingName}
          </h1>
          <p style={{ color: colors.textMuted, marginTop: spacing.xs }}>Here&apos;s what needs your attention today.</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: spacing.sm, flexShrink: 0 }}>
          <Link
            href="/discovery"
            prefetch={false}
            style={{ ...buttonPrimary, display: "flex", alignItems: "center", gap: 8, textDecoration: "none" }}
          >
            <Search size={16} /> Find opportunities
          </Link>
          {org?.name && (
            <span
              style={{
                ...buttonSecondary,
                display: "flex",
                alignItems: "center",
                gap: 8,
                cursor: "default",
              }}
            >
              <Building2 size={16} /> {org.name}
            </span>
          )}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: spacing.xl, marginTop: spacing.xl, alignItems: "start" }}>
        <div style={sectionStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: spacing.sm }}>
              <IconBadge icon={Star} tone="teal" />
              <h2 style={{ fontSize: typeScale.sectionTitle, margin: 0 }}>Today&apos;s priorities</h2>
            </div>
          </div>
          <div style={{ display: "grid", gap: spacing.sm }}>
            {readyForReviewCount > 0 && (
              <PriorityRow
                icon={ClipboardCheck}
                title={`Review ${readyForReviewCount} completed ${readyForReviewCount === 1 ? "strategy" : "strategies"}`}
                detail="Ready for your approval"
                actionHref="/prospects/review"
                actionLabel="Review"
              />
            )}
            {priorityProspects.map((p) => (
              <PriorityRow
                key={p.id}
                icon={Mail}
                title={`Follow up with ${p.name}`}
                detail={p.next_action ?? "Next action not set"}
                health={p.health ?? undefined}
                actionHref={`/prospects/${p.id}`}
                actionLabel="View"
              />
            ))}
            {(pendingCandidateCount ?? 0) > 0 && (
              <PriorityRow
                icon={Search}
                title={`Evaluate ${pendingCandidateCount} new ${pendingCandidateCount === 1 ? "opportunity" : "opportunities"}`}
                detail="Waiting in Donor Finder"
                actionHref="/discovery"
                actionLabel="Review"
              />
            )}
            {priorityCount === 0 && <p style={{ fontSize: 13, color: colors.textMuted }}>Nothing needs attention right now.</p>}
          </div>
        </div>

        <div style={sectionStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: spacing.sm }}>
              <IconBadge icon={BarChart3} tone="teal" />
              <h2 style={{ fontSize: typeScale.sectionTitle, margin: 0 }}>Pipeline forecast</h2>
            </div>
            <Link href="/pipeline" prefetch={false} style={{ fontSize: 13, color: colors.primary, textDecoration: "none" }}>
              View full pipeline
            </Link>
          </div>

          {totalPotential > 0 && (
            <div style={{ fontSize: 26, fontWeight: 700 }}>
              {formatAmountCompact(totalPotential)}
              <span style={{ fontSize: 13, fontWeight: 500, color: colors.textMuted, marginLeft: 8 }}>Total potential</span>
            </div>
          )}

          <div style={{ display: "grid", gap: spacing.sm }}>
            {STAGES.map((s) => {
              const value = potentialByStage.get(s.value) ?? 0;
              const widthPct = Math.round((value / maxStagePotential) * 100);
              return (
                <div key={s.value} style={{ display: "grid", gridTemplateColumns: "88px 1fr auto", alignItems: "center", gap: spacing.sm }}>
                  <span style={{ fontSize: 12.5, color: colors.textMuted }}>{s.label}</span>
                  <div style={{ background: colors.surfaceSubtle, borderRadius: radiusSm, height: 10, overflow: "hidden" }}>
                    <div style={{ width: `${widthPct}%`, height: "100%", background: colors.navy700, borderRadius: radiusSm }} />
                  </div>
                  <span style={{ fontSize: 12.5, color: colors.textMuted, minWidth: 44, textAlign: "right" }}>
                    {value > 0 ? formatAmountCompact(value) : "—"}
                  </span>
                </div>
              );
            })}
          </div>

          <div style={{ fontSize: 12, color: colors.textFaint }}>As of {now.toLocaleString()}</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: spacing.md, marginTop: spacing.xl }}>
        <StatCard
          href="/discovery"
          icon={Search}
          label="New opportunities"
          value={pendingCandidateCount ?? 0}
          delta={newCandidatesThisWeek ?? 0}
        />
        <StatCard href="/pipeline" icon={Users} label="Active prospects" value={totalInPipeline} delta={newProspectsThisWeek ?? 0} />
        <StatCard
          href="/pipeline"
          icon={CalendarClock}
          label="Follow-ups due"
          value={followUpsDueThisWeek ?? 0}
          sub="Due in the next 7 days"
        />
        <StatCard href="/prospects/review" icon={ClipboardCheck} label="Strategy to review" value={readyForReviewCount} sub="Awaiting review" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: spacing.xl, marginTop: spacing.xl, alignItems: "start" }}>
        <div style={sectionStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ fontSize: typeScale.sectionTitle, margin: 0 }}>Pipeline by stage</h2>
            <Link href="/pipeline" prefetch={false} style={{ fontSize: 13, color: colors.primary, textDecoration: "none" }}>
              View pipeline
            </Link>
          </div>
          <div style={{ display: "flex", gap: spacing.md, flexWrap: "wrap" }}>
            {STAGES.map((s) => {
              const Icon = STAGE_ICONS[s.value] ?? Compass;
              return (
                <Link
                  key={s.value}
                  href={`/pipeline?stage=${s.value}`}
                  prefetch={false}
                  style={{ ...cardStyle, minWidth: 100, textDecoration: "none", color: colors.text, display: "grid", gap: 4 }}
                >
                  <Icon size={15} color={colors.navy500} />
                  <div style={{ fontSize: 22, fontWeight: 700 }}>{byStage.get(s.value) ?? 0}</div>
                  <div style={{ fontSize: 12.5, color: colors.textMuted }}>{s.label}</div>
                  {(potentialByStage.get(s.value) ?? 0) > 0 && (
                    <div style={{ fontSize: 11, color: colors.textFaint }}>{formatAmountCompact(potentialByStage.get(s.value) ?? 0)}</div>
                  )}
                </Link>
              );
            })}
          </div>
          <div style={{ fontSize: 12, color: colors.textFaint }}>
            Total opportunities: {totalInPipeline} · Total potential: {formatAmountCompact(totalPotential)} · As of {now.toLocaleDateString()}
          </div>
        </div>

        <div style={sectionStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: spacing.sm }}>
              <IconBadge icon={Sparkles} tone="teal" />
              <h2 style={{ fontSize: typeScale.sectionTitle, margin: 0 }}>Recommended opportunities</h2>
            </div>
            <Link href="/discovery" prefetch={false} style={{ fontSize: 13, color: colors.primary, textDecoration: "none" }}>
              View all opportunities
            </Link>
          </div>
          <div style={{ display: "grid", gap: spacing.sm }}>
            {recommended.map((c) => (
              <div key={c.id} style={{ display: "flex", alignItems: "center", gap: spacing.sm, ...cardStyle }}>
                {c.fitPercentage != null && <FitScoreCircle percentage={c.fitPercentage} size={36} />}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.name}
                  </div>
                  <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 1 }}>
                    {channelLabel(c.channel)}
                    {c.typical_grant_size ? ` · ${c.typical_grant_size}` : ""}
                  </div>
                </div>
                <Link
                  href="/discovery"
                  prefetch={false}
                  style={{ ...buttonSecondary, padding: "6px 12px", fontSize: 13, flexShrink: 0 }}
                >
                  Review
                </Link>
              </div>
            ))}
            {recommended.length === 0 && <p style={{ fontSize: 13, color: colors.textMuted }}>No pending opportunities right now.</p>}
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: spacing.xl, marginTop: spacing.xl }}>
        <div>
          <h2 style={{ fontSize: typeScale.sectionTitle }}>Recent search runs</h2>
          <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.md }}>
            {(recentRuns ?? []).map((r) => (
              <div key={r.id} style={cardStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                  <strong>{channelLabel(r.channel)}</strong>
                  <span style={{ color: r.status === "error" ? colors.danger : colors.textMuted }}>
                    {r.status === "done" ? `${r.found_count ?? 0} found` : r.status}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: colors.textFaint, marginTop: 2 }}>{new Date(r.created_at).toLocaleString()}</div>
              </div>
            ))}
            {(recentRuns ?? []).length === 0 && <p style={{ fontSize: 13, color: colors.textMuted }}>No search runs yet.</p>}
          </div>
        </div>

        <div>
          <h2 style={{ fontSize: typeScale.sectionTitle }}>Recently reviewed candidates</h2>
          <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.md }}>
            {(recentReviewed ?? []).map((c) => (
              <div key={c.id} style={cardStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                  <strong>{c.name}</strong>
                  <span style={{ color: c.status === "accepted" ? colors.success : colors.textMuted }}>{c.status}</span>
                </div>
                <div style={{ fontSize: 12, color: colors.textFaint, marginTop: 2 }}>{channelLabel(c.channel)}</div>
              </div>
            ))}
            {(recentReviewed ?? []).length === 0 && <p style={{ fontSize: 13, color: colors.textMuted }}>Nothing reviewed yet.</p>}
          </div>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: spacing.md,
          marginTop: spacing.xl,
          paddingTop: spacing.md,
          borderTop: `1px solid ${colors.border}`,
          fontSize: 12,
          color: colors.textFaint,
          flexWrap: "wrap",
        }}
      >
        <span>Evidence sources: AI web search · ProPublica Nonprofit Explorer (IRS Form 990 filings)</span>
        <span>Last updated {now.toLocaleString()}</span>
      </div>
    </div>
  );
}

function IconBadge({ icon: Icon, tone }: { icon: LucideIcon; tone: "teal" }) {
  const bg = tone === "teal" ? colors.teal100 : colors.surfaceSubtle;
  const fg = tone === "teal" ? colors.teal700 : colors.textMuted;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        borderRadius: radiusSm,
        background: bg,
        color: fg,
        flexShrink: 0,
      }}
    >
      <Icon size={15} />
    </span>
  );
}

function PriorityRow({
  icon: Icon,
  title,
  detail,
  health,
  actionHref,
  actionLabel,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  health?: HealthStatus;
  actionHref: string;
  actionLabel: string;
}) {
  return (
    <div
      style={{
        ...cardStyle,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: spacing.md,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: spacing.sm, minWidth: 0 }}>
        <IconBadge icon={Icon} tone="teal" />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
          <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>{detail}</div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: spacing.sm, flexShrink: 0 }}>
        {health && <HealthChip status={health} />}
        <Link href={actionHref} prefetch={false} style={buttonSecondary}>
          {actionLabel}
        </Link>
      </div>
    </div>
  );
}

function StatCard({
  href,
  icon: Icon,
  label,
  value,
  delta,
  sub,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  value: number;
  delta?: number;
  sub?: string;
}) {
  return (
    <Link href={href} prefetch={false} style={{ ...cardStyle, textDecoration: "none", color: colors.text, display: "block" }}>
      <IconBadge icon={Icon} tone="teal" />
      <div style={{ fontSize: 26, fontWeight: 700, marginTop: spacing.sm }}>{value}</div>
      <div style={{ fontSize: 13, color: colors.textMuted }}>{label}</div>
      {delta !== undefined && delta > 0 && (
        <div style={{ fontSize: 12, color: colors.teal700, marginTop: spacing.xs, display: "flex", alignItems: "center", gap: 3 }}>
          <ArrowUp size={12} /> {delta} from last 7 days
        </div>
      )}
      {sub && <div style={{ fontSize: 12, color: colors.textFaint, marginTop: spacing.xs }}>{sub}</div>}
    </Link>
  );
}
