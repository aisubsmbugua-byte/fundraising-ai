import { createProspect } from "../actions";
import { CHANNELS } from "@/lib/prospects";
import { spacing, fieldStyle, labelStyle, buttonPrimary } from "@/lib/ui";

export default function NewProspectPage() {
  return (
    <div style={{ maxWidth: 480 }}>
      <h1>New Prospect</h1>
      <form action={createProspect} style={{ display: "grid", gap: spacing.md, marginTop: spacing.lg }}>
        <label style={labelStyle}>
          Name *
          <input name="name" required style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          Channel *
          <select name="channel" required defaultValue="" style={fieldStyle}>
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
        <label style={labelStyle}>
          Organization
          <input name="organization" style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          Contact name
          <input name="contact_name" style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          Contact email
          <input name="contact_email" type="email" style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          Website
          <input name="website" type="url" style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          Notes
          <textarea name="notes" rows={4} style={fieldStyle} />
        </label>
        <button type="submit" style={buttonPrimary}>
          Create Prospect
        </button>
      </form>
    </div>
  );
}
