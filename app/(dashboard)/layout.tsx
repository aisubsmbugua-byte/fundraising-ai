import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const NAV = [
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

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <nav style={{ width: 200, background: "#0f172a", color: "#fff", padding: 20 }}>
        <div style={{ fontWeight: 700, marginBottom: 24 }}>Fundraising AI</div>
        <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
          {NAV.map((n) => (
            <li key={n.href}>
              <Link href={n.href} style={{ color: "#cbd5e1", textDecoration: "none" }}>
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
