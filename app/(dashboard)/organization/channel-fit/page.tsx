import Link from "next/link";
import { Sparkles, Landmark, Repeat, Briefcase, Globe, Church, Wallet, User, type LucideIcon } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { runChannelMatch } from "./actions";
import ReviewPanel from "./review-panel";
import SubmitButton from "@/components/SubmitButton";
import FormLoadingStatus from "@/components/FormLoadingStatus";
import { CHANNELS, type Channel } from "@/lib/prospects";
import { spacing, colors, type as typeScale, radiusSm, sectionStyle, cardStyle } from "@/lib/ui";

const ANALYSIS_MESSAGES = [
  "Reading your Organization Profile...",
  "Weighing fit against each of the seven channels...",
  "Drafting rationale for each recommendation...",
  "Almost done — finalizing the analysis...",
];
import type { ChannelMatchRun } from "@/lib/channel-match";

const CHANNEL_ICONS: Record<Channel, LucideIcon> = {
  foundation: Landmark,
  regranting: Repeat,
  christian_business: Briefcase,
  denomination: Globe,
  church: Church,
  daf: Wallet,
  major_donor: User,
};

export default async function ChannelFitPage() {
  const supabase = createClient();
  const [{ data: runs, error }, { data: candidates }, { data: prospects }] = await Promise.all([
    supabase.from("channel_match_runs").select("*").order("created_at", { ascending: false }).returns<ChannelMatchRun[]>(),
    supabase.from("candidates").select("channel"),
    supabase.from("prospects").select("channel"),
  ]);

  const latest = runs?.[0] ?? null;
  const history = runs?.slice(1) ?? [];

  // Real counts of what's already in the funnel per channel, so
  // "explore opportunities" isn't just a bare link -- it says how
  // much is actually there.
  const countByChannel = new Map<string, number>();
  for (const c of CHANNELS) countByChannel.set(c.value, 0);
  for (const row of [...(candidates ?? []), ...(prospects ?? [])]) {
    countByChannel.set(row.channel, (countByChannel.get(row.channel) ?? 0) + 1);
  }

  const recommendedChannels = (latest?.evaluations ?? [])
    .filter((e) => e.recommended)
    .sort((a, b) => (b.confidence === "high" ? 1 : 0) - (a.confidence === "high" ? 1 : 0));

  return (
    <div style={{ maxWidth: 760 }}>
      <Link href="/organization" style={{ fontSize: 13, color: colors.textMuted, textDecoration: "none" }}>
        ← Organization Profile
      </Link>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: spacing.md, marginTop: spacing.xs }}>
        <div>
          <h1 style={{ fontSize: typeScale.pageTitle }}>Channel Fit Analysis</h1>
          <p style={{ color: colors.textMuted, fontSize: 14, marginTop: spacing.xs, maxWidth: 520 }}>
            AI proposes which funder channels are a plausible fit based on your Organization Profile.
            Review each recommendation and confirm which channels to pursue — this never happens
            automatically.
          </p>
        </div>
        <form action={runChannelMatch}>
          <SubmitButton>{latest ? "Run New Analysis" : "Run Analysis"}</SubmitButton>
          <FormLoadingStatus messages={ANALYSIS_MESSAGES} />
        </form>
      </div>

      {error && <p style={{ color: colors.danger, marginTop: spacing.md }}>Error: {error.message}</p>}

      {latest ? (
        <div style={{ marginTop: spacing.xl }}>
          {recommendedChannels.length > 0 && (
            <div style={{ ...sectionStyle, display: "flex", alignItems: "flex-start", gap: spacing.md, marginBottom: spacing.lg }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 36,
                  height: 36,
                  borderRadius: radiusSm,
                  background: colors.teal100,
                  color: colors.teal700,
                  flexShrink: 0,
                }}
              >
                <Sparkles size={18} />
              </span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 15 }}>
                  Prioritize {recommendedChannels
                    .slice(0, 3)
                    .map((e) => CHANNELS.find((c) => c.value === e.channel)?.label ?? e.channel)
                    .join(", ")}
                </div>
                <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>
                  {recommendedChannels.length} of {CHANNELS.length} channels came back recommended in the
                  latest analysis, run {new Date(latest.created_at).toLocaleDateString()}.
                </div>
              </div>
            </div>
          )}

          <ReviewPanel
            runId={latest.id}
            evaluations={latest.evaluations}
            approvedChannels={latest.approved_channels}
            icons={CHANNEL_ICONS}
            countByChannel={countByChannel}
          />
        </div>
      ) : (
        <p style={{ color: colors.textFaint, marginTop: spacing.xl }}>
          No analysis yet. Make sure your Organization Profile is filled in, then run one.
        </p>
      )}

      {history.length > 0 && (
        <div style={{ marginTop: spacing.xxl }}>
          <h2 style={{ fontSize: typeScale.sectionTitle }}>History</h2>
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
