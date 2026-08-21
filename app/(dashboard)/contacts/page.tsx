import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { Contact } from "@/lib/contacts";
import { spacing, colors, cardStyle } from "@/lib/ui";

export default async function ContactsPage() {
  const supabase = createClient();
  const { data: contacts, error } = await supabase
    .from("contacts")
    .select("*")
    .order("updated_at", { ascending: false })
    .returns<Contact[]>();

  if (error) {
    return <p style={{ color: colors.danger }}>Error loading contacts: {error.message}</p>;
  }

  return (
    <div>
      <h1>Contacts</h1>
      <p style={{ color: colors.textMuted, marginTop: spacing.xs, maxWidth: 640 }}>
        Every individual contact captured across Donor Finder and Pipeline, deduplicated by email. Saved
        automatically whenever a contact name or email is entered elsewhere — nothing to maintain here.
      </p>

      <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.xl }}>
        {(contacts ?? []).map((c) => (
          <div
            key={c.id}
            style={{
              ...cardStyle,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div>
              <strong>{c.name}</strong>
              <div style={{ fontSize: 13, color: colors.textMuted }}>
                {c.email ?? "No email on file"}
                {c.organization && c.organization !== c.name ? ` · ${c.organization}` : ""}
              </div>
            </div>
            {c.source_prospect_id && (
              <Link href={`/prospects/${c.source_prospect_id}`} style={{ fontSize: 13 }}>
                View prospect →
              </Link>
            )}
          </div>
        ))}
        {(contacts ?? []).length === 0 && (
          <p style={{ color: colors.textMuted, fontSize: 14 }}>
            No contacts yet — they'll show up here as soon as one is entered on a candidate or prospect.
          </p>
        )}
      </div>
    </div>
  );
}
