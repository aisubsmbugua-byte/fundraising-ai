// The wiring of the existing entry points a command may call (STATE item 92,
// ruling 0038 clause 1: "the signed-in user, not a privileged process").
//
// Each is the SAME server action a person using the page calls, and each
// reads the signed-in user from the session itself -- nothing here holds a
// service-role client, a key or a second implementation of any write.
//
// This is the only module in lib/assistant that imports a server action for
// the command path. It is imported by exactly one file, turn.ts, and only
// lazily (a dynamic import resolved the first time a command actually
// reaches its effect), so the choke point (command.ts), the executors
// (command-exec.ts) and the registry (abilities.ts) hold no entry point at
// all. scripts/test-assistant.ts asserts this module's exact import list.
//
// NOT here, by design: sending anything to a funder (sendApprovedDraft and
// everything in send-actions.ts), any stage move, approving or correcting a
// research claim, deleting a record, recording a gift, changing a contact's
// name or email (the send path's recipient), composing a new email from
// nothing, and starting a research or strategy run.

import { createProspect, updateNextAction, updateAskAmount } from "@/app/(dashboard)/prospects/actions";
import { updateDraft, approveDraft, unapproveDraft, reviseDraftWithFeedback, generateDraft } from "@/app/(dashboard)/prospects/[id]/draft-actions";
import { approveStrategy, reviseStrategyWithFeedback } from "@/app/(dashboard)/prospects/[id]/strategy-actions";
import { logInteraction } from "@/app/(dashboard)/revisit/actions";
import { logSupporterInteraction } from "@/app/(dashboard)/supporters/actions";
import type { CommandEntryPoints } from "./types";

export const DEFAULT_COMMAND_ENTRY_POINTS: CommandEntryPoints = {
  createProspect,
  updateDraft,
  reviseDraftWithFeedback,
  reviseStrategyWithFeedback,
  generateDraft,
  unapproveDraft,
  approveDraft,
  approveStrategy,
  logInteraction,
  updateNextAction,
  logSupporterInteraction,
  updateAskAmount,
};
