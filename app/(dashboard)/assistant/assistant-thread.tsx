"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { approveProposal, dismissProposal } from "./actions";
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
// This component imports nothing from lib/assistant (it would drag server-only
// modules into the browser bundle); its types are declared here, and the page
// that renders it passes plain data as props. All calls go to the turn route
// (one fetch per turn) or the approve/dismiss server actions (one click each).

type CardRow = { title: string; detail?: string; meta?: string; href?: string };
type CardView =
  | { kind: "facts"; ability: string; title: string; items: { label: string; value: string }[]; note?: string; href?: string }
  | { kind: "rows"; ability: string; title: string; rows: CardRow[]; total: number; emptyText: string; note?: string }
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
            Ask what is going on, who needs attention, or have it suggest a next step. It can look things up and propose changes; you decide.
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
        this conversation and the results of lookups are sent to that provider: names, stages, dates, and research facts your team has confirmed. Email
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
        <DataCard key={i} card={c} />
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
  if (card.kind === "notice") return null;
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
