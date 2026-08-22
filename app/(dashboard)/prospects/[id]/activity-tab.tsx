import { stageLabel, type StageChange } from "@/lib/prospects";
import { spacing, colors } from "@/lib/ui";

export default function ActivityTab({ history }: { history: StageChange[] }) {
  if (history.length === 0) {
    return <p style={{ fontSize: 13, color: colors.textFaint }}>No stage changes yet.</p>;
  }

  return (
    <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: spacing.sm }}>
      {history.map((h) => (
        <li key={h.id} style={{ fontSize: 13, borderBottom: `1px solid ${colors.bgSubtle}`, paddingBottom: spacing.sm }}>
          <strong>
            {stageLabel(h.from_stage)} → {stageLabel(h.to_stage)}
          </strong>
          <div style={{ color: colors.textMuted, fontSize: 12 }}>
            {h.changed_by_email} · {new Date(h.created_at).toLocaleString()}
          </div>
          {h.note && <div style={{ marginTop: spacing.xs }}>{h.note}</div>}
        </li>
      ))}
    </ul>
  );
}
