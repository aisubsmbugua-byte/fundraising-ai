import Link from "next/link";
import { runDiscoverySearch } from "./actions";

// Two sequential AI calls plus up to 10 sequential ProPublica lookups
// can genuinely run past the Vercel Pro default (60s) -- give this
// route real headroom instead of racing the clock.
export const maxDuration = 280;
import SubmitButton from "@/components/SubmitButton";
import FormLoadingStatus from "@/components/FormLoadingStatus";
import { CHANNELS, channelLabel } from "@/lib/prospects";
import { spacing, colors, fieldStyle, labelStyle } from "@/lib/ui";

const SEARCH_MESSAGES = [
  "Searching the web for candidate funders...",
  "Reading through search results...",
  "Extracting names, websites, and contact info...",
  "Cross-referencing against public IRS filing data...",
  "Screening each candidate and saving to the queue...",
];

export default function DiscoverySearchPage({
  searchParams,
}: {
  searchParams: { found?: string; channel?: string };
}) {
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

      {searchParams.found !== undefined && (
        <div
          style={{
            background: "#dcfce7",
            color: "#166534",
            padding: spacing.sm,
            borderRadius: 6,
            marginTop: spacing.sm,
            fontSize: 14,
          }}
        >
          ✓ Found {searchParams.found} candidate{searchParams.found === "1" ? "" : "s"}
          {searchParams.channel ? ` for ${channelLabel(searchParams.channel)}` : ""} — review them in the{" "}
          <Link href="/discovery" style={{ color: "#166534", fontWeight: 600 }}>
            Discovery queue
          </Link>
          .
        </div>
      )}

      <form action={runDiscoverySearch} style={{ marginTop: spacing.lg }}>
        <label style={labelStyle}>
          Channel
          <select name="channel" required defaultValue="" style={fieldStyle}>
            <option value="" disabled>
              Select a channel
            </option>
            {CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <div style={{ marginTop: spacing.md }}>
          <SubmitButton>Search</SubmitButton>
          <FormLoadingStatus messages={SEARCH_MESSAGES} />
        </div>
      </form>
    </div>
  );
}
