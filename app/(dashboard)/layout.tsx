import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Home as HomeIcon,
  Building2,
  Search,
  ClipboardCheck,
  Users,
  FileText,
  CalendarClock,
  Settings as SettingsIcon,
  type LucideIcon,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { countStrategiesReadyForReview } from "@/lib/deep-dive";
import { STAGES, type Prospect } from "@/lib/prospects";
import { colors, radiusSm, radiusPill } from "@/lib/ui";
import PipelineNavItem from "@/components/PipelineNavItem";
import InitialsAvatar from "@/components/InitialsAvatar";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Badges represent items that are, by definition, waiting on a
  // human -- pending Donor Finder candidates, deep-dive strategies
  // ready_for_review, unverified evidence -- so they all get the same
  // "needs a look" treatment.
  const [readyForReviewCount, { count: pendingCandidateCount }, { data: pipelineProspects }, { count: needsReviewEvidenceCount }] =
    await Promise.all([
      countStrategiesReadyForReview(supabase),
      supabase.from("candidates").select("*", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("prospects").select("stage").returns<Pick<Prospect, "stage">[]>(),
      supabase.from("evidence_items").select("*", { count: "exact", head: true }).is("verified_at", null),
    ]);

  const stageCounts = STAGES.map((s) => ({
    value: s.value,
    label: s.label,
    count: (pipelineProspects ?? []).filter((p) => p.stage === s.value).length,
  }));

  // Order follows the actual workflow: overview, then setup, then the
  // funnel itself (source -> stage strategy -> active pursuit), then
  // supporting/reference items last. Prospects is no longer its own
  // entry -- it's Pipeline's List view now. Labels per the design
  // handoff, decided case-by-case against what was already live.
  const BEFORE_PIPELINE: { href: string; label: string; badge: number; icon: LucideIcon }[] = [
    { href: "/dashboard", label: "Home", badge: 0, icon: HomeIcon },
    { href: "/organization", label: "Org Profile", badge: 0, icon: Building2 },
    { href: "/discovery", label: "Donor Finder", badge: pendingCandidateCount ?? 0, icon: Search },
    { href: "/prospects/review", label: "Strategy review", badge: readyForReviewCount, icon: ClipboardCheck },
  ];
  const AFTER_PIPELINE: { href: string; label: string; badge: number; icon: LucideIcon }[] = [
    { href: "/contacts", label: "Relationships", badge: 0, icon: Users },
    { href: "/evidence", label: "Evidence", badge: needsReviewEvidenceCount ?? 0, icon: FileText },
    { href: "/revisit", label: "Follow-up", badge: 0, icon: CalendarClock },
    { href: "/settings", label: "Settings", badge: 0, icon: SettingsIcon },
  ];

  return (
    <div>
      {process.env.DISABLE_AUTH === "true" && (
        <div
          style={{
            background: colors.amber700,
            color: "#fff",
            fontSize: 13,
            textAlign: "center",
            padding: "4px 0",
          }}
        >
          Sign-in disabled for the build phase — re-enable before Beta
        </div>
      )}
      <div style={{ display: "flex", minHeight: "100vh", background: colors.canvas }}>
        <nav
          style={{
            width: 232,
            flexShrink: 0,
            background: colors.navy950,
            color: "#fff",
            padding: 20,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 24, fontSize: 15 }}>Fundraising AI</div>
          <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 4, flex: 1, alignContent: "start" }}>
            {BEFORE_PIPELINE.map((n) => (
              <NavLink key={n.href} {...n} />
            ))}
            <PipelineNavItem stageCounts={stageCounts} />
            {AFTER_PIPELINE.map((n) => (
              <NavLink key={n.href} {...n} />
            ))}
          </ul>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginTop: 16,
              paddingTop: 16,
              borderTop: "1px solid rgba(255,255,255,0.1)",
            }}
          >
            <InitialsAvatar name={user.email ?? "?"} size={32} />
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {user.email}
              </div>
            </div>
          </div>
        </nav>
        <main style={{ flex: 1, padding: 32 }}>{children}</main>
      </div>
    </div>
  );
}

function NavLink({
  href,
  label,
  badge,
  icon: Icon,
}: {
  href: string;
  label: string;
  badge: number;
  icon: LucideIcon;
}) {
  return (
    <li>
      <Link
        href={href}
        prefetch={false}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "7px 10px",
          borderRadius: radiusSm,
          color: "#cbd5e1",
          textDecoration: "none",
          fontSize: 14,
        }}
      >
        <Icon size={16} strokeWidth={2} style={{ flexShrink: 0 }} />
        <span style={{ flex: 1 }}>{label}</span>
        {badge > 0 && (
          <span
            style={{
              background: colors.amber700,
              color: "#fff",
              borderRadius: radiusPill,
              padding: "1px 8px",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {badge}
          </span>
        )}
      </Link>
    </li>
  );
}
