"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Sparkles, ThumbsUp, ThumbsDown, Plus, Mail, PhoneCall, Users, MessageSquare, CalendarClock, ArrowLeft } from "lucide-react";
import {
  suggestNextStep,
  useSuggestedNextStep,
  dismissSuggestedNextStep,
  updateCandidateRevisit,
  logInteraction,
} from "./actions";
import { channelLabel, stageLabel, computeHealthStatus, type Prospect } from "@/lib/prospects";
import type { Candidate } from "@/lib/candidates";
import { interactionKindLabel, type Interaction, type InteractionKind } from "@/lib/interactions";
import type { NurtureRow } from "@/lib/nurture";
import { describeDisposition, type ProspectOutcome } from "@/lib/prospect-outcomes";
import { supporterTierLabel, formatPledge, sourceTypeLabel, type SupporterStewardshipRow } from "@/lib/supporters";
import InitialsAvatar from "@/components/InitialsAvatar";
import HealthChip from "@/components/HealthChip";
import ProspectOutcomePanel from "@/components/ProspectOutcomePanel";
import LogInteractionForm from "@/components/LogInteractionForm";
import { spacing, colors, radiusSm, fieldStyle, labelStyle, sectionStyle, chipStyle, buttonPrimary, buttonSecondary } from "@/lib/ui";

export type DeclinedProspect = { prospect: Prospect; outcome: ProspectOutcome };

type Row =
  | { kind: "prospect"; data: Prospect }
  | { kind: "candidate"; data: Candidate }
  | { kind: "declined"; data: Prospect; outcome: ProspectOutcome }
  | { kind: "nurture"; data: Prospect; nurture: NurtureRow };

type Tab =
  | "due_now"
  | "open_questions"
  | "waiting"
  | "scheduled"
  | "revisit_later"
  | "past_decisions"
  | "nurture"
  | "supporter_stewardship";
// "Open questions" sits second, directly after the work that is already due,
// because that is what it is: a funder said no and nobody has decided whether
// to go back. Ruling 0019 requires that state to surface rather than sit.
const TABS: { value: Tab; label: string }[] = [
  { value: "due_now", label: "Due now" },
  { value: "open_questions", label: "Open questions" },
  { value: "waiting", label: "Waiting" },
  { value: "scheduled", label: "Scheduled" },
  { value: "revisit_later", label: "Revisit later" },
  { value: "past_decisions", label: "Past decisions" },
  // Post-yes relationships going quiet (STATE item 75). Hosted as a tab here
  // because the row detail already carries the suggest-next-step control.
  { value: "nurture", label: "Nurture" },
  // STATE item 80, ruling 0034: individual, recurring supporters going quiet
  // relative to THEIR OWN tiered threshold -- a separate population and a
  // separate derivation (lib/supporters.ts) from prospect Nurture above;
  // ruling 0034 is explicit the two must not collapse into one queue.
  { value: "supporter_stewardship", label: "Supporter stewardship" },
];

const NURTURE_NOTE =
  "Nurture v1: this queue shows who has gone quiet. AI-drafted nurture notes are a later version — for now, use Suggest next step for ideas and Compose to write the note yourself; every email still needs your approval before it can be sent.";

const SUPPORTER_STEWARDSHIP_NOTE =
  "Individual, recurring supporters, ordered stalest-first by their own tier's quiet threshold (light/standard/priority, scaled to pledge size -- ruling 0034). A different population and a different clock from Nurture above, which tracks prospects.";

const TIER_TONE: Record<SupporterStewardshipRow["tier"], "neutral" | "amber" | "red"> = {
  light: "neutral",
  standard: "amber",
  priority: "red",
};

const ICON_BY_KIND: Record<InteractionKind, typeof Mail> = {
  email: Mail,
  call: PhoneCall,
  meeting: Users,
  note: MessageSquare,
};

