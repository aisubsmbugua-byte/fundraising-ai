import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { updateProspect } from "../actions";
import { CHANNELS, type Prospect } from "@/lib/prospects";

export default async function ProspectDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: prospect } = await supabase
    .from("prospects")
    .select("*")
    .eq("id", params.id)
    .single<Prospect>();

  if (!prospect) notFound();

  const boundUpdate = updateProspect.bind(null, prospect.id);

  return (
    <div style={{ maxWidth: 480 }}>
      <h1>{prospect.name}</h1>
      <form action={boundUpdate} style={{ display: "grid", gap: 12, marginTop: 16 }}>
        <label>
          Name *
          <input name="name" defaultValue={prospect.name} required style={{ width: "100%", padding: 8, marginTop: 4 }} />
        </label>
        <label>
          Channel *
          <select
            name="channel"
            defaultValue={prospect.channel}
            required
            style={{ width: "100%", padding: 8, marginTop: 4 }}
          >
            {CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Organization
          <input
            name="organization"
            defaultValue={prospect.organization ?? ""}
            style={{ width: "100%", padding: 8, marginTop: 4 }}
          />
        </label>
        <label>
          Contact name
          <input
            name="contact_name"
            defaultValue={prospect.contact_name ?? ""}
            style={{ width: "100%", padding: 8, marginTop: 4 }}
          />
        </label>
        <label>
          Contact email
          <input
            name="contact_email"
            type="email"
            defaultValue={prospect.contact_email ?? ""}
            style={{ width: "100%", padding: 8, marginTop: 4 }}
          />
        </label>
        <label>
          Website
          <input
            name="website"
            type="url"
            defaultValue={prospect.website ?? ""}
            style={{ width: "100%", padding: 8, marginTop: 4 }}
          />
        </label>
        <label>
          Notes
          <textarea
            name="notes"
            rows={4}
            defaultValue={prospect.notes ?? ""}
            style={{ width: "100%", padding: 8, marginTop: 4 }}
          />
        </label>
        <button
          type="submit"
          style={{ padding: 10, background: "#0f172a", color: "#fff", border: "none", borderRadius: 6 }}
        >
          Save Changes
        </button>
      </form>
    </div>
  );
}
