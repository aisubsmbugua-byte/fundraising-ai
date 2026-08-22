import Link from "next/link";
import type { Prospect } from "@/lib/prospects";
import type { Contact } from "@/lib/contacts";
import { spacing, colors, sectionStyle, buttonSecondary } from "@/lib/ui";

export default function ContactsTab({ prospect, relatedContacts }: { prospect: Prospect; relatedContacts: Contact[] }) {
  return (
    <div style={{ display: "grid", gap: spacing.lg }}>
      <div style={sectionStyle}>
        <h3 style={{ fontSize: 14 }}>On this record</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: spacing.md }}>
          <div>
            <div style={{ fontSize: 12, color: colors.textMuted }}>Contact name</div>
            <div style={{ fontSize: 14, marginTop: 2 }}>{prospect.contact_name ?? "—"}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: colors.textMuted }}>Contact email</div>
            <div style={{ fontSize: 14, marginTop: 2 }}>{prospect.contact_email ?? "—"}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: colors.textMuted }}>Website</div>
            <div style={{ fontSize: 14, marginTop: 2 }}>{prospect.website ?? "—"}</div>
          </div>
        </div>
        <Link href={`/prospects/${prospect.id}?edit=1`} style={{ ...buttonSecondary, marginTop: spacing.sm, justifySelf: "start" }}>
          Edit
        </Link>
      </div>

      {relatedContacts.length > 0 && (
        <div>
          <h3 style={{ fontSize: 14 }}>In Relationships</h3>
          <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.sm }}>
            {relatedContacts.map((c) => (
              <Link
                key={c.id}
                href="/contacts"
                style={{ ...sectionStyle, textDecoration: "none", color: colors.text, display: "block" }}
              >
                <strong style={{ fontSize: 14 }}>{c.name}</strong>
                <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>
                  {c.email ?? "No email on file"}
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
