"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { approveProposal, dismissProposal, restoreCommandPrevious } from "./actions";
import { spacing, colors, type as typeScale, fieldStyle, labelStyle, buttonPrimary, buttonSecondary, buttonDanger, cardStyle, sectionStyle, chipStyle } from "@/lib/ui";

// The thread surface (STATE item 87, ruling 0037 clause 3).
//
// Two kinds of content are kept visibly apart on screen:
//
//   * AI-written prose -- the model's sentences. Always inside a block
//     labelled "AI-written", because a figure in a sentence is a claim.
//   * Cards -- figures, names, dates and lists RENDERED BY CODE from what a
//     lookup actually returned. Labelled as such.
//
// A third kind (STATE item 92, ruling 0038): what a COMMAND did, or did not
// do. Written by code from the validated payload and the entry point's own
// return, with the user's own quoted words beside it. Strategy and draft cards
// render their content IN FULL -- what a decision is pinned to must be what
// was shown -- and a result that replaced something says what, with a Restore
// click for draft text.
//
// This component imports nothing from lib/assistant (it would drag server-only
// modules into the browser bundle); its types are declared here, and the page
// that renders it passes plain data as props. All calls go to the turn route
// (one fetch per turn) or the approve/dismiss/restore server actions (one
// click each).

type CardRow = { title: string; detail?: string; meta?: string; href?: string };
type KV = { label: string; value: string };
type DraftItem = { draftId: string; kind: string; kindLabel: string; status: string; sent: boolean; subject: string | null; content: string; fingerprint: string };
type CardView =
  | { kind: "facts"; ability: string; title: string; items: KV[]; note?: string; href?: string }
  | { kind: "rows"; ability: string; title: string; rows: CardRow[]; total: number; emptyText: string; note?: string }
  | {
      kind: "strategy_review";
      ability: string;
      title: string;
      prospectId: string;
      prospectName: string;
      hasRun: boolean;
      runId: string | null;
      status: string | null;
      statusLabel: string;
      approved: boolean;
      fingerprint: string | null;
      strategy: { outreach_approach: string; ask_positioning: string; rationale: string; key_talking_points: string[]; evidence_to_highlight: string[] } | null;
      organizationIntel: { location: string; funder_type: string; geographic_focus: string; typical_grant_size: string; focus_areas: string[] } | null;
      note?: string;
      href: string;
    }
  | { kind: "draft_review"; ability: string; title: string; prospectId: string; prospectName: string; drafts: DraftItem[]; total: number; note?: string; href: string }
  | {
      kind: "command_result";
      ability: string;
      commandId: string;
      title: string;
      summary: string;
      quote: string;
      fields: KV[];
      replaced?: KV[];
      restorable: boolean;
      href?: string;
      note?: string;
    }
  | { kind: "refusal"; ability: string; title: string; reason: string; quote?: string; href?: string }
  | { kind: "notice"; text: string };

export type MessageView = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "running" | "completed" | "failed";
  cards: CardView[];
  createdAt: string;
};

export type ProposalViewProps = {
  id: string;
  messageId: string;
  actionKey: string;
  summary: string;
  fields: { label: string; value: string }[];
  status: "pending" | "executed" | "failed" | "dismissed" | "expired";
  expiresAt: string;
  decidedAt: string | null;
  errorNote: string | null;
  subjectHref: string | null;
};

const MAX_MESSAGE_CHARS = 2000;

const STARTERS = ["What's going on?", "Who needs follow-up this week?", "Which supporters have gone quiet?"];

