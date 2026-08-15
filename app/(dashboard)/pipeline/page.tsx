import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { STAGES, channelLabel, type Prospect } from "@/lib/prospects";
import type { ScreeningResult } from "@/lib/screening";
import MoveStageControl from "./move-stage-control";
import TierBadge from "@/components/TierBadge";

export default async function PipelinePage() {
  const supabase = createClient();
  const { data: prospects, error } = await supabase
    .from("prospects")
    .select("*")
    .order("updated_at", { ascending: false });

  if (error) {
    return <p style={{ color: "crimson" }}>Error loading pipeline: {error.message}</p>;
  }

  const { data: screenings } = await supabase
    .from("screening_results")
    .select("*")
    .order("created_at", { ascending: false })
    .returns<ScreeningResult[]>();

  const latestTierByProspect = new Map<string, number>();
  for (const s of screenings ?? []) {
    if (!latestTierByProspect.has(s.prospect_id)) {
      latestTierByProspect.set(s.prospect_id, s.tier);
    }
  }

  const byStage = new Map<string, Prospect[]>();
  for (const s of STAGES) byStage.set(s.value, []);
  for (const p of (prospects as Prospect[]) ?? []) {
    byStage.get(p.stage)?.push(p);
  }

  return (
    <div>
      <h1>Pipeline</h1>
      <div style={{ display: "flex", gap: 12, marginTop: 16, overflowX: "auto", paddingBottom: 16 }}>
        {STAGES.map((s) => (
          <div
            key={s.value}
            style={{
              minWidth: 220,
              flexShrink: 0,
              background: "#f8fafc",
              borderRadius: 8,
              padding: 12,
            }}
          >
            <h3 style={{ fontSize: 14, marginBottom: 8 }}>
              {s.label} ({byStage.get(s.value)?.length ?? 0})
            </h3>
            <div style={{ display: "grid", gap: 8 }}>
              {byStage.get(s.value)?.map((p) => (
                <div
                  key={p.id}
                  style={{
                    background: "#fff",
                    border: "1px solid #e2e8f0",
                    borderRadius: 6,
                    padding: 10,
                  }}
                >
                  <Link href={`/prospects/${p.id}`} style={{ fontWeight: 600, fontSize: 13 }}>
                    {p.name}
                  </Link>
                  <div style={{ fontSize: 11, color: "#64748b" }}>{channelLabel(p.channel)}</div>
                  {latestTierByProspect.has(p.id) && (
                    <div style={{ marginTop: 4 }}>
                      <TierBadge tier={latestTierByProspect.get(p.id)!} />
                    </div>
                  )}
                  <MoveStageControl prospectId={p.id} prospectName={p.name} currentStage={p.stage} />
                </div>
              ))}
              {byStage.get(s.value)?.length === 0 && (
                <p style={{ fontSize: 12, color: "#94a3b8" }}>No prospects</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
