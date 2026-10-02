"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Plus, Upload, DollarSign, Mail, PhoneCall, Users as UsersIcon, MessageSquare, ArrowLeft, Pencil, Trash2 } from "lucide-react";
import { createSupporter, updateSupporter, deleteSupporter, bulkDeleteSupporters, logSupporterGift, logSupporterInteraction } from "./actions";
import {
  SOURCE_TYPES,
  PLEDGE_FREQUENCIES,
  sourceTypeLabel,
  pledgeFrequencyLabel,
  formatPledge,
  daysSinceSupporterTouch,
  type Supporter,
  type SupporterGift,
  type SupporterInteraction,
} from "@/lib/supporters";
import { interactionKindLabel, type InteractionKind } from "@/lib/interactions";
import InitialsAvatar from "@/components/InitialsAvatar";
import LogInteractionForm from "@/components/LogInteractionForm";
import { spacing, colors, radiusSm, fieldStyle, labelStyle, sectionStyle, cardStyle, chipStyle, buttonPrimary, buttonSecondary, buttonDanger } from "@/lib/ui";

const ICON_BY_KIND: Record<InteractionKind, typeof Mail> = {
  email: Mail,
  call: PhoneCall,
  meeting: UsersIcon,
  note: MessageSquare,
};

export default function SupportersWorkspace({
  supporters,
  giftsBySupporter,
  interactionsBySupporter,
  initialSelectedId,
}: {
  supporters: Supporter[];
  giftsBySupporter: Record<string, SupporterGift[]>;
  interactionsBySupporter: Record<string, SupporterInteraction[]>;
  initialSelectedId?: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? supporters[0]?.id ?? null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  // STATE item 84: bulk delete's row-selection set, and its own
  // expand-then-confirm step -- same discipline as every other destructive
  // action on this page, never an instant click.
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null);
  const [isBulkDeleting, startBulkDeleting] = useTransition();
  const now = new Date();

  const selected = supporters.find((s) => s.id === selectedId) ?? null;

  function toggleChecked(id: string, checked: boolean) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  return (
    <div
      className="split-pane"
      style={{ display: "grid", gridTemplateColumns: "minmax(320px, 42%) 1fr", gap: spacing.lg, marginTop: spacing.lg }}
    >
      <div className={`split-pane-list${mobileDetailOpen ? " detail-active" : ""}`} style={{ minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: spacing.sm }}>
          <h2 style={{ fontSize: 15, margin: 0 }}>Supporters ({supporters.length})</h2>
          <div style={{ display: "flex", gap: spacing.xs }}>
            <Link
              href="/supporters/import"
              style={{ ...buttonSecondary, display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: "6px 10px", textDecoration: "none" }}
            >
              <Upload size={13} /> Import CSV
            </Link>
            {/* STATE item 82: a visibly different link/icon/label from
                "Import CSV" above -- that one creates supporters, this one
                never does, it only logs gifts against people already on the
                list. Kept distinguishable so the two are never confused. */}
            <Link
              href="/supporters/import-gifts"
              style={{ ...buttonSecondary, display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: "6px 10px", textDecoration: "none" }}
            >
              <DollarSign size={13} /> Import giving history
            </Link>
            <button
              type="button"
              onClick={() => setAddOpen((o) => !o)}
              style={{ ...buttonPrimary, display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: "6px 10px" }}
            >
              <Plus size={13} /> Add supporter
            </button>
            {/* STATE item 84: only appears once at least one row is checked,
                and even then does not delete instantly -- it opens the
                confirm panel below. */}
            {checkedIds.size > 0 && !bulkDeleteOpen && (
              <button
                type="button"
                onClick={() => setBulkDeleteOpen(true)}
                style={{ ...buttonDanger, display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: "6px 10px" }}
              >
                <Trash2 size={13} /> Delete selected ({checkedIds.size})
              </button>
            )}
          </div>
        </div>

        {addOpen && (
          <AddSupporterForm
            onDone={(id) => {
              setAddOpen(false);
              if (id) {
                setSelectedId(id);
                setMobileDetailOpen(true);
              }
            }}
          />
        )}

        {bulkDeleteOpen && (
          <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.md, ...cardStyle }}>
            <p style={{ fontSize: 13, margin: 0 }}>
              Delete {checkedIds.size} selected supporter{checkedIds.size === 1 ? "" : "s"}? This removes their gift
              and interaction history too, and can&apos;t be undone.
            </p>
            {bulkDeleteError && <p style={{ color: colors.danger, fontSize: 13, margin: 0 }}>{bulkDeleteError}</p>}
            <div style={{ display: "flex", gap: spacing.sm }}>
              <button
                type="button"
                disabled={isBulkDeleting}
                onClick={() => {
                  setBulkDeleteError(null);
                  startBulkDeleting(async () => {
                    const ids = Array.from(checkedIds);
                    const result = await bulkDeleteSupporters(ids);
                    if ("error" in result) {
                      setBulkDeleteError(result.error);
                      return;
                    }
                    setBulkDeleteOpen(false);
                    setCheckedIds(new Set());
                    // The detail panel can't keep showing a supporter that
                    // was just deleted in this same batch.
                    if (selectedId && ids.includes(selectedId)) setSelectedId(null);
                  });
                }}
                style={buttonDanger}
              >
                {isBulkDeleting ? "Deleting…" : `Delete ${checkedIds.size} supporter${checkedIds.size === 1 ? "" : "s"}`}
              </button>
              <button type="button" onClick={() => setBulkDeleteOpen(false)} style={buttonSecondary}>
                Cancel
              </button>
            </div>
          </div>
        )}

        <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.md, maxHeight: "70vh", overflowY: "auto" }}>
          {supporters.map((s) => {
            const days = daysSinceSupporterTouch(giftsBySupporter[s.id] ?? [], interactionsBySupporter[s.id] ?? [], now);
            return (
              // A checkbox is interactive content and isn't valid nested inside
              // a <button>, so the row is a checkbox and a button side by side
              // in their own flex wrapper, not one checkbox-inside-button.
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: spacing.xs }}>
                <input
                  type="checkbox"
                  checked={checkedIds.has(s.id)}
                  onChange={(e) => toggleChecked(s.id, e.target.checked)}
                  aria-label={`Select ${s.name} for bulk delete`}
                  style={{ flexShrink: 0, cursor: "pointer" }}
                />
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(s.id);
                    setMobileDetailOpen(true);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: spacing.sm,
                    textAlign: "left",
                    background: selected?.id === s.id ? colors.teal100 : colors.surface,
                    border: `1px solid ${selected?.id === s.id ? colors.teal700 : colors.border}`,
                    borderRadius: radiusSm,
                    padding: spacing.sm,
                    cursor: "pointer",
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  <InitialsAvatar name={s.name} size={36} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.name}
                    </div>
                    <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 1 }}>
                      {formatPledge(s)} · {sourceTypeLabel(s.source_type)}
                    </div>
                  </div>
                  <span style={{ ...chipStyle(days === null ? "amber" : "neutral"), flexShrink: 0 }}>
                    {days === null ? "Never touched" : `${days}d ago`}
                  </span>
                </button>
              </div>
            );
          })}
          {supporters.length === 0 && (
            <p style={{ fontSize: 13, color: colors.textMuted, padding: spacing.sm }}>
              No supporters yet. Add the first one by hand.
            </p>
          )}
        </div>
      </div>

      <div className={`split-pane-detail${mobileDetailOpen ? " detail-active" : ""}`}>
        <button
          type="button"
          onClick={() => setMobileDetailOpen(false)}
          className="split-pane-back-button"
          style={{ alignItems: "center", gap: 6, background: "none", border: "none", color: colors.textMuted, fontSize: 13, cursor: "pointer", padding: 0, marginBottom: spacing.sm }}
        >
          <ArrowLeft size={14} /> Back to list
        </button>
        {selected ? (
          <SupporterDetail
            supporter={selected}
            gifts={giftsBySupporter[selected.id] ?? []}
            interactions={interactionsBySupporter[selected.id] ?? []}
            onDeleted={() => {
              setSelectedId(null);
              setMobileDetailOpen(false);
            }}
          />
        ) : (
          <div style={{ border: `1px dashed ${colors.border}`, borderRadius: radiusSm, padding: spacing.xxl, textAlign: "center", color: colors.textFaint, fontSize: 14 }}>
            Select a supporter from the list to see details, or add one.
          </div>
        )}
      </div>
    </div>
  );
}

