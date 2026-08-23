import { createAdminClient } from "@/lib/supabase/admin";
import DeleteOrgButton from "./delete-org-button";
import CreateOrgForm from "./create-org-form";
import { spacing, colors, cardStyle, type as typeScale } from "@/lib/ui";

// createAdminClient() has no cookies() dependency to implicitly force
// dynamic rendering the way the normal session client does elsewhere
// in this app -- this page's data (live org/member list) must never
// be statically cached, so it's forced explicitly.
export const dynamic = "force-dynamic";

// Housekeeping: name + member count per org, nothing about any org's
// actual CRM content -- that boundary is structural (organizations
// has zero RLS policies for "authenticated", see
// 0032_multi_tenant_foundation.sql), not just a UI choice, so this
// page reading via the admin client doesn't weaken it.
export default async function AdminOrganizationsPage() {
  const admin = createAdminClient();

  const { data: organizations } = await admin
    .from("organizations")
    .select("id, name, created_at")
    .order("created_at", { ascending: false });

  const { data: profiles } = await admin.from("profiles").select("organization_id, email, is_superadmin");

  const membersByOrg = new Map<string, { email: string; is_superadmin: boolean }[]>();
  for (const p of profiles ?? []) {
    const list = membersByOrg.get(p.organization_id) ?? [];
    list.push({ email: p.email, is_superadmin: p.is_superadmin });
    membersByOrg.set(p.organization_id, list);
  }

  return (
    <div>
      <h1 style={{ fontSize: typeScale.pageTitle }}>Organizations</h1>
      <p style={{ color: colors.textMuted, fontSize: 14 }}>
        Superadmin-only. Creates a new organization and invites its first user -- that user can then invite their
        own teammates from Settings once they're signed in.
      </p>

      <CreateOrgForm />

      <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.xl }}>
        {(organizations ?? []).map((org) => {
          const members = membersByOrg.get(org.id) ?? [];
          return (
            <div key={org.id} style={{ ...cardStyle, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: spacing.md }}>
              <div style={{ minWidth: 0 }}>
                <strong>{org.name}</strong>
                <div style={{ fontSize: 13, color: colors.textMuted, marginTop: spacing.xs }}>
                  {members.length} member{members.length === 1 ? "" : "s"}
                  {members.length > 0 && ` · ${members.map((m) => m.email).join(", ")}`}
                </div>
              </div>
              <DeleteOrgButton organizationId={org.id} name={org.name} />
            </div>
          );
        })}
        {(organizations ?? []).length === 0 && (
          <p style={{ color: colors.textFaint }}>No organizations yet.</p>
        )}
      </div>
    </div>
  );
}
