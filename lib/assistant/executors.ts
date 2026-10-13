// The ONLY module that performs an assistant write (STATE item 87, ruling
// 0037 clause 2).
//
// It is imported by exactly one file: the approve action in
// app/(dashboard)/assistant/actions.ts, which runs only as the direct result
// of a user clicking Approve on a rendered proposal. abilities.ts,
// proposals.ts, dispatch.ts, loop.ts, provider.ts and reads.ts never import
// it; scripts/test-assistant.ts fails the suite the day any other file does.
// A model's tool call therefore has no path to anything in this file.
//
// Each execution goes through the EXISTING entry point a person using the
// page would use -- logInteraction, updateNextAction, logSupporterInteraction
// -- called with exactly the stored payload's fields, as the signed-in user
// (those functions read the user from the session themselves). There is no
// second implementation of any write here, no service-role client, no send
// path and no stage move.
//
// The entry points may THROW (they surface a database error that way) or call
// redirect() (a signed-out caller), and redirect works by throwing. Both
// become a returned failure here, which the approve action stores as the
// proposal's own failure -- never an unhandled throw to the client.

import { logInteraction } from "@/app/(dashboard)/revisit/actions";
import { updateNextAction } from "@/app/(dashboard)/prospects/actions";
import { logSupporterInteraction } from "@/app/(dashboard)/supporters/actions";
import type { ExecutionResult } from "./types";
import {
  validatePayload,
  type LogInteractionPayload,
  type LogSupporterInteractionPayload,
  type SetNextActionPayload,
} from "./proposals";

export type EntryPoints = {
  logInteraction: (prospectId: string, kind: LogInteractionPayload["kind"], summary: string, occurredAt: string) => Promise<unknown>;
  updateNextAction: (prospectId: string, nextAction: string, nextActionDue: string) => Promise<unknown>;
  logSupporterInteraction: (supporterId: string, kind: LogSupporterInteractionPayload["kind"], summary: string, occurredAt: string) => Promise<unknown>;
};

export const DEFAULT_ENTRY_POINTS: EntryPoints = { logInteraction, updateNextAction, logSupporterInteraction };

// next/navigation's redirect() throws an error carrying a digest that starts
// with NEXT_REDIRECT. Detected structurally so this file does not depend on
// framework internals.
export function isRedirectError(err: unknown): boolean {
  const digest = err && typeof err === "object" ? (err as { digest?: unknown }).digest : undefined;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}

export async function executeProposal(
  actionKey: string,
  storedPayload: unknown,
  now: Date,
  entryPoints: EntryPoints = DEFAULT_ENTRY_POINTS
): Promise<ExecutionResult> {
  // The stored row is not trusted because it is stored: the same validator
  // that accepted the payload at birth re-checks it before any write.
  const valid = validatePayload(actionKey, storedPayload, now);
  if (!valid.ok) return { ok: false, error: `The stored proposal is not valid (${valid.error}). Nothing was changed.` };

  try {
    switch (actionKey) {
      case "log_prospect_interaction": {
        const p = valid.value as LogInteractionPayload;
        await entryPoints.logInteraction(p.prospect_id, p.kind, p.summary, p.occurred_at);
        return { ok: true, result: { entryPoint: "logInteraction" } };
      }
      case "set_prospect_next_action": {
        const p = valid.value as SetNextActionPayload;
        await entryPoints.updateNextAction(p.prospect_id, p.next_action, p.next_action_due ?? "");
        return { ok: true, result: { entryPoint: "updateNextAction" } };
      }
      case "log_supporter_interaction": {
        const p = valid.value as LogSupporterInteractionPayload;
        await entryPoints.logSupporterInteraction(p.supporter_id, p.kind, p.summary, p.occurred_at);
        return { ok: true, result: { entryPoint: "logSupporterInteraction" } };
      }
      default:
        return { ok: false, error: "Unknown action. Nothing was changed." };
    }
  } catch (err) {
    if (isRedirectError(err)) return { ok: false, error: "Your session is no longer signed in, so nothing was changed. Sign in and try again." };
    return { ok: false, error: err instanceof Error && err.message ? err.message : "The change could not be made." };
  }
}
