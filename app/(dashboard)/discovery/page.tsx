import Link from "next/link";
import { Sparkles, Plus, Upload } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getAutoSearchSettings } from "./auto-search-actions";
import AutoSearchForm from "./auto-search-form";
import OpportunityWorkspace, { type CandidateWithScore } from "./opportunity-workspace";
import { screenProspect, type ScreeningRule } from "@/lib/screening";
import { spacing, colors, type as typeScale, buttonPrimary, buttonSecondary } from "@/lib/ui";
import type { Candidate } from "@/lib/candidates";

export default async function DiscoveryPage() {
  const supabase = createClient();
  const [{ data: candidates, error }, autoSearchSettings, { data: rulesData }] = await Promise.all([
    // Accepted candidates are already prospects -- this workspace only
    // ever needs the three still-in-Discovery states (pending/saved/
    // dismissed), not a full-table fetch.
    supabase
      .from("candidates")
      .select("*")
      .neq("status", "accepted")
      // A candidate the extractor could not attribute to any search result
      // it actually visited is the fabrication signal. Kept in the table for
      // audit, never offered as something to accept.
      .neq("capture_status", "source_missing")
      .order("created_at", { ascending: false })
      .returns<Candidate[]>(),
    getAutoSearchSettings(),
    supabase.from("screening_rules").select("*").eq("active", true),
  ]);

  const rules = (rulesData ?? []) as ScreeningRule[];
  // Recomputed at render time rather than reading a stored score --
  // screening rules can change after a candidate was found, and this
  // way the fit shown always reflects the rules active right now
  // (same reasoning as health_status being derived, not stored).
  const candidatesWithScore: CandidateWithScore[] = (candidates ?? []).map((c) => ({
    ...c,
    fitPercentage: screenProspect(c, rules).breakdown.percentage,
  }));

  return (
    <div>
      <div
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.xl, flexWrap: "wrap", gap: spacing.md }}
      >
        <div>
          <h1 style={{ fontSize: typeScale.pageTitle }}>Donor Finder</h1>
          <p style={{ color: colors.textMuted, fontSize: 14, marginTop: spacing.xs }}>
            Candidates from AI search, CSV import, or manual entry. Nothing here reaches the pipeline
            until a human accepts it.
          </p>
        </div>
        <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap" }}>
          <Link href="/discovery/search" style={{ ...buttonPrimary, display: "flex", alignItems: "center", gap: 8, textDecoration: "none" }}>
            <Sparkles size={15} /> AI Search
          </Link>
          <Link href="/discovery/new" style={{ ...buttonSecondary, display: "flex", alignItems: "center", gap: 8 }}>
            <Plus size={15} /> Add Candidate
          </Link>
          <Link href="/discovery/import" style={{ ...buttonSecondary, display: "flex", alignItems: "center", gap: 8 }}>
            <Upload size={15} /> Import CSV
          </Link>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-start", alignItems: "center", gap: spacing.sm }}>
        <AutoSearchForm settings={autoSearchSettings} />
        {autoSearchSettings?.enabled && (
          <span style={{ fontSize: 12, color: colors.textFaint }}>Runs nightly at 10:00 UTC</span>
        )}
      </div>

      {error && <p style={{ color: "crimson" }}>Error loading candidates: {error.message}</p>}

      <OpportunityWorkspace candidates={candidatesWithScore} />
    </div>
  );
}
