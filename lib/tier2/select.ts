// Choosing which of a funder's pages to read.
//
// One bounded model call. No tools, no loop, no ability to search. The model
// is shown a manifest that code assembled and reduced, and returns INDICES
// into it -- it never writes a URL, so it cannot invent, guess, or reach a
// page discovery did not find. Same reason extraction selects evidence_ids
// instead of typing quotes: measured prompt-only compliance on this codebase
// is 52-80%, so any guarantee that matters belongs in code.
//
// This is the only judgement in Tier 2. Discovery is deterministic, reduction
// is deterministic, fetching is deterministic. Selection is the one step where
// "which of these is likely to state their grant priorities" is a genuinely
// semantic question, and it costs one call over a list of at most 60 lines.

import Anthropic from "@anthropic-ai/sdk";

import { anthropic } from "../ai/anthropic";
import { renderManifest, type DiscoveryManifest, type ManifestEntry } from "./manifest";

// Enough to cover priorities, eligibility, process and a grant list; few
// enough that fetching stays inside the ten-second rung.
export const MAX_SELECTED = 8;
export const SELECTION_PROMPT_VERSION = 1;
const SELECTION_MODEL = "claude-sonnet-4-6";
const TIMEOUT_MS = 30_000;

export type SelectionPurpose =
  | "priorities"      // what they fund, and where
  | "eligibility"     // stated rules that could disqualify us
  | "process"         // how and when to apply
  | "grants"          // who they actually funded -- revealed priorities
  | "identity";       // legal name, address, EIN -- feeds Tier 1

export type PageSelection = {
  index: number;
  url: string;
  purposes: SelectionPurpose[];
};

export type SelectionOutcome = {
  selected: PageSelection[];
  promptVersion: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  // Purposes the model could find no candidate page for. An empty manifest
  // slot is a fact about the site, not a failure of the call -- and saying so
  // here is what stops a later stage reporting "not checked" for something
  // that was checked and does not exist.
  unavailablePurposes: SelectionPurpose[];
};

export const SELECTION_TOOL: Anthropic.Tool = {
  name: "select_pages",
  description: "Select which pages from the supplied manifest should be read.",
  input_schema: {
    type: "object",
    properties: {
      selections: {
        type: "array",
        description: `Up to ${MAX_SELECTED} pages, best first. Reference pages ONLY by their index in the manifest.`,
        items: {
          type: "object",
          properties: {
            index: { type: "integer", description: "The [n] index of the page in the manifest." },
            purposes: {
              type: "array",
              description: "What this page is expected to establish. One page may serve several.",
              items: { type: "string", enum: ["priorities", "eligibility", "process", "grants", "identity"] },
            },
          },
          required: ["index", "purposes"],
        },
      },
      unavailable_purposes: {
        type: "array",
        description:
          "Purposes for which NO page in this manifest is a plausible candidate. Say so rather than selecting a weak page: a page that cannot answer the question wastes a fetch and produces a misleading absence.",
        items: { type: "string", enum: ["priorities", "eligibility", "process", "grants", "identity"] },
      },
    },
    required: ["selections", "unavailable_purposes"],
  },
};

// Built here rather than inline so it can be tested, diffed and versioned
// without an API key.
export function buildSelectionPrompt(input: {
  manifest: DiscoveryManifest;
  funderName: string;
  opportunityName?: string | null;
}): string {
  const subject = input.opportunityName
    ? `${input.funderName}, specifically its "${input.opportunityName}" opportunity`
    : input.funderName;

  return `You are choosing which pages of a funder's own website to read, in order to decide whether a nonprofit should pursue them.

Funder: ${subject}
Site: ${input.manifest.host ?? "unknown"}

Below is every page discovered on their site, after mechanical filtering. Choose at most ${MAX_SELECTED}, best first.

What the reading needs to establish:
- priorities   what they fund, and where
- eligibility  stated rules that could disqualify an applicant
- process      how and when to apply
- grants       who they have actually funded
- identity     their legal name, address, or EIN

Rules:
- Reference pages ONLY by their [n] index. Do not write URLs.
- Prefer one page that answers several purposes over several thin ones.
- An entry marked "[1 of ~N under /path/*]" stands for a group of similar pages; selecting it means reading that one example.
- If no page here could plausibly answer a purpose, list it in unavailable_purposes instead of selecting a weak substitute. A page that cannot answer the question wastes a read and produces a misleading absence.
${input.manifest.capped ? `- This manifest was capped: ${input.manifest.droppedByCap} further pages exist and are not shown.\n` : ""}
Pages:
${renderManifest(input.manifest)}`;
}

// Validate a model's selection against the manifest it was shown.
//
// Pure, and deliberately strict: an out-of-range index is dropped rather than
// clamped. Clamping would silently substitute a different page for the one the
// model chose, which is exactly the class of quiet substitution this pipeline
// exists to remove.
export function resolveSelection(
  raw: { selections?: { index?: unknown; purposes?: unknown }[]; unavailable_purposes?: unknown },
  entries: ManifestEntry[]
): { selected: PageSelection[]; unavailablePurposes: SelectionPurpose[]; discarded: number } {
  const valid = new Set<SelectionPurpose>(["priorities", "eligibility", "process", "grants", "identity"]);
  const seen = new Set<number>();
  const selected: PageSelection[] = [];
  let discarded = 0;

  for (const s of raw.selections ?? []) {
    const index = typeof s.index === "number" ? s.index : Number.NaN;
    if (!Number.isInteger(index) || index < 0 || index >= entries.length || seen.has(index)) {
      discarded++;
      continue;
    }
    seen.add(index);
    const purposes = (Array.isArray(s.purposes) ? s.purposes : []).filter((p): p is SelectionPurpose =>
      typeof p === "string" && valid.has(p as SelectionPurpose)
    );
    selected.push({ index, url: entries[index].url, purposes });
    if (selected.length >= MAX_SELECTED) break;
  }

  const unavailablePurposes = (Array.isArray(raw.unavailable_purposes) ? raw.unavailable_purposes : []).filter(
    (p): p is SelectionPurpose => typeof p === "string" && valid.has(p as SelectionPurpose)
  );

  return { selected, unavailablePurposes, discarded };
}

export async function selectPages(input: {
  manifest: DiscoveryManifest;
  funderName: string;
  opportunityName?: string | null;
}): Promise<SelectionOutcome> {
  if (input.manifest.entries.length === 0) {
    return { selected: [], promptVersion: SELECTION_PROMPT_VERSION, model: SELECTION_MODEL, inputTokens: 0, outputTokens: 0, unavailablePurposes: ["priorities", "eligibility", "process", "grants", "identity"] };
  }

  const response = await anthropic.messages.create(
    {
      model: SELECTION_MODEL,
      max_tokens: 1500,
      tools: [SELECTION_TOOL],
      // Forced: the value of this call is the structured selection, and a
      // prose answer would have to be parsed back into indices -- reintroducing
      // exactly the free-text step the tool exists to remove.
      tool_choice: { type: "tool", name: "select_pages" },
      messages: [{ role: "user", content: buildSelectionPrompt(input) }],
    },
    { timeout: TIMEOUT_MS }
  );

  const call = response.content.find((b) => b.type === "tool_use");
  const resolved = resolveSelection(
    (call?.type === "tool_use" ? call.input : {}) as Parameters<typeof resolveSelection>[0],
    input.manifest.entries
  );

  return {
    selected: resolved.selected,
    promptVersion: SELECTION_PROMPT_VERSION,
    model: SELECTION_MODEL,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    unavailablePurposes: resolved.unavailablePurposes,
  };
}
