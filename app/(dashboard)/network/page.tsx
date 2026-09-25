import { createClient } from "@/lib/supabase/server";
import { spacing, colors, type as typeScale } from "@/lib/ui";
import type { NetworkConnection } from "@/lib/network";
import NetworkWorkspace from "./network-workspace";

export default async function NetworkPage() {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("network_connections")
    .select("*")
    .order("updated_at", { ascending: false })
    .returns<NetworkConnection[]>();

  return (
    <div>
      <h1 style={{ fontSize: typeScale.pageTitle }}>Network</h1>
      <p style={{ color: colors.textMuted, marginTop: spacing.xs, maxWidth: 640, fontSize: 14 }}>
        The people your team knows. Record them here by hand, and on a prospect the AI can suggest which of them might
        open a door to that funder. You decide every suggestion, and nobody on this list is ever contacted by this
        system.
      </p>
      {error ? (
        <p style={{ color: colors.danger, marginTop: spacing.lg }}>
          Could not load your network just now. If this is a new install, the network tables may not be set up yet.
        </p>
      ) : (
        <NetworkWorkspace connections={data ?? []} />
      )}
    </div>
  );
}
