"use client";

import { useState, useTransition } from "react";
import { deleteProspect } from "../actions";
import ConfirmDialog from "@/components/ConfirmDialog";

export default function DeleteProspectButton({ id, name }: { id: string; name: string }) {
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        disabled={isPending}
        onClick={() => setOpen(true)}
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
      <ConfirmDialog
        open={open}
        title="Delete prospect"
        message={`Delete "${name}"? This can't be undone.`}
        confirmLabel="Delete"
        danger
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false);
          startTransition(() => {
            deleteProspect(id);
          });
        }}
      />
    </>
  );
}
