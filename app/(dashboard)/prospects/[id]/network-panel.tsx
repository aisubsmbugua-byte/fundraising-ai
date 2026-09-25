"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { findNetworkPaths, decideNetworkPath } from "./network-actions";
import type { NetworkPanelData, NetworkPanelItem } from "@/lib/network-panel";
import { spacing, colors, buttonPrimary, buttonSecondary, sectionStyle, cardStyle, chipStyle } from "@/lib/ui";

const STRENGTH_LABEL: Record<string, string> = { close: "Close", warm: "Warm", acquaintance: "Acquaintance" };

function PathCard({ item, prospectId }: { item: NetworkPanelItem; prospectId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const { suggestion, person, anchor } = item;
  const decide = (decision: "accepted" | "dismissed") => {
    setError(null);
    startTransition(async () => {
      const result = await decideNetworkPath(suggestion.id, prospectId, decision);
      if ("error" in result) setError(result.error);
    });
  };

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: spacing.md, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{person?.person_name ?? "A person you removed"}</div>
          {person && (
            <div style={{ fontSize: 12.5, color: colors.textMuted }}>
              {[person.affiliation, `${STRENGTH_LABEL[person.strength] ?? person.strength} connection (your words)`].filter(Boolean).join(" · ")}
            </div>
          )}
        </div>
        {suggestion.status !== "suggested" && (
          <span style={chipStyle(suggestion.status === "accepted" ? "teal" : "neutral")}>
            {suggestion.status === "accepted" ? "Accepted" : "Dismissed"}
          </span>
        )}
      </div>
      <p style={{ fontSize: 13, margin: `${spacing.sm}px 0 0` }}>
        <span style={{ color: colors.textMuted }}>Connects through: </span>
        {anchor ? (
          <>
            <strong>{anchor.text}</strong> <span style={{ color: colors.textMuted }}>({anchor.kind}, from approved research)</span>
          </>
        ) : (
          <span style={{ color: colors.textMuted }}>a research fact that is no longer in this funder&apos;s approved research</span>
        )}
      </p>
      <p style={{ fontSize: 13, margin: `${spacing.xs}px 0 0` }}>{suggestion.reasoning}</p>
      {suggestion.model_confidence && (
        <p style={{ fontSize: 12.5, color: colors.textMuted, margin: `${spacing.xs}px 0 0` }}>
          AI&apos;s estimate: {suggestion.model_confidence} confidence — a guess, not a fact.
        </p>
      )}
      {error && <p style={{ color: colors.danger, fontSize: 13, margin: `${spacing.sm}px 0 0` }}>{error}</p>}
      {suggestion.status === "suggested" && (
        <div style={{ display: "flex", gap: spacing.sm, marginTop: spacing.md }}>
          <button type="button" style={buttonPrimary} disabled={isPending} onClick={() => decide("accepted")}>
            Accept
          </button>
          <button type="button" style={buttonSecondary} disabled={isPending} onClick={() => decide("dismissed")}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

export default function NetworkPanel({ prospectId, data }: { prospectId: string; data: NetworkPanelData }) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const find = () => {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      const result = await findNetworkPaths(prospectId);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setMessage(
        result.stored > 0
          ? `Found ${result.stored} possible path${result.stored === 1 ? "" : "s"}. Review them below.`
          : result.alreadyKnown > 0
            ? "No new paths — everything the AI found is already listed below."
            : "No paths found. Nothing you have recorded clearly connects to this funder's people, and that is a fair answer."
      );
    });
  };

  // What is missing, said plainly, in the order a person would fix it.
  const missingConnections = data.connectionCount === 0;
  const missingAnchors = data.anchorCount === 0;
  const canFind = !data.unavailable && !missingConnections && !missingAnchors;

  return (
    <div style={{ ...sectionStyle, marginTop: spacing.lg }}>
      <h3 style={{ fontSize: 14, margin: 0 }}>Who can open this door</h3>
      <p style={{ fontSize: 13, color: colors.textMuted, margin: 0 }}>
        People you know who might connect you to this funder. The AI only proposes; you decide, and nobody on your list is
        ever contacted by this system.
      </p>

      {data.unavailable ? (
        <p style={{ fontSize: 13, color: colors.textMuted, margin: 0 }}>The network could not be loaded just now.</p>
      ) : (
        <>
          {missingConnections && (
            <p style={{ fontSize: 13, color: colors.textMuted, margin: 0 }}>
              You have not recorded anyone you know yet.{" "}
              <Link href="/network" style={{ color: colors.text }}>
                Record people on the Network page
              </Link>
              .
            </p>
          )}
          {missingAnchors && (
            <p style={{ fontSize: 13, color: colors.textMuted, margin: 0 }}>
              Nothing approved about this funder names a person or an organization yet.{" "}
              <Link href={`/prospects/${prospectId}?tab=research`} style={{ color: colors.text }}>
                Approve research on the Research tab
              </Link>{" "}
              so the funder&apos;s people are known.
            </p>
          )}
          {canFind && (
            <div>
              <button type="button" style={buttonPrimary} disabled={isPending} onClick={find}>
                {isPending ? "Looking for paths…" : "Find paths"}
              </button>
            </div>
          )}
          {error && <p style={{ color: colors.danger, fontSize: 13, margin: 0 }}>{error}</p>}
          {message && <p style={{ fontSize: 13, margin: 0 }}>{message}</p>}
          {data.items.map((item) => (
            <PathCard key={item.suggestion.id} item={item} prospectId={prospectId} />
          ))}
        </>
      )}
    </div>
  );
}
