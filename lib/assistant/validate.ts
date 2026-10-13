// Argument validation for assistant tools. Tool arguments come from a model,
// so they are untrusted input: every id is a uuid, every enum is closed,
// every string is bounded, every date is a real calendar date, and an
// argument the schema does not name is refused rather than ignored.
//
// Pure -- no database, no clock (callers pass `todayIso` where it matters).

import type { Result } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// NUL and the C0/C1 controls other than tab and newline have no place in a
// funder name, a note or a summary; refusing them is cheaper than reasoning
// about what a downstream renderer does with them.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

// "2026-02-31" round-trips to 2026-03-03 and is refused, rather than becoming
// a different day than the one named.
export function normalizeIsoDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!ISO_DATE_RE.test(t)) return null;
  const parsed = new Date(`${t}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === t ? t : null;
}

export function rejectUnknownKeys(raw: Record<string, unknown>, allowed: readonly string[]): string | null {
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  return extra.length > 0 ? `Unknown argument(s): ${extra.slice(0, 5).join(", ")}.` : null;
}

export function asUuid(v: unknown, field: string): Result<string> {
  if (!isUuid(v)) return { ok: false, error: `${field} must be an id in the form returned by a previous lookup.` };
  return { ok: true, value: v.toLowerCase() };
}

export function asBoundedString(
  v: unknown,
  field: string,
  opts: { min: number; max: number }
): Result<string> {
  if (typeof v !== "string") return { ok: false, error: `${field} must be text.` };
  const t = v.trim();
  if (CONTROL_RE.test(t)) return { ok: false, error: `${field} contains characters that are not allowed.` };
  if (t.length < opts.min) return { ok: false, error: `${field} must be at least ${opts.min} character(s).` };
  if (t.length > opts.max) return { ok: false, error: `${field} must be at most ${opts.max} characters.` };
  return { ok: true, value: t };
}

export function asOptionalBoundedString(
  v: unknown,
  field: string,
  opts: { max: number }
): Result<string | null> {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return { ok: true, value: null };
  return asBoundedString(v, field, { min: 1, max: opts.max });
}

export function asEnum<T extends string>(v: unknown, field: string, values: readonly T[]): Result<T> {
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
    return { ok: false, error: `${field} must be one of: ${values.join(", ")}.` };
  }
  return { ok: true, value: v as T };
}

export function asIsoDate(v: unknown, field: string, bounds: { min: string; max: string }): Result<string> {
  const d = normalizeIsoDate(v);
  if (!d) return { ok: false, error: `${field} must be a real calendar date written YYYY-MM-DD.` };
  if (d < bounds.min || d > bounds.max) return { ok: false, error: `${field} must be between ${bounds.min} and ${bounds.max}.` };
  return { ok: true, value: d };
}

export function asOptionalIsoDate(
  v: unknown,
  field: string,
  bounds: { min: string; max: string }
): Result<string | null> {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return { ok: true, value: null };
  return asIsoDate(v, field, bounds);
}

export function asIntInRange(v: unknown, field: string, opts: { min: number; max: number; fallback: number }): Result<number> {
  if (v === undefined || v === null) return { ok: true, value: opts.fallback };
  if (typeof v !== "number" || !Number.isInteger(v) || v < opts.min || v > opts.max) {
    return { ok: false, error: `${field} must be a whole number from ${opts.min} to ${opts.max}.` };
  }
  return { ok: true, value: v };
}

// Parses a tool call's `arguments` string. An empty string is "no arguments".
// Anything that is not a JSON object is refused (a bare array, number or
// string is not a legal argument set for any ability in the registry).
export function parseArgumentsJson(raw: string): Result<Record<string, unknown>> {
  const text = raw.trim();
  if (text === "") return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "The arguments were not valid JSON." };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "The arguments must be a JSON object." };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}
