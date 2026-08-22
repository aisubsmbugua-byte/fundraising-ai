"use client";

import { useMemo, useState, useTransition } from "react";
import { Plus, Search, ShieldCheck, ShieldOff, Pencil, Trash2 } from "lucide-react";
import { createEvidenceItem, updateEvidenceItem, verifyEvidenceItem, deleteEvidenceItem } from "./actions";
import { EVIDENCE_TYPES, evidenceTypeLabel, type EvidenceItem, type EvidenceType } from "@/lib/evidence";
import { spacing, colors, radiusSm, fieldStyle, labelStyle, cardStyle, chipStyle, buttonPrimary, buttonSecondary } from "@/lib/ui";
import SubmitButton from "@/components/SubmitButton";

type OrgDocument = { id: string; file_name: string };

const TABS: { value: EvidenceType | "all"; label: string }[] = [
  { value: "all", label: "All evidence" },
  { value: "outcome", label: "Outcomes" },
  { value: "story", label: "Stories" },
  { value: "testimonial", label: "Testimonials" },
  { value: "document", label: "Documents" },
];

export default function EvidenceWorkspace({
  items,
  documents,
  usageCount,
}: {
  items: EvidenceItem[];
  documents: OrgDocument[];
  usageCount: Record<string, number>;
}) {
  const [tab, setTab] = useState<EvidenceType | "all">("all");
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<EvidenceItem | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .filter((e) => tab === "all" || e.type === tab)
      .filter((e) => !q || e.title.toLowerCase().includes(q) || e.description.toLowerCase().includes(q));
  }, [items, tab, search]);

  function openNew() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(item: EvidenceItem) {
    setEditing(item);
    setFormOpen(true);
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: spacing.xl, flexWrap: "wrap", gap: spacing.md }}>
        <div style={{ display: "flex", gap: spacing.lg, borderBottom: `1px solid ${colors.border}`, flex: 1 }}>
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setTab(t.value)}
              style={{
                background: "none",
                border: "none",
                borderBottom: `2px solid ${tab === t.value ? colors.primary : "transparent"}`,
                color: tab === t.value ? colors.text : colors.textMuted,
                fontWeight: tab === t.value ? 600 : 500,
                fontSize: 14,
                padding: "8px 2px",
                cursor: "pointer",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={openNew}
          style={{ ...buttonPrimary, display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}
        >
          <Plus size={15} /> Add evidence
        </button>
      </div>

      <div style={{ position: "relative", marginTop: spacing.md, maxWidth: 320 }}>
        <Search size={15} color={colors.textFaint} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)" }} />
        <input
          type="text"
          placeholder="Search evidence..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ ...fieldStyle, marginTop: 0, paddingLeft: 32 }}
        />
      </div>

      <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.lg }}>
        {filtered.map((item) => (
          <EvidenceRow key={item.id} item={item} usedIn={usageCount[item.id] ?? 0} onEdit={() => openEdit(item)} />
        ))}
        {filtered.length === 0 && (
          <p style={{ fontSize: 13, color: colors.textMuted }}>
            {items.length === 0 ? "No evidence yet — add your first item." : "No evidence matches your search."}
          </p>
        )}
      </div>

      {formOpen && (
        <EvidenceForm
          item={editing}
          documents={documents}
          onClose={() => setFormOpen(false)}
        />
      )}
    </div>
  );
}

