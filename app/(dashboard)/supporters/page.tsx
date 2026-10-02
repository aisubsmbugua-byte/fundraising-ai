import { createClient } from "@/lib/supabase/server";
import { spacing, colors, type as typeScale } from "@/lib/ui";
import type { Supporter, SupporterGift, SupporterInteraction } from "@/lib/supporters";
import SupportersWorkspace from "./supporters-workspace";

export default async function SupportersPage({
  searchParams,
}: {
  // Populated when arriving from the Follow-up page's "Supporter
  // stewardship" tab (?id=...), so "Open supporter" lands on that row
  // instead of the default first-in-list selection.
  searchParams: { id?: string };
}) {
  const supabase = createClient();
  const [{ data: supporters, error }, { data: gifts }, { data: interactions }] = await Promise.all([
    supabase.from("supporters").select("*").order("created_at", { ascending: false }).returns<Supporter[]>(),
    supabase.from("supporter_gifts").select("*").order("gift_date", { ascending: false }).returns<SupporterGift[]>(),
    supabase.from("supporter_interactions").select("*").order("occurred_at", { ascending: false }).returns<SupporterInteraction[]>(),
  ]);

  const giftsBySupporter: Record<string, SupporterGift[]> = {};
  for (const g of gifts ?? []) {
    (giftsBySupporter[g.supporter_id] ??= []).push(g);
  }
  const interactionsBySupporter: Record<string, SupporterInteraction[]> = {};
  for (const i of interactions ?? []) {
    (interactionsBySupporter[i.supporter_id] ??= []).push(i);
  }

  return (
    <div>
      <h1 style={{ fontSize: typeScale.pageTitle }}>Supporters</h1>
      <p style={{ color: colors.textMuted, marginTop: spacing.xs, maxWidth: 640, fontSize: 14 }}>
        Individual, recurring givers — event signups, website pledges, and other one-off or ongoing gifts. A different
        shape from a funder prospect: no channel, no stage, no screening, just who they are, what they committed to
        giving, and what they actually gave.
      </p>
      {error ? (
        <p style={{ color: colors.danger, marginTop: spacing.lg }}>
          Could not load supporters just now. If this is a new install, the supporter tables may not be set up yet.
        </p>
      ) : (
        <SupportersWorkspace
          supporters={supporters ?? []}
          giftsBySupporter={giftsBySupporter}
          interactionsBySupporter={interactionsBySupporter}
          initialSelectedId={searchParams?.id ?? null}
        />
      )}
    </div>
  );
}
