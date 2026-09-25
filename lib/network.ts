// Network paths (STATE item 76, ruling 0033).
//
// The general invariant: a network path is a PROPOSAL grounded in two captured
// facts, each referenced by id and never retyped -- a person a human recorded
// and a funder-side claim a human approved -- and it changes nothing until a
// human decides it.
//
// Everything here is pure (no database, no model) so the rules that matter are
// testable by running them. Prompt wording is never the last line of defence
// (CLAUDE.md, "Capture, don't retype"): the id validation below is what
// guarantees a stored path cites a real connection and a real claim; the prompt
// only asks the model to behave.

import type { ApprovedClaim } from "@/lib/prospect-intelligence";
import { RESEARCH_CLAIM_KEYS } from "@/lib/research";

// Ruling 0033 clause 1: a closed list, chosen by the recorder, no default.
export const CONNECTION_STRENGTHS = ["close", "warm", "acquaintance"] as const;
export type ConnectionStrength = (typeof CONNECTION_STRENGTHS)[number];

export function isConnectionStrength(v: unknown): v is ConnectionStrength {
  return typeof v === "string" && (CONNECTION_STRENGTHS as readonly string[]).includes(v);
}

export const PATH_CONFIDENCES = ["low", "medium", "high"] as const;
export type PathConfidence = (typeof PATH_CONFIDENCES)[number];

export function isPathConfidence(v: unknown): v is PathConfidence {
  return typeof v === "string" && (PATH_CONFIDENCES as readonly string[]).includes(v);
}

export const PATH_STATUSES = ["suggested", "accepted", "dismissed"] as const;
export type PathStatus = (typeof PATH_STATUSES)[number];

// Ruling 0033 clause 3, verbatim from the STATE item 76 row. Shown wherever a
// connection is entered.
export const NETWORK_DISCLOSURE =
  "What you record here is shared with the AI service to find introductions. Nothing is ever sent to the people you list. Avoid recording sensitive personal details in notes.";

