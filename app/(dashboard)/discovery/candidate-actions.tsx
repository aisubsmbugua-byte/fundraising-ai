"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acceptCandidate, dismissCandidate } from "./actions";
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
              // The prospect page's DeepDivePanel triggers the actual
              // research on mount -- not here, since this component
              // is about to unmount and an in-flight request from an
              // unmounting component risks getting cancelled.
              router.push(`/prospects/${result.prospectId}`);
            }
          });
        }}
      />
    </div>
  );
}
