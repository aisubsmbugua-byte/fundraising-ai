import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { loadCharityDirectoryRefreshedAt, loadCharityStateStatuses, searchCharities } from "@/lib/funder-reference/charity-read";
import {
  CHARITY_SORT_LABELS,
  GRANT_BANDS,
  KIND_LABELS,
  DAF_COUNT_CAVEAT,
  NO_DONOR_STATEMENT,
  PAGE_SIZE,
  charitySearchHref,
  describeCharityStates,
  grantBandValue,
  kindLabels,
  parseCharitySearch,
  type CharityKind,
  type CharitySortKey,
} from "@/lib/funder-reference/charity-browse";
import { NOT_STATED, US_STATES, formatAmount, formatCount, formatEin, formatPeriodEnd, formatRefreshed, funderName, pageCount, placeLine } from "@/lib/funder-reference/browse";
import { buttonPrimary, buttonSecondary, cardStyle, chipStyle, colors, fieldStyle, labelStyle, spacing, tableStyle, tableWrapStyle, tdStyle, thStyle, type as typeScale } from "@/lib/ui";
import { FunderTabs } from "../FunderTabs";

export const dynamic = "force-dynamic";

const muted = { color: colors.textMuted, fontSize: typeScale.meta } as const;

export default async function CharitySearchPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const supabase = createClient();
  const input = parseCharitySearch(searchParams);
  const [statuses, result, refreshedAt] = await Promise.all([loadCharityStateStatuses(supabase), searchCharities(supabase, input), loadCharityDirectoryRefreshedAt(supabase)]);
  const states = describeCharityStates(statuses);
  const selectedStatus = input.state ? statuses[input.state] : null;
  const pages = pageCount(result.total);
  const first = result.total === 0 ? 0 : (input.page - 1) * PAGE_SIZE + 1;
  const last = Math.min(result.total, input.page * PAGE_SIZE);
  const base = "/funders/charities";

  const sortLink = (key: CharitySortKey) => charitySearchHref(base, input, { sort: key, descending: input.sort === key ? !input.descending : key !== "name", page: 1 });
  const ariaSort = (key: CharitySortKey): "ascending" | "descending" | "none" => (input.sort !== key ? "none" : input.descending ? "descending" : "ascending");
  const arrow = (key: CharitySortKey) => (input.sort !== key ? "" : input.descending ? " ↓" : " ↑");

  return (
    <div style={{ maxWidth: 1100 }}>
      <h1 style={{ fontSize: typeScale.pageTitle }}>Funder database</h1>
      <p style={{ color: colors.textMuted, fontSize: typeScale.body, marginTop: spacing.xs, maxWidth: 720 }}>
        Grantmaking public charities and donor-advised fund sponsors, read from their public IRS filings (Form 990 with Schedule I or Schedule D). This screen only reads: nothing here creates a prospect, contacts anyone, or changes any record.
      </p>
      <div style={{ marginTop: spacing.md }}>
        <FunderTabs active="charities" />
      </div>

      <section aria-label="What is loaded" style={cardStyle}>
        <div style={{ fontSize: typeScale.body }}>
          <strong>{states.loaded.length}</strong> of {Object.keys(US_STATES).length} states and districts are loaded; <strong>{states.exact.length + states.withinTolerance.length}</strong> have passed their sample check
          {states.withinTolerance.length > 0 && <> ({states.withinTolerance.length} of them within the agreed margin of error)</>}.
          {states.notVerified.length > 0 && (
            <>
              {" "}
              Not yet verified: <span style={{ fontWeight: 600 }}>{states.notVerified.join(", ")}</span>.
            </>
          )}
          {states.notRecorded.length > 0 && (
            <>
              {" "}
              Loaded, check result not recorded on the load: <span style={{ fontWeight: 600 }}>{states.notRecorded.join(", ")}</span>.
            </>
          )}
        </div>
        <div style={{ ...muted, marginTop: spacing.xs }}>
          A funder is in this list when a return in the periods held shows grants to domestic organizations of $100,000 or more (a grantmaking public charity) or at least one donor-advised fund on Schedule D (a sponsor); a funder can be both. Returns just under that line are not stored. Counts here are of one list; a funder that is both kinds is one funder.
        </div>
        <div style={{ ...muted, marginTop: spacing.xs }}>
          The search list was last refreshed {formatRefreshed(refreshedAt)}. A funder loaded since then appears in search after the next refresh; its own page is always current.
        </div>
      </section>

      <form method="get" action={base} role="search" aria-label="Search public charities and donor-advised fund sponsors" style={{ marginTop: spacing.lg }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: spacing.md, alignItems: "end" }}>
          <div style={{ gridColumn: "1 / -1" }}>
            <label htmlFor="q" style={labelStyle}>
              Name, EIN or city
            </label>
            <input id="q" name="q" type="search" defaultValue={input.q} placeholder="e.g. Community Foundation, 94-1655673 or Tulsa" style={fieldStyle} />
          </div>
          <div>
            <label htmlFor="kind" style={labelStyle}>
              Kind
            </label>
            <select id="kind" name="kind" defaultValue={input.kind} style={fieldStyle}>
              {(Object.keys(KIND_LABELS) as CharityKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="state" style={labelStyle}>
              State
            </label>
            <select id="state" name="state" defaultValue={input.state} style={fieldStyle}>
              <option value="">Any state</option>
              {Object.entries(US_STATES).map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                  {statuses[code] === "not_loaded" ? " (not loaded)" : statuses[code] === "not_verified" ? " (not yet verified)" : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="size" style={labelStyle}>
              Largest grants to organizations in a year held
            </label>
            <select id="size" name="size" defaultValue={grantBandValue(input)} style={fieldStyle}>
              {GRANT_BANDS.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="sort" style={labelStyle}>
              Sort by
            </label>
            <select id="sort" name="sort" defaultValue={input.sort} style={fieldStyle}>
              {(Object.keys(CHARITY_SORT_LABELS) as CharitySortKey[]).map((k) => (
                <option key={k} value={k}>
                  {CHARITY_SORT_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="dir" style={labelStyle}>
              Order
            </label>
            <select id="dir" name="dir" defaultValue={input.descending ? "desc" : "asc"} style={fieldStyle}>
              <option value="asc">Smallest or A to Z first</option>
              <option value="desc">Largest or Z to A first</option>
            </select>
          </div>
        </div>
        <div style={{ display: "flex", gap: spacing.sm, marginTop: spacing.md, flexWrap: "wrap" }}>
          <button type="submit" style={buttonPrimary}>
            Search
          </button>
          <Link href={base} style={buttonSecondary}>
            Clear
          </Link>
        </div>
      </form>

      <div aria-live="polite" style={{ marginTop: spacing.xl }}>
        {result.error ? (
          <div role="alert" style={{ ...cardStyle, borderColor: colors.red600, background: colors.red100 }}>
            <strong>The search could not run.</strong>
            <p style={{ ...muted, marginTop: spacing.xs }}>Nothing was changed. If this keeps happening, the charity directory may not be set up in this database yet.</p>
            <p style={{ ...muted, marginTop: spacing.xs }}>Detail: {result.error}</p>
          </div>
        ) : (
          <>
            {selectedStatus === "not_loaded" && (
              <div role="status" style={{ ...cardStyle, borderColor: colors.amber700, background: colors.amber100, marginBottom: spacing.md }}>
                <strong>{US_STATES[input.state]} is not loaded yet.</strong> The database holds no charities for it, which does not mean it has none.
              </div>
            )}
            {selectedStatus === "not_verified" && (
              <div role="status" style={{ ...cardStyle, borderColor: colors.amber700, background: colors.amber100, marginBottom: spacing.md }}>
                <strong>{US_STATES[input.state]} is loaded but not yet verified.</strong> Its funders are shown, but its sample check against the IRS filings has not passed yet.
              </div>
            )}
            <p style={{ fontSize: typeScale.body, margin: `0 0 ${spacing.sm}px` }}>
              {result.total === 0 ? (
                selectedStatus === "not_loaded" ? null : <>No funders match this search. Try fewer words or a different state, kind or size.</>
              ) : (
                <>
                  <strong>{result.total.toLocaleString("en-US")}</strong> {result.total === 1 ? "funder matches" : "funders match"} · showing {first.toLocaleString("en-US")}–{last.toLocaleString("en-US")}
                </>
              )}
            </p>

            {result.rows.length > 0 && (
              <>
                <p id="results-note" style={{ ...muted, margin: `0 0 ${spacing.sm}px` }}>
                  The size column is the largest Part IX line 1 figure (grants to domestic organizations) among the tax periods held, the figure the rule tests; the period of the latest figures is on the funder’s page. {NO_DONOR_STATEMENT} {DAF_COUNT_CAVEAT}
                </p>
                <div style={tableWrapStyle}>
                  <table style={tableStyle} aria-describedby="results-note">
                    <thead>
                      <tr>
                        <th scope="col" style={thStyle} aria-sort={ariaSort("name")}>
                          <Link href={sortLink("name")} style={{ color: "inherit" }}>
                            Funder{arrow("name")}
                          </Link>
                        </th>
                        <th scope="col" style={thStyle}>Place</th>
                        <th scope="col" style={thStyle}>Kind</th>
                        <th scope="col" style={{ ...thStyle, textAlign: "right" }} aria-sort={ariaSort("grants")}>
                          <Link href={sortLink("grants")} style={{ color: "inherit" }}>
                            Largest grants to organizations{arrow("grants")}
                          </Link>
                        </th>
                        <th scope="col" style={{ ...thStyle, textAlign: "right" }} aria-sort={ariaSort("daf_funds")}>
                          <Link href={sortLink("daf_funds")} style={{ color: "inherit" }}>
                            Donor-advised funds held, as filed{arrow("daf_funds")}
                          </Link>
                        </th>
                        <th scope="col" style={{ ...thStyle, textAlign: "right" }} aria-sort={ariaSort("daf_value")}>
                          <Link href={sortLink("daf_value")} style={{ color: "inherit" }}>
                            Donor-advised fund value{arrow("daf_value")}
                          </Link>
                        </th>
                        <th scope="col" style={{ ...thStyle, textAlign: "right" }}>Periods held</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map((r) => (
                        <tr key={r.ein}>
                          <th scope="row" style={{ ...tdStyle, textAlign: "left", fontWeight: 500, minWidth: 240 }}>
                            <Link href={`/funders/charities/${r.ein}`} style={{ color: colors.primary, fontWeight: 600 }}>
                              {funderName(r.name)}
                            </Link>
                            <div style={muted}>EIN {formatEin(r.ein)}</div>
                          </th>
                          <td style={{ ...tdStyle, minWidth: 140 }}>{placeLine(r.city, r.state)}</td>
                          <td style={tdStyle}>
                            <div style={{ display: "flex", gap: spacing.xs, flexWrap: "wrap" }}>
                              {kindLabels(r.is_grantmaking_public_charity, r.is_daf_sponsor).map((k) => (
                                <span key={k} style={chipStyle(k.startsWith("Donor") ? "amber" : "teal")}>
                                  {k}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                            {r.grants_domestic_orgs_max_amt === null ? <span style={{ color: colors.textFaint, fontSize: typeScale.meta }}>{NOT_STATED}</span> : formatAmount(r.grants_domestic_orgs_max_amt)}
                          </td>
                          <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                            {r.daf_held_max_cnt === null ? <span style={{ color: colors.textFaint, fontSize: typeScale.meta }}>{r.is_daf_sponsor ? NOT_STATED : "—"}</span> : formatCount(r.daf_held_max_cnt)}
                            {r.daf_period_end && r.daf_held_max_cnt !== null && <div style={muted}>filed {formatPeriodEnd(r.daf_period_end)}</div>}
                          </td>
                          <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                            {r.daf_value_eoy_amt === null ? <span style={{ color: colors.textFaint, fontSize: typeScale.meta }}>{r.is_daf_sponsor ? NOT_STATED : "—"}</span> : formatAmount(r.daf_value_eoy_amt)}
                          </td>
                          <td style={{ ...tdStyle, textAlign: "right" }}>{r.periods_held}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {pages > 1 && (
              <nav aria-label="Pages of results" style={{ display: "flex", gap: spacing.sm, alignItems: "center", marginTop: spacing.md, flexWrap: "wrap" }}>
                {input.page > 1 ? (
                  <Link href={charitySearchHref(base, input, { page: input.page - 1 })} style={buttonSecondary} rel="prev">
                    ← Previous
                  </Link>
                ) : null}
                <span style={muted}>
                  Page {input.page.toLocaleString("en-US")} of {pages.toLocaleString("en-US")}
                </span>
                {input.page < pages ? (
                  <Link href={charitySearchHref(base, input, { page: input.page + 1 })} style={buttonSecondary} rel="next">
                    Next →
                  </Link>
                ) : null}
              </nav>
            )}
          </>
        )}
      </div>
    </div>
  );
}
