// Content fingerprints for decision gates (STATE item 92, ruling 0038
// clause 3).
//
// A gate ability is decided only on a version the user was SHOWN in an earlier
// turn. "The same version" has to mean the same CONTENT, not the same row id --
// a draft edited after it was displayed is a different thing to approve. So
// the displayed card carries a fingerprint of what it shows, and the executor
// recomputes it from the live row at the moment of execution; a mismatch
// refuses.
//
// ONE pure function per subject, used identically by the reads that produce
// the cards and by the executors that recompute (a test pins both call sites
// to this module). It hashes a canonical JSON form: object keys sorted, every
// string trimmed, arrays kept in order, so a re-ordered key or stray
// whitespace at the edges of a field does not make the same text look
// different -- while any change to the words does.
//
// Pure: no database, no clock. Server-side only (node:crypto).

import { createHash } from "node:crypto";
import type { OrganizationIntel, Strategy } from "@/lib/strategy";

// Sorted-key, trimmed-string JSON. `undefined` object members are dropped (as
// JSON.stringify does); `undefined` array members become null (also as it does).
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonicalize(v)));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// A stored strategy/intel jsonb can be missing a field or carry a non-string
// where a string belongs. Both the read and the executor normalise through
// this same projection before hashing, so a sparse row hashes the same way in
// both places.
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function normalizeStrategy(raw: unknown): Strategy {
  const s = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    outreach_approach: str(s.outreach_approach),
    ask_positioning: str(s.ask_positioning),
    rationale: str(s.rationale),
    key_talking_points: strList(s.key_talking_points),
    evidence_to_highlight: strList(s.evidence_to_highlight),
  };
}

export function normalizeIntel(raw: unknown): OrganizationIntel {
  const s = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    location: str(s.location),
    funder_type: str(s.funder_type),
    geographic_focus: str(s.geographic_focus),
    typical_grant_size: str(s.typical_grant_size),
    focus_areas: strList(s.focus_areas),
  };
}

// {strategy, organization_intel} -- what approveStrategy approves.
export function strategyFingerprint(strategy: unknown, organizationIntel: unknown): string {
  return sha256Hex(canonicalJson({ strategy: normalizeStrategy(strategy), organization_intel: normalizeIntel(organizationIntel) }));
}

// {kind, subject, content} -- what approveDraft approves. A null subject (a
// call-prep draft has none) and an empty one are different facts and stay so.
export function draftFingerprint(draft: { kind: unknown; subject: unknown; content: unknown }): string {
  return sha256Hex(
    canonicalJson({
      kind: str(draft.kind),
      subject: typeof draft.subject === "string" ? draft.subject : null,
      content: str(draft.content),
    })
  );
}

export const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
