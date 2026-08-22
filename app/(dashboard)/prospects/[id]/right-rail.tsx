import { CalendarClock, UserRound } from "lucide-react";
import { computeHealthStatus, type Prospect } from "@/lib/prospects";
import { spacing, colors, radiusSm, sectionStyle } from "@/lib/ui";
import HealthChip from "@/components/HealthChip";
import NextActionPopover from "@/components/NextActionPopover";
import ContactPopover from "@/components/ContactPopover";

function SectionTitle({ icon: Icon, title }: { icon: typeof CalendarClock; title: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: spacing.sm }}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 26,
          height: 26,
          borderRadius: radiusSm,
          background: colors.teal100,
          color: colors.teal700,
          flexShrink: 0,
        }}
      >
        <Icon size={14} />
      </span>
      <h3 style={{ fontSize: 14, margin: 0 }}>{title}</h3>
    </div>
  );
}

export default function RightRail({ prospect }: { prospect: Prospect }) {
  const health = computeHealthStatus(prospect.next_action_due);

  return (
    <div style={{ display: "grid", gap: spacing.lg, alignContent: "start" }}>
      <div style={sectionStyle}>
        <SectionTitle icon={CalendarClock} title="Next action" />
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
        <div style={{ marginTop: spacing.sm }}>
          <NextActionPopover
            prospectId={prospect.id}
            currentAction={prospect.next_action}
            currentDue={prospect.next_action_due}
          />
        </div>
      </div>

      <div style={sectionStyle}>
        <SectionTitle icon={UserRound} title="Key contact" />
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
        <div style={{ marginTop: spacing.sm }}>
          <ContactPopover
            prospectId={prospect.id}
            currentName={prospect.contact_name}
            currentEmail={prospect.contact_email}
          />
        </div>
      </div>
    </div>
  );
}
