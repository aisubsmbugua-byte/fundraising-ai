import { createProspect } from "../actions";
import { CHANNELS } from "@/lib/prospects";

export default function NewProspectPage() {
  return (
    <div style={{ maxWidth: 480 }}>
      <h1>New Prospect</h1>
      <form action={createProspect} style={{ display: "grid", gap: 12, marginTop: 16 }}>
        <label>
          Name *
          <input name="name" required style={{ width: "100%", padding: 8, marginTop: 4 }} />
        </label>
        <label>
          Channel *
          <select name="channel" required defaultValue="" style={{ width: "100%", padding: 8, marginTop: 4 }}>
            <option value="" disabled>
              Select a channel
            </option>
            {CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Organization
          <input name="organization" style={{ width: "100%", padding: 8, marginTop: 4 }} />
        </label>
        <label>
          Contact name
          <input name="contact_name" style={{ width: "100%", padding: 8, marginTop: 4 }} />
        </label>
        <label>
          Contact email
          <input name="contact_email" type="email" style={{ width: "100%", padding: 8, marginTop: 4 }} />
        </label>
        <label>
          Website
          <input name="website" type="url" style={{ width: "100%", padding: 8, marginTop: 4 }} />
        </label>
        <label>
          Notes
          <textarea name="notes" rows={4} style={{ width: "100%", padding: 8, marginTop: 4 }} />
        </label>
        <button
          type="submit"
          style={{ padding: 10, background: "#0f172a", color: "#fff", border: "none", borderRadius: 6 }}
        >
          Create Prospect
        </button>
      </form>
    </div>
  );
}
