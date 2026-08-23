import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { spacing } from "@/lib/ui";

// Deliberately outside the (dashboard) route group -- this is a
// platform-operator tool, not part of any org's CRM, so it doesn't
// belong in the CRM sidebar/nav. Gated on profiles.is_superadmin,
// which grants nothing beyond org creation + this housekeeping view
// (see 0032_multi_tenant_foundation.sql) -- it never exposes any
// org's actual CRM content.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("is_superadmin").eq("id", user.id).maybeSingle();
  if (!profile?.is_superadmin) redirect("/pipeline");

  return <div style={{ maxWidth: 720, margin: "0 auto", padding: spacing.xl }}>{children}</div>;
}
