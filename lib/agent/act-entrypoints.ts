// The entry points an agent's ACT may call (STATE item 98, ruling 0039
// clause 3).
//
// The assistant's command-entrypoints.ts wires every existing action a
// command may call, INCLUDING the two decision gates (approveStrategy,
// approveDraft). An agent call may never decide a gate, so this module hands
// the act path that same wiring with the two gate entries REPLACED by stubs
// that throw: whatever a tool handler, an executor or a bug does, no agent call
// can reach the real approval actions. The real ones are loaded only by
// approve-entrypoints.ts, which only the signed-in owner's click on an approval
// link reaches.
//
// Loaded lazily (a dynamic import resolved the first time an act actually
// reaches its effect), exactly as the assistant's turn does, so the server
// actions are not loaded for a read.

import type { CommandEntryPoints } from "@/lib/assistant/types";

const GATE_REFUSAL = "A decision cannot be made on an agent's call. The owner decides it on the platform, from an approval link.";

export async function loadAgentActEntryPoints(): Promise<CommandEntryPoints> {
  const { DEFAULT_COMMAND_ENTRY_POINTS } = await import("@/lib/assistant/command-entrypoints");
  return {
    ...DEFAULT_COMMAND_ENTRY_POINTS,
    approveStrategy: async () => {
      throw new Error(GATE_REFUSAL);
    },
    approveDraft: async () => {
      throw new Error(GATE_REFUSAL);
    },
  };
}