export type NetworkConnection = {
  id: string;
  organization_id: string;
  recorded_by: string;
  person_name: string;
  affiliation: string | null;
  how_known: string | null;
  strength: ConnectionStrength;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type NetworkPathSuggestion = {
  id: string;
  prospect_id: string;
  network_connection_id: string;
  funder_claim_id: string;
  reasoning: string;
  model_confidence: PathConfidence | null;
  status: PathStatus;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
};

// The funder-side facts that can anchor a path: approved claims that NAME a
// person or an organization. A door is opened by someone who knows someone, so
// the claim must give a name to be known by:
//   people.key_contacts             a named person and their role
//   funding.recent_grants           names the recipient organizations
//   application.denominational_restriction   names a religious body
//   application.invitation_mechanism         may name who invites or refers
// A claim about a dollar figure or a deadline names nobody and can anchor
// nothing, so it is never handed to the model.
export const NETWORK_ANCHOR_CLAIM_KEYS: readonly string[] = [
  "people.key_contacts",
  "funding.recent_grants",
  "application.denominational_restriction",
  "application.invitation_mechanism",
];

// Ruling 0033 clause 4 requires a funder-side fact a HUMAN has approved. The
// approved-intelligence payload also admits claims that were merely verified
// against their evidence and "advisory" claims nobody has decided; of those, an
// advisory claim no person has decided is exactly the unapproved case and is
// excluded. Verified claims are admitted as the loader admits them (see the
// escalation in the build report).
export function selectAnchorClaims(claims: readonly ApprovedClaim[]): ApprovedClaim[] {
  return claims.filter((c) => NETWORK_ANCHOR_CLAIM_KEYS.includes(c.claimKey) && (!c.advisory || c.humanDecided));
}

// The human-readable label for the fact a path anchors to. For a named person
// the claim text IS the name and role ("Jane Doe, Executive Director"), so the
// label is the kind and the caller shows the text beside it.
export function anchorKindLabel(claimKey: string): string {
  return RESEARCH_CLAIM_KEYS.find((k) => k.key === claimKey)?.label ?? "Research fact";
}

// The tool the model must answer through. Each path must carry both ids, its
// reasoning and its confidence; an empty list is a valid answer.
export const NETWORK_PATHS_TOOL = {
  name: "submit_network_paths",
  description:
    "Submit the introduction paths you can ground in the recorded connections and the approved funder facts. Submit an empty list if none can be grounded -- that is a valid and often correct answer.",
  input_schema: {
    type: "object" as const,
    properties: {
      paths: {
        type: "array",
        description: "Zero or more paths. Never pad the list.",
        items: {
          type: "object",
          properties: {
            network_connection_id: {
              type: "string",
              description: "The id of ONE recorded connection, copied exactly from the connections list. Never invent an id.",
            },
            funder_claim_id: {
              type: "string",
              description: "The id of ONE approved funder fact, copied exactly from the funder facts list. Never invent an id.",
            },
            reasoning: {
              type: "string",
              description:
                "One or two sentences on how this connection could open a door, using only what the recorded connection and the funder fact actually say.",
            },
            confidence: {
              type: "string",
              enum: [...PATH_CONFIDENCES],
              description: "Your own estimate of how likely this path is real and useful.",
            },
          },
          required: ["network_connection_id", "funder_claim_id", "reasoning", "confidence"],
        },
      },
    },
    required: ["paths"],
  },
};

// Only what the model may see: the connection's own fields and its id. No
// recorder id, no timestamps, and -- there being none stored -- no contact
// detail.
export function connectionLine(c: Pick<NetworkConnection, "id" | "person_name" | "affiliation" | "how_known" | "strength" | "notes">): string {
  return [
    `- id: ${c.id}`,
    `  name: ${c.person_name}`,
    `  affiliation: ${c.affiliation?.trim() || "(not recorded)"}`,
    `  how the recorder knows them: ${c.how_known?.trim() || "(not recorded)"}`,
    `  strength (chosen by the recorder): ${c.strength}`,
    `  notes: ${c.notes?.trim() || "(none)"}`,
  ].join("\n");
}

export function claimLine(c: Pick<ApprovedClaim, "claimId" | "claimKey" | "claim">): string {
  return `- id: ${c.claimId}\n  kind: ${anchorKindLabel(c.claimKey)}\n  fact: ${c.claim}`;
}

// The ground rules of ruling 0033 clause 4, in the codebase's grounding
// language: what may be cited, what may never be invented, what a name match is
// worth, and that nothing is a valid answer.
export function buildNetworkPathPrompt(input: {
  prospectName: string;
  connections: readonly Pick<NetworkConnection, "id" | "person_name" | "affiliation" | "how_known" | "strength" | "notes">[];
  claims: readonly Pick<ApprovedClaim, "claimId" | "claimKey" | "claim">[];
}): string {
  return `Find introduction paths to "${input.prospectName}" through people the user's organization already knows.

You have two lists and nothing else. Every path you propose must cite exactly one connection id from the first list and exactly one funder fact id from the second, copied exactly. A path that cites an id not in these lists is discarded.

Recorded connections (people the organization's team says they know, exactly as they recorded them):
${input.connections.map(connectionLine).join("\n")}

Approved funder facts (each names a person or an organization connected to ${input.prospectName}; a person on the team has approved every one):
${input.claims.map(claimLine).join("\n")}

Ground rules -- these are not suggestions:
- Use ONLY what is written above. Never invent a person, an affiliation, an employer, a board seat, a relationship or a mutual acquaintance. If it is not in a list, it is not known.
- A path exists only when the recorded connection and the funder fact actually connect: the same organization, the same congregation or body, or a relationship stated in the connection's own affiliation, how-known or notes. State that link in the reasoning in your own words, pointing at what the two entries say.
- A name that merely matches is not a link. A shared first or last name, a similar-sounding organization or a common word is a coincidence. If a name coincidence is the only basis, the confidence is "low" at most, and the reasoning must say it rests on the name alone.
- Confidence is your own estimate, not a fact. Use "high" only when the two entries state the same organization or relationship outright.
- Do not write outreach, do not suggest what to say, and do not address anyone. You are only saying which recorded person might open which door, and why.
- Zero paths is a valid answer and often the right one. Return an empty list rather than stretch a weak link.
- At most one path per connection-and-fact pair. No more than five paths in total.`;
}

export type ValidPath = {
  network_connection_id: string;
  funder_claim_id: string;
  reasoning: string;
  confidence: PathConfidence;
};

export type DiscardedPath = { reason: string; raw: unknown };

// The capture guarantee. Nothing the model typed is stored unless BOTH ids are
// in the pools that were handed to it, the reasoning is present and the
// confidence is on the closed list. Everything else is returned as discarded so
// the caller can LOG it -- never store it, never silently vanish it.
export function validateNetworkPaths(
  raw: unknown,
  connectionIds: ReadonlySet<string>,
  claimIds: ReadonlySet<string>
): { kept: ValidPath[]; discarded: DiscardedPath[] } {
  const kept: ValidPath[] = [];
  const discarded: DiscardedPath[] = [];
  if (!Array.isArray(raw)) return { kept, discarded };
  const seen = new Set<string>();
  for (const item of raw) {
    const p = (item ?? {}) as Record<string, unknown>;
    const connectionId = typeof p.network_connection_id === "string" ? p.network_connection_id : "";
    const claimId = typeof p.funder_claim_id === "string" ? p.funder_claim_id : "";
    const reasoning = typeof p.reasoning === "string" ? p.reasoning.trim() : "";
    if (!connectionIds.has(connectionId)) {
      discarded.push({ reason: "cited a network_connection_id that was not in the pool handed to the model", raw: item });
      continue;
    }
    if (!claimIds.has(claimId)) {
      discarded.push({ reason: "cited a funder_claim_id that was not in the pool handed to the model", raw: item });
      continue;
    }
    if (!reasoning) {
      discarded.push({ reason: "carried no reasoning", raw: item });
      continue;
    }
    if (!isPathConfidence(p.confidence)) {
      discarded.push({ reason: "carried a confidence outside low/medium/high", raw: item });
      continue;
    }
    const key = `${connectionId}|${claimId}`;
    if (seen.has(key)) {
      discarded.push({ reason: "repeated a connection-and-fact pair already proposed", raw: item });
      continue;
    }
    seen.add(key);
    kept.push({ network_connection_id: connectionId, funder_claim_id: claimId, reasoning, confidence: p.confidence });
  }
  return { kept, discarded };
}