export default function AssistantThread({
  initialThreadId,
  initialMessages,
  initialProposals,
  providerLabel,
  modelName,
}: {
  initialThreadId: string | null;
  initialMessages: MessageView[];
  initialProposals: ProposalViewProps[];
  providerLabel: string;
  modelName: string;
}) {
  const [threadId, setThreadId] = useState<string | null>(initialThreadId);
  const [messages, setMessages] = useState<MessageView[]>(initialMessages);
  const [proposals, setProposals] = useState<ProposalViewProps[]>(initialProposals);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, sending]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || sending) return;
    setError(null);
    setSending(true);
    const optimisticId = `local-${Date.now()}`;
    setMessages((m) => [...m, { id: optimisticId, role: "user", content: message, status: "completed", cards: [], createdAt: new Date().toISOString() }]);
    setInput("");
    try {
      const res = await fetch("/api/assistant/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId, message }),
      });
      let body: Record<string, unknown> | null = null;
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        body = null;
      }
      if (!body) {
        setError("The assistant's answer could not be read. Reload the page to see whether it was recorded.");
        return;
      }
      if (typeof body.threadId === "string") setThreadId(body.threadId);
      const userMessageId = typeof body.userMessageId === "string" ? body.userMessageId : null;
      const reply = body.message as { id: string; content: string; status: "completed" | "failed" } | undefined;
      const cards = Array.isArray(body.cards) ? (body.cards as CardView[]) : [];
      const newProposals = Array.isArray(body.proposals) ? (body.proposals as ProposalViewProps[]) : [];

      setMessages((m) => {
        const next = m.map((x) => (x.id === optimisticId && userMessageId ? { ...x, id: userMessageId } : x));
        if (reply) {
          next.push({ id: reply.id, role: "assistant", content: reply.content, status: reply.status, cards, createdAt: new Date().toISOString() });
        }
        return next;
      });
      if (newProposals.length > 0) setProposals((p) => [...p, ...newProposals]);
      if (body.ok !== true) setError(typeof body.error === "string" ? body.error : "The assistant could not answer.");
    } catch {
      setError("The assistant could not be reached. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  function newConversation() {
    setThreadId(null);
    setMessages([]);
    setProposals([]);
    setError(null);
  }

  function updateProposal(view: ProposalViewProps) {
    setProposals((p) => p.map((x) => (x.id === view.id ? view : x)));
  }

  const empty = messages.length === 0;

  return (
    <div style={{ maxWidth: 860 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: spacing.lg, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: typeScale.pageTitle, margin: 0 }}>Assistant</h1>
          <p style={{ color: colors.textMuted, marginTop: spacing.xs, marginBottom: 0, fontSize: typeScale.body }}>
            Ask what is going on, or tell it what to do &mdash; add a prospect, edit a draft, push back on a strategy, approve one you have just read.
            It acts as you, on your words, and shows exactly what it did. Approving a draft is not sending it.
          </p>
        </div>
        {!empty && (
          <button type="button" onClick={newConversation} style={buttonSecondary}>
            New conversation
          </button>
        )}
      </div>

      <div style={{ ...cardStyle, marginTop: spacing.lg, background: colors.bgSubtle, fontSize: 12.5, color: colors.textMuted, lineHeight: 1.5 }}>
        <strong style={{ color: colors.text }}>What is shared.</strong> Answers come from {providerLabel} (model: {modelName}). To answer, your messages in
        this conversation and the results of lookups are sent to that provider: names, stages, dates, and research facts your team has confirmed. When you
        ask about a strategy or a draft, its full text &mdash; the approach, the funder facts, the subject line and the body &mdash; is shared with that provider too. Email
        addresses, phone numbers, notes and interaction text are never sent. The provider&apos;s own retention and training terms are its own; this platform
        does not check them. Anything you type here goes to the provider, so do not paste what you would not want shared.
      </div>

      <div style={{ display: "grid", gap: spacing.md, marginTop: spacing.lg }}>
        {empty && (
          <div style={{ ...sectionStyle }}>
            <div style={{ fontSize: typeScale.body, color: colors.textMuted }}>Start with a question:</div>
            <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap" }}>
              {STARTERS.map((s) => (
                <button key={s} type="button" disabled={sending} onClick={() => send(s)} style={buttonSecondary}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <MessageBlock key={m.id} message={m} proposals={proposals.filter((p) => p.messageId === m.id)} onProposal={updateProposal} />
        ))}

        {sending && (
          <div style={{ ...cardStyle, color: colors.textMuted, fontSize: typeScale.body }} role="status" aria-live="polite">
            Looking into it… this can take up to a couple of minutes.
          </div>
        )}
        {error && (
          <div role="alert" style={{ ...cardStyle, borderColor: colors.red600, background: colors.red100, color: colors.text, fontSize: typeScale.body }}>
            {error}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        style={{ ...sectionStyle, marginTop: spacing.lg }}
      >
        <label htmlFor="assistant-input" style={labelStyle}>
          Your message
        </label>
        <textarea
          id="assistant-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          rows={3}
          maxLength={MAX_MESSAGE_CHARS}
          placeholder="Ask about your pipeline, follow-ups, or supporters…"
          style={{ ...fieldStyle, marginTop: 0, resize: "vertical" }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: spacing.sm }}>
          <span style={{ fontSize: 12, color: colors.textFaint }}>
            {input.length}/{MAX_MESSAGE_CHARS} · Enter to send, Shift+Enter for a new line
          </span>
          <button type="submit" disabled={sending || input.trim() === ""} style={{ ...buttonPrimary, opacity: sending || input.trim() === "" ? 0.6 : 1 }}>
            {sending ? "Working…" : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}

function MessageBlock({
  message,
  proposals,
  onProposal,
}: {
  message: MessageView;
  proposals: ProposalViewProps[];
  onProposal: (p: ProposalViewProps) => void;
}) {
  if (message.role === "user") {
    return (
      <div style={{ ...cardStyle, background: colors.bgSubtle }}>
        <div style={{ fontSize: 12, color: colors.textMuted, fontWeight: 600, marginBottom: spacing.xs }}>You</div>
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: typeScale.body }}>{message.content}</div>
      </div>
    );
  }

  const notices = message.cards.filter((c): c is Extract<CardView, { kind: "notice" }> => c.kind === "notice");
  const dataCards = message.cards.filter((c) => c.kind !== "notice");

  return (
    <div style={{ display: "grid", gap: spacing.sm }}>
      {message.content.trim() !== "" && (
        <div style={{ ...cardStyle }}>
          <div style={{ display: "flex", gap: spacing.sm, alignItems: "center", marginBottom: spacing.xs }}>
            <span style={{ fontSize: 12, color: colors.textMuted, fontWeight: 600 }}>Assistant</span>
            <span style={chipStyle("neutral")} title="Written by the AI model. It can be wrong; the cards below are read from your data.">
              AI-written
            </span>
          </div>
          <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: typeScale.body, lineHeight: 1.5 }}>{message.content}</div>
        </div>
      )}
      {message.status === "failed" && message.content.trim() === "" && (
        <div style={{ ...cardStyle, color: colors.textMuted, fontSize: typeScale.body }}>The assistant could not answer this one.</div>
      )}
      {message.status === "running" && (
        <div style={{ ...cardStyle, color: colors.textMuted, fontSize: typeScale.body }}>This reply did not finish.</div>
      )}
      {dataCards.map((c, i) => (
        <CardRenderer key={i} card={c} />
      ))}
      {proposals.map((p) => (
        <ProposalCard key={p.id} proposal={p} onChange={onProposal} />
      ))}
      {notices.map((n, i) => (
        <div key={`n${i}`} style={{ ...cardStyle, background: colors.amber100, borderColor: colors.amber700, fontSize: 13 }}>
          {n.text}
        </div>
      ))}
    </div>
  );
}

function DataCard({ card }: { card: CardView }) {
  if (card.kind !== "facts" && card.kind !== "rows") return null;
  return (
    <div style={{ ...sectionStyle, gap: spacing.sm }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: typeScale.cardTitle }}>{card.title}</h3>
        <span style={chipStyle("teal")} title="Read from your data by the platform, not written by the AI.">
          From your data
        </span>
      </div>
      {card.kind === "facts" ? (
        <>
          <dl style={{ margin: 0, display: "grid", gap: spacing.xs }}>
            {card.items.map((it, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: spacing.sm, fontSize: 13 }}>
                <dt style={{ color: colors.textMuted }}>{it.label}</dt>
                <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{it.value}</dd>
              </div>
            ))}
          </dl>
          {card.href && (
            <Link href={card.href} prefetch={false} style={{ fontSize: 13, color: colors.primary }}>
              Open this prospect
            </Link>
          )}
        </>
      ) : card.rows.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: colors.textMuted }}>{card.emptyText}</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: spacing.sm }}>
          {card.rows.map((r, i) => (
            <li key={i} style={{ borderTop: i === 0 ? "none" : `1px solid ${colors.border}`, paddingTop: i === 0 ? 0 : spacing.sm }}>
              <div style={{ fontSize: 14, fontWeight: 600, overflowWrap: "anywhere" }}>
                {r.href ? (
                  <Link href={r.href} prefetch={false} style={{ color: colors.text }}>
                    {r.title}
                  </Link>
                ) : (
                  r.title
                )}
              </div>
              {r.detail && <div style={{ fontSize: 13, color: colors.textMuted, overflowWrap: "anywhere" }}>{r.detail}</div>}
              {r.meta && <div style={{ fontSize: 12, color: colors.textFaint }}>{r.meta}</div>}
            </li>
          ))}
        </ul>
      )}
      {card.note && <div style={{ fontSize: 12, color: colors.textFaint }}>{card.note}</div>}
    </div>
  );
}

