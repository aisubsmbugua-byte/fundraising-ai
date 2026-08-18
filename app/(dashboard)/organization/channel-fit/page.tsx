import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { runChannelMatch } from "./actions";
import ReviewPanel from "./review-panel";
import SubmitButton from "@/components/SubmitButton";
import { spacing, colors, cardStyle } from "@/lib/ui";
import type { ChannelMatchRun } from "@/lib/channel-match";

export default async function ChannelFitPage() {
  const supabase = createClient();
  const { data: runs, error } = await supabase
    .from("channel_match_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .returns<ChannelMatchRun[]>();

  const latest = runs?.[0] ?? null;
  const history = runs?.slice(1) ?? [];

  return (
    <div style={{ maxWidth: 640 }}>
      <Link href="/organization" style={{ fontSize: 14, color: colors.textMuted, textDecoration: "none" }}>
        ← Back to Organization Profile
      </Link>
      <h1>Channel Fit Analysis</h1>
      <p style={{ color: colors.textMuted, fontSize: 14 }}>
        AI proposes which funder channels are a plausible fit based on your Organization Profile.
        Review each recommendation and confirm which channels to pursue — this never happens
        automatically.
      </p>

      <form action={runChannelMatch} style={{ marginTop: spacing.lg }}>
        <SubmitButton>{latest ? "Run New Analysis" : "Run Analysis"}</SubmitButton>
      </form>

      {error && <p style={{ color: "crimson", marginTop: spacing.md }}>Error: {error.message}</p>}

      {latest ? (
        <div style={{ marginTop: spacing.xl }}>
          <ReviewPanel
            runId={latest.id}
            evaluations={latest.evaluations}
            approvedChannels={latest.approved_channels}
          />
        </div>
      ) : (
        <p style={{ color: colors.textFaint, marginTop: spacing.xl }}>
          No analysis yet. Make sure your Organization Profile is filled in, then run one.
        </p>
      )}

      {history.length > 0 && (
        <div style={{ marginTop: spacing.xxl }}>
          <h2 style={{ fontSize: 16 }}>History</h2>
          <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.sm }}>
            {history.map((run) => (
              <div key={run.id} style={{ ...cardStyle, fontSize: 13 }}>
                {new Date(run.created_at).toLocaleString()} —{" "}
                {run.approved_channels
                  ? `${run.approved_channels.length} channel${run.approved_channels.length === 1 ? "" : "s"} confirmed`
                  : "not reviewed"}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
