import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { CHANNELS, channelLabel, type Prospect } from "@/lib/prospects";
import { spacing, colors, buttonPrimary, buttonSecondary } from "@/lib/ui";

export default async function ProspectsPage({
  searchParams,
}: {
  searchParams: { q?: string; channel?: string };
}) {
  const supabase = createClient();
  let query = supabase
    .from("prospects")
    .select("*")
    .order("created_at", { ascending: false });

  if (searchParams.q) {
    query = query.ilike("name", `%${searchParams.q}%`);
  }
  if (searchParams.channel) {
    query = query.eq("channel", searchParams.channel);
  }

  const { data: prospects, error } = await query;

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: spacing.xl,
        }}
      >
        <h1>Prospects</h1>
        <Link href="/prospects/new" style={buttonPrimary}>
          + New Prospect
        </Link>
      </div>

      <form style={{ display: "flex", gap: spacing.sm, marginBottom: spacing.xl }}>
        <input
          type="text"
          name="q"
          placeholder="Search by name..."
          defaultValue={searchParams.q}
          style={{
            padding: spacing.sm,
            flex: 1,
            border: `1px solid ${colors.borderStrong}`,
            borderRadius: 4,
            boxSizing: "border-box",
          }}
        />
        <select
          name="channel"
          defaultValue={searchParams.channel ?? ""}
          style={{ padding: spacing.sm, border: `1px solid ${colors.borderStrong}`, borderRadius: 4 }}
        >
          <option value="">All channels</option>
          {CHANNELS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <button type="submit" style={buttonSecondary}>
          Filter
        </button>
      </form>

      {error && <p style={{ color: "crimson" }}>Error loading prospects: {error.message}</p>}

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: `1px solid ${colors.border}` }}>
            <th style={{ padding: spacing.sm }}>Name</th>
            <th style={{ padding: spacing.sm }}>Channel</th>
            <th style={{ padding: spacing.sm }}>Organization</th>
            <th style={{ padding: spacing.sm }}>Contact</th>
            <th style={{ padding: spacing.sm }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {(prospects as Prospect[] | null)?.map((p) => (
            <tr key={p.id} style={{ borderBottom: `1px solid ${colors.bgSubtle}` }}>
              <td style={{ padding: spacing.sm }}>
                <Link href={`/prospects/${p.id}`}>{p.name}</Link>
              </td>
              <td style={{ padding: spacing.sm }}>{channelLabel(p.channel)}</td>
              <td style={{ padding: spacing.sm }}>{p.organization ?? "—"}</td>
              <td style={{ padding: spacing.sm }}>{p.contact_name ?? p.contact_email ?? "—"}</td>
              <td style={{ padding: spacing.sm }}>
                <Link href={`/prospects/${p.id}?edit=1`}>Edit</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {prospects?.length === 0 && <p style={{ color: colors.textMuted, marginTop: spacing.xl }}>No prospects found.</p>}
    </div>
  );
}
