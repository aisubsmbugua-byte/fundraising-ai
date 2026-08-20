import Link from "next/link";
import SearchPanel from "./search-panel";
import { colors } from "@/lib/ui";

// The search runs asynchronously (see search-panel.tsx / actions.ts)
// against a DB-backed run row, polled from the client, but
// runDiscoverySearch still executes as a POST to this same route --
// its actual runtime is bounded by this maxDuration regardless of the
// client not waiting on it. Real runs were consistently exceeding a
// 150s search-call timeout, so this and the Anthropic client timeout
// in actions.ts were raised together to give the AI call genuine room
// to finish instead of being cut off before it can produce results.
export const maxDuration = 450;

export default function DiscoverySearchPage() {
  return (
    <div style={{ maxWidth: 480 }}>
      <Link href="/discovery" prefetch={false} style={{ fontSize: 14, color: colors.textMuted, textDecoration: "none" }}>
        ← Back to Discovery
      </Link>
      <h1>AI Discovery Search</h1>
      <p style={{ color: colors.textMuted, fontSize: 14 }}>
        Pick a channel and AI searches the web for candidate funders matching your Organization
        Profile — up to 5 per run. Each candidate is cross-referenced against public IRS filing data
        where a match exists (not available for individual churches, which generally don&apos;t file).
        Results land in the same review queue as manual/CSV candidates — nothing is added to the
        pipeline without an explicit Accept.
      </p>

      <div style={{ marginTop: 24 }}>
        <SearchPanel />
      </div>
    </div>
  );
}