function CardRenderer({ card }: { card: CardView }) {
  switch (card.kind) {
    case "strategy_review":
      return <StrategyReviewView card={card} />;
    case "draft_review":
      return <DraftReviewView card={card} />;
    case "command_result":
      return <CommandResultView card={card} />;
    case "refusal":
      return <RefusalView card={card} />;
    default:
      return <DataCard card={card} />;
  }
}

function Prose({ label, text }: { label: string; text: string }) {
  if (text.trim() === "") return null;
  return (
    <div style={{ display: "grid", gap: 2 }}>
      <div style={{ fontSize: 12, color: colors.textMuted, fontWeight: 600 }}>{label}</div>
      <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 13, lineHeight: 1.5 }}>{text}</div>
    </div>
  );
}

function BulletList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 2 }}>
      <div style={{ fontSize: 12, color: colors.textMuted, fontWeight: 600 }}>{label}</div>
      <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2, fontSize: 13 }}>
        {items.map((t, i) => (
          <li key={i} style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}

// The full proposed strategy, nothing truncated: a later "approve" is pinned
// to exactly this text (ruling 0038 clause 3).
function StrategyReviewView({ card }: { card: Extract<CardView, { kind: "strategy_review" }> }) {
  const tone = card.approved ? "teal" : card.status === "ready_for_review" ? "amber" : "neutral";
  return (
    <div style={{ ...sectionStyle, gap: spacing.sm }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: typeScale.cardTitle }}>{card.title}</h3>
        <span style={{ display: "flex", gap: spacing.xs, flexWrap: "wrap" }}>
          <span style={chipStyle(tone)}>{card.statusLabel}</span>
          <span style={chipStyle("teal")} title="Read from your data by the platform, not written by the AI assistant.">
            From your data
          </span>
        </span>
      </div>
      {!card.hasRun || !card.strategy ? (
        <p style={{ margin: 0, fontSize: 13, color: colors.textMuted }}>
          {card.hasRun ? "There is no proposed strategy to show for this one yet." : "No strategy has been built for this prospect yet."}
        </p>
      ) : (
        <>
          <Prose label="Outreach approach" text={card.strategy.outreach_approach} />
          <Prose label="Ask positioning" text={card.strategy.ask_positioning} />
          <Prose label="Rationale" text={card.strategy.rationale} />
          <BulletList label="Key talking points" items={card.strategy.key_talking_points} />
          <BulletList label="Evidence to highlight" items={card.strategy.evidence_to_highlight} />
          {card.organizationIntel && (
            <dl style={{ margin: 0, display: "grid", gap: spacing.xs }}>
              {(
                [
                  ["Location", card.organizationIntel.location],
                  ["Funder type", card.organizationIntel.funder_type],
                  ["Geographic focus", card.organizationIntel.geographic_focus],
                  ["Typical grant size", card.organizationIntel.typical_grant_size],
                  ["Focus areas", card.organizationIntel.focus_areas.join(", ")],
                ] as [string, string][]
              )
                .filter(([, v]) => v.trim() !== "")
                .map(([k, v]) => (
                  <div key={k} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)", gap: spacing.sm, fontSize: 13 }}>
                    <dt style={{ color: colors.textMuted }}>{k}</dt>
                    <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{v}</dd>
                  </div>
                ))}
            </dl>
          )}
        </>
      )}
      {card.note && <div style={{ fontSize: 12, color: colors.textFaint }}>{card.note}</div>}
      <div style={{ display: "flex", gap: spacing.sm, alignItems: "center", flexWrap: "wrap" }}>
        <Link href={card.href} prefetch={false} style={{ fontSize: 13, color: colors.primary }}>
          Open this prospect
        </Link>
        {card.fingerprint && <span style={{ fontSize: 12, color: colors.textFaint }}>Version {card.fingerprint.slice(0, 8)}</span>}
      </div>
    </div>
  );
}

