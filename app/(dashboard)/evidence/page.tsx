import { FileText, ShieldCheck, UserRound, BarChart3 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import type { EvidenceItem } from "@/lib/evidence";
import { spacing, colors, type as typeScale, radiusSm, cardStyle } from "@/lib/ui";
import EvidenceWorkspace from "./evidence-workspace";

type DeepDiveRunEvidence = { evidence_item_ids: string[] | null; approved_strategy: unknown | null };
type OrgDocument = { id: string; file_name: string };

export default async function EvidencePage() {
  const supabase = createClient();
  const [{ data: items, error }, { data: documents }, { data: runs }] = await Promise.all([
    supabase.from("evidence_items").select("*").order("created_at", { ascending: false }).returns<EvidenceItem[]>(),
    supabase.from("org_documents").select("id, file_name").order("uploaded_at", { ascending: false }).returns<OrgDocument[]>(),
    supabase.from("deep_dive_runs").select("evidence_item_ids, approved_strategy").returns<DeepDiveRunEvidence[]>(),
  ]);

  if (error) {
    return <p style={{ color: colors.danger }}>Error loading evidence: {error.message}</p>;
  }

  const all = items ?? [];
  const usageCount = new Map<string, number>();
  for (const run of runs ?? []) {
    if (!run.approved_strategy || !run.evidence_item_ids) continue;
    for (const id of run.evidence_item_ids) usageCount.set(id, (usageCount.get(id) ?? 0) + 1);
  }

  const verifiedCount = all.filter((e) => e.verified_at).length;
  const needsReviewCount = all.filter((e) => !e.verified_at).length;
  const usedCount = all.filter((e) => (usageCount.get(e.id) ?? 0) > 0).length;

  return (
    <div>
      <h1 style={{ fontSize: typeScale.pageTitle }}>Evidence Library</h1>
      <p style={{ color: colors.textMuted, fontSize: 14, marginTop: spacing.xs, maxWidth: 640 }}>
        Verified outcomes, stories, testimonials, and documents your team can safely reuse. AI drafts
        only ever use evidence that's been verified and marked approved here — nothing else.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: spacing.md, marginTop: spacing.lg }}>
        <StatTile icon={FileText} value={String(all.length)} label="Evidence items" />
        <StatTile icon={ShieldCheck} value={String(verifiedCount)} label="Verified" />
        <StatTile icon={UserRound} value={String(needsReviewCount)} label="Needs review" tone={needsReviewCount > 0 ? "amber" : undefined} />
        <StatTile icon={BarChart3} value={String(usedCount)} label="Used in strategies" />
      </div>

      <EvidenceWorkspace items={all} documents={documents ?? []} usageCount={Object.fromEntries(usageCount)} />
    </div>
  );
}

function StatTile({
  icon: Icon,
  value,
  label,
  tone,
}: {
  icon: typeof FileText;
  value: string;
  label: string;
  tone?: "amber";
}) {
  return (
    <div style={cardStyle}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          borderRadius: radiusSm,
          background: tone === "amber" ? colors.amber100 : colors.teal100,
          color: tone === "amber" ? colors.amber700 : colors.teal700,
        }}
      >
        <Icon size={15} />
      </span>
      <div style={{ fontSize: 26, fontWeight: 700, marginTop: spacing.sm }}>{value}</div>
      <div style={{ fontSize: 13, color: colors.textMuted }}>{label}</div>
    </div>
  );
}
