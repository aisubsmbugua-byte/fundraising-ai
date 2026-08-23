import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import InviteTeammateForm from "./invite-teammate-form";
import { spacing, colors, cardStyle, type as typeScale } from "@/lib/ui";

export default async function TeamPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: teammates } = await supabase
    .from("profiles")
    .select("id, email, created_at")
    .order("created_at", { ascending: true });

  return (
    <div style={{ maxWidth: 640 }}>
      <h1 style={{ fontSize: typeScale.pageTitle }}>Team</h1>
      <p style={{ color: colors.textMuted, fontSize: 14, marginTop: spacing.xs }}>
        Everyone here shares full access to your organization's prospects, evidence, and drafts.
      </p>

      <InviteTeammateForm />

      <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.xl }}>
        {(teammates ?? []).map((t) => (
          <div key={t.id} style={{ ...cardStyle, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{t.email}</span>
            {t.id === user.id && <span style={{ fontSize: 12, color: colors.textMuted }}>You</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