function DraftReviewView({ card }: { card: Extract<CardView, { kind: "draft_review" }> }) {
  return (
    <div style={{ ...sectionStyle, gap: spacing.sm }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: typeScale.cardTitle }}>{card.title}</h3>
        <span style={chipStyle("teal")} title="Read from your data by the platform, not written by the AI assistant.">
          From your data
        </span>
      </div>
      {card.drafts.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: colors.textMuted }}>There are no drafts for this prospect yet.</p>
      ) : (
        card.drafts.map((d) => (
          <div key={d.draftId} style={{ borderTop: `1px solid ${colors.border}`, paddingTop: spacing.sm, display: "grid", gap: spacing.xs }}>
            <div style={{ display: "flex", gap: spacing.xs, alignItems: "center", flexWrap: "wrap" }}>
              <strong style={{ fontSize: 14 }}>{d.kindLabel}</strong>
              <span style={chipStyle(d.sent ? "neutral" : d.status === "approved" ? "teal" : "amber")}>
                {d.sent ? "Delivered" : d.status === "approved" ? "Approved" : "Draft"}
              </span>
              <span style={{ fontSize: 12, color: colors.textFaint }}>Version {d.fingerprint.slice(0, 8)}</span>
            </div>
            {d.subject !== null && <Prose label="Subject" text={d.subject} />}
            <Prose label="Text" text={d.content} />
          </div>
        ))
      )}
      {card.note && <div style={{ fontSize: 12, color: colors.textFaint }}>{card.note}</div>}
      <Link href={card.href} prefetch={false} style={{ fontSize: 13, color: colors.primary }}>
        Open this prospect
      </Link>
    </div>
  );
}

