// The REAL entry points, for the one place a gate may be decided: the signed-in
// owner's click on an approval link (STATE item 98, ruling 0039 clause 3).
//
// Imported by exactly one file, the approval page's server action
// (app/(dashboard)/approve/[id]/actions.ts). Nothing an agent call can reach --
// tools, the act choke point, the JSON-RPC layer -- imports this module; a
// source scan in scripts/test-agent.ts asserts it. Loaded lazily, like the
// assistant's wiring.

import type { CommandEntryPoints } from "@/lib/assistant/types";

export async function loadApprovalEntryPoints(): Promise<CommandEntryPoints> {
  const { DEFAULT_COMMAND_ENTRY_POINTS } = await import("@/lib/assistant/command-entrypoints");
  return DEFAULT_COMMAND_ENTRY_POINTS;
}
