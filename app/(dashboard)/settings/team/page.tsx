import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { inviteTeammate } from "./actions";
import { spacing, colors, fieldStyle, labelStyle, sectionStyle, cardStyle, buttonPrimary, type as typeScale } from "@/lib/ui";

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

      <form action={inviteTeammate} style={{ display: "flex", gap: spacing.sm, marginTop: spacing.xl, ...sectionStyle }}>
        <label style={{ ...labelStyle, flex: 1 }}>
          Invite a teammate by email
          <input name="email" type="email" required placeholder="teammate@org.com" style={fieldStyle} />
        </label>
        <button type="submit" style={{ ...buttonPrimary, alignSelf: "flex-end" }}>
          Send invite
        </button>
      </form>

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
