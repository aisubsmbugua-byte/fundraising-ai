import { createAdminClient } from "@/lib/supabase/admin";
import { runAutoDiscoverySearchForChannel } from "@/app/(dashboard)/discovery/search/actions";
import { countStrategiesReadyForReview } from "@/lib/deep-dive";
import { CHANNELS } from "@/lib/prospects";

// Up to 7 sequential channel searches (each search call alone can
// take up to 240s), so this needs real headroom -- Vercel Pro's cap
// without Fluid Compute is 300s; if this project has Fluid Compute
// enabled, this gets more room, but 280s is the safe assumption
// either way. Stops well before that in practice since it typically
// exits early once TARGET_NEW_CANDIDATES is reached.
export const maxDuration = 280;

const TARGET_NEW_CANDIDATES = 10;

// Triggered by Vercel Cron (see vercel.json) -- Vercel automatically
// sends Authorization: Bearer $CRON_SECRET for its own cron
// invocations when that env var is set, which is what this checks.
// No user session exists in this context at all, hence the admin
// client and the settings-based user attribution below.
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createAdminClient();

  const { data: settings } = await supabase.from("auto_search_settings").select("*").limit(1).maybeSingle();
  if (!settings?.enabled) {
    console.log("[auto-discovery-search] skipped: disabled in Settings");
    return Response.json({ skipped: "disabled" });
  }
  if (!settings.updated_by) {
    // Shouldn't happen in practice -- updated_by is set whenever a
    // real user saves these settings -- but there's no user session
    // to fall back on here, and created_by is a required column.
    console.log("[auto-discovery-search] skipped: no attributable user on settings row");
    return Response.json({ skipped: "no attributable user" });
  }

  // Gated on Strategies to Review, not raw Discovery candidates --
  // Discovery candidates are quick to Accept/Dismiss in bulk, but
  // Strategies to Review is the real backlog (each one takes actually
  // reading a full AI-researched strategy and deciding on it), and
  // it's also the queue auto-search indirectly feeds: every candidate
  // accepted triggers a deep-dive that lands there. Searching for more
  // candidates while that queue is already backed up just sets up more
  // strain downstream instead of helping.
  const readyForReviewCount = await countStrategiesReadyForReview(supabase);
  if (readyForReviewCount >= settings.queue_threshold) {
    console.log(
      `[auto-discovery-search] skipped: Strategies to Review already at ${readyForReviewCount}/${settings.queue_threshold}`
    );
    return Response.json({ skipped: "queue full", readyForReviewCount });
  }

  // Shuffled so the same 2-3 channels don't always get first crack at
  // the nightly budget on nights the target is hit before all 7 run.
  const channels = [...CHANNELS].sort(() => Math.random() - 0.5);

  let totalInserted = 0;
  const results: Record<string, number> = {};
  for (const { value: channel } of channels) {
    if (totalInserted >= TARGET_NEW_CANDIDATES) break;
    const inserted = await runAutoDiscoverySearchForChannel(supabase, channel, settings.updated_by);
    results[channel] = inserted;
    totalInserted += inserted;
  }

  console.log(`[auto-discovery-search] complete: totalInserted=${totalInserted}`, results);
  return Response.json({ totalInserted, results });
}
