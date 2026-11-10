import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { loadStateStatuses, searchFunders } from "@/lib/funder-reference/read";
import {
  NOT_STATED,
  PAGE_SIZE,
  SIZE_BANDS,
  SORT_LABELS,
  US_STATES,
  describeStates,
  formatAmount,
  formatEin,
  formatPeriodEnd,
  funderName,
  pageCount,
  parseSearch,
  placeLine,
  searchHref,
  sizeBandValue,
  type SortKey,
} from "@/lib/funder-reference/browse";
import {
  buttonPrimary,
  buttonSecondary,
  cardStyle,
  chipStyle,
  colors,
  fieldStyle,
  labelStyle,
  spacing,
  tableStyle,
  tableWrapStyle,
  tdStyle,
  thStyle,
  type as typeScale,
} from "@/lib/ui";

export const dynamic = "force-dynamic";

const muted = { color: colors.textMuted, fontSize: typeScale.meta } as const;

export default async function FunderSearchPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const supabase = createClient();
  const input = parseSearch(searchParams);
  const [statuses, result] = await Promise.all([loadStateStatuses(supabase), searchFunders(supabase, input)]);
  const states = describeStates(statuses);
  const selectedStatus = input.state ? statuses[input.state] : null;
  const pages = pageCount(result.total);
  const first = result.total === 0 ? 0 : (input.page - 1) * PAGE_SIZE + 1;
  const last = Math.min(result.total, input.page * PAGE_SIZE);
  const base = "/funders";

  // Clicking the heading of the column the list is sorted by reverses it; any other starts at its natural order.
  const sortLink = (key: SortKey) =>
    searchHref(base, input, { sort: key, descending: input.sort === key ? !input.descending : key !== "name", page: 1 });
  const ariaSort = (key: SortKey): "ascending" | "descending" | "none" =>
    input.sort !== key ? "none" : input.descending ? "descending" : "ascending";
  const arrow = (key: SortKey) => (input.sort !== key ? "" : input.descending ? " ↓" : " ↑");

  return (
    <div style={{ maxWidth: 1100 }}>
      <h1 style={{ fontSize: typeScale.pageTitle }}>Funder database</h1>
      <p style={{ color: colors.textMuted, fontSize: typeScale.body, marginTop: spacing.xs, maxWidth: 720 }}>
        Private foundations, read from their public IRS filings. This screen only reads: nothing here creates a prospect,
        contacts anyone, or changes any record.
      </p>

      <section aria-label="What is loaded" style={{ ...cardStyle, marginTop: spacing.lg }}>
        <div style={{ fontSize: typeScale.body }}>
          <strong>{states.loaded.length}</strong> of {Object.keys(US_STATES).length} states and districts are loaded;{" "}
          <strong>{states.verified.length}</strong> have passed their sample check.
          {states.notVerified.length > 0 && (
            <>
              {" "}
              Not yet verified: <span style={{ fontWeight: 600 }}>{states.notVerified.join(", ")}</span>.
            </>
          )}
        </div>
        {states.notLoaded.length > 0 && (
          <details style={{ marginTop: spacing.sm }}>
            <summary style={{ ...muted, cursor: "pointer" }}>Not loaded yet ({states.notLoaded.length})</summary>
            <p style={{ ...muted, marginTop: spacing.xs }}>
              {states.notLoaded.map((s) => US_STATES[s]).join(", ")}. A state that is not loaded shows no funders, which is not the same as having none.
            </p>
          </details>
        )}
      </section>

      <form method="get" action={base} role="search" aria-label="Search funders" style={{ marginTop: spacing.lg }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: spacing.md, alignItems: "end" }}>
          <div style={{ gridColumn: "1 / -1" }}>
            <label htmlFor="q" style={labelStyle}>
              Name, EIN or city
            </label>
            <input id="q" name="q" type="search" defaultValue={input.q} placeholder="e.g. Hewlett, 94-1655673 or Tulsa" style={fieldStyle} />
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
              Assets, end of year (latest period held)
            </label>
            <select id="size" name="size" defaultValue={sizeBandValue(input)} style={fieldStyle}>
              {SIZE_BANDS.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="preselected" style={labelStyle}>
              Pre-selected charities only?
            </label>
            <select id="preselected" name="preselected" defaultValue={input.preselected} style={fieldStyle}>
              <option value="any">Any</option>
              <option value="not_marked">Return does not say so</option>
              <option value="marked">Return says so</option>
            </select>
          </div>
          <div>
            <label htmlFor="sort" style={labelStyle}>
              Sort by
            </label>
            <select id="sort" name="sort" defaultValue={input.sort} style={fieldStyle}>
              {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABELS[k]}
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
            <p style={{ ...muted, marginTop: spacing.xs }}>
              Nothing was changed. If this keeps happening, the funder directory may not be set up in this database yet.
            </p>
            <p style={{ ...muted, marginTop: spacing.xs }}>Detail: {result.error}</p>
          </div>
        ) : (
          <>
            {selectedStatus === "not_loaded" && (
              <div role="status" style={{ ...cardStyle, borderColor: colors.amber700, background: colors.amber100, marginBottom: spacing.md }}>
                <strong>{US_STATES[input.state]} is not loaded yet.</strong> The database holds no funders for it, which does not mean it has none.
              </div>
            )}
            {selectedStatus === "not_verified" && (
              <div role="status" style={{ ...cardStyle, borderColor: colors.amber700, background: colors.amber100, marginBottom: spacing.md }}>
                <strong>{US_STATES[input.state]} is loaded but not yet verified.</strong> Its funders are shown, but its sample check against the IRS filings has not passed yet.
              </div>
            )}
            <p style={{ fontSize: typeScale.body, margin: `0 0 ${spacing.sm}px` }}>
              {result.total === 0 ? (
                selectedStatus === "not_loaded" ? null : (
                  <>No funders match this search. Try fewer words or a different state or size.</>
                )
              ) : (
                <>
                  <strong>{result.total.toLocaleString("en-US")}</strong> {result.total === 1 ? "funder matches" : "funders match"} · showing {first.toLocaleString("en-US")}–{last.toLocaleString("en-US")}
                </>
              )}
            </p>

            {result.rows.length > 0 && (
              <>
              <p id="results-note" style={{ ...muted, margin: `0 0 ${spacing.sm}px` }}>
                Figures are from each funder’s latest tax period held; the period is shown on each row.
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
                      <th scope="col" style={{ ...thStyle, textAlign: "right" }} aria-sort={ariaSort("assets")}>
                        <Link href={sortLink("assets")} style={{ color: "inherit" }}>
                          Assets, end of year{arrow("assets")}
                        </Link>
                      </th>
                      <th scope="col" style={{ ...thStyle, textAlign: "right" }} aria-sort={ariaSort("grants_paid")}>
                        <Link href={sortLink("grants_paid")} style={{ color: "inherit" }}>
                          Grants paid in the year{arrow("grants_paid")}
                        </Link>
                      </th>
                      <th scope="col" style={thStyle}>Period</th>
                      <th scope="col" style={thStyle}>Pre-selected only?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((r) => (
                      <tr key={r.ein}>
                        <th scope="row" style={{ ...tdStyle, textAlign: "left", fontWeight: 500 }}>
                          <Link href={`/funders/${r.ein}`} style={{ color: colors.primary, fontWeight: 600 }}>
                            {funderName(r.name)}
                          </Link>
                          <div style={muted}>EIN {formatEin(r.ein)}</div>
                        </th>
                        <td style={tdStyle}>{placeLine(r.city, r.state)}</td>
                        <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          <Amount value={r.fmv_assets_eoy_amt} />
                        </td>
                        <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          <Amount value={r.contributions_paid_per_books_amt} />
                        </td>
                        <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                          {r.figures_period_end ? formatPeriodEnd(r.figures_period_end) : <span style={muted}>No figures held</span>}
                        </td>
                        <td style={tdStyle}>
                          {r.only_preselected_charities_box_checked === true ? (
                            <span style={chipStyle("amber")}>Return says so</span>
                          ) : r.figures_period_end ? (
                            <span style={chipStyle("neutral")}>Return does not say so</span>
                          ) : (
                            <span style={muted}>—</span>
                          )}
                        </td>
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
                  <Link href={searchHref(base, input, { page: input.page - 1 })} style={buttonSecondary} rel="prev">
                    ← Previous
                  </Link>
                ) : null}
                <span style={muted}>
                  Page {input.page.toLocaleString("en-US")} of {pages.toLocaleString("en-US")}
                </span>
                {input.page < pages ? (
                  <Link href={searchHref(base, input, { page: input.page + 1 })} style={buttonSecondary} rel="next">
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

/** A stored amount, or the plain words for "the return does not carry it" -- never $0 for an absent figure. */
function Amount({ value }: { value: number | null }) {
  if (value === null || value === undefined) return <span style={{ color: colors.textFaint, fontSize: typeScale.meta }}>{NOT_STATED}</span>;
  return <>{formatAmount(value)}</>;
}
