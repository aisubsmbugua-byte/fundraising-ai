import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { spacing, colors, type as typeScale } from "@/lib/ui";
import { identityState, planBulkLook, type IdentityState } from "@/lib/network-identity";
import { STRONG_MATCHES_PER_SCREEN, buildReviewPerson, type ReviewPerson, type StateCounts } from "@/lib/network-identity-flow";
import { loadIdentityOverview } from "@/lib/network-identity-store";
import { pageWindow, parsePage } from "@/lib/network-list";
import IdentityWorkspace from "./identity-workspace";

// A look is a web search plus a model call run inside this page's request (one
// person per request: the "Look up more people" button calls the single-person
// action from the browser, one call at a time); this is the same budget the
// prospect page gives its longest actions.
export const maxDuration = 450;

const REVIEW_PAGE_SIZE = 20;

// Confirm your network (STATE item 107 slice A and item 109, ruling 0044 clause
// 2). The one screen where a human says, for each recorded person, which
// candidate is the real one -- or that none is -- with the evidence for each laid
// out beside it, opening straight to the work with a one-line status on top.
// Nothing here confirms anything on its own: a preselected candidate is only a
// default highlight until a human clicks.
export default async function IdentityPage({ searchParams }: { searchParams: { page?: string } }) {
  const supabase = createClient();
  const overview = await loadIdentityOverview(supabase);

  const header = (
    <>
      <p style={{ margin: 0, fontSize: 13 }}>
        <Link href="/network" style={{ color: colors.textMuted }}>
          ← Back to Network
        </Link>
      </p>
      <h1 style={{ fontSize: typeScale.pageTitle, marginTop: spacing.xs }}>Confirm your network</h1>
    </>
  );

  if (!overview.ok) {
    return (
      <div>
        {header}
        <p style={{ color: colors.danger, marginTop: spacing.lg, maxWidth: 640 }}>
          {overview.reason === "not_set_up"
            ? "Identity checks are not available yet: the database has not had migration 0083 applied. Everything else works as before."
            : "Could not load your network just now."}
        </p>
      </div>
    );
  }

  const candidateCounts = new Map<string, number>();
  for (const [id, list] of overview.candidates) candidateCounts.set(id, list.length);

  const tally: StateCounts = { not_looked_at: 0, no_candidates_found: 0, candidates: 0, confirmed: 0, none_of_these: 0, do_not_research: 0 };
  const stateOf = new Map<string, IdentityState>();
  for (const p of overview.people) {
    const st = identityState(p, candidateCounts.get(p.id) ?? 0, overview.lookedEmpty.has(p.id));
    stateOf.set(p.id, st);
    tally[st]++;
  }

  // Everyone with candidates waiting for a human, in the order recorded. People
  // with exactly one strong (preselected) match are listed in full on the screen
  // with the match that would be used; the rest are paged for an individual choice.
  const toReview: ReviewPerson[] = [];
  for (const p of overview.people) {
    if (stateOf.get(p.id) !== "candidates") continue;
    toReview.push(buildReviewPerson(p, overview.candidates.get(p.id) ?? []));
  }
  const allStrong = toReview.filter((r) => r.preselectedId !== null);
  const strong = allStrong.slice(0, STRONG_MATCHES_PER_SCREEN);
  const others = toReview.filter((r) => r.preselectedId === null);
  const win = pageWindow(parsePage(searchParams.page), others.length, REVIEW_PAGE_SIZE);
  const pageItems = others.slice(win.from, others.length === 0 ? 0 : win.to + 1);

  const plan = planBulkLook(overview.people, candidateCounts, overview.lookedEmpty);

  return (
    <div>
      {header}
      <p style={{ color: colors.textMuted, marginTop: spacing.xs, maxWidth: 700, fontSize: 14 }}>
        For each person you recorded, the platform can look for who they are on the public web and propose up to three matches, showing what each was found on
        and which of the details you recorded the page&apos;s text contains. You decide which one is the real person, or that none is. It never searches or reads a
        social or professional network, nothing more is looked up about a person until you have decided, and nothing is ever sent to them.
      </p>
      <IdentityWorkspace
        counts={tally}
        totalRecorded={overview.people.length}
        eligible={plan.eligible.length}
        skipped={plan.skipped}
        strong={strong}
        strongTotal={allStrong.length}
        others={pageItems}
        paging={{ page: win.page, totalPages: win.totalPages, first: win.first, last: win.last, total: others.length }}
      />
    </div>
  );
}
