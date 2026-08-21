import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { countStrategiesReadyForReview } from "@/lib/deep-dive";
import { colors } from "@/lib/ui";

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

  // Both badges represent items that are, by definition, waiting on a
  // human -- pending Donor Finder candidates and deep-dive strategies
  // ready_for_review -- so both get the same "needs a look" treatment.
  const [readyForReviewCount, { count: pendingCandidateCount }] = await Promise.all([
    countStrategiesReadyForReview(supabase),
    supabase.from("candidates").select("*", { count: "exact", head: true }).eq("status", "pending"),
  ]);

  // Order follows the actual workflow: overview, then setup, then the
  // funnel itself (source -> stage strategy -> active pursuit), then
  // supporting/reference items last -- replaces the old flat,
  // build-order list per the nav-redesign discussion.
  const NAV: { href: string; label: string; badge: number }[] = [
    { href: "/dashboard", label: "Dashboard", badge: 0 },
    { href: "/organization", label: "Org Profile", badge: 0 },
    { href: "/discovery", label: "Donor Finder", badge: pendingCandidateCount ?? 0 },
    { href: "/prospects/review", label: "Strategy Staging", badge: readyForReviewCount },
    { href: "/pipeline", label: "Pipeline", badge: 0 },
    { href: "/prospects", label: "Prospects", badge: 0 },
    { href: "/people", label: "People", badge: 0 },
    { href: "/evidence", label: "Evidence", badge: 0 },
    { href: "/revisit", label: "Revisit", badge: 0 },
    { href: "/settings", label: "Settings", badge: 0 },
  ];

  return (
    <div>
      {process.env.DISABLE_AUTH === "true" && (
        <div
          style={{
            background: colors.warning,
            color: "#fff",
            fontSize: 13,
            textAlign: "center",
            padding: "4px 0",
          }}
        >
          Sign-in disabled for the build phase — re-enable before Beta
        </div>
      )}
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <nav style={{ width: 200, background: "#0f172a", color: "#fff", padding: 20 }}>
          <div style={{ fontWeight: 700, marginBottom: 24 }}>Fundraising AI</div>
          <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
            {NAV.map((n) => (
              <li key={n.href}>
                <Link
                  href={n.href}
                  prefetch={false}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    color: "#cbd5e1",
                    textDecoration: "none",
                  }}
                >
                  {n.label}
                  {n.badge > 0 && (
                    <span
                      style={{
                        background: colors.danger,
                        color: "#fff",
                        borderRadius: 10,
                        padding: "1px 8px",
                        fontSize: 12,
                      }}
                    >
                      {n.badge}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <main style={{ flex: 1, padding: 32 }}>{children}</main>
      </div>
    </div>
  );
}
