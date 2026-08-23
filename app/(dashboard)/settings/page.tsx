import Link from "next/link";
import { SlidersHorizontal, Building2, Users, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { computeProfileCompleteness, type OrgProfile } from "@/lib/organization";
import type { ScreeningRule } from "@/lib/screening";
import FitScoreCircle from "@/components/FitScoreCircle";
import { spacing, colors, type as typeScale, radiusSm, sectionStyle } from "@/lib/ui";

export default async function SettingsPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const [{ data: profile }, { count: activeRuleCount }, { data: caller }] = await Promise.all([
    supabase.from("org_profile").select("*").limit(1).maybeSingle<OrgProfile>(),
    supabase.from("screening_rules").select("*", { count: "exact", head: true }).eq("active", true),
    user ? supabase.from("profiles").select("is_superadmin").eq("id", user.id).maybeSingle() : Promise.resolve({ data: null }),
  ]);

  const completeness = computeProfileCompleteness(profile ?? null);

  return (
    <div style={{ maxWidth: 640 }}>
      <h1 style={{ fontSize: typeScale.pageTitle }}>Settings</h1>
      <p style={{ color: colors.textMuted, fontSize: 14, marginTop: spacing.xs }}>
        Manage your organization profile and AI screening rules.
      </p>

      <div style={{ display: "grid", gap: spacing.lg, marginTop: spacing.xl }}>
        <Link
          href="/organization"
          style={{ ...sectionStyle, display: "flex", alignItems: "center", justifyContent: "space-between", textDecoration: "none", color: colors.text }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: spacing.md }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 36,
                height: 36,
                borderRadius: radiusSm,
                background: colors.teal100,
                color: colors.teal700,
                flexShrink: 0,
              }}
            >
              <Building2 size={18} />
            </span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Organization Profile</div>
              <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>
                {profile?.name ?? "The nonprofit's own knowledge base"} — AI uses this to propose funder matches.
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: spacing.sm, flexShrink: 0 }}>
            <FitScoreCircle percentage={completeness} size={40} />
          </div>
        </Link>

        <Link
          href="/settings/screening"
          style={{ ...sectionStyle, display: "flex", alignItems: "center", justifyContent: "space-between", textDecoration: "none", color: colors.text }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: spacing.md }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 36,
                height: 36,
                borderRadius: radiusSm,
                background: colors.teal100,
                color: colors.teal700,
                flexShrink: 0,
              }}
            >
              <SlidersHorizontal size={18} />
            </span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Screening Rules</div>
              <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>
                Drives the tier a candidate gets when screened — never moves a stage automatically.
              </div>
            </div>
          </div>
          <div style={{ fontSize: 13, color: colors.textMuted, flexShrink: 0 }}>
            {activeRuleCount ?? 0} active
          </div>
        </Link>

        <Link
          href="/settings/team"
          style={{ ...sectionStyle, display: "flex", alignItems: "center", justifyContent: "space-between", textDecoration: "none", color: colors.text }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: spacing.md }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 36,
                height: 36,
                borderRadius: radiusSm,
                background: colors.teal100,
                color: colors.teal700,
                flexShrink: 0,
              }}
            >
              <Users size={18} />
            </span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Team</div>
              <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>
                Invite teammates into your organization.
              </div>
            </div>
          </div>
        </Link>

        {caller?.is_superadmin && (
          <Link
            href="/admin/organizations"
            style={{ ...sectionStyle, display: "flex", alignItems: "center", justifyContent: "space-between", textDecoration: "none", color: colors.text }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: spacing.md }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 36,
                  height: 36,
                  borderRadius: radiusSm,
                  background: colors.amber100,
                  color: colors.amber700,
                  flexShrink: 0,
                }}
              >
                <ShieldCheck size={18} />
              </span>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>Organizations (superadmin)</div>
                <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>
                  Create and manage organizations across the whole platform.
                </div>
              </div>
            </div>
          </Link>
        )}
      </div>
    </div>
  );
}
