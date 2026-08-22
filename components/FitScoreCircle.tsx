import { colors } from "@/lib/ui";

// A real percentage -- screenProspect() already computes a
// rules-weighted 0-1 fit score for tiering; this just gives that
// existing number a face instead of leaving it collapsed into a
// coarse 1/2/3 tier. Color follows the same teal/amber/red scale as
// tier badges and health chips.
export default function FitScoreCircle({ percentage, size = 48 }: { percentage: number; size?: number }) {
  const pct = Math.round(percentage * 100);
  const stroke = Math.max(3, size * 0.08);
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.min(1, Math.max(0, percentage)));
  const color = percentage >= 0.7 ? colors.teal700 : percentage >= 0.4 ? colors.amber700 : colors.red600;

  return (
    <svg width={size} height={size} style={{ flexShrink: 0 }} role="img" aria-label={`${pct}% fit`}>
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={colors.border} strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dy="0.32em"
        fontSize={size * 0.32}
        fontWeight={700}
        fill={color}
        fontFamily="inherit"
      >
        {pct}
      </text>
    </svg>
  );
}
