// The Connect Muse page's call list (STATE item 98): one line per call, built
// by code from agent_call_log rows. A write's two rows (started, terminal)
// become one line showing its outcome; a started row with no terminal row is
// shown as such -- "no outcome recorded" is the honest state of a killed call,
// not a success and not a failure (ruling 0026's encoding).

export type CallLogRow = {
  call_id: string;
  token_id: string;
  event: "started" | "executed" | "failed" | "refused";
  origin: "agent" | "user_click";
  access: "read" | "write";
  tool: string;
  result: { summary?: string } | null;
  error_note: string | null;
  created_at: string;
  restores_call_id: string | null;
};

export type CallLine = {
  callId: string;
  at: string;
  tokenName: string;
  tool: string;
  outcome: "looked up" | "done" | "not done" | "failed" | "no outcome recorded";
  detail: string | null;
  origin: "agent" | "user_click";
  restorable: boolean;
};

export const CALL_LIST_COLUMNS = "call_id, token_id, event, origin, access, tool, result, error_note, created_at, restores_call_id";

export function buildCallLines(rows: CallLogRow[], tokenNames: Map<string, string>): CallLine[] {
  const byCall = new Map<string, CallLogRow[]>();
  for (const r of rows) {
    const list = byCall.get(r.call_id) ?? [];
    list.push(r);
    byCall.set(r.call_id, list);
  }
  const restoredCalls = new Set(rows.filter((r) => r.event === "executed" && r.restores_call_id).map((r) => r.restores_call_id as string));

  const lines: CallLine[] = [];
  for (const [callId, group] of byCall) {
    const terminal = group.find((r) => r.event !== "started");
    const shown = terminal ?? group[0];
    let outcome: CallLine["outcome"];
    if (!terminal) outcome = "no outcome recorded";
    else if (terminal.event === "executed") outcome = terminal.access === "read" ? "looked up" : "done";
    else outcome = terminal.event === "refused" ? "not done" : "failed";
    const detail = terminal?.event === "executed" ? (terminal.result?.summary ?? null) : (terminal?.error_note ?? null);
    lines.push({
      callId,
      at: shown.created_at,
      tokenName: tokenNames.get(shown.token_id) ?? "(a removed token)",
      tool: shown.tool,
      outcome,
      detail: detail ? (detail.length > 160 ? `${detail.slice(0, 159)}…` : detail) : null,
      origin: shown.origin,
      restorable: shown.origin === "agent" && shown.tool === "edit_draft" && terminal?.event === "executed" && !restoredCalls.has(callId),
    });
  }
  return lines.sort((a, b) => b.at.localeCompare(a.at));
}
