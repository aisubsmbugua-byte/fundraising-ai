import { createProspect } from "../actions";
import { CHANNELS } from "@/lib/prospects";
import { spacing, colors, fieldStyle, labelStyle, buttonPrimary } from "@/lib/ui";

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

        <div style={{ fontSize: 13, fontWeight: 600, color: colors.text, marginTop: spacing.sm }}>
          Pipeline tracking (optional)
        </div>
        <label style={labelStyle}>
          Ask amount
          <input name="ask_amount" type="number" min={0} step={1} placeholder="e.g. 25000" style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          Next action
          <input name="next_action" placeholder="e.g. Send intro email" style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          Next action due
          <input name="next_action_due" type="date" style={fieldStyle} />
        </label>

        <div style={{ fontSize: 13, fontWeight: 600, color: colors.text, marginTop: spacing.sm }}>
          Funder intelligence (optional — fill in what you already know)
        </div>
        <label style={labelStyle}>
          Location
          <input name="location" style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          Funder type
          <input name="funder_type" placeholder="e.g. private foundation, corporate giving" style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          Geographic focus
          <input name="geographic_focus" placeholder="e.g. nationwide, California only" style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          Typical grant size
          <input name="typical_grant_size" placeholder="e.g. $5,000-$25,000" style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          Focus areas (comma-separated)
          <input name="focus_areas" style={fieldStyle} />
        </label>

        <button type="submit" style={buttonPrimary}>
          Create Prospect
        </button>
      </form>
    </div>
  );
}
