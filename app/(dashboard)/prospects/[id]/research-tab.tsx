import type { DeepDiveRun } from "@/lib/deep-dive";
import { spacing, colors, sectionStyle } from "@/lib/ui";

// Raw web-research findings behind the AI strategy -- captured since
// the very first deep dive but never surfaced anywhere in the UI
// before now; this tab just gives it a home.
export default function ResearchTab({ deepDiveRun }: { deepDiveRun: DeepDiveRun | null }) {
  if (!deepDiveRun?.findings) {
    return (
      <p style={{ fontSize: 13, color: colors.textFaint }}>
        No research findings yet — these appear once the AI deep-dive has run.
      </p>
    );
  }

  return (
    <div style={sectionStyle}>
      <h3 style={{ fontSize: 14 }}>Web research findings</h3>
      <p style={{ fontSize: 13, color: colors.textMuted, margin: 0 }}>
        Raw findings from the deep-dive's web search step, before the AI structured them into a strategy.
      </p>
      <p style={{ fontSize: 13, color: colors.text, whiteSpace: "pre-wrap", marginTop: spacing.sm }}>
        {deepDiveRun.findings}
      </p>
    </div>
  );
}
