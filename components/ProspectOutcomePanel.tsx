"use client";

import { useState, useTransition } from "react";
import { Ban, CalendarClock, HelpCircle, History } from "lucide-react";
import { recordProspectDecline, setRevisitDisposition } from "@/app/(dashboard)/prospects/[id]/outcome-actions";
import { describeDisposition, type ProspectOutcome, type RevisitDisposition } from "@/lib/prospect-outcomes";
import {
  spacing,
  colors,
  fieldStyle,
  labelStyle,
  sectionStyle,
  cardStyle,
  chipStyle,
  buttonPrimary,
  buttonSecondary,
} from "@/lib/ui";

// The interface ruling 0019 authorizes: record a decline, and separately set or
// reverse the revisit disposition.
//
// Every string describing a disposition comes from describeDisposition, not
// from this file. Restating "never revisit" here would be an interface
// asserting something the code had already decided otherwise -- one of the two
// defect shapes CLAUDE.md names, and the one that is hardest to see in review.

const CHOICES: { value: RevisitDisposition; label: string; hint: string; icon: typeof Ban }[] = [
  { value: "revisit_on", label: "Come back to this on a date", hint: "Goes back on the follow-up list then.", icon: CalendarClock },
  { value: "never", label: "Close this permanently", hint: "Needs a reason. Reversible at any time.", icon: Ban },
  { value: "undecided", label: "Leave it open", hint: "Stays on the list of open questions.", icon: HelpCircle },
];

export default function ProspectOutcomePanel({
  prospectId,
  outcome,
  showRecordForm = true,
}: {
  prospectId: string;
  outcome: ProspectOutcome | null;
  // The follow-up page only ever shows prospects that already have an outcome,
  // so it has no use for the record form.
  showRecordForm?: boolean;
}) {
  if (!outcome) {
    return showRecordForm ? <RecordDeclineSection prospectId={prospectId} /> : null;
  }
  return <OutcomeSection prospectId={prospectId} outcome={outcome} />;
}

