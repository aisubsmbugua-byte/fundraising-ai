"use client";

// Overview-tab giving-history display -- STATE item 83, ruling 0035. Beside
// the existing "Opportunity summary" card (app/(dashboard)/prospects/[id]/
// overview-tab.tsx), showing what this funder has ACTUALLY given in the
// past, as a list of dated, amounted rows -- never a single number or a
// notes paragraph (ruling 0035's test of compliance). The "Log a gift"
// control reuses the exact inline-form pattern the Supporters detail page
// uses for its own gift log (app/(dashboard)/supporters/supporters-
// workspace.tsx's LogGiftForm): a toggled form beside the list, not a
// separate page or modal.
//
// Its own small component, not inlined into overview-tab.tsx, because
// overview-tab.tsx is a Server Component (it reads prospect/strategyRun/
// screening data straight from the page's server-side fetch) and this piece
// needs client state (the open/closed form) and a server action call --
// exactly the split components/EditableAskAmount.tsx and
// components/ProspectOutcomePanel.tsx already establish for this same tab:
// a client "island" imported into the server-rendered Overview tab.
import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { logProspectGift } from "@/app/(dashboard)/prospects/[id]/gift-actions";
import type { ProspectGift } from "@/lib/prospects";
import { spacing, colors, fieldStyle, sectionStyle, cardStyle, buttonPrimary, buttonSecondary } from "@/lib/ui";

export default function ProspectGiftHistory({ prospectId, gifts }: { prospectId: string; gifts: ProspectGift[] }) {
  const [giftOpen, setGiftOpen] = useState(false);

  return (
    <div style={sectionStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ fontSize: 14 }}>Giving history ({gifts.length})</h3>
        <button
          type="button"
          onClick={() => setGiftOpen((o) => !o)}
          style={{ ...buttonSecondary, display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: "6px 10px" }}
        >
          <Plus size={13} /> Log a gift
        </button>
      </div>

      {giftOpen && <LogGiftForm prospectId={prospectId} onDone={() => setGiftOpen(false)} />}

      {gifts.length > 0 ? (
        <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.sm }}>
          {gifts.map((g) => (
            <div key={g.id} style={{ fontSize: 13, display: "flex", justifyContent: "space-between", gap: spacing.sm }}>
              <div>
                <div style={{ fontWeight: 600 }}>${g.amount.toLocaleString("en-US")}</div>
                {g.note && <div style={{ color: colors.textFaint, fontSize: 12 }}>{g.note}</div>}
              </div>
              <div style={{ color: colors.textFaint, fontSize: 12, whiteSpace: "nowrap" }}>
                {new Date(g.gift_date + "T00:00:00").toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p style={{ fontSize: 13, color: colors.textFaint, margin: 0, marginTop: spacing.sm }}>
          No gifts logged yet. An ask with no giving history is an honest, ordinary state -- not an error.
        </p>
      )}
    </div>
  );
}

function LogGiftForm({ prospectId, onDone }: { prospectId: string; onDone: () => void }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          const amount = Number(formData.get("amount"));
          const giftDate = (formData.get("gift_date") as string) || new Date().toISOString().slice(0, 10);
          const note = (formData.get("note") as string) || null;
          const result = await logProspectGift(prospectId, amount, giftDate, note);
          if ("error" in result) setError(result.error);
          else onDone();
        });
      }}
      style={{ display: "grid", gap: spacing.sm, marginTop: spacing.sm, ...cardStyle }}
    >
      <div style={{ display: "flex", gap: spacing.sm }}>
        <input name="amount" type="number" min="0.01" step="0.01" placeholder="Amount" required style={{ ...fieldStyle, marginTop: 0 }} />
        <input type="date" name="gift_date" defaultValue={new Date().toISOString().slice(0, 10)} style={{ ...fieldStyle, marginTop: 0 }} />
      </div>
      <textarea name="note" placeholder="Note (optional)" rows={2} style={fieldStyle} />
      {error && <p style={{ color: colors.danger, fontSize: 13, margin: 0 }}>{error}</p>}
      <div style={{ display: "flex", gap: spacing.sm }}>
        <button type="submit" disabled={isPending} style={buttonPrimary}>
          {isPending ? "Saving…" : "Save gift"}
        </button>
        <button type="button" onClick={onDone} style={buttonSecondary}>
          Cancel
        </button>
      </div>
    </form>
  );
}
