import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import CandidateCard from "./candidate-card";
import { getAutoSearchSettings } from "./auto-search-actions";
import AutoSearchForm from "./auto-search-form";
import { spacing, colors, buttonPrimary, buttonSecondary } from "@/lib/ui";
import type { Candidate } from "@/lib/candidates";

export default async function DiscoveryPage() {
  const supabase = createClient();
  const [{ data: candidates, error }, autoSearchSettings] = await Promise.all([
    supabase
      .from("candidates")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .returns<Candidate[]>(),
    getAutoSearchSettings(),
  ]);

  return (
    <div>
      <div
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.xl }}
      >
        <div>
          <h1>Donor Finder</h1>
          <p style={{ color: colors.textMuted, fontSize: 14 }}>
            Candidates from AI search, CSV import, or manual entry. Nothing here reaches the pipeline
            until a human accepts it.
          </p>
        </div>
        <div style={{ display: "flex", gap: spacing.sm }}>
          <Link href="/discovery/search" style={buttonPrimary}>
            AI Search
          </Link>
          <Link href="/discovery/new" style={buttonSecondary}>
            + Add Candidate
          </Link>
          <Link href="/discovery/import" style={buttonSecondary}>
            Import CSV
          </Link>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: spacing.xl }}>
        <AutoSearchForm settings={autoSearchSettings} />
      </div>

      {error && <p style={{ color: "crimson" }}>Error loading candidates: {error.message}</p>}

      <div style={{ display: "grid", gap: spacing.sm }}>
        {candidates?.map((c) => (
          <CandidateCard key={c.id} candidate={c} />
        ))}
        {candidates?.length === 0 && <p style={{ color: colors.textFaint }}>No pending candidates.</p>}
      </div>
    </div>
  );
}