function AddSupporterForm({ onDone }: { onDone: (id: string | null) => void }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          const result = await createSupporter(formData);
          if ("error" in result) setError(result.error);
          else onDone(result.id);
        });
      }}
      style={{ display: "grid", gap: spacing.sm, marginTop: spacing.md, ...cardStyle }}
    >
      <label style={labelStyle}>
        Name
        <input name="name" required style={fieldStyle} />
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: spacing.sm }}>
        <label style={labelStyle}>
          Email
          <input name="email" type="email" style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          Phone
          <input name="phone" style={fieldStyle} />
        </label>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: spacing.sm }}>
        <label style={labelStyle}>
          How they arrived
          <select name="source_type" defaultValue="other" style={fieldStyle}>
            {SOURCE_TYPES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          Detail (which event, which page, etc.)
          <input name="source_detail" style={fieldStyle} />
        </label>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: spacing.sm }}>
        <label style={labelStyle}>
          Pledged amount
          <input name="pledged_amount" type="number" min="0" step="0.01" style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          Pledge frequency
          <select name="pledged_frequency" defaultValue="" style={fieldStyle}>
            <option value="">No pledge on file</option>
            {PLEDGE_FREQUENCIES.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label style={labelStyle}>
        Notes
        <textarea name="notes" rows={2} style={fieldStyle} />
      </label>
      {error && <p style={{ color: colors.danger, fontSize: 13, margin: 0 }}>{error}</p>}
      <div style={{ display: "flex", gap: spacing.sm }}>
        <button type="submit" disabled={isPending} style={buttonPrimary}>
          {isPending ? "Saving…" : "Add supporter"}
        </button>
        <button type="button" onClick={() => onDone(null)} style={buttonSecondary}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function SupporterDetail({
  supporter,
  gifts,
  interactions,
  onDeleted,
}: {
  supporter: Supporter;
  gifts: SupporterGift[];
  interactions: SupporterInteraction[];
  // Called once deleteSupporter actually succeeds, so the parent can drop
  // the selection -- the detail panel can't keep showing a row that no
  // longer exists.
  onDeleted: () => void;
}) {
  const [giftOpen, setGiftOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, startDeleting] = useTransition();

  // Edit replaces the identity/pledge view in place -- the expand-in-place
  // pattern this page already uses for "Add supporter", "Log a gift" and
  // "Log" (interaction), not the prospect page's ?edit=1 query-param
  // pattern, which belongs to a server component reading searchParams. This
  // page is a client component managing all of its state with useState
  // already, so expand-in-place is the pattern consistent with everything
  // else on it.
  if (editOpen) {
    return (
      <div style={{ display: "grid", gap: spacing.lg }}>
        <EditSupporterForm supporter={supporter} onDone={() => setEditOpen(false)} />
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: spacing.lg }}>
      <div style={sectionStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: spacing.md }}>
          <div style={{ display: "flex", gap: spacing.md, minWidth: 0 }}>
            <InitialsAvatar name={supporter.name} size={44} />
            <div style={{ minWidth: 0 }}>
              <h2 style={{ fontSize: 17, overflowWrap: "break-word" }}>{supporter.name}</h2>
              <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>
                {supporter.email ?? "No email on file"}
                {supporter.phone ? ` · ${supporter.phone}` : ""}
              </div>
              <div style={{ display: "flex", gap: spacing.xs, marginTop: spacing.xs, flexWrap: "wrap" }}>
                <span style={chipStyle("neutral")}>{sourceTypeLabel(supporter.source_type)}</span>
                {supporter.source_detail && <span style={chipStyle("neutral")}>{supporter.source_detail}</span>}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setEditOpen(true)}
            style={{ ...buttonSecondary, display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: "6px 10px", flexShrink: 0 }}
          >
            <Pencil size={13} /> Edit
          </button>
        </div>
      </div>

      <div style={sectionStyle}>
        <h3 style={{ fontSize: 14 }}>Pledge</h3>
        <p style={{ fontSize: 14, margin: 0 }}>
          {formatPledge(supporter)}
          {supporter.pledged_frequency && supporter.pledged_frequency !== "one_time" && (
            <span style={{ color: colors.textMuted }}> ({pledgeFrequencyLabel(supporter.pledged_frequency)})</span>
          )}
        </p>
        {supporter.notes && <p style={{ fontSize: 13, color: colors.textMuted, marginTop: spacing.sm }}>{supporter.notes}</p>}
      </div>

      <div style={sectionStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ fontSize: 14 }}>Gift history ({gifts.length})</h3>
          <button type="button" onClick={() => setGiftOpen((o) => !o)} style={{ ...buttonSecondary, display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: "6px 10px" }}>
            <Plus size={13} /> Log a gift
          </button>
        </div>

        {giftOpen && <LogGiftForm supporterId={supporter.id} onDone={() => setGiftOpen(false)} />}

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
          <p style={{ fontSize: 13, color: colors.textFaint, margin: 0 }}>
            No gifts logged yet. A pledge with no gifts logged is an honest, ordinary state -- not an error.
          </p>
        )}
      </div>

      <div style={sectionStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ fontSize: 14 }}>Interaction history ({interactions.length})</h3>
          <button type="button" onClick={() => setLogOpen((o) => !o)} style={{ ...buttonSecondary, display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: "6px 10px" }}>
            <Plus size={13} /> Log
          </button>
        </div>

        {logOpen && (
          <LogInteractionForm
            onLog={(kind, summary, occurredAt) => logSupporterInteraction(supporter.id, kind, summary, occurredAt)}
            onDone={() => setLogOpen(false)}
          />
        )}

        {interactions.length > 0 ? (
          <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.sm }}>
            {interactions.map((i) => {
              const Icon = ICON_BY_KIND[i.kind];
              return (
                <div key={i.id} style={{ display: "flex", gap: spacing.sm, fontSize: 13 }}>
                  <Icon size={14} color={colors.navy500} style={{ flexShrink: 0, marginTop: 2 }} />
                  <div style={{ minWidth: 0 }}>
                    <div>{i.summary}</div>
                    <div style={{ fontSize: 12, color: colors.textFaint, marginTop: 1 }}>
                      {interactionKindLabel(i.kind)} · {new Date(i.occurred_at + "T00:00:00").toLocaleDateString()}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p style={{ fontSize: 13, color: colors.textFaint, margin: 0 }}>No interactions logged yet.</p>
        )}
      </div>

      {/* STATE item 84: deletion is destructive and irreversible (unlike
          every action above it on this page), so it gets a real "are you
          sure" step -- expand-then-confirm, the same model
          components/ProspectOutcomePanel.tsx uses for retracting a decline.
          Nothing fires on the first click. */}
      <div style={{ ...sectionStyle, borderTop: `1px solid ${colors.border}` }}>
        {!deleteOpen ? (
          <button
            type="button"
            onClick={() => setDeleteOpen(true)}
            style={{ ...buttonDanger, display: "flex", alignItems: "center", gap: 6 }}
          >
            <Trash2 size={13} /> Delete supporter
          </button>
        ) : (
          <div style={{ display: "grid", gap: spacing.sm }}>
            <p style={{ fontSize: 13, color: colors.text, margin: 0 }}>
              Delete &quot;{supporter.name}&quot;? This removes their gift and interaction history too, and
              can&apos;t be undone.
            </p>
            {deleteError && <p style={{ fontSize: 13, color: colors.danger, margin: 0 }}>{deleteError}</p>}
            <div style={{ display: "flex", gap: spacing.sm }}>
              <button
                type="button"
                disabled={isDeleting}
                onClick={() => {
                  setDeleteError(null);
                  startDeleting(async () => {
                    const result = await deleteSupporter(supporter.id);
                    if ("error" in result) setDeleteError(result.error);
                    else onDeleted();
                  });
                }}
                style={buttonDanger}
              >
                {isDeleting ? "Deleting…" : "Delete supporter"}
              </button>
              <button type="button" onClick={() => setDeleteOpen(false)} style={buttonSecondary}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function EditSupporterForm({ supporter, onDone }: { supporter: Supporter; onDone: () => void }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          const result = await updateSupporter(supporter.id, formData);
          if ("error" in result) setError(result.error);
          else onDone();
        });
      }}
      style={{ display: "grid", gap: spacing.sm, ...cardStyle }}
    >
      <label style={labelStyle}>
        Name
        <input name="name" defaultValue={supporter.name} required style={fieldStyle} />
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: spacing.sm }}>
        <label style={labelStyle}>
          Email
          <input name="email" type="email" defaultValue={supporter.email ?? ""} style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          Phone
          <input name="phone" defaultValue={supporter.phone ?? ""} style={fieldStyle} />
        </label>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: spacing.sm }}>
        <label style={labelStyle}>
          How they arrived
          <select name="source_type" defaultValue={supporter.source_type} style={fieldStyle}>
            {SOURCE_TYPES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          Detail (which event, which page, etc.)
          <input name="source_detail" defaultValue={supporter.source_detail ?? ""} style={fieldStyle} />
        </label>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: spacing.sm }}>
        <label style={labelStyle}>
          Pledged amount
          <input name="pledged_amount" type="number" min="0" step="0.01" defaultValue={supporter.pledged_amount ?? ""} style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          Pledge frequency
          <select name="pledged_frequency" defaultValue={supporter.pledged_frequency ?? ""} style={fieldStyle}>
            <option value="">No pledge on file</option>
            {PLEDGE_FREQUENCIES.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label style={labelStyle}>
        Notes
        <textarea name="notes" rows={2} defaultValue={supporter.notes ?? ""} style={fieldStyle} />
      </label>
      {error && <p style={{ color: colors.danger, fontSize: 13, margin: 0 }}>{error}</p>}
      <div style={{ display: "flex", gap: spacing.sm }}>
        <button type="submit" disabled={isPending} style={buttonPrimary}>
          {isPending ? "Saving…" : "Save changes"}
        </button>
        <button type="button" onClick={onDone} style={buttonSecondary}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function LogGiftForm({ supporterId, onDone }: { supporterId: string; onDone: () => void }) {
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
          const result = await logSupporterGift(supporterId, amount, giftDate, note);
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
