"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import FitScoreCircle from "@/components/FitScoreCircle";
import { CHANNELS, channelLabel } from "@/lib/prospects";
import { spacing, colors, fieldStyle, radiusSm } from "@/lib/ui";
import type { Candidate } from "@/lib/candidates";
import OpportunityDetail from "./opportunity-detail";

export type CandidateWithScore = Candidate & { fitPercentage: number | null };

const DAY_MS = 86400000;

// "Added 2 days ago" instead of a raw timestamp -- this is when the
// candidate was actually found (AI search, CSV import, or manual
// entry), not a fabricated "verified" claim.
function formatRelativeDate(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS);
  if (days <= 0) return "Added today";
  if (days === 1) return "Added yesterday";
  return `Added ${days} days ago`;
}

type Tab = "pending" | "saved" | "dismissed";
const TABS: { value: Tab; label: string }[] = [
  { value: "pending", label: "To review" },
  { value: "saved", label: "Saved" },
  { value: "dismissed", label: "Dismissed" },
];

export default function OpportunityWorkspace({ candidates }: { candidates: CandidateWithScore[] }) {
  const [items, setItems] = useState(candidates);
  const [tab, setTab] = useState<Tab>("pending");
  const [search, setSearch] = useState("");
  const [channelFilter, setChannelFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const counts = useMemo(
    () => ({
      pending: items.filter((c) => c.status === "pending").length,
      saved: items.filter((c) => c.status === "saved").length,
      dismissed: items.filter((c) => c.status === "dismissed").length,
    }),
    [items]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .filter((c) => c.status === tab)
      .filter((c) => !channelFilter || c.channel === channelFilter)
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.organization?.toLowerCase().includes(q))
      .sort((a, b) => (b.fitPercentage ?? -1) - (a.fitPercentage ?? -1));
  }, [items, tab, channelFilter, search]);

  const selected = filtered.find((c) => c.id === selectedId) ?? filtered[0] ?? null;

  function handleStatusChange(id: string, newStatus: "dismissed" | "saved" | "pending" | "accepted") {
    setItems((prev) => prev.map((c) => (c.id === id ? { ...c, status: newStatus } : c)));
    setSelectedId(null); // fall through to whatever's now first in the filtered list
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 42%) 1fr", gap: spacing.lg, marginTop: spacing.lg }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: spacing.sm }}>
          <div style={{ position: "relative", flex: 1 }}>
            <Search size={15} color={colors.textFaint} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)" }} />
            <input
              type="text"
              placeholder="Search opportunities..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ ...fieldStyle, marginTop: 0, paddingLeft: 32 }}
            />
          </div>
          <select
            value={channelFilter}
            onChange={(e) => setChannelFilter(e.target.value)}
            style={{ ...fieldStyle, marginTop: 0, width: 160 }}
          >
            <option value="">All channels</option>
            {CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", gap: spacing.md, marginTop: spacing.md, borderBottom: `1px solid ${colors.border}` }}>
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => {
                setTab(t.value);
                setSelectedId(null);
              }}
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
              {t.label} {counts[t.value]}
            </button>
          ))}
        </div>

        <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.md, maxHeight: "70vh", overflowY: "auto" }}>
          {filtered.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setSelectedId(c.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: spacing.sm,
                textAlign: "left",
                background: selected?.id === c.id ? colors.teal100 : colors.surface,
                border: `1px solid ${selected?.id === c.id ? colors.teal700 : colors.border}`,
                borderRadius: radiusSm,
                padding: spacing.sm,
                cursor: "pointer",
              }}
            >
              {c.fitPercentage != null && <FitScoreCircle percentage={c.fitPercentage} size={40} />}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {c.name}
                </div>
                <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 1 }}>
                  {channelLabel(c.channel)}
                  {c.typical_grant_size ? ` · ${c.typical_grant_size}` : ""}
                </div>
                <div style={{ fontSize: 11, color: colors.textFaint, marginTop: 1 }}>
                  {formatRelativeDate(c.created_at)}
                </div>
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <p style={{ fontSize: 13, color: colors.textMuted, padding: spacing.sm }}>
              {tab === "pending" ? "No pending candidates." : `Nothing ${tab} yet.`}
            </p>
          )}
        </div>
      </div>

      <div>
        {selected ? (
          <OpportunityDetail candidate={selected} onStatusChange={handleStatusChange} />
        ) : (
          <div
            style={{
              border: `1px dashed ${colors.border}`,
              borderRadius: radiusSm,
              padding: spacing.xxl,
              textAlign: "center",
              color: colors.textFaint,
              fontSize: 14,
            }}
          >
            Select an opportunity from the list to see details.
          </div>
        )}
      </div>
    </div>
  );
}
