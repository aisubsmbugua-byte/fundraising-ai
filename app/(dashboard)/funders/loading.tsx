import { colors, spacing, type as typeScale } from "@/lib/ui";

export default function Loading() {
  return (
    <div role="status" aria-live="polite" style={{ maxWidth: 1100 }}>
      <h1 style={{ fontSize: typeScale.pageTitle }}>Funder database</h1>
      <p style={{ color: colors.textMuted, fontSize: typeScale.body, marginTop: spacing.sm }}>Loading…</p>
    </div>
  );
}
