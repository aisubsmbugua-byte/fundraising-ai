import { tierLabel, tierColor } from "@/lib/screening";

export default function TierBadge({ tier }: { tier: number }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        color: "#fff",
        background: tierColor(tier),
      }}
    >
      {tierLabel(tier)}
    </span>
  );
}
