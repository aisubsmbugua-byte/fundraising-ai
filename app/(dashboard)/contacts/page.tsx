import Link from "next/link";
import { Users, Building2, MailWarning } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import type { Contact } from "@/lib/contacts";
import InitialsAvatar from "@/components/InitialsAvatar";
import { spacing, colors, type as typeScale, radiusSm, fieldStyle, cardStyle, chipStyle } from "@/lib/ui";

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: { tab?: string; q?: string; org?: string };
}) {
  const supabase = createClient();
  const { data: contacts, error } = await supabase
    .from("contacts")
    .select("*")
    .order("updated_at", { ascending: false })
    .returns<Contact[]>();

  if (error) {
    return <p style={{ color: colors.danger }}>Error loading contacts: {error.message}</p>;
  }

  const all = contacts ?? [];
  const tab = searchParams.tab === "organizations" ? "organizations" : "people";

  const orgCounts = new Map<string, number>();
  for (const c of all) {
    if (c.organization) orgCounts.set(c.organization, (orgCounts.get(c.organization) ?? 0) + 1);
  }
  const missingEmailCount = all.filter((c) => !c.email).length;

  const q = searchParams.q?.trim().toLowerCase();
  const filtered = all.filter((c) => {
    if (q && !c.name.toLowerCase().includes(q)) return false;
    if (searchParams.org && c.organization !== searchParams.org) return false;
    return true;
  });

  return (
    <div>
      <h1 style={{ fontSize: typeScale.pageTitle }}>Relationships</h1>
      <p style={{ color: colors.textMuted, marginTop: spacing.xs, maxWidth: 640, fontSize: 14 }}>
        Every individual contact captured across Donor Finder and Pipeline, deduplicated by email. Saved
        automatically whenever a contact name or email is entered elsewhere — nothing to maintain here.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: spacing.md, marginTop: spacing.lg }}>
        <StatTile icon={Users} value={String(all.length)} label="People" />
        <StatTile icon={Building2} value={String(orgCounts.size)} label="Organizations" />
        <StatTile
          icon={MailWarning}
          value={String(missingEmailCount)}
          label="Missing email"
          tone={missingEmailCount > 0 ? "amber" : undefined}
        />
      </div>

      <div style={{ display: "flex", gap: spacing.lg, marginTop: spacing.xl, borderBottom: `1px solid ${colors.border}` }}>
        <Link
          href="/contacts"
          style={{
            fontSize: 14,
            fontWeight: tab === "people" ? 600 : 500,
            color: tab === "people" ? colors.text : colors.textMuted,
            textDecoration: "none",
            padding: "8px 2px",
            borderBottom: `2px solid ${tab === "people" ? colors.primary : "transparent"}`,
          }}
        >
          People
        </Link>
        <Link
          href="/contacts?tab=organizations"
          style={{
            fontSize: 14,
            fontWeight: tab === "organizations" ? 600 : 500,
            color: tab === "organizations" ? colors.text : colors.textMuted,
            textDecoration: "none",
            padding: "8px 2px",
            borderBottom: `2px solid ${tab === "organizations" ? colors.primary : "transparent"}`,
          }}
        >
          Organizations
        </Link>
      </div>

      {tab === "organizations" ? (
        <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.lg }}>
          {[...orgCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([org, count]) => (
              <Link
                key={org}
                href={`/contacts?org=${encodeURIComponent(org)}`}
                style={{ ...cardStyle, display: "flex", justifyContent: "space-between", alignItems: "center", textDecoration: "none", color: colors.text }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: spacing.sm }}>
                  <Building2 size={15} color={colors.navy500} />
                  <strong style={{ fontSize: 14 }}>{org}</strong>
                </div>
                <span style={{ fontSize: 13, color: colors.textMuted }}>
                  {count} {count === 1 ? "contact" : "contacts"}
                </span>
              </Link>
            ))}
          {orgCounts.size === 0 && <p style={{ color: colors.textMuted, fontSize: 14 }}>No organizations on file yet.</p>}
        </div>
      ) : (
        <div style={{ marginTop: spacing.lg }}>
          <form style={{ display: "flex", gap: spacing.sm, marginBottom: spacing.lg, alignItems: "center" }}>
            {searchParams.org && <input type="hidden" name="org" value={searchParams.org} />}
            <input
              type="text"
              name="q"
              placeholder="Search people..."
              defaultValue={searchParams.q}
              style={{ ...fieldStyle, marginTop: 0, flex: 1 }}
            />
            {searchParams.org && (
              <Link href="/contacts" style={{ ...chipStyle("neutral"), display: "flex", alignItems: "center", textDecoration: "none" }}>
                {searchParams.org} ✕
              </Link>
            )}
          </form>

          <div style={{ display: "grid", gap: spacing.sm }}>
            {filtered.map((c) => (
              <div key={c.id} style={{ ...cardStyle, display: "flex", justifyContent: "space-between", alignItems: "center", gap: spacing.md }}>
                <div style={{ display: "flex", alignItems: "center", gap: spacing.sm, minWidth: 0 }}>
                  <InitialsAvatar name={c.name} size={36} />
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ fontSize: 14 }}>{c.name}</strong>
                    <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 1 }}>
                      {c.email ? c.email : <span style={{ color: colors.amber700 }}>No email on file</span>}
                      {c.organization && c.organization !== c.name ? ` · ${c.organization}` : ""}
                    </div>
                  </div>
                </div>
                {c.source_prospect_id && (
                  <Link href={`/prospects/${c.source_prospect_id}`} style={{ fontSize: 13, flexShrink: 0 }}>
                    View prospect →
                  </Link>
                )}
              </div>
            ))}
            {filtered.length === 0 && (
              <p style={{ color: colors.textMuted, fontSize: 14 }}>
                {all.length === 0
                  ? "No contacts yet — they'll show up here as soon as one is entered on a candidate or prospect."
                  : "No contacts match your search."}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatTile({
  icon: Icon,
  value,
  label,
  tone,
}: {
  icon: typeof Users;
  value: string;
  label: string;
  tone?: "amber";
}) {
  return (
    <div style={cardStyle}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          borderRadius: radiusSm,
          background: tone === "amber" ? colors.amber100 : colors.teal100,
          color: tone === "amber" ? colors.amber700 : colors.teal700,
        }}
      >
        <Icon size={15} />
      </span>
      <div style={{ fontSize: 26, fontWeight: 700, marginTop: spacing.sm }}>{value}</div>
      <div style={{ fontSize: 13, color: colors.textMuted }}>{label}</div>
    </div>
  );
}
