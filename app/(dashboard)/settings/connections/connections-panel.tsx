"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, Check } from "lucide-react";
import { createAgentToken, revokeAgentToken, restoreAgentEdit } from "./actions";
import { spacing, colors, fieldStyle, labelStyle, sectionStyle, cardStyle, buttonPrimary, buttonSecondary, buttonDanger, chipStyle } from "@/lib/ui";

export type TokenView = {
  id: string;
  name: string;
  prefix: string;
  scope: "read" | "act";
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  status: "live" | "revoked" | "expired";
};

export type CallView = {
  callId: string;
  at: string;
  tokenName: string;
  tool: string;
  outcome: string;
  detail: string | null;
  origin: "agent" | "user_click";
  restorable: boolean;
};

const EXPIRY_CHOICES = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days (recommended)" },
  { days: 180, label: "180 days" },
  { days: 365, label: "1 year (the longest)" },
];

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "never";
}

function CreateTokenForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "act">("read");
  const [days, setDays] = useState(90);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ token: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);

  return (
    <div style={{ ...sectionStyle }}>
      <h2 style={{ margin: 0, fontSize: 17 }}>Create a token</h2>
      {made ? (
        <div style={{ display: "grid", gap: spacing.sm }}>
          <p style={{ margin: 0, fontWeight: 600, color: colors.amber700 }}>Copy this token now. It is shown once and cannot be shown again.</p>
          <p style={{ margin: 0, fontSize: 13, color: colors.textMuted }}>
            The platform keeps only a fingerprint of it, so it cannot be recovered. Enter it in Muse through Muse&apos;s secure credential prompt -- never paste it into a chat message. If it is lost or leaks, revoke it below and make a new one.
          </p>
          <div style={{ display: "flex", gap: spacing.sm, alignItems: "stretch" }}>
            <input readOnly value={made.token} onFocus={(e) => e.currentTarget.select()} style={{ ...fieldStyle, marginTop: 0, fontFamily: "ui-monospace, monospace", fontSize: 13 }} aria-label="The new token" />
            <button
              type="button"
              style={{ ...buttonSecondary, display: "inline-flex", alignItems: "center", gap: 6 }}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(made.token);
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p style={{ margin: 0, fontSize: 13, color: colors.textMuted }}>Expires {when(made.expiresAt)}.</p>
          <div>
            <button
              type="button"
              style={buttonSecondary}
              onClick={() => {
                setMade(null);
                setCopied(false);
                router.refresh();
              }}
            >
              I have copied it
            </button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            startTransition(async () => {
              const result = await createAgentToken({ name, scope, days });
              if ("error" in result) setError(result.error);
              else {
                setMade({ token: result.token, expiresAt: result.expiresAt });
                setName("");
              }
            });
          }}
          style={{ display: "grid", gap: spacing.md }}
        >
          <label style={labelStyle}>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required placeholder="Muse on my laptop" style={fieldStyle} />
          </label>
          <fieldset style={{ border: "none", padding: 0, margin: 0, display: "grid", gap: spacing.xs }}>
            <legend style={{ ...labelStyle, padding: 0 }}>What it may do</legend>
            <label style={{ fontSize: 14, display: "flex", gap: spacing.sm, alignItems: "flex-start" }}>
              <input type="radio" name="scope" checked={scope === "read"} onChange={() => setScope("read")} />
              <span>
                <strong>Look things up only.</strong> Reports and lookups. It cannot change anything.
              </span>
            </label>
            <label style={{ fontSize: 14, display: "flex", gap: spacing.sm, alignItems: "flex-start" }}>
              <input type="radio" name="scope" checked={scope === "act"} onChange={() => setScope("act")} />
              <span>
                <strong>Look things up and make everyday changes.</strong> Add a prospect, log an interaction, set a follow-up or an ask amount, edit a draft, push back on a strategy, reopen an approved draft, and ask for an approval link. It can never approve anything itself.
              </span>
            </label>
          </fieldset>
          <label style={labelStyle}>
            Lasts
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={fieldStyle}>
              {EXPIRY_CHOICES.map((c) => (
                <option key={c.days} value={c.days}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <div>
            <button type="submit" disabled={isPending} style={buttonPrimary}>
              {isPending ? "Creating…" : "Create token"}
            </button>
          </div>
          {error && <p style={{ margin: 0, color: colors.red600, fontSize: 13 }}>{error}</p>}
        </form>
      )}
    </div>
  );
}

