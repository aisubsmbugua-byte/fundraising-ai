"use client";

import { useFormStatus } from "react-dom";
import { buttonPrimary } from "@/lib/ui";

export default function SubmitButton({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending} style={{ ...buttonPrimary, opacity: pending ? 0.7 : 1 }}>
      {pending ? "Saving…" : children}
    </button>
  );
}
