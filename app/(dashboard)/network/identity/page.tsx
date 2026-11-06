import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { spacing, colors, type as typeScale } from "@/lib/ui";
import {
  IDENTITY_BULK_CAP,
  IDENTITY_STATE_LABEL,
  agreementFor,
  evidenceItems,
  evidenceLine,
  identityState,
  planBulkLook,
  preselectedCandidate,
  type IdentityFacts,
  type IdentityState,
} from "@/lib/network-identity";
import { loadIdentityOverview } from "@/lib/network-identity-store";
import { pageWindow, parsePage } from "@/lib/network-list";
import IdentityWorkspace, { type ReviewPerson, type StateCounts } from "./identity-workspace";

// A look is a web search plus a model call run inside this page's request, and
// "Find matches for everyone" runs up to IDENTITY_BULK_CAP of them; this is the
// same budget the prospect page gives its longest actions.
export const maxDuration = 450;

const REVIEW_PAGE_SIZE = 20;

// Who is who (STATE item 107 slice A, ruling 0044 clause 2). One screen where a
// human says, for each recorded person, which candidate is the real one -- or
// that none is -- with the evidence for each laid out beside it. Nothing here
// confirms anything on its own: a preselected candidate is only a default
// highlight until a human clicks.
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
      <h1 style={{ fontSize: typeScale.pageTitle, marginTop: spacing.xs }}>Who is who</h1>
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

  const toReview: ReviewPerson[] = [];
  for (const p of overview.people) {
    if (stateOf.get(p.id) !== "candidates") continue;
    const facts: IdentityFacts = { person_name: p.person_name, affiliation: p.affiliation, title: p.title, city: p.city, state: p.state };
    const cands = overview.candidates.get(p.id) ?? [];
    const pre = preselectedCandidate(cands, facts);
    toReview.push({
      id: p.id,
      name: p.person_name,
      affiliation: p.affiliation,
      title: p.title,
      city: p.city,
      state: p.state,
      preselectedId: pre?.id ?? null,
      candidates: cands.map((c) => {
        const { agreement, recomputed } = agreementFor(c, facts);
        return {
          id: c.id,
          label: c.label,
          headline: c.headline,
          locationText: c.location_text,
          sourceUrl: c.source_url,
          sourceTitle: c.source_title,
          evidence: evidenceItems(agreement),
          evidenceLine: evidenceLine(agreement),
          labelSupported: agreement.model_text.label,
          headlineSupported: agreement.model_text.headline,
          recomputed,
        };
      }),
    });
  }
  // People with a preselected candidate come first, then the rest, each in the
  // order they were recorded; the batch panel lists ALL preselected people
  // regardless of which page of cards is showing.
  const preselected = toReview.filter((r) => r.preselectedId !== null);
  const win = pageWindow(parsePage(searchParams.page), toReview.length, REVIEW_PAGE_SIZE);
  const pageItems = toReview.slice(win.from, toReview.length === 0 ? 0 : win.to + 1);

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
        cap={IDENTITY_BULK_CAP}
        stateLabels={IDENTITY_STATE_LABEL}
        preselected={preselected}
        people={pageItems}
        paging={{ page: win.page, totalPages: win.totalPages, first: win.first, last: win.last, total: toReview.length }}
      />
    </div>
  );
}
