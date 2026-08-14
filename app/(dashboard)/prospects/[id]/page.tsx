import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { updateProspect } from "../actions";
import { CHANNELS, channelLabel, type Prospect } from "@/lib/prospects";
import DeleteProspectButton from "./delete-button";

const fieldLabelStyle: React.CSSProperties = { fontSize: 12, color: "#64748b" };

export default async function ProspectDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { edit?: string };
}) {
  const supabase = createClient();
  const { data: prospect } = await supabase
    .from("prospects")
    .select("*")
    .eq("id", params.id)
    .single<Prospect>();

  if (!prospect) notFound();

  const isEditing = searchParams.edit === "1";
  const boundUpdate = updateProspect.bind(null, prospect.id);

  return (
    <div style={{ maxWidth: 480 }}>
      <Link href="/prospects" style={{ fontSize: 14, color: "#64748b", textDecoration: "none" }}>
        ← Back to Prospects
      </Link>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 8,
        }}
      >
        <h1>{prospect.name}</h1>
        <div style={{ display: "flex", gap: 8 }}>
          {!isEditing && (
            <Link
              href={`/prospects/${prospect.id}?edit=1`}
              style={{
                padding: "6px 12px",
                border: "1px solid #cbd5e1",
                borderRadius: 4,
                textDecoration: "none",
                color: "#0f172a",
              }}
            >
              Edit
            </Link>
          )}
          <DeleteProspectButton id={prospect.id} name={prospect.name} />
        </div>
      </div>

      {isEditing ? (
        <form action={boundUpdate} style={{ display: "grid", gap: 12, marginTop: 20 }}>
          <label>
            Name *
            <input
              name="name"
              defaultValue={prospect.name}
              required
              style={{ width: "100%", padding: 8, marginTop: 4 }}
            />
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
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="submit"
              style={{ padding: 10, background: "#0f172a", color: "#fff", border: "none", borderRadius: 6 }}
            >
              Save Changes
            </button>
            <Link
              href={`/prospects/${prospect.id}`}
              style={{
                padding: 10,
                border: "1px solid #cbd5e1",
                borderRadius: 6,
                textDecoration: "none",
                color: "#0f172a",
              }}
            >
              Cancel
            </Link>
          </div>
        </form>
      ) : (
        <dl style={{ marginTop: 20, display: "grid", gap: 12 }}>
          <div>
            <dt style={fieldLabelStyle}>Channel</dt>
            <dd>{channelLabel(prospect.channel)}</dd>
          </div>
          <div>
            <dt style={fieldLabelStyle}>Organization</dt>
            <dd>{prospect.organization ?? "—"}</dd>
          </div>
          <div>
            <dt style={fieldLabelStyle}>Contact name</dt>
            <dd>{prospect.contact_name ?? "—"}</dd>
          </div>
          <div>
            <dt style={fieldLabelStyle}>Contact email</dt>
            <dd>{prospect.contact_email ?? "—"}</dd>
          </div>
          <div>
            <dt style={fieldLabelStyle}>Website</dt>
            <dd>{prospect.website ?? "—"}</dd>
          </div>
          <div>
            <dt style={fieldLabelStyle}>Notes</dt>
            <dd style={{ whiteSpace: "pre-wrap" }}>{prospect.notes ?? "—"}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}