function TokenList({ tokens }: { tokens: TokenView[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div style={{ display: "grid", gap: spacing.sm }}>
      <h2 style={{ margin: 0, fontSize: 17 }}>Your tokens</h2>
      {tokens.length === 0 && <p style={{ margin: 0, color: colors.textMuted, fontSize: 14 }}>No tokens yet.</p>}
      {tokens.map((t) => (
        <div key={t.id} style={{ ...cardStyle, display: "flex", justifyContent: "space-between", gap: spacing.md, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>
              {t.name}{" "}
              <span style={chipStyle(t.status === "live" ? "teal" : t.status === "revoked" ? "red" : "neutral")}>{t.status === "live" ? "Live" : t.status === "revoked" ? "Revoked" : "Expired"}</span>{" "}
              <span style={chipStyle(t.scope === "act" ? "amber" : "neutral")}>{t.scope === "act" ? "Look up and change" : "Look up only"}</span>
            </div>
            <div style={{ fontSize: 12.5, color: colors.textMuted, marginTop: 2 }}>
              <code>{t.prefix}…</code> · created {when(t.createdAt)} · last used {when(t.lastUsedAt)} · expires {when(t.expiresAt)}
            </div>
          </div>
          {t.status === "live" && (
            <button
              type="button"
              disabled={isPending}
              style={buttonDanger}
              onClick={() => {
                if (!window.confirm(`Revoke "${t.name}"? It stops working on its very next call.`)) return;
                setError(null);
                startTransition(async () => {
                  const r = await revokeAgentToken(t.id);
                  if ("error" in r) setError(r.error);
                  else router.refresh();
                });
              }}
            >
              Revoke
            </button>
          )}
        </div>
      ))}
      {error && <p style={{ margin: 0, color: colors.red600, fontSize: 13 }}>{error}</p>}
    </div>
  );
}

function CallList({ calls }: { calls: CallView[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div style={{ display: "grid", gap: spacing.sm }}>
      <h2 style={{ margin: 0, fontSize: 17 }}>Recent calls</h2>
      <p style={{ margin: 0, fontSize: 13, color: colors.textMuted }}>
        Every call an agent makes is recorded here with the token it used. A call is recorded as the agent&apos;s own call; this record never claims you said anything.
      </p>
      {calls.length === 0 && <p style={{ margin: 0, color: colors.textMuted, fontSize: 14 }}>No calls yet.</p>}
      {calls.map((c) => (
        <div key={`${c.callId}-${c.outcome}-${c.at}`} style={{ ...cardStyle, display: "flex", justifyContent: "space-between", gap: spacing.md, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14 }}>
              <strong>{c.tool}</strong> <span style={chipStyle(c.outcome === "done" || c.outcome === "looked up" ? "teal" : c.outcome === "not done" || c.outcome === "failed" ? "red" : "neutral")}>{c.outcome}</span>{" "}
              {c.origin === "user_click" && <span style={chipStyle("neutral")}>your click</span>}
            </div>
            <div style={{ fontSize: 12.5, color: colors.textMuted, marginTop: 2 }}>
              {when(c.at)} · {c.tokenName}
              {c.detail ? ` · ${c.detail}` : ""}
            </div>
          </div>
          {c.restorable && (
            <button
              type="button"
              disabled={isPending}
              style={buttonSecondary}
              onClick={() => {
                setMessage(null);
                startTransition(async () => {
                  const r = await restoreAgentEdit(c.callId);
                  setMessage("error" in r ? r.error : r.summary);
                  router.refresh();
                });
              }}
            >
              Restore earlier text
            </button>
          )}
        </div>
      ))}
      {message && <p style={{ margin: 0, fontSize: 13 }}>{message}</p>}
    </div>
  );
}

export default function ConnectionsPanel({ tokens, calls }: { tokens: TokenView[]; calls: CallView[] }) {
  return (
    <div style={{ display: "grid", gap: spacing.xl, marginTop: spacing.xl }}>
      <CreateTokenForm />
      <TokenList tokens={tokens} />
      <CallList calls={calls} />
    </div>
  );
}
