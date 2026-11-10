import Link from "next/link";
import { buttonSecondary, colors, spacing, type as typeScale } from "@/lib/ui";

export default function FunderNotFound() {
  return (
    <div style={{ maxWidth: 640 }}>
      <h1 style={{ fontSize: typeScale.pageTitle }}>Funder not found</h1>
      <p style={{ color: colors.textMuted, fontSize: typeScale.body, marginTop: spacing.sm }}>
        No funder with that EIN is in the database. That does not mean it does not exist: it may be in a state
        that is not loaded yet, or below the size the database holds.
      </p>
      <Link href="/funders" style={{ ...buttonSecondary, marginTop: spacing.lg }}>
        Back to search
      </Link>
    </div>
  );
}