function EvidenceRow({ item, usedIn, onEdit }: { item: EvidenceItem; usedIn: number; onEdit: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [isPending, startTransition] = useTransition();

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: spacing.md }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 14 }}>{item.title}</strong>
            <span style={chipStyle("neutral")}>{evidenceTypeLabel(item.type)}</span>
            {item.verified_at ? (
              <span style={chipStyle(item.permission === "approved" ? "teal" : "amber")}>
                {item.permission === "approved" ? "Approved for AI" : "Restricted"}
              </span>
            ) : (
              <span style={chipStyle("amber")}>Needs review</span>
            )}
          </div>
          <p style={{ fontSize: 13, color: colors.text, marginTop: spacing.xs, marginBottom: 0 }}>{item.description}</p>
          <div style={{ fontSize: 12, color: colors.textMuted, marginTop: spacing.xs }}>
            {[item.program, item.geography].filter(Boolean).join(" · ") || "No program/geography set"}
            {item.verified_at && ` · Verified ${new Date(item.verified_at).toLocaleDateString()}`}
            {usedIn > 0 && ` · Used in ${usedIn} ${usedIn === 1 ? "strategy" : "strategies"}`}
          </div>
        </div>
        <div style={{ display: "flex", gap: spacing.xs, flexShrink: 0 }}>
          <button type="button" onClick={onEdit} title="Edit" style={{ ...buttonSecondary, padding: "6px 8px" }}>
            <Pencil size={14} />
          </button>
          <button
            type="button"
            title="Delete"
            disabled={isPending}
            onClick={() => {
              if (!confirm(`Delete "${item.title}"? This can't be undone.`)) return;
              startTransition(() => deleteEvidenceItem(item.id));
            }}
            style={{ ...buttonSecondary, padding: "6px 8px", color: colors.red600 }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {!item.verified_at && (
        <div style={{ marginTop: spacing.sm, display: "flex", gap: spacing.sm, alignItems: "center" }}>
          {!confirming ? (
            <button
              type="button"
              disabled={isPending}
              onClick={() => setConfirming(true)}
              style={{ ...buttonSecondary, display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: "6px 12px" }}
            >
              <ShieldCheck size={13} /> Verify
            </button>
          ) : (
            <>
              <span style={{ fontSize: 12, color: colors.textMuted }}>Safe to cite to a funder?</span>
              <button
                type="button"
                disabled={isPending}
                onClick={() => startTransition(() => verifyEvidenceItem(item.id, "approved"))}
                style={{ ...buttonPrimary, display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: "6px 12px" }}
              >
                <ShieldCheck size={13} /> Verify &amp; approve for AI
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={() => startTransition(() => verifyEvidenceItem(item.id, "restricted"))}
                style={{ ...buttonSecondary, display: "flex", alignItems: "center", gap: 6, fontSize: 13, padding: "6px 12px" }}
              >
                <ShieldOff size={13} /> Verify &amp; restrict
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function EvidenceForm({
  item,
  documents,
  onClose,
}: {
  item: EvidenceItem | null;
  documents: OrgDocument[];
  onClose: () => void;
}) {
  const action = item ? updateEvidenceItem.bind(null, item.id) : createEvidenceItem;

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(15, 23, 42, 0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{ background: "#fff", borderRadius: 8, padding: 24, maxWidth: 480, width: "90%", maxHeight: "85vh", overflowY: "auto", boxShadow: "0 10px 40px rgba(0,0,0,0.2)" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontSize: 18 }}>{item ? "Edit evidence" : "Add evidence"}</h2>
          <button type="button" onClick={onClose} aria-label="Close" style={{ border: "none", background: "none", cursor: "pointer", fontSize: 20, color: colors.textMuted }}>
            ×
          </button>
        </div>

        <form
          action={async (formData) => {
            await action(formData);
            onClose();
          }}
          style={{ display: "grid", gap: spacing.md, marginTop: spacing.md }}
        >
          <label style={labelStyle}>
            Title *
            <input name="title" defaultValue={item?.title ?? ""} required style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Type *
            <select name="type" defaultValue={item?.type ?? "outcome"} required style={fieldStyle}>
              {EVIDENCE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Description *
            <textarea name="description" rows={4} defaultValue={item?.description ?? ""} required style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Program
            <input name="program" defaultValue={item?.program ?? ""} style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Geography
            <input name="geography" defaultValue={item?.geography ?? ""} style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Linked document (optional)
            <select name="source_document_id" defaultValue={item?.source_document_id ?? ""} style={fieldStyle}>
              <option value="">None</option>
              {documents.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.file_name}
                </option>
              ))}
            </select>
          </label>

          {item && (
            <p style={{ fontSize: 12, color: colors.textFaint, margin: 0 }}>
              Editing does not change verification status — re-verify from the list if the change
              affects whether it's safe to cite.
            </p>
          )}

          <div style={{ display: "flex", gap: spacing.sm }}>
            <SubmitButton>{item ? "Save changes" : "Add evidence"}</SubmitButton>
            <button type="button" onClick={onClose} style={buttonSecondary}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