function CommandResultView({ card }: { card: Extract<CardView, { kind: "command_result" }> }) {
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function restore() {
    setBusy(true);
    setError(null);
    try {
      const res = await restoreCommandPrevious(card.commandId);
      if ("error" in res) setError(res.error);
      else setRestored(res.summary);
    } catch {
      setError("That did not go through. Reload the page and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ ...sectionStyle, borderColor: colors.teal700, gap: spacing.sm }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: typeScale.cardTitle }}>{card.title}</h3>
        <span style={chipStyle("teal")} title="Done by the platform as you, through the same entry point the page uses.">
          Done
        </span>
      </div>
      <div style={{ fontSize: 14, overflowWrap: "anywhere" }}>{card.summary}</div>
      <div style={{ fontSize: 13, color: colors.textMuted, overflowWrap: "anywhere" }}>
        On your words: &ldquo;{card.quote}&rdquo;
      </div>
      <dl style={{ margin: 0, display: "grid", gap: spacing.xs }}>
        {card.fields.map((f, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)", gap: spacing.sm, fontSize: 13 }}>
            <dt style={{ color: colors.textMuted }}>{f.label}</dt>
            <dd style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{f.value}</dd>
          </div>
        ))}
      </dl>
      {card.replaced && card.replaced.length > 0 && (
        <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: spacing.sm, display: "grid", gap: spacing.xs }}>
          <div style={{ fontSize: 12, color: colors.textMuted, fontWeight: 600 }}>What this replaced</div>
          <dl style={{ margin: 0, display: "grid", gap: spacing.xs }}>
            {card.replaced.map((f, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)", gap: spacing.sm, fontSize: 13 }}>
                <dt style={{ color: colors.textMuted }}>{f.label}</dt>
                <dd style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{f.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {card.note && <div style={{ fontSize: 12, color: colors.amber700 }}>{card.note}</div>}
      <div style={{ display: "flex", gap: spacing.sm, alignItems: "center", flexWrap: "wrap" }}>
        {card.href && (
          <Link href={card.href} prefetch={false} style={{ fontSize: 13, color: colors.primary }}>
            See the record
          </Link>
        )}
        {card.restorable && !restored && (
          <button type="button" disabled={busy} onClick={restore} style={{ ...buttonSecondary, opacity: busy ? 0.6 : 1 }}>
            {busy ? "Restoring…" : "Restore the earlier text"}
          </button>
        )}
      </div>
      {restored && <div style={{ fontSize: 13, color: colors.success }}>{restored}</div>}
      {error && (
        <div role="alert" style={{ fontSize: 13, color: colors.danger }}>
          {error}
        </div>
      )}
    </div>
  );
}

function RefusalView({ card }: { card: Extract<CardView, { kind: "refusal" }> }) {
  return (
    <div style={{ ...sectionStyle, borderColor: colors.amber700, background: colors.amber100, gap: spacing.xs }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: typeScale.cardTitle }}>{card.title}</h3>
        <span style={chipStyle("amber")}>Not done</span>
      </div>
      <div style={{ fontSize: 14, overflowWrap: "anywhere" }}>{card.reason}</div>
      {card.quote && <div style={{ fontSize: 13, color: colors.textMuted, overflowWrap: "anywhere" }}>Asked on your words: &ldquo;{card.quote}&rdquo;</div>}
      {card.href && (
        <Link href={card.href} prefetch={false} style={{ fontSize: 13, color: colors.primary }}>
          Open this prospect
        </Link>
      )}
    </div>
  );
}

function ProposalCard({ proposal, onChange }: { proposal: ProposalViewProps; onChange: (p: ProposalViewProps) => void }) {
  const [busy, setBusy] = useState<"approve" | "dismiss" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const expired = proposal.status === "pending" && new Date(proposal.expiresAt).getTime() <= Date.now();
  const status = expired ? "expired" : proposal.status;

  async function decide(kind: "approve" | "dismiss") {
    setBusy(kind);
    setMessage(null);
    try {
      const result = kind === "approve" ? await approveProposal(proposal.id) : await dismissProposal(proposal.id);
      if ("proposal" in result && result.proposal) onChange(result.proposal as ProposalViewProps);
      if ("error" in result && result.error) setMessage(result.error);
    } catch {
      setMessage("That did not go through. Reload the page to see the current state before trying again.");
    } finally {
      setBusy(null);
    }
  }

  const tone = status === "executed" ? "teal" : status === "failed" ? "red" : status === "pending" ? "amber" : "neutral";
  const label =
    status === "executed" ? "Done" : status === "failed" ? "Failed" : status === "dismissed" ? "Dismissed" : status === "expired" ? "Expired" : "Waiting for you";

  return (
    <div style={{ ...sectionStyle, borderColor: status === "pending" ? colors.amber700 : colors.border, gap: spacing.sm }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: typeScale.cardTitle }}>Proposed change</h3>
        <span style={chipStyle(tone)}>{label}</span>
      </div>
      <div style={{ fontSize: 14, overflowWrap: "anywhere" }}>{proposal.summary}</div>
      <dl style={{ margin: 0, display: "grid", gap: spacing.xs }}>
        {proposal.fields.map((f, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)", gap: spacing.sm, fontSize: 13 }}>
            <dt style={{ color: colors.textMuted }}>{f.label}</dt>
            <dd style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{f.value}</dd>
          </div>
        ))}
      </dl>
      {status === "pending" && (
        <>
          <div style={{ fontSize: 12, color: colors.textFaint }}>
            Nothing changes until you approve. This is made as you, through the same screen you would use by hand. Any wording above in quotes or under
            &ldquo;What happened&rdquo; and &ldquo;New next action&rdquo; was written by the AI &mdash; read it before you approve. Expires{" "}
            {new Date(proposal.expiresAt).toLocaleString()}.
          </div>
          <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap" }}>
            <button type="button" disabled={busy !== null} onClick={() => decide("approve")} style={{ ...buttonPrimary, opacity: busy ? 0.6 : 1 }}>
              {busy === "approve" ? "Making the change…" : "Approve"}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => decide("dismiss")} style={{ ...buttonDanger, opacity: busy ? 0.6 : 1 }}>
              {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
            </button>
          </div>
        </>
      )}
      {status === "executed" && proposal.subjectHref && (
        <Link href={proposal.subjectHref} prefetch={false} style={{ fontSize: 13, color: colors.primary }}>
          See the record
        </Link>
      )}
      {status === "failed" && proposal.errorNote && <div style={{ fontSize: 13, color: colors.danger }}>{proposal.errorNote}</div>}
      {message && (
        <div role="alert" style={{ fontSize: 13, color: colors.danger }}>
          {message}
        </div>
      )}
    </div>
  );
}
