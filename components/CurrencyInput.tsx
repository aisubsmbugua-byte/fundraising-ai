"use client";

import { useState } from "react";
import { fieldStyle, colors } from "@/lib/ui";

function formatWithCommas(digits: string) {
  if (!digits) return "";
  return Number(digits).toLocaleString("en-US");
}

export default function CurrencyInput({
  name,
  defaultValue,
}: {
  name: string;
  defaultValue?: number | null;
}) {
  const [digits, setDigits] = useState(defaultValue ? String(defaultValue) : "");

  return (
    <div style={{ position: "relative", marginTop: 4 }}>
      <span
        style={{
          position: "absolute",
          left: 8,
          top: "50%",
          transform: "translateY(-50%)",
          color: colors.textMuted,
          pointerEvents: "none",
        }}
      >
        $
      </span>
      <input
        type="text"
        inputMode="numeric"
        value={formatWithCommas(digits)}
        onChange={(e) => setDigits(e.target.value.replace(/[^0-9]/g, ""))}
        style={{ ...fieldStyle, marginTop: 0, paddingLeft: 20 }}
      />
      <input type="hidden" name={name} value={digits} />
    </div>
  );
}
