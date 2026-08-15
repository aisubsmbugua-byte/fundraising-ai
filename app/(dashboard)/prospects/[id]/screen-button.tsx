"use client";

import { useTransition } from "react";
import { screenProspectAction } from "../actions";

export default function ScreenButton({ prospectId }: { prospectId: string }) {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => startTransition(() => screenProspectAction(prospectId))}
      style={{
        padding: "6px 12px",
        border: "1px solid #cbd5e1",
        borderRadius: 4,
        background: "#fff",
        cursor: "pointer",
      }}
    >
      {isPending ? "Screening…" : "Screen"}
    </button>
  );
}
