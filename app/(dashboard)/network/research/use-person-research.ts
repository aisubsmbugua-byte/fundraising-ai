"use client";

// The state of researching ONE person, for the card that shows it (STATE item 112,
// ruling 0044). No effect, no timer, no page-load hook: nothing here runs unless a
// caller invokes `run`, `strike` or `restore` from a click handler (or, for the
// single-person card, from the continuation of a human's "Confirm this person"
// click, after the confirmation succeeded). scripts/test-network-research.ts scans
// every caller.
//
// `run(false)` researches a person who has not been researched; `run(true)` is a
// human's explicit "Research again". The server decides whether either is allowed:
// it refuses anyone who is not confirmed, who is marked do-not-research, or who has
// been researched and was not explicitly asked for again.

import { useState } from "react";
import { loadPersonFindings, researchPerson, strikeFinding, unstrikeFinding } from "../research-actions";
import type { ReviewFinding } from "@/lib/network-research";

export type ResearchPhase = { kind: "none" } | { kind: "running" } | { kind: "failed"; message: string } | { kind: "ready" };

export type InitialResearch = { findings: ReviewFinding[]; researchedAt: string | null; ageText: string | null };

export type PersonResearch = {
  phase: ResearchPhase;
  findings: ReviewFinding[];
  ageText: string | null;
  // What the last run said it found (in words), shown above the findings.
  message: string | null;
  // A problem striking or restoring, in words.
  error: string | null;
  busyId: string | null;
  run: (again: boolean) => Promise<void>;
  strike: (findingId: string) => Promise<void>;
  restore: (findingId: string) => Promise<void>;
};

export function usePersonResearch(personId: string, initial?: InitialResearch): PersonResearch {
  const [phase, setPhase] = useState<ResearchPhase>(initial && initial.researchedAt ? { kind: "ready" } : { kind: "none" });
  const [findings, setFindings] = useState<ReviewFinding[]>(initial?.findings ?? []);
  const [ageText, setAgeText] = useState<string | null>(initial?.ageText ?? null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const show = async (): Promise<boolean> => {
    const loaded = await loadPersonFindings(personId);
    if ("error" in loaded) {
      setPhase({ kind: "failed", message: `Research finished, but what it found could not be shown: ${loaded.error}` });
      return false;
    }
    setFindings(loaded.findings);
    setAgeText(loaded.ageText);
    setPhase({ kind: "ready" });
    return true;
  };

  const run = async (again: boolean) => {
    setError(null);
    setMessage(null);
    setPhase({ kind: "running" });
    let result: Awaited<ReturnType<typeof researchPerson>>;
    try {
      result = await researchPerson(personId, again);
    } catch (err) {
      setPhase({ kind: "failed", message: err instanceof Error ? err.message : "The research did not complete." });
      return;
    }
    if ("error" in result) {
      // Already researched is not a failure: show what is held, with its age.
      if (result.code === "already_researched") {
        if (await show()) setMessage(result.error);
        return;
      }
      setPhase({ kind: "failed", message: result.error });
      return;
    }
    setMessage(result.message);
    await show();
  };

  const mark = async (findingId: string, status: "struck" | "included") => {
    setError(null);
    setBusyId(findingId);
    try {
      const result = status === "struck" ? await strikeFinding(findingId) : await unstrikeFinding(findingId);
      if ("error" in result) setError(result.error);
      else setFindings((list) => list.map((f) => (f.id === findingId ? { ...f, status } : f)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not go through.");
    } finally {
      setBusyId(null);
    }
  };

  return {
    phase,
    findings,
    ageText,
    message,
    error,
    busyId,
    run,
    strike: (id) => mark(id, "struck"),
    restore: (id) => mark(id, "included"),
  };
}
