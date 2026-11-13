import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  DAF_GROUP_NOTE,
  FAITH_NAMED_NOTE,
  NO_UNSOLICITED_NOTE,
  ORDERING_RULE,
  SUGGESTION_PAGE_SIZE,
  bandFromBudget,
  describeBand,
  describeReason,
  kindLabel,
  loadSuggestions,
  readableName,
  stateFromLocation,
  type Suggestion,
  type SuggestionPage,
} from "@/lib/funder-reference/suggestions";
import { NO_DONOR_STATEMENT } from "@/lib/funder-reference/charity-browse";
import { NOT_STATED, formatAmount, formatEin, formatPeriodEnd } from "@/lib/funder-reference/browse";
import { cardStyle, chipStyle, colors, sectionStyle, spacing, type as typeScale } from "@/lib/ui";
import AddSuggestedButton from "./add-suggested-button";

const muted = { color: colors.textMuted, fontSize: typeScale.meta } as const;

function SampleGrants({ s, links }: { s: Suggestion; links: SuggestionPage["links"] }) {
  if (s.faith_sample.length === 0) return null;
  return (
    <details style={{ marginTop: spacing.sm }}>
      <summary style={{ cursor: "pointer", fontSize: typeScale.body, color: colors.primary }}>Show grants behind this ({s.faith_sample.length} most recent)</summary>
      <ul style={{ margin: `${spacing.sm}px 0 0`, paddingLeft: spacing.xl, fontSize: typeScale.body }}>
        {s.faith_sample.map((g) => {
          const link = links[g.filing_object_id];
          return (
            <li key={`${g.filing_object_id}-${g.kind}-${g.ordinal}`} style={{ marginBottom: spacing.xs }}>
              {g.recipient ?? "Recipient not stated"} — {formatAmount(g.amount_amt)}, tax year ended {formatPeriodEnd(g.tax_period_end)}
              {" · "}
              {link ? (
                <a href={link.url} target="_blank" rel="noreferrer noopener" style={{ color: colors.primary }}>
                  the filing{link.member ? ` (${link.member})` : ""}
                </a>
              ) : (
                <span style={muted}>filing link not available</span>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function Row({ s, band, orgState, links, allowAdd }: { s: Suggestion; band: ReturnType<typeof bandFromBudget>; orgState: string | null; links: SuggestionPage["links"]; allowAdd: boolean }) {
  const name = readableName(s.name) || `EIN ${formatEin(s.ein)}`;
  return (
    <li style={{ ...cardStyle, listStyle: "none" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: spacing.lg, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 320px" }}>
          <div style={{ display: "flex", gap: spacing.sm, alignItems: "center", flexWrap: "wrap" }}>
            <strong style={{ fontSize: typeScale.cardTitle }}>{name}</strong>
            <span style={chipStyle("neutral")}>{kindLabel(s)}</span>
            {s.takes_no_unsolicited && <span style={chipStyle("amber")}>Pre-selected charities only</span>}
          </div>
          <div style={{ ...muted, marginTop: spacing.xs }}>
            {[readableName(s.city), s.state].filter(Boolean).join(", ") || NOT_STATED} · EIN {formatEin(s.ein)}
            {s.giving_amt !== null && (
              <>
                {" · "}
                {s.source === "private_foundation" ? "Paid out" : "Grants to U.S. organizations"} {formatAmount(s.giving_amt)} (tax year ended {formatPeriodEnd(s.giving_period_end)})
              </>
            )}
          </div>
          <div style={{ marginTop: spacing.sm, fontSize: typeScale.body, display: "grid", gap: spacing.xs }}>
            {describeReason(s, band, orgState).map((line) => (
              <span key={line}>{line}</span>
            ))}
          </div>
          {s.is_daf_sponsor && <p style={{ ...muted, margin: `${spacing.sm}px 0 0` }}>{NO_DONOR_STATEMENT}</p>}
          <SampleGrants s={s} links={links} />
        </div>
        {allowAdd && <AddSuggestedButton ein={s.ein} source={s.source} name={name} />}
      </div>
    </li>
  );
}

/** The national-database suggestions, above web results (ruling 0049). A server component: reads only, through the user's own session. */
export default async function ReferenceSuggestions({ page }: { page: number }) {
  const supabase = createClient();
  const { data: profile } = await supabase.from("org_profile").select("annual_budget, hq_location").limit(1).maybeSingle();
  const band = bandFromBudget(profile?.annual_budget ?? null);
  const orgState = stateFromLocation(profile?.hq_location ?? null);
  const [main, daf, held] = await Promise.all([
    loadSuggestions(supabase, { band, state: orgState, group: "main", page }),
    loadSuggestions(supabase, { band, state: orgState, group: "daf", page: 1 }),
    loadSuggestions(supabase, { band, state: orgState, group: "held_out", page: 1 }),
  ]);

  const pages = Math.max(1, Math.ceil(main.total / SUGGESTION_PAGE_SIZE));
  return (
    <section aria-labelledby="ref-suggestions" style={{ ...sectionStyle, marginBottom: spacing.xl }}>
      <div>
        <h2 id="ref-suggestions" style={{ fontSize: typeScale.sectionTitle, margin: 0 }}>
          Suggested from the national funder database
        </h2>
        <p style={{ ...muted, marginTop: spacing.xs, fontSize: typeScale.body }}>
          Funders found in IRS filings that gave to faith-named recipients. Every number is counted from the filed grants, and each funder shows the grants behind it. Nothing is added until you
          add it.
        </p>
      </div>

      <div style={{ ...muted, display: "grid", gap: spacing.xs }}>
        <span>{describeBand(band, profile?.annual_budget ?? null)}</span>
        <span>{ORDERING_RULE}</span>
        <span>{FAITH_NAMED_NOTE}</span>
        {orgState && <span>Your profile puts you in {orgState}; each funder shows how many of its faith-named grants went to recipients there. It does not change the order.</span>}
      </div>

      {main.error && (
        <p role="alert" style={{ color: colors.danger }}>
          The suggestions could not be loaded: {main.error}
        </p>
      )}

      {!main.error && main.rows.length === 0 && (
        <p style={{ margin: 0, fontSize: typeScale.body }}>
          {main.computed
            ? "No funder in the database matches yet. That means none gave a grant in your size band to a faith-named recipient that you have not already added, not that nothing exists."
            : "The database's grant counts have not been computed yet, so there are no suggestions to show. This is not the same as there being no funders."}
        </p>
      )}

      {main.rows.length > 0 && (
        <>
          <p style={{ ...muted, margin: 0 }}>
            {main.total.toLocaleString("en-US")} funders match. Showing {(page - 1) * SUGGESTION_PAGE_SIZE + 1}–{(page - 1) * SUGGESTION_PAGE_SIZE + main.rows.length}.
          </p>
          <ul style={{ margin: 0, padding: 0, display: "grid", gap: spacing.md }}>
            {main.rows.map((s) => (
              <Row key={`${s.source}-${s.ein}`} s={s} band={band} orgState={orgState} links={main.links} allowAdd />
            ))}
          </ul>
          {pages > 1 && (
            <nav aria-label="More suggestions" style={{ display: "flex", gap: spacing.md, alignItems: "center", ...muted }}>
              {page > 1 && <Link href={`/discovery?refpage=${page - 1}`}>Previous</Link>}
              <span>
                Page {page} of {pages}
              </span>
              {page < pages && <Link href={`/discovery?refpage=${page + 1}`}>Next</Link>}
            </nav>
          )}
        </>
      )}

      {daf.rows.length > 0 && (
        <details>
          <summary style={{ cursor: "pointer", fontSize: typeScale.body }}>
            Donor-advised fund sponsors ({daf.total.toLocaleString("en-US")}) — listed apart, ordered the same way
          </summary>
          <p style={{ ...muted, margin: `${spacing.sm}px 0` }}>{DAF_GROUP_NOTE}</p>
          <ul style={{ margin: 0, padding: 0, display: "grid", gap: spacing.md }}>
            {daf.rows.map((s) => (
              <Row key={`${s.source}-${s.ein}`} s={s} band={band} orgState={orgState} links={daf.links} allowAdd />
            ))}
          </ul>
          {daf.total > daf.rows.length && <p style={{ ...muted, margin: `${spacing.sm}px 0 0` }}>Showing the first {daf.rows.length} of {daf.total.toLocaleString("en-US")}.</p>}
        </details>
      )}

      {held.rows.length > 0 && (
        <details>
          <summary style={{ cursor: "pointer", fontSize: typeScale.body }}>
            Funders that give only to pre-selected charities ({held.total.toLocaleString("en-US")})
          </summary>
          <p style={{ ...muted, margin: `${spacing.sm}px 0` }}>{NO_UNSOLICITED_NOTE}</p>
          <ul style={{ margin: 0, padding: 0, display: "grid", gap: spacing.md }}>
            {held.rows.map((s) => (
              <Row key={`${s.source}-${s.ein}`} s={s} band={band} orgState={orgState} links={held.links} allowAdd={false} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
