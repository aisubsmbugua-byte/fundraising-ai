import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { channelLabel } from "@/lib/prospects";
import TierBadge from "@/components/TierBadge";
import CandidateActions from "./candidate-actions";
import { spacing, colors, buttonPrimary, buttonSecondary, cardStyle } from "@/lib/ui";
import type { Candidate } from "@/lib/candidates";

export default async function DiscoveryPage() {
  const supabase = createClient();
  const { data: candidates, error } = await supabase
    .from("candidates")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .returns<Candidate[]>();

  return (
    <div>
      <div
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.xl }}
      >
        <div>
          <h1>Discovery</h1>
          <p style={{ color: colors.textMuted, fontSize: 14 }}>
            Candidates from AI search, CSV import, or manual entry. Nothing here reaches the pipeline
            until a human accepts it.
          </p>
        </div>
        <div style={{ display: "flex", gap: spacing.sm }}>
          <Link href="/discovery/import" style={buttonSecondary}>
            Import CSV
          </Link>
          <Link href="/discovery/new" style={buttonSecondary}>
            + Add Candidate
          </Link>
          <Link href="/discovery/search" style={buttonPrimary}>
            AI Search
          </Link>
        </div>
      </div>

      {error && <p style={{ color: "crimson" }}>Error loading candidates: {error.message}</p>}

      <div style={{ display: "grid", gap: spacing.sm }}>
        {candidates?.map((c) => (
          <div
            key={c.id}
            style={{ ...cardStyle, display: "flex", justifyContent: "space-between", alignItems: "center" }}
          >
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: spacing.sm }}>
                <strong>{c.name}</strong>
                {c.suggested_tier && <TierBadge tier={c.suggested_tier} />}
              </div>
              <div style={{ fontSize: 13, color: colors.textMuted }}>
                {channelLabel(c.channel)}
                {c.organization ? ` · ${c.organization}` : ""} · via {c.source ?? "unknown"}
              </div>
              {typeof c.raw?.rationale === "string" && c.raw.rationale && (
                <p style={{ fontSize: 13, color: colors.textMuted, marginTop: spacing.xs, maxWidth: 560 }}>
                  {c.raw.rationale}
                </p>
              )}
            </div>
            <CandidateActions id={c.id} name={c.name} />
          </div>
        ))}
        {candidates?.length === 0 && <p style={{ color: colors.textFaint }}>No pending candidates.</p>}
      </div>
    </div>
  );
}