export default function FollowupWorkspace({
  dueNow,
  dueRevisits,
  waiting,
  scheduled,
  revisitLater,
  pastDecisions,
  openQuestions,
  scheduledRevisits,
  nurture,
  interactionsByProspect,
  supporterStewardship,
}: {
  dueNow: Prospect[];
  // Ruling 0028 clause 3: a declined prospect whose revisit date has arrived
  // is due work, so it sits in the same "Due now" tab as everything else due.
  dueRevisits: DeclinedProspect[];
  waiting: Prospect[];
  scheduled: Prospect[];
  revisitLater: Candidate[];
  pastDecisions: Candidate[];
  openQuestions: DeclinedProspect[];
  scheduledRevisits: DeclinedProspect[];
  nurture: NurtureRow[];
  interactionsByProspect: Record<string, Interaction[]>;
  // STATE item 80: a separate derivation (lib/supporters.ts), a separate
  // population, rendered through its own list+detail rather than forced
  // through Row/RowCard -- those are shaped for Prospect/Candidate data and a
  // supporter has neither channel nor stage.
  supporterStewardship: SupporterStewardshipRow[];
}) {
  const [tab, setTab] = useState<Tab>("due_now");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSupporterId, setSelectedSupporterId] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const rowsByTab: Record<Tab, Row[]> = {
    due_now: [
      ...dueNow.map((p) => ({ kind: "prospect" as const, data: p })),
      ...dueRevisits.map((d) => ({ kind: "declined" as const, data: d.prospect, outcome: d.outcome })),
    ],
    open_questions: openQuestions.map((d) => ({ kind: "declined", data: d.prospect, outcome: d.outcome })),
    waiting: waiting.map((p) => ({ kind: "prospect", data: p })),
    scheduled: scheduled.map((p) => ({ kind: "prospect", data: p })),
    // A dismissed candidate with a date and a declined prospect with a date are
    // the same question -- something to come back to then -- so they share a
    // list rather than a near-duplicate one beside it.
    revisit_later: [
      ...revisitLater.map((c) => ({ kind: "candidate" as const, data: c })),
      ...scheduledRevisits.map((d) => ({ kind: "declined" as const, data: d.prospect, outcome: d.outcome })),
    ],
    past_decisions: pastDecisions.map((c) => ({ kind: "candidate", data: c })),
    nurture: nurture.map((n) => ({ kind: "nurture", data: n.prospect, nurture: n })),
    // supporter_stewardship is rendered through its own list+detail below, not
    // through Row/RowCard -- kept out of rowsByTab's Row union rather than
    // stuffing a Supporter into a type shaped for Prospect/Candidate.
    supporter_stewardship: [],
  };
  const isSupporterTab = tab === "supporter_stewardship";
  const rows = rowsByTab[tab];
  const selected = rows.find((r) => r.data.id === selectedId) ?? rows[0] ?? null;
  const selectedSupporterRow =
    supporterStewardship.find((r) => r.supporter.id === selectedSupporterId) ?? supporterStewardship[0] ?? null;

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
                setSelectedSupporterId(null);
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
              {t.label} {t.value === "supporter_stewardship" ? supporterStewardship.length : rowsByTab[t.value].length}
            </button>
          ))}
        </div>

        {tab === "nurture" && (
          <p style={{ fontSize: 13, color: colors.textMuted, marginTop: spacing.md, marginBottom: 0 }}>{NURTURE_NOTE}</p>
        )}
        {isSupporterTab && (
          <p style={{ fontSize: 13, color: colors.textMuted, marginTop: spacing.md, marginBottom: 0 }}>{SUPPORTER_STEWARDSHIP_NOTE}</p>
        )}

        <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.md, maxHeight: "70vh", overflowY: "auto" }}>
          {isSupporterTab
            ? supporterStewardship.map((row) => (
                <SupporterStewardshipRowCard
                  key={row.supporter.id}
                  row={row}
                  selected={selectedSupporterRow?.supporter.id === row.supporter.id}
                  onClick={() => {
                    setSelectedSupporterId(row.supporter.id);
                    setMobileDetailOpen(true);
                  }}
                />
              ))
            : rows.map((row) => (
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
          {isSupporterTab && supporterStewardship.length === 0 && (
            <p style={{ fontSize: 13, color: colors.textMuted, padding: spacing.sm }}>
              Nobody is due for stewardship contact -- every supporter has been touched within their tier's window.
            </p>
          )}
          {!isSupporterTab && rows.length === 0 && (
            <p style={{ fontSize: 13, color: colors.textMuted, padding: spacing.sm }}>
              {tab === "nurture" ? "Nobody has gone quiet. Every funder in Awarding or Stewardship has been touched recently." : "Nothing here."}
            </p>
          )}
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
        {isSupporterTab ? (
          selectedSupporterRow ? (
            <SupporterStewardshipDetail row={selectedSupporterRow} />
          ) : (
            <div style={{ border: `1px dashed ${colors.border}`, borderRadius: radiusSm, padding: spacing.xxl, textAlign: "center", color: colors.textFaint, fontSize: 14 }}>
              Select a supporter from the list to see details.
            </div>
          )
        ) : selected ? (
          selected.kind === "prospect" || selected.kind === "nurture" ? (
            <ProspectDetail
              prospect={selected.data}
              interactions={interactionsByProspect[selected.data.id] ?? []}
              composeHref={selected.kind === "nurture" ? `/prospects/${selected.data.id}?tab=strategy` : undefined}
            />
          ) : selected.kind === "declined" ? (
            <DeclinedProspectDetail prospect={selected.data} outcome={selected.outcome} />
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

function SupporterStewardshipRowCard({ row, selected, onClick }: { row: SupporterStewardshipRow; selected: boolean; onClick: () => void }) {
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
      <InitialsAvatar name={row.supporter.name} size={36} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {row.supporter.name}
        </div>
        <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 1 }}>{formatPledge(row.supporter)}</div>
      </div>
      <span style={{ ...chipStyle(TIER_TONE[row.tier]), flexShrink: 0 }}>{supporterTierLabel(row.tier)}</span>
      <span style={{ ...chipStyle("neutral"), flexShrink: 0 }}>
        {row.daysSinceLastTouch === null ? "Never touched" : `${row.daysSinceLastTouch}d quiet`}
      </span>
    </button>
  );
}

function SupporterStewardshipDetail({ row }: { row: SupporterStewardshipRow }) {
  const { supporter } = row;
  return (
    <div style={{ display: "grid", gap: spacing.lg }}>
      <div style={sectionStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: spacing.md }}>
          <div style={{ display: "flex", gap: spacing.md, minWidth: 0 }}>
            <InitialsAvatar name={supporter.name} size={44} />
            <div style={{ minWidth: 0 }}>
              <h2 style={{ fontSize: 17, overflowWrap: "break-word" }}>{supporter.name}</h2>
              <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>
                {formatPledge(supporter)} · {sourceTypeLabel(supporter.source_type)}
              </div>
              <div style={{ display: "flex", gap: spacing.xs, marginTop: spacing.xs, flexWrap: "wrap" }}>
                <span style={chipStyle(TIER_TONE[row.tier])}>{supporterTierLabel(row.tier)} tier</span>
                <span style={chipStyle("neutral")}>
                  Threshold: every {row.thresholdDays} days
                </span>
              </div>
            </div>
          </div>
          <Link href={`/supporters?id=${supporter.id}`} style={{ ...buttonSecondary, flexShrink: 0 }}>
            Open supporter →
          </Link>
        </div>
      </div>

      <div style={sectionStyle}>
        <h3 style={{ fontSize: 14 }}>Why this row is here</h3>
        <p style={{ fontSize: 13, margin: 0 }}>
          {row.daysSinceLastTouch === null
            ? `Never touched. The ${supporterTierLabel(row.tier).toLowerCase()} tier checks on a supporter at this pledge size every ${row.thresholdDays} days, and nothing has ever been logged.`
            : `${row.daysSinceLastTouch} days since the last gift or interaction, past the ${supporterTierLabel(row.tier).toLowerCase()} tier's ${row.thresholdDays}-day threshold for this pledge size.`}
        </p>
      </div>
    </div>
  );
}

function RowCard({ row, selected, onClick }: { row: Row; selected: boolean; onClick: () => void }) {
  const isProspect = row.kind === "prospect";
  const name = row.data.name;
  const health = isProspect ? computeHealthStatus((row.data as Prospect).next_action_due) : null;
  // The disposition chip is read from the rule, so a row in this list and the
  // panel that edits it can never describe the same state differently.
  const disposition = row.kind === "declined" ? describeDisposition(row.outcome.current) : null;

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
          {row.kind !== "candidate" && ` · ${stageLabel((row.data as Prospect).stage)}`}
        </div>
        {isProspect && (row.data as Prospect).next_action && (
          <div style={{ fontSize: 11, color: colors.textFaint, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {(row.data as Prospect).next_action}
          </div>
        )}
        {row.kind === "nurture" && (
          <div style={{ fontSize: 11, color: colors.textFaint, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {row.nurture.lastInteractionSummary ?? "No interactions logged yet"}
          </div>
        )}
        {row.kind === "candidate" && row.data.dismissed_reason && (
          <div style={{ fontSize: 11, color: colors.textFaint, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {row.data.dismissed_reason}
          </div>
        )}
        {row.kind === "declined" && row.outcome.outcome.reason && (
          <div style={{ fontSize: 11, color: colors.textFaint, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {row.outcome.outcome.reason}
          </div>
        )}
      </div>
      {row.kind === "nurture" && (
        <span style={{ ...chipStyle("amber"), flexShrink: 0 }}>
          {row.nurture.daysSinceLastTouch === null ? "Never touched" : `${row.nurture.daysSinceLastTouch} days quiet`}
        </span>
      )}
      {disposition && <span style={{ ...chipStyle(disposition.tone), flexShrink: 0 }}>{disposition.label}</span>}
      {health && <HealthChip status={health} />}
    </button>
  );
}

function ProspectDetail({
  prospect,
  interactions,
  composeHref,
}: {
  prospect: Prospect;
  interactions: Interaction[];
  // Set only on the Nurture tab: a link into the existing human compose flow
  // (Strategy tab, item 60). Nothing is drafted or sent from here.
  composeHref?: string;
}) {
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
          <div style={{ display: "flex", gap: spacing.sm, flexShrink: 0, flexWrap: "wrap" }}>
            {composeHref && (
              <Link href={composeHref} style={buttonSecondary}>
                Compose email
              </Link>
            )}
            <Link href={`/prospects/${prospect.id}`} style={buttonSecondary}>
              Open prospect →
            </Link>
          </div>
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

        {logOpen && (
          <LogInteractionForm
            onLog={(kind, summary, occurredAt) => logInteraction(prospect.id, kind, summary, occurredAt)}
            onDone={() => setLogOpen(false)}
          />
        )}

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

// A prospect that declined. The same panel the prospect's own page uses, so
// there is one interface for setting and reversing a disposition rather than
// two that can drift apart.
function DeclinedProspectDetail({ prospect, outcome }: { prospect: Prospect; outcome: ProspectOutcome }) {
  return (
    <div style={{ display: "grid", gap: spacing.lg }}>
      <div style={sectionStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: spacing.md }}>
          <div style={{ display: "flex", gap: spacing.md, minWidth: 0 }}>
            <InitialsAvatar name={prospect.name} size={44} />
            <div style={{ minWidth: 0 }}>
              <h2 style={{ fontSize: 17, overflowWrap: "break-word" }}>{prospect.name}</h2>
              <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>{channelLabel(prospect.channel)}</div>
              <div style={{ display: "flex", gap: spacing.xs, marginTop: spacing.xs, flexWrap: "wrap" }}>
                {/* The stage is shown unchanged beside the outcome: recording a
                    no does not move a prospect (hard rule 2). */}
                <span style={chipStyle("neutral")}>{stageLabel(prospect.stage)}</span>
                <span style={chipStyle("red")}>Declined</span>
              </div>
            </div>
          </div>
          <Link href={`/prospects/${prospect.id}`} style={{ ...buttonSecondary, flexShrink: 0 }}>
            Open prospect →
          </Link>
        </div>
      </div>

      <ProspectOutcomePanel prospectId={prospect.id} outcome={outcome} showRecordForm={false} />
    </div>
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
