"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { startDiscoverySearch, runDiscoverySearch, retryDiscoverySearch } from "./actions";
import LoadingStatus from "@/components/LoadingStatus";
import { CHANNELS, channelLabel, type Channel } from "@/lib/prospects";
import { spacing, colors, fieldStyle, labelStyle, buttonPrimary, buttonSecondary, cardStyle } from "@/lib/ui";
import type { DiscoverySearchRun } from "@/lib/discovery-search";

const RUNNING_STATUSES = new Set(["searching", "extracting", "screening"]);

export default function SearchPanel() {
  const [channel, setChannel] = useState<Channel>(CHANNELS[0].value);
  const [run, setRun] = useState<DiscoverySearchRun | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const triggeredRef = useRef<string | null>(null);

  // This panel is the stable component for a run -- it's responsible
  // for actually kicking off the work once a run row exists, mirroring
  // StrategyPanel. triggeredRef guards against firing twice within
  // this component instance; started_at on the server guards against
  // firing twice across page loads/refreshes.
  useEffect(() => {
    if (run && run.status === "searching" && !run.started_at && triggeredRef.current !== run.id) {
      triggeredRef.current = run.id;
      runDiscoverySearch(run.id, run.channel);
    }
  }, [run]);

  // Fetches run status via a plain REST route, not a Server Action --
  // a real search runs for minutes, meaning dozens of polls per run,
  // and repeatedly routing that through Server Actions' RSC wire
  // protocol was implicated in a production-only client crash that
  // never reproduced locally no matter how it was tested.
  async function fetchRun(runId: string) {
    const res = await fetch(`/api/discovery-search-runs/${runId}`);
    if (!res.ok) return null;
    const { run: latest } = await res.json();
    return latest as DiscoverySearchRun | null;
  }

  // Poll while the run is actively in progress. Stops itself once the
  // run reaches a terminal state.
  useEffect(() => {
    if (!run || !RUNNING_STATUSES.has(run.status)) return;

    const interval = setInterval(async () => {
      const latest = await fetchRun(run.id);
      if (latest) setRun(latest);
    }, 1200);

    return () => clearInterval(interval);
  }, [run]);

  // startDiscoverySearch/retryDiscoverySearch can throw (missing org
  // profile, a DB error) -- without a catch here, that becomes an
  // uncaught client-side rejection with no graceful UI, same failure
  // mode the polling fix addressed for the long-running path.
  function handleSearch() {
    setStartError(null);
    startTransition(async () => {
      try {
        const runId = await startDiscoverySearch(channel);
        setRun(await fetchRun(runId));
      } catch (err) {
        console.error("[discovery-search] startDiscoverySearch failed:", err);
        setStartError(err instanceof Error ? err.message : "Failed to start search");
      }
    });
  }

  function handleRetry() {
    if (!run) return;
    setStartError(null);
    startTransition(async () => {
      try {
        const runId = await retryDiscoverySearch(run.channel);
        setRun(await fetchRun(runId));
      } catch (err) {
        console.error("[discovery-search] retryDiscoverySearch failed:", err);
        setStartError(err instanceof Error ? err.message : "Failed to start search");
      }
    });
  }

  const isRunning = !!run && RUNNING_STATUSES.has(run.status);

  return (
    <div>
      <label style={labelStyle}>
        Channel
        <select
          value={channel}
          disabled={isRunning}
          onChange={(e) => setChannel(e.target.value as Channel)}
          style={fieldStyle}
        >
          {CHANNELS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <div style={{ marginTop: spacing.md }}>
        <button type="button" disabled={isPending || isRunning} onClick={handleSearch} style={buttonPrimary}>
          {isRunning ? "Searching…" : "Search"}
        </button>
      </div>

      {startError && (
        <div style={{ ...cardStyle, marginTop: spacing.md }}>
          <p style={{ fontSize: 14, color: "crimson" }}>Search failed: {startError}</p>
        </div>
      )}

      {isRunning && (
        <div style={{ ...cardStyle, marginTop: spacing.md }}>
          <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: spacing.sm }}>
            This can take a few minutes — this will update automatically as soon as results are ready.
          </p>
          <LoadingStatus active messages={[run.status_message ?? "Working…"]} />
        </div>
      )}

      {run && run.status === "error" && (
        <div style={{ ...cardStyle, marginTop: spacing.md }}>
          <p style={{ fontSize: 14, color: "crimson" }}>
            {run.status_message}
            {run.error_message ? `: ${run.error_message}` : ""}
          </p>
          <button type="button" disabled={isPending} onClick={handleRetry} style={{ ...buttonSecondary, marginTop: spacing.sm }}>
            {isPending ? "Retrying…" : "Retry Search"}
          </button>
        </div>
      )}

      {run && run.status === "done" && (
        <div
          style={{
            background: "#dcfce7",
            color: "#166534",
            padding: spacing.sm,
            borderRadius: 6,
            marginTop: spacing.md,
            fontSize: 14,
          }}
        >
          ✓ {run.status_message ?? `Found ${run.found_count ?? 0} candidates`} for {channelLabel(run.channel)} —
          review them in the{" "}
          <Link href="/discovery" prefetch={false} style={{ color: "#166534", fontWeight: 600 }}>
            Discovery queue
          </Link>
          .
        </div>
      )}
    </div>
  );
}
