"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Sparkles, ThumbsUp, ThumbsDown, Plus, Mail, PhoneCall, Users, MessageSquare, CalendarClock, ArrowLeft } from "lucide-react";
import {
  logInteraction,
  suggestNextStep,
  useSuggestedNextStep,
  dismissSuggestedNextStep,
  updateCandidateRevisit,
} from "./actions";
import { channelLabel, stageLabel, computeHealthStatus, type Prospect } from "@/lib/prospects";
import type { Candidate } from "@/lib/candidates";
import { INTERACTION_KINDS, interactionKindLabel, type Interaction, type InteractionKind } from "@/lib/interactions";
import InitialsAvatar from "@/components/InitialsAvatar";
import HealthChip from "@/components/HealthChip";
import { spacing, colors, radiusSm, fieldStyle, labelStyle, cardStyle, sectionStyle, chipStyle, buttonPrimary, buttonSecondary } from "@/lib/ui";

type Row = { kind: "prospect"; data: Prospect } | { kind: "candidate"; data: Candidate };

type Tab = "due_now" | "waiting" | "scheduled" | "revisit_later" | "past_decisions";
const TABS: { value: Tab; label: string }[] = [
  { value: "due_now", label: "Due now" },
  { value: "waiting", label: "Waiting" },
  { value: "scheduled", label: "Scheduled" },
  { value: "revisit_later", label: "Revisit later" },
  { value: "past_decisions", label: "Past decisions" },
];

const ICON_BY_KIND: Record<InteractionKind, typeof Mail> = {
  email: Mail,
  call: PhoneCall,
  meeting: Users,
  note: MessageSquare,
};

export default function FollowupWorkspace({
  dueNow,
  waiting,
  scheduled,
  revisitLater,
  pastDecisions,
  interactionsByProspect,
}: {
  dueNow: Prospect[];
  waiting: Prospect[];
  scheduled: Prospect[];
  revisitLater: Candidate[];
  pastDecisions: Candidate[];
  interactionsByProspect: Record<string, Interaction[]>;
}) {
  const [tab, setTab] = useState<Tab>("due_now");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const rowsByTab: Record<Tab, Row[]> = {
    due_now: dueNow.map((p) => ({ kind: "prospect", data: p })),
    waiting: waiting.map((p) => ({ kind: "prospect", data: p })),
    scheduled: scheduled.map((p) => ({ kind: "prospect", data: p })),
    revisit_later: revisitLater.map((c) => ({ kind: "candidate", data: c })),
    past_decisions: pastDecisions.map((c) => ({ kind: "candidate", data: c })),
  };
  const rows = rowsByTab[tab];
  const selected = rows.find((r) => r.data.id === selectedId) ?? rows[0] ?? null;

  return (
    <div
      className="split-pane"
      style={{ display: "grid", gridTemplateColumns: "minmax(320px, 42%) 1fr", gap: spacing.lg, marginTop: spacing.lg }}
    >
      <div className={`split-pane-list${mobileDetailOpen ? " detail-active" : ""}`} style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: spacing.lg, borderBottom: `1px solid ${colors.border}`, flexWrap: "wrap" }}>
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => {
                setTab(t.value);
                setSelectedId(null);
                setMobileDetailOpen(false);
              }}
              style={{
                background: "none",
                border: "none",
                borderBottom: `2px solid ${tab === t.value ? colors.primary : "transparent"}`,
                color: tab === t.value ? colors.text : colors.textMuted,
                fontWeight: tab === t.value ? 600 : 500,
                fontSize: 13,
                padding: "8px 2px",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {t.label} {rowsByTab[t.value].length}
            </button>
          ))}
        </div>

        <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.md, maxHeight: "70vh", overflowY: "auto" }}>
          {rows.map((row) => (
            <RowCard
              key={row.data.id}
              row={row}
              selected={selected?.data.id === row.data.id}
              onClick={() => {
                setSelectedId(row.data.id);
                setMobileDetailOpen(true);
              }}
            />
          ))}
          {rows.length === 0 && <p style={{ fontSize: 13, color: colors.textMuted, padding: spacing.sm }}>Nothing here.</p>}
        </div>
      </div>

      <div className={`split-pane-detail${mobileDetailOpen ? " detail-active" : ""}`}>
        <button
          type="button"
          onClick={() => setMobileDetailOpen(false)}
          className="split-pane-back-button"
          style={{ alignItems: "center", gap: 6, background: "none", border: "none", color: colors.textMuted, fontSize: 13, cursor: "pointer", padding: 0, marginBottom: spacing.sm }}
        >
          <ArrowLeft size={14} /> Back to list
        </button>
        {selected ? (
          selected.kind === "prospect" ? (
            <ProspectDetail prospect={selected.data} interactions={interactionsByProspect[selected.data.id] ?? []} />
          ) : (
            <CandidateDetail candidate={selected.data} />
          )
        ) : (
          <div style={{ border: `1px dashed ${colors.border}`, borderRadius: radiusSm, padding: spacing.xxl, textAlign: "center", color: colors.textFaint, fontSize: 14 }}>
            Select an item from the list to see details.
          </div>
        )}
      </div>
    </div>
  );
}

