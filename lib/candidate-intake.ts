// One answer to "do we already have this funder?", for every path that
// writes a candidate.
//
// There are three such paths -- Donor Finder's search, manual entry, and CSV
// import -- and until now only the search checked. Five identical "Graceway
// Church" rows were written through the manual form on 18 August, four of them
// minutes apart with nothing telling the person it already existed. The
// protection was real; it just guarded one door of three.
//
// Same lesson as allocateResearchRunVersion: when a rule lives inside one
// caller, the second caller is the one that eventually gets it wrong. The rule
// moves here, and the callers ask.
//
// This is a check, NOT the guarantee. Between reading and writing there is a
// window in which a second identical request can pass the same check -- which
// is exactly what happened at 22:48:00.440 and 22:48:01.884, one click landing
// twice. Only the database can close that, and 0057's unique index does. This
// module exists to produce a good answer BEFORE the write, so the constraint is
// a backstop a person never has to see.

import type { SupabaseClient } from "@supabase/supabase-js";

export type KnownOrg = { name: string; organization: string | null };

// Strips a leading "The " and normalizes case/whitespace so "The Maclellan
// Foundation" and "Maclellan Foundation" compare equal.
export function normalizeOrgName(s: string): string {
  return s.trim().toLowerCase().replace(/^the\s+/, "");
}

// Two names are the same real thing if they're equal after normalizing, or one
// contains the other ("Assemblies of God" vs "Assemblies of God World Missions
// (AGWM)"). Guarded to at least 4 characters so a short generic word doesn't
// false-positive against everything.
export function isSameOrg(a: string, b: string): boolean {
  const na = normalizeOrgName(a);
  const nb = normalizeOrgName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length < 4 || nb.length < 4) return false;
  return na.includes(nb) || nb.includes(na);
}

// Best-effort by name, and deliberately kept even now that dedupe_key exists:
// prospects carry no key (they have no source domain), and neither do rows
// written before 0055. The key is the precise instrument; this is the net
// underneath it.
export function isAlreadyKnown(known: KnownOrg[], name: string, organization?: string | null): boolean {
  return known.some((row) => {
    if (isSameOrg(row.name, name)) return true;
    if (organization && row.organization && isSameOrg(row.organization, organization)) return true;
    return false;
  });
}

export type ExistingFunder = {
  // Where it already lives, which decides what we offer to do about it.
  kind: "candidate" | "prospect";
  id: string;
  name: string;
  status: string | null;
};

// The single-record version, for the manual and CSV paths. Donor Finder loads
// both tables once per run and reuses them across candidates instead -- same
// predicates, different access pattern, because it checks hundreds of names
// against the same snapshot.
export async function findExistingFunder(
  supabase: SupabaseClient,
  input: { name: string; organization?: string | null; dedupeKey?: string | null; organizationId?: string }
): Promise<ExistingFunder | null> {
  let candidatesQuery = supabase.from("candidates").select("id, name, organization, status, dedupe_key");
  let prospectsQuery = supabase.from("prospects").select("id, name, organization, stage");
  if (input.organizationId) {
    candidatesQuery = candidatesQuery.eq("organization_id", input.organizationId);
    prospectsQuery = prospectsQuery.eq("organization_id", input.organizationId);
  }
  const [{ data: candidates }, { data: prospects }] = await Promise.all([candidatesQuery, prospectsQuery]);

  // A prospect wins over a candidate when both match: it is further along and
  // the more useful thing to send someone to.
  for (const p of prospects ?? []) {
    if (isSameOrg(p.name as string, input.name) || (input.organization && p.organization && isSameOrg(p.organization as string, input.organization))) {
      return { kind: "prospect", id: p.id as string, name: p.name as string, status: (p.stage as string) ?? null };
    }
  }
  for (const c of candidates ?? []) {
    const keyMatch = !!input.dedupeKey && c.dedupe_key === input.dedupeKey;
    if (keyMatch || isSameOrg(c.name as string, input.name) || (input.organization && c.organization && isSameOrg(c.organization as string, input.organization))) {
      return { kind: "candidate", id: c.id as string, name: c.name as string, status: (c.status as string) ?? null };
    }
  }
  return null;
}

// Postgres unique_violation. The one error a write path must translate rather
// than surface: it means the constraint caught what the check above raced past,
// and the person needs "this already exists", not a database code.
export function isUniqueViolation(error: { code?: string } | null | undefined): boolean {
  return error?.code === "23505";
}
