import Link from "next/link";
import SearchPanel from "./search-panel";
import { colors } from "@/lib/ui";

// The search runs asynchronously (see search-panel.tsx / actions.ts)
// against a DB-backed run row, polled from the client -- this route
// no longer holds one request open for the duration of the AI call,
// so a generous maxDuration here is just a safety margin, not the
// thing standing between the user and a timeout.
export const maxDuration = 280;

export default function DiscoverySearchPage() {
  return (
    <div style={{ maxWidth: 480 }}>
      <Link href="/discovery" style={{ fontSize: 14, color: colors.textMuted, textDecoration: "none" }}>
        ← Back to Discovery
      </Link>
      <h1>AI Discovery Search</h1>
      <p style={{ color: colors.textMuted, fontSize: 14 }}>
        Pick a channel and AI searches the web for candidate funders matching your Organization
        Profile — up to 10 per run. Each candidate is cross-referenced against public IRS filing data
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
