import { CHANNELS } from "@/lib/prospects";
import { FIELDS, OPERATORS, IMPORTANCE_LEVELS, nearestImportance, type ScreeningRule } from "@/lib/screening";
import { spacing, colors, fieldStyle, labelStyle, sectionStyle, buttonPrimary } from "@/lib/ui";

export default function RuleForm({
  action,
  rule,
}: {
  action: (formData: FormData) => void;
  rule?: ScreeningRule;
}) {
  return (
    <form action={action} style={{ display: "grid", gap: spacing.md, marginTop: spacing.lg }}>
      <label style={labelStyle}>
        Label *
        <input name="label" defaultValue={rule?.label} required style={fieldStyle} />
      </label>
      <label style={labelStyle}>
        Description
        <input name="description" defaultValue={rule?.description ?? ""} style={fieldStyle} />
      </label>
      <label style={labelStyle}>
        Channel (leave blank to apply to all channels)
        <select name="channel" defaultValue={rule?.channel ?? ""} style={fieldStyle}>
          <option value="">All channels</option>
          {CHANNELS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label style={labelStyle}>
        Importance
        <select name="weight" defaultValue={String(rule ? nearestImportance(rule.weight) : 3)} style={fieldStyle}>
          {IMPORTANCE_LEVELS.map((level) => (
            <option key={level.value} value={level.value}>
              {level.label}
            </option>
          ))}
        </select>
      </label>

      <fieldset style={sectionStyle}>
        <legend style={{ fontSize: 12, color: colors.textMuted, padding: "0 4px" }}>
          Criterion — a prospect passes this rule when...
        </legend>
        <select name="field" defaultValue={rule?.criterion.field ?? "channel"} style={{ ...fieldStyle, marginTop: 0 }}>
          {FIELDS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <select name="operator" defaultValue={rule?.criterion.operator ?? "equals"} style={{ ...fieldStyle, marginTop: 0 }}>
          {OPERATORS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          name="value"
          placeholder="Value (not used for is filled in / is empty)"
          defaultValue={rule?.criterion.value ?? ""}
          style={{ ...fieldStyle, marginTop: 0 }}
        />
      </fieldset>

      <label style={{ display: "flex", alignItems: "center", gap: spacing.sm, fontSize: 14 }}>
        <input type="checkbox" name="active" defaultChecked={rule?.active ?? true} />
        Active
      </label>

      <button type="submit" style={buttonPrimary}>
        {rule ? "Save Rule" : "Create Rule"}
      </button>
    </form>
  );
}
