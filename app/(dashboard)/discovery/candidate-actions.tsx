"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acceptCandidate, dismissCandidate } from "./actions";
import { runDeepDive } from "../prospects/[id]/deep-dive-actions";
import ConfirmDialog from "@/components/ConfirmDialog";
import { buttonPrimary, buttonSecondary } from "@/lib/ui";

export default function CandidateActions({ id, name }: { id: string; name: string }) {
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const router = useRouter();

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
              // Fire the actual research without awaiting it here --
              // the prospect page polls for progress, it doesn't need
              // this call to resolve before navigating.
              runDeepDive(result.runId, result.prospectId);
              router.push(`/prospects/${result.prospectId}`);
            }
          });
        }}
      />
    </div>
  );
}
