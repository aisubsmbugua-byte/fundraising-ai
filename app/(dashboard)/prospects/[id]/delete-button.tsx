"use client";

import { useTransition } from "react";
import { deleteProspect } from "../actions";

export default function DeleteProspectButton({ id, name }: { id: string; name: string }) {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => {
        if (confirm(`Delete "${name}"? This can't be undone.`)) {
          startTransition(() => {
            deleteProspect(id);
          });
        }
      }}
      style={{
        padding: "6px 12px",
        border: "1px solid #dc2626",
        color: "#dc2626",
        borderRadius: 4,
        background: "#fff",
        cursor: "pointer",
      }}
    >
      {isPending ? "Deleting…" : "Delete"}
    </button>
  );
}
