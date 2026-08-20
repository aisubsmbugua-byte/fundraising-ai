"use client";

import { useEffect, useState, useTransition } from "react";
import { acceptCandidate, dismissCandidate } from "./actions";
import { runDeepDive } from "../prospects/[id]/deep-dive-actions";
import ConfirmDialog from "@/components/ConfirmDialog";
import { buttonPrimary, buttonSecondary } from "@/lib/ui";

export default function CandidateActions({ id, name }: { id: string; name: string }) {
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingDeepDive, setPendingDeepDive] = useState<{ runId: string; prospectId: string } | null>(
    null
  );

  // Fired from an effect, not called directly inside the
  // startTransition below -- calling a Server Action inside a
  // transition kept isPending true for as long as that call's promise
  // took to settle even though it's never awaited, which left this
  // candidate's own buttons stuck in a "pending" state for the full
  // deep-dive duration (a minute or more) instead of just the fast
  // accept step. Firing it from an effect decouples it entirely,
  // mirroring the same pattern DeepDivePanel already uses.
  useEffect(() => {
    if (pendingDeepDive) {
      runDeepDive(pendingDeepDive.runId, pendingDeepDive.prospectId);
    }
  }, [pendingDeepDive]);

  return (
    <div style={{ display: "flex", gap: 8 }}>
      <button
        type="button"
        disabled={isPending}
        onClick={() => setConfirmOpen(true)}
        style={{ ...buttonPrimary, padding: "6px 12px", fontSize: 13 }}
      >
        Accept
      </button>
      <button
        type="button"
        disabled={isPending}
        onClick={() => startTransition(() => dismissCandidate(id))}
        style={{ ...buttonSecondary, padding: "6px 12px", fontSize: 13 }}
      >
        {isPending ? "…" : "Dismiss"}
      </button>
      <ConfirmDialog
        open={confirmOpen}
        title="Accept candidate"
        message={`Accept "${name}" into the pipeline as a new prospect at the Discovery stage? This starts an automatic deep-dive to propose a strategy for pursuing them.`}
        confirmLabel="Accept"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          startTransition(async () => {
            const result = await acceptCandidate(id);
            if (result) setPendingDeepDive(result);
          });
        }}
      />
    </div>
  );
}
