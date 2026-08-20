"use client";

import { useState, useTransition } from "react";
import { acceptCandidate, dismissCandidate } from "./actions";
import { runDeepDive } from "../prospects/[id]/deep-dive-actions";
import ConfirmDialog from "@/components/ConfirmDialog";
import { buttonPrimary, buttonSecondary } from "@/lib/ui";

export default function CandidateActions({ id, name }: { id: string; name: string }) {
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

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
            if (result) {
              // Deliberately doesn't navigate to the prospect page --
              // staying here lets the reviewer accept several
              // candidates back-to-back. The Discovery page stays
              // mounted, so it's now safe for this fire-and-forget
              // call to be the trigger (previously this had to happen
              // on the destination page instead, since navigating
              // away right after firing it risked the browser
              // cancelling the in-flight request).
              runDeepDive(result.runId, result.prospectId);
            }
          });
        }}
      />
    </div>
  );
}
