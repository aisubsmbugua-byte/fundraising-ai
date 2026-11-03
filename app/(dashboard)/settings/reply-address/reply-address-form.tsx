"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveReplyAddress, clearReplyAddress } from "./actions";
import { spacing, colors, fieldStyle, labelStyle, buttonPrimary, buttonSecondary } from "@/lib/ui";

// Ruling 0042. `initial` is the address replies use now, when that is the one
// the person chose (else empty). "Use my sign-in address" (clear) is offered
// whenever anything is saved (`hasStored`), including a saved value that
// cannot be used -- the page explains that case.
export default function ReplyAddressForm({ initial, hasStored }: { initial: string; hasStored: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setMessage(null);
        startTransition(async () => {
          const result = await saveReplyAddress(value);
          if ("error" in result) setError(result.error);
          else {
            setMessage("Saved. Replies to your funders' emails now go to this address.");
            router.refresh();
          }
        });
      }}
      style={{ display: "grid", gap: spacing.md }}
    >
      <label style={labelStyle}>
        Send replies to
        <input
          type="email"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="name@yourorganization.org"
          autoComplete="email"
          maxLength={254}
          style={fieldStyle}
        />
      </label>
      <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap" }}>
        <button type="submit" disabled={isPending} style={buttonPrimary}>
          {isPending ? "Saving…" : "Save reply address"}
        </button>
        {hasStored && (
          <button
            type="button"
            disabled={isPending}
            style={buttonSecondary}
            onClick={() => {
              setError(null);
              setMessage(null);
              startTransition(async () => {
                const result = await clearReplyAddress();
                if ("error" in result) setError(result.error);
                else {
                  setValue("");
                  setMessage("Cleared. Replies now go to your sign-in address.");
                  router.refresh();
                }
              });
            }}
          >
            Use my sign-in address
          </button>
        )}
      </div>
      {error && <p style={{ margin: 0, color: colors.red600, fontSize: 13 }}>{error}</p>}
      {message && <p style={{ margin: 0, color: colors.textMuted, fontSize: 13 }}>{message}</p>}
    </form>
  );
}
