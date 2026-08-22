import { colors } from "@/lib/ui";

export default function InitialsAvatar({ name, size = 48 }: { name: string; size?: number }) {
  const initials = name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: colors.navy900,
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 700,
        fontSize: Math.max(11, Math.round(size * 0.32)),
        flexShrink: 0,
      }}
    >
      {initials || "?"}
    </div>
  );
}
