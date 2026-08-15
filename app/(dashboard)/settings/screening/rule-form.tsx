import { CHANNELS } from "@/lib/prospects";
import { FIELDS, OPERATORS, IMPORTANCE_LEVELS, nearestImportance, type ScreeningRule } from "@/lib/screening";

export default function RuleForm({
  action,
  rule,
}: {
  action: (formData: FormData) => void;
  rule?: ScreeningRule;
}) {
  return (
    <form action={action} style={{ display: "grid", gap: 12, marginTop: 16 }}>
      <label>
        Label *
        <input name="label" defaultValue={rule?.label} required style={{ width: "100%", padding: 8, marginTop: 4 }} />
      </label>
      <label>
        Description
        <input
          name="description"
          defaultValue={rule?.description ?? ""}
          style={{ width: "100%", padding: 8, marginTop: 4 }}
        />
      </label>
      <label>
        Channel (leave blank to apply to all channels)
        <select name="channel" defaultValue={rule?.channel ?? ""} style={{ width: "100%", padding: 8, marginTop: 4 }}>
          <option value="">All channels</option>
          {CHANNELS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Importance
        <select
          name="weight"
          defaultValue={String(rule ? nearestImportance(rule.weight) : 3)}
          style={{ width: "100%", padding: 8, marginTop: 4 }}
        >
          {IMPORTANCE_LEVELS.map((level) => (
            <option key={level.value} value={level.value}>
              {level.label}
            </option>
          ))}
        </select>
      </label>

      <fieldset style={{ border: "1px solid #e2e8f0", borderRadius: 6, padding: 12 }}>
        <legend style={{ fontSize: 12, color: "#64748b", padding: "0 4px" }}>
          Criterion — a prospect passes this rule when...
        </legend>
        <div style={{ display: "grid", gap: 8, marginTop: 4 }}>
          <select name="field" defaultValue={rule?.criterion.field ?? "channel"} style={{ padding: 8 }}>
            {FIELDS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <select name="operator" defaultValue={rule?.criterion.operator ?? "equals"} style={{ padding: 8 }}>
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
            style={{ padding: 8 }}
          />
        </div>
      </fieldset>

      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="checkbox" name="active" defaultChecked={rule?.active ?? true} />
        Active
      </label>

      <button
        type="submit"
        style={{ padding: 10, background: "#0f172a", color: "#fff", border: "none", borderRadius: 6 }}
      >
        {rule ? "Save Rule" : "Create Rule"}
      </button>
    </form>
  );
}