function RowCard({ row, selected, onClick }: { row: Row; selected: boolean; onClick: () => void }) {
  const isProspect = row.kind === "prospect";
  const name = row.data.name;
  const health = isProspect ? computeHealthStatus((row.data as Prospect).next_action_due) : null;

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: spacing.sm,
        textAlign: "left",
        background: selected ? colors.teal100 : colors.surface,
        border: `1px solid ${selected ? colors.teal700 : colors.border}`,
        borderRadius: radiusSm,
        padding: spacing.sm,
        cursor: "pointer",
      }}
    >
      <InitialsAvatar name={name} size={36} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
        <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 1 }}>
          {channelLabel(row.data.channel)}
          {isProspect && ` · ${stageLabel((row.data as Prospect).stage)}`}
        </div>
        {isProspect && (row.data as Prospect).next_action && (
          <div style={{ fontSize: 11, color: colors.textFaint, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {(row.data as Prospect).next_action}
          </div>
        )}
        {!isProspect && (row.data as Candidate).dismissed_reason && (
          <div style={{ fontSize: 11, color: colors.textFaint, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {(row.data as Candidate).dismissed_reason}
          </div>
        )}
      </div>
      {health && <HealthChip status={health} />}
    </button>
  );
}

function ProspectDetail({ prospect, interactions }: { prospect: Prospect; interactions: Interaction[] }) {
  const [isPending, startTransition] = useTransition();
  const [logOpen, setLogOpen] = useState(false);
  const hasSuggestion = !!prospect.suggested_at;

  return (
    <div style={{ display: "grid", gap: spacing.lg }}>
      <div style={sectionStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: spacing.md }}>
          <div style={{ display: "flex", gap: spacing.md, minWidth: 0 }}>
            <InitialsAvatar name={prospect.name} size={44} />
            <div style={{ minWidth: 0 }}>
              <h2 style={{ fontSize: 17, overflowWrap: "break-word" }}>{prospect.name}</h2>
              <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>
                {prospect.contact_name ?? "No contact identified"}
                {prospect.contact_email ? ` · ${prospect.contact_email}` : ""}
              </div>
              <span style={{ ...chipStyle("neutral"), marginTop: spacing.xs, display: "inline-block" }}>{stageLabel(prospect.stage)}</span>
            </div>
          </div>
          <Link href={`/prospects/${prospect.id}`} style={{ ...buttonSecondary, flexShrink: 0 }}>
            Open prospect →
          </Link>
        </div>
      </div>

      <div style={sectionStyle}>
        <h3 style={{ fontSize: 14 }}>Current next action</h3>
        {prospect.next_action ? (
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{prospect.next_action}</div>
            {prospect.next_action_due && (
              <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
                Due {new Date(prospect.next_action_due + "T00:00:00").toLocaleDateString()}
              </div>
            )}
          </div>
        ) : (
          <p style={{ fontSize: 13, color: colors.textFaint, margin: 0 }}>No next action set.</p>
        )}
      </div>

      <div style={sectionStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: spacing.sm }}>
          <Sparkles size={15} color={colors.teal700} />
          <h3 style={{ fontSize: 14, margin: 0 }}>AI-suggested next step</h3>
        </div>
        {hasSuggestion ? (
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{prospect.suggested_next_action}</div>
            {prospect.suggested_next_action_due && (
              <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
                Suggested due {new Date(prospect.suggested_next_action_due + "T00:00:00").toLocaleDateString()}
              </div>
            )}
            {prospect.suggested_reasoning && (
              <p style={{ fontSize: 13, color: colors.text, marginTop: spacing.sm }}>{prospect.suggested_reasoning}</p>
            )}
            <p style={{ fontSize: 12, color: colors.textFaint, marginTop: spacing.sm }}>
              AI-proposed — review before using. Nothing is applied automatically.
            </p>
            <div style={{ display: "flex", gap: spacing.sm, marginTop: spacing.sm }}>
              <button
                type="button"
                disabled={isPending}
                onClick={() => startTransition(() => useSuggestedNextStep(prospect.id))}
                style={{ ...buttonPrimary, display: "flex", alignItems: "center", gap: 6 }}
              >
                <ThumbsUp size={14} /> Use this
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={() => startTransition(() => dismissSuggestedNextStep(prospect.id))}
                style={{ ...buttonSecondary, display: "flex", alignItems: "center", gap: 6 }}
              >
                <ThumbsDown size={14} /> Dismiss
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={isPending}
            onClick={() => startTransition(() => suggestNextStep(prospect.id))}
            style={{ ...buttonSecondary, display: "flex", alignItems: "center", gap: 6 }}
          >
            <Sparkles size={14} /> {isPending ? "Thinking…" : "Suggest next step"}
          </button>
        )}
      </div>

      <div style={sectionStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ fontSize: 14 }}>Interaction history ({interactions.length})</h3>
          <button type="button" onClick={() => setLogOpen((o) => !o)} style={{ ...buttonSecondary, display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: "6px 10px" }}>
            <Plus size={13} /> Log
          </button>
        </div>

        {logOpen && <LogInteractionForm prospectId={prospect.id} onDone={() => setLogOpen(false)} />}

        {interactions.length > 0 ? (
          <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.sm }}>
            {interactions.map((i) => {
              const Icon = ICON_BY_KIND[i.kind];
              return (
                <div key={i.id} style={{ display: "flex", gap: spacing.sm, fontSize: 13 }}>
                  <Icon size={14} color={colors.navy500} style={{ flexShrink: 0, marginTop: 2 }} />
                  <div style={{ minWidth: 0 }}>
                    <div>{i.summary}</div>
                    <div style={{ fontSize: 12, color: colors.textFaint, marginTop: 1 }}>
                      {interactionKindLabel(i.kind)} · {new Date(i.occurred_at + "T00:00:00").toLocaleDateString()}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p style={{ fontSize: 13, color: colors.textFaint, margin: 0 }}>No interactions logged yet.</p>
        )}
      </div>
    </div>
  );
}

function LogInteractionForm({ prospectId, onDone }: { prospectId: string; onDone: () => void }) {
  const [isPending, startTransition] = useTransition();

  return (
    <form
      action={(formData) => {
        startTransition(async () => {
          await logInteraction(
            prospectId,
            formData.get("kind") as InteractionKind,
            formData.get("summary") as string,
            (formData.get("occurred_at") as string) || new Date().toISOString().slice(0, 10)
          );
          onDone();
        });
      }}
      style={{ display: "grid", gap: spacing.sm, marginTop: spacing.sm, ...cardStyle }}
    >
      <div style={{ display: "flex", gap: spacing.sm }}>
        <select name="kind" defaultValue="email" style={{ ...fieldStyle, marginTop: 0 }}>
          {INTERACTION_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <input type="date" name="occurred_at" defaultValue={new Date().toISOString().slice(0, 10)} style={{ ...fieldStyle, marginTop: 0 }} />
      </div>
      <textarea name="summary" placeholder="What happened?" required rows={2} style={fieldStyle} />
      <div style={{ display: "flex", gap: spacing.sm }}>
        <button type="submit" disabled={isPending} style={buttonPrimary}>
          {isPending ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onDone} style={buttonSecondary}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function CandidateDetail({ candidate }: { candidate: Candidate }) {
  const [isPending, startTransition] = useTransition();

  return (
    <div style={{ display: "grid", gap: spacing.lg }}>
      <div style={sectionStyle}>
        <div style={{ display: "flex", gap: spacing.md, minWidth: 0 }}>
          <InitialsAvatar name={candidate.name} size={44} />
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 17 }}>{candidate.name}</h2>
            <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>
              {channelLabel(candidate.channel)}
              {candidate.organization ? ` · ${candidate.organization}` : ""}
            </div>
            <span style={{ ...chipStyle("neutral"), marginTop: spacing.xs, display: "inline-block" }}>Dismissed</span>
          </div>
        </div>
      </div>

      <div style={sectionStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: spacing.sm }}>
          <CalendarClock size={15} color={colors.teal700} />
          <h3 style={{ fontSize: 14, margin: 0 }}>Why, and when to revisit</h3>
        </div>
        <form
          action={(formData) => {
            startTransition(() =>
              updateCandidateRevisit(candidate.id, formData.get("reason") as string, formData.get("revisit_date") as string)
            );
          }}
          style={{ display: "grid", gap: spacing.sm }}
        >
          <label style={labelStyle}>
            Reason
            <textarea name="reason" defaultValue={candidate.dismissed_reason ?? ""} rows={2} placeholder="e.g. Not accepting applications until 2027" style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Revisit on
            <input type="date" name="revisit_date" defaultValue={candidate.revisit_date ?? ""} style={fieldStyle} />
          </label>
          <button type="submit" disabled={isPending} style={{ ...buttonPrimary, justifySelf: "start" }}>
            {isPending ? "Saving…" : "Save"}
          </button>
        </form>
      </div>
    </div>
  );
}
