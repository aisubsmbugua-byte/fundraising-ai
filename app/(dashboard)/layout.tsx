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
import { STAGES, computeHealthStatus, type Prospect } from "@/lib/prospects";
import { colors } from "@/lib/ui";
import Sidebar from "@/components/Sidebar";

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
      supabase.from("prospects").select("stage, next_action_due").returns<Pick<Prospect, "stage" | "next_action_due">[]>(),
      supabase.from("evidence_items").select("*", { count: "exact", head: true }).is("verified_at", null),
    ]);

  const stageCounts = STAGES.map((s) => ({
    value: s.value,
    label: s.label,
    count: (pipelineProspects ?? []).filter((p) => p.stage === s.value).length,
  }));
  const dueNowCount = (pipelineProspects ?? []).filter((p) => {
    const h = computeHealthStatus(p.next_action_due);
    return h === "due_soon" || h === "stalled";
  }).length;

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
    { href: "/revisit", label: "Follow-up", badge: dueNowCount, icon: CalendarClock },
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
      <div className="app-shell" style={{ background: colors.canvas }}>
        <Sidebar
          beforePipeline={BEFORE_PIPELINE}
          afterPipeline={AFTER_PIPELINE}
          stageCounts={stageCounts}
          userEmail={user.email ?? "?"}
        />
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}
