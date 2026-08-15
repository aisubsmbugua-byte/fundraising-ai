"use client";

import { useState, useTransition } from "react";
import { deleteRule } from "./actions";
import ConfirmDialog from "@/components/ConfirmDialog";

export default function DeleteRuleButton({ id, label }: { id: string; label: string }) {
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        disabled={isPending}
        onClick={() => setOpen(true)}
        style={{
          padding: "4px 10px",
          border: "1px solid #dc2626",
          color: "#dc2626",
          borderRadius: 4,
          background: "#fff",
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        {isPending ? "Deleting…" : "Delete"}
      </button>
      <ConfirmDialog
        open={open}
        title="Delete rule"
        message={`Delete the rule "${label}"? This can't be undone.`}
        confirmLabel="Delete"
        danger
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false);
          startTransition(() => {
            deleteRule(id);
          });
        }}
      />
    </>
  );
}
