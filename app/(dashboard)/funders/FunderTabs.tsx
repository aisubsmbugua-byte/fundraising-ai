import Link from "next/link";
import { buttonPrimary, buttonSecondary, spacing } from "@/lib/ui";

// STATE items 113 + 116 (ruling 0048 clause 4): the two kinds of funder are separate lists, never blended in a
// count or average. Foundations (Form 990-PF) and grantmaking public charities and donor-advised fund sponsors
// (Form 990) each have their own search, loaded by their own run.
export function FunderTabs({ active }: { active: "foundations" | "charities" }) {
  const tab = (key: "foundations" | "charities", href: string, label: string) => (
    <Link key={key} href={href} aria-current={active === key ? "page" : undefined} style={{ ...(active === key ? buttonPrimary : buttonSecondary), padding: "6px 14px" }}>
      {label}
    </Link>
  );
  return (
    <nav aria-label="Kinds of funder" style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap", marginBottom: spacing.md }}>
      {tab("foundations", "/funders", "Private foundations")}
      {tab("charities", "/funders/charities", "Public charities and donor-advised fund sponsors")}
    </nav>
  );
}