function RecordDeclineSection({ prospectId }: { prospectId: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <div style={sectionStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: spacing.sm }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>Outcome</h3>
        {!open && (
          <button type="button" onClick={() => setOpen(true)} style={{ ...buttonSecondary, padding: "6px 12px", fontSize: 13 }}>
            They said no
          </button>
        )}
      </div>
      {!open ? (
        <p style={{ fontSize: 13, color: colors.textFaint, margin: 0 }}>
          No outcome recorded. A decline is kept with its reason — a no is data, not a dead end.
        </p>
      ) : (
        <form
          action={(formData) => {
            setError(null);
            startTransition(async () => {
              const result = await recordProspectDecline(
                prospectId,
                (formData.get("reason") as string) ?? "",
                (formData.get("occurred_on") as string) ?? "",
              );
              if ("error" in result) setError(result.error);
              else setOpen(false);
            });
          }}
          style={{ display: "grid", gap: spacing.sm }}
        >
          <label style={labelStyle}>
            Why did they decline?
            <textarea
              name="reason"
              rows={3}
              required
              placeholder="e.g. Funding priorities moved to disaster relief for this cycle"
              style={fieldStyle}
            />
          </label>
          <label style={labelStyle}>
            When
            <input type="date" name="occurred_on" defaultValue={new Date().toISOString().slice(0, 10)} style={fieldStyle} />
          </label>
          <p style={{ fontSize: 12, color: colors.textFaint, margin: 0 }}>
            This records the no. It does not move the prospect to another stage — that stays a separate decision.
          </p>
          {error && <p style={{ fontSize: 13, color: colors.danger, margin: 0 }}>{error}</p>}
          <div style={{ display: "flex", gap: spacing.sm }}>
            <button type="submit" disabled={isPending} style={buttonPrimary}>
              {isPending ? "Saving…" : "Record the decline"}
            </button>
            <button type="button" onClick={() => setOpen(false)} style={buttonSecondary}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function OutcomeSection({ prospectId, outcome }: { prospectId: string; outcome: ProspectOutcome }) {
  const [choice, setChoice] = useState<RevisitDisposition | "">("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const presentation = describeDisposition(outcome.current);
  const isNever = outcome.current.disposition === "never";

  return (
    <div style={sectionStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>Outcome — declined</h3>
        <span style={chipStyle(presentation.tone)}>{presentation.label}</span>
      </div>

      <div>
        <div style={{ fontSize: 13, color: colors.textMuted }}>
          {new Date(outcome.outcome.occurred_on + "T00:00:00").toLocaleDateString()}
        </div>
        <p style={{ fontSize: 14, margin: `${spacing.xs}px 0 0` }}>{outcome.outcome.reason ?? "No reason recorded."}</p>
      </div>

      <div style={{ ...cardStyle, background: colors.surfaceSubtle }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Revisit: {presentation.label}</div>
        <div style={{ fontSize: 12.5, color: colors.textMuted, marginTop: 2 }}>{presentation.detail}</div>
        {outcome.current.reason && (
          <div style={{ fontSize: 12.5, color: colors.textMuted, marginTop: spacing.xs }}>“{outcome.current.reason}”</div>
        )}
      </div>

      <form
        action={(formData) => {
          setError(null);
          startTransition(async () => {
            const result = await setRevisitDisposition(
              prospectId,
              outcome.outcome.id,
              formData.get("disposition"),
              formData.get("revisit_on"),
              (formData.get("disposition_reason") as string) ?? "",
            );
            if ("error" in result) setError(result.error);
            else setChoice("");
          });
        }}
        style={{ display: "grid", gap: spacing.sm }}
      >
        <div style={{ fontSize: 13, fontWeight: 600 }}>{isNever ? "Reverse this" : "What happens next?"}</div>
        <div style={{ display: "grid", gap: spacing.xs }}>
          {CHOICES.filter((c) => c.value !== outcome.current.disposition || c.value === "revisit_on").map((c) => {
            const Icon = c.icon;
            return (
              <label
                key={c.value}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: spacing.sm,
                  fontSize: 13,
                  padding: spacing.sm,
                  border: `1px solid ${choice === c.value ? colors.teal700 : colors.border}`,
                  borderRadius: 6,
                  cursor: "pointer",
                  background: choice === c.value ? colors.teal100 : colors.surface,
                }}
              >
                <input
                  type="radio"
                  name="disposition"
                  value={c.value}
                  checked={choice === c.value}
                  onChange={() => setChoice(c.value)}
                  style={{ marginTop: 3 }}
                />
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
                    <Icon size={13} color={colors.navy500} /> {c.label}
                  </span>
                  <span style={{ display: "block", color: colors.textMuted, marginTop: 1 }}>{c.hint}</span>
                </span>
              </label>
            );
          })}
        </div>

        {choice === "revisit_on" && (
          <label style={labelStyle}>
            Revisit on
            <input type="date" name="revisit_on" defaultValue={outcome.current.revisitOn ?? ""} style={fieldStyle} />
          </label>
        )}

        <label style={labelStyle}>
          {choice === "never" ? "Why permanently?" : "Note (optional)"}
          <textarea name="disposition_reason" rows={2} style={fieldStyle} />
        </label>

        {error && <p style={{ fontSize: 13, color: colors.danger, margin: 0 }}>{error}</p>}

        <button type="submit" disabled={isPending || choice === ""} style={{ ...buttonPrimary, justifySelf: "start", opacity: choice === "" ? 0.5 : 1 }}>
          {isPending ? "Saving…" : "Save this decision"}
        </button>
        <p style={{ fontSize: 12, color: colors.textFaint, margin: 0 }}>
          Nothing here is deleted. Each decision is added to the history below, including one that undoes another.
        </p>
      </form>

      {outcome.history.length > 0 && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 }}>
            <History size={13} color={colors.navy500} /> Decision history ({outcome.history.length})
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: `${spacing.sm}px 0 0`, display: "grid", gap: spacing.xs }}>
            {[...outcome.history].reverse().map((h) => {
              const entry = describeDisposition({
                disposition: h.disposition as RevisitDisposition,
                revisitOn: h.revisit_on,
                reason: h.reason,
                decidedAt: h.decided_at,
                chosen: true,
              });
              return (
                <li key={h.id} style={{ fontSize: 12.5 }}>
                  <strong>{entry.label}</strong>
                  <span style={{ color: colors.textFaint }}> · {new Date(h.decided_at).toLocaleString()}</span>
                  {h.reason && <div style={{ color: colors.textMuted }}>“{h.reason}”</div>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
