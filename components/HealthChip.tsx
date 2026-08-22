import { healthStatusLabel, type HealthStatus } from "@/lib/prospects";
import { chipStyle } from "@/lib/ui";

const TONE: Record<HealthStatus, "teal" | "amber" | "red"> = {
  on_track: "teal",
  due_soon: "amber",
  stalled: "red",
};

// Never the only signal for status (per the handoff's accessibility
// guidance) -- chipStyle pairs a light tint with matching dark text,
// and the label itself always renders, so this doesn't rely on hue
// alone even before considering colorblindness.
export default function HealthChip({ status }: { status: HealthStatus }) {
  return <span style={chipStyle(TONE[status])}>{healthStatusLabel(status)}</span>;
}
