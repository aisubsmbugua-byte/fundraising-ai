"use client";

import { useState, useTransition } from "react";
import { addConnection, updateConnection, deleteConnection, type ConnectionInput } from "./actions";
import ConfirmDialog from "@/components/ConfirmDialog";
import { CONNECTION_STRENGTHS, NETWORK_DISCLOSURE, type NetworkConnection } from "@/lib/network";
import { spacing, colors, fieldStyle, labelStyle, buttonPrimary, buttonSecondary, buttonDanger, sectionStyle, cardStyle, chipStyle } from "@/lib/ui";

const STRENGTH_LABEL: Record<string, string> = { close: "Close", warm: "Warm", acquaintance: "Acquaintance" };

const EMPTY: ConnectionInput = { person_name: "", affiliation: "", how_known: "", strength: "", notes: "" };

function toInput(c: NetworkConnection): ConnectionInput {
  return {
    person_name: c.person_name,
    affiliation: c.affiliation ?? "",
    how_known: c.how_known ?? "",
    strength: c.strength,
    notes: c.notes ?? "",
  };
}

// One form for add and edit. The disclosure sentence (ruling 0033 clause 3)
// sits on the form itself, where the data is entered. Strength has no default:
// the select starts on an empty choice and the action refuses an omitted value.
function ConnectionForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: ConnectionInput;
  submitLabel: string;
  onSubmit: (input: ConnectionInput) => Promise<{ error: string } | { success: true }>;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState<ConnectionInput>(initial);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const set = (key: keyof ConnectionInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await onSubmit(values);
          if ("error" in result) setError(result.error);
          else if (!onCancel) setValues(EMPTY);
        });
      }}
      style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: spacing.md }}
    >
      <p
        style={{
          margin: 0,
          fontSize: 13,
          color: colors.text,
          background: colors.amber100,
          border: `1px solid ${colors.border}`,
          borderRadius: 6,
          padding: spacing.md,
        }}
      >
        {NETWORK_DISCLOSURE}
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: spacing.md }}>
        <label style={labelStyle}>
          Name
          <input style={fieldStyle} value={values.person_name} onChange={set("person_name")} required />
        </label>
        <label style={labelStyle}>
          Where they work or serve
          <input style={fieldStyle} value={values.affiliation} onChange={set("affiliation")} />
        </label>
        <label style={labelStyle}>
          How close are you
          <select style={fieldStyle} value={values.strength} onChange={set("strength")} required>
            <option value="" disabled>
              Choose one
            </option>
            {CONNECTION_STRENGTHS.map((s) => (
              <option key={s} value={s}>
                {STRENGTH_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label style={labelStyle}>
        How you know them
        <input style={fieldStyle} value={values.how_known} onChange={set("how_known")} />
      </label>
      <label style={labelStyle}>
        Notes
        <textarea style={{ ...fieldStyle, minHeight: 72 }} value={values.notes} onChange={set("notes")} />
      </label>
      {error && <p style={{ color: colors.danger, fontSize: 13, margin: 0 }}>{error}</p>}
      <div style={{ display: "flex", gap: spacing.sm }}>
        <button type="submit" disabled={isPending} style={buttonPrimary}>
          {isPending ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={isPending} style={buttonSecondary}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function ConnectionCard({ connection }: { connection: NetworkConnection }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (editing) {
    return (
      <div style={cardStyle}>
        <ConnectionForm
          initial={toInput(connection)}
          submitLabel="Save changes"
          onCancel={() => setEditing(false)}
          onSubmit={async (input) => {
            const result = await updateConnection(connection.id, input);
            if ("success" in result) setEditing(false);
            return result;
          }}
        />
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: spacing.md, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{connection.person_name}</div>
          {connection.affiliation && <div style={{ fontSize: 13, color: colors.textMuted }}>{connection.affiliation}</div>}
        </div>
        <span style={chipStyle(connection.strength === "close" ? "teal" : connection.strength === "warm" ? "amber" : "neutral")}>
          {STRENGTH_LABEL[connection.strength] ?? connection.strength}
        </span>
      </div>
      {connection.how_known && (
        <p style={{ fontSize: 13, margin: `${spacing.sm}px 0 0` }}>
          <span style={{ color: colors.textMuted }}>How you know them: </span>
          {connection.how_known}
        </p>
      )}
      {connection.notes && <p style={{ fontSize: 13, color: colors.textMuted, margin: `${spacing.xs}px 0 0` }}>{connection.notes}</p>}
      {error && <p style={{ color: colors.danger, fontSize: 13, margin: `${spacing.sm}px 0 0` }}>{error}</p>}
      <div style={{ display: "flex", gap: spacing.sm, marginTop: spacing.md }}>
        <button type="button" style={buttonSecondary} onClick={() => setEditing(true)} disabled={isPending}>
          Edit
        </button>
        <button type="button" style={buttonDanger} onClick={() => setConfirming(true)} disabled={isPending}>
          {isPending ? "Deleting…" : "Delete"}
        </button>
      </div>
      <ConfirmDialog
        open={confirming}
        title="Delete this person"
        message={`Delete "${connection.person_name}" from your network? Any introduction paths suggested through them will be deleted too. This can't be undone.`}
        confirmLabel="Delete"
        danger
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          setError(null);
          startTransition(async () => {
            const result = await deleteConnection(connection.id);
            if ("error" in result) setError(result.error);
          });
        }}
      />
    </div>
  );
}

export default function NetworkWorkspace({ connections }: { connections: NetworkConnection[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: spacing.xl, marginTop: spacing.lg }}>
      <section style={sectionStyle}>
        <h2 style={{ fontSize: 17, margin: 0 }}>Add someone you know</h2>
        <ConnectionForm initial={EMPTY} submitLabel="Add to network" onSubmit={addConnection} />
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: spacing.md }}>
        <h2 style={{ fontSize: 17, margin: 0 }}>People you have recorded ({connections.length})</h2>
        {connections.length === 0 ? (
          <div style={sectionStyle}>
            <p style={{ margin: 0, fontSize: 13, color: colors.textMuted }}>
              No one recorded yet. Add the people your team knows — board members, donors, partners, pastors — and the AI
              can look for which of them might open a door to a funder you are pursuing.
            </p>
          </div>
        ) : (
          connections.map((c) => <ConnectionCard key={c.id} connection={c} />)
        )}
      </section>
    </div>
  );
}
