import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { CHANNELS, channelLabel, type Prospect } from "@/lib/prospects";

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
          marginBottom: 24,
        }}
      >
        <h1>Prospects</h1>
        <Link
          href="/prospects/new"
          style={{
            padding: "8px 16px",
            background: "#0f172a",
            color: "#fff",
            borderRadius: 6,
            textDecoration: "none",
          }}
        >
          + New Prospect
        </Link>
      </div>

      <form style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <input
          type="text"
          name="q"
          placeholder="Search by name..."
          defaultValue={searchParams.q}
          style={{ padding: 8, flex: 1, border: "1px solid #cbd5e1", borderRadius: 4 }}
        />
        <select
          name="channel"
          defaultValue={searchParams.channel ?? ""}
          style={{ padding: 8, border: "1px solid #cbd5e1", borderRadius: 4 }}
        >
          <option value="">All channels</option>
          {CHANNELS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          style={{ padding: "8px 16px", border: "1px solid #cbd5e1", borderRadius: 4, background: "#fff" }}
        >
          Filter
        </button>
      </form>

      {error && <p style={{ color: "crimson" }}>Error loading prospects: {error.message}</p>}

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
            <th style={{ padding: 8 }}>Name</th>
            <th style={{ padding: 8 }}>Channel</th>
            <th style={{ padding: 8 }}>Organization</th>
            <th style={{ padding: 8 }}>Contact</th>
            <th style={{ padding: 8 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {(prospects as Prospect[] | null)?.map((p) => (
            <tr key={p.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
              <td style={{ padding: 8 }}>
                <Link href={`/prospects/${p.id}`}>{p.name}</Link>
              </td>
              <td style={{ padding: 8 }}>{channelLabel(p.channel)}</td>
              <td style={{ padding: 8 }}>{p.organization ?? "—"}</td>
              <td style={{ padding: 8 }}>{p.contact_name ?? p.contact_email ?? "—"}</td>
              <td style={{ padding: 8 }}>
                <Link href={`/prospects/${p.id}?edit=1`}>Edit</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {prospects?.length === 0 && <p style={{ color: "#666", marginTop: 20 }}>No prospects found.</p>}
    </div>
  );
}
