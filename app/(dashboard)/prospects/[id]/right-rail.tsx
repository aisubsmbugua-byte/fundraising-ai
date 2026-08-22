import Link from "next/link";
import { computeHealthStatus, type Prospect } from "@/lib/prospects";
import { spacing, colors, sectionStyle, buttonSecondary } from "@/lib/ui";
import HealthChip from "@/components/HealthChip";

export default function RightRail({ prospect }: { prospect: Prospect }) {
  const health = computeHealthStatus(prospect.next_action_due);

  return (
    <div style={{ display: "grid", gap: spacing.lg, alignContent: "start" }}>
      <div style={sectionStyle}>
        <h3 style={{ fontSize: 14 }}>Next action</h3>
        {prospect.next_action ? (
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{prospect.next_action}</div>
            <div style={{ display: "flex", alignItems: "center", gap: spacing.sm, marginTop: spacing.xs }}>
              {prospect.next_action_due && (
                <span style={{ fontSize: 12, color: colors.textMuted }}>
                  Due{" "}
                  {new Date(prospect.next_action_due + "T00:00:00").toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              )}
              {health && <HealthChip status={health} />}
            </div>
          </div>
        ) : (
          <p style={{ fontSize: 13, color: colors.textFaint }}>No next action set.</p>
        )}
        <Link href={`/prospects/${prospect.id}?edit=1`} style={{ ...buttonSecondary, marginTop: spacing.sm, textAlign: "center" }}>
          {prospect.next_action ? "Update" : "Set next action"}
        </Link>
      </div>

      <div style={sectionStyle}>
        <h3 style={{ fontSize: 14 }}>Key contact</h3>
        {prospect.contact_name || prospect.contact_email ? (
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{prospect.contact_name ?? "—"}</div>
            {prospect.contact_email && (
              <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>{prospect.contact_email}</div>
            )}
          </div>
        ) : (
          <p style={{ fontSize: 13, color: colors.textFaint }}>No contact identified yet.</p>
        )}
        <Link href={`/prospects/${prospect.id}?edit=1`} style={{ ...buttonSecondary, marginTop: spacing.sm, textAlign: "center" }}>
          {prospect.contact_name || prospect.contact_email ? "Edit contact" : "Add a contact"}
        </Link>
      </div>
    </div>
  );
}
