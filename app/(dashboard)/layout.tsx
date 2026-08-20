import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const NAV = [
  { href: "/organization", label: "Organization Profile" },
  { href: "/pipeline", label: "Pipeline" },
  { href: "/prospects", label: "Prospects" },
  { href: "/discovery", label: "Discovery" },
  { href: "/evidence", label: "Evidence" },
  { href: "/revisit", label: "Revisit" },
  { href: "/settings", label: "Settings" },
];

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

  // Deep dives now fire in the background right from the Discovery
  // queue (see candidate-actions.tsx) instead of the reviewer having
  // to sit on the destination page waiting -- this badge is how they
  // find out a strategy finished and is ready to look at. No "latest
  // per prospect" query built in, so dedupe newest-first in JS; cheap
  // at this app's scale.
  const { data: runs } = await supabase
    .from("deep_dive_runs")
    .select("prospect_id, status, approved_strategy, created_at")
    .order("created_at", { ascending: false });

  const seenProspects = new Set<string>();
  let readyForReviewCount = 0;
  for (const run of runs ?? []) {
    if (seenProspects.has(run.prospect_id)) continue;
    seenProspects.add(run.prospect_id);
    if (run.status === "ready_for_review" && !run.approved_strategy) readyForReviewCount++;
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <nav style={{ width: 200, background: "#0f172a", color: "#fff", padding: 20 }}>
        <div style={{ fontWeight: 700, marginBottom: 24 }}>Fundraising AI</div>
        <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
          {readyForReviewCount > 0 && (
            <li>
              <Link
                href="/prospects/review"
                prefetch={false}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  color: "#fff",
                  fontWeight: 600,
                  textDecoration: "none",
                }}
              >
                Strategies to Review
                <span
                  style={{
                    background: "#d97706",
                    color: "#fff",
                    borderRadius: 10,
                    padding: "1px 8px",
                    fontSize: 12,
                  }}
                >
                  {readyForReviewCount}
                </span>
              </Link>
            </li>
          )}
          {NAV.map((n) => (
            <li key={n.href}>
              <Link href={n.href} prefetch={false} style={{ color: "#cbd5e1", textDecoration: "none" }}>
                {n.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <main style={{ flex: 1, padding: 32 }}>{children}</main>
    </div>
  );
}
