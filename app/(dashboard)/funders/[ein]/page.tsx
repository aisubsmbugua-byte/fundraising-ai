import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadFunderPage, loadStateStatuses, type FigureRow, type FunderPage } from "@/lib/funder-reference/read";
import {
  GRANTS_PAGE_SIZE,
  NOT_HELD,
  NOT_STATED,
  US_STATES,
  coverageText,
  filingAnchor,
  formatAmount,
  formatCount,
  formatEin,
  formatPeriodEnd,
  funderName,
  pageCount,
  placeLine,
  preselectedText,
} from "@/lib/funder-reference/browse";
import {
  buttonSecondary,
  cardStyle,
  chipStyle,
  colors,
  sectionStyle,
  spacing,
  tableStyle,
  tableWrapStyle,
  tdStyle,
  thStyle,
  type as typeScale,
} from "@/lib/ui";

export const dynamic = "force-dynamic";

const muted = { color: colors.textMuted, fontSize: typeScale.meta } as const;
const h2 = { fontSize: typeScale.sectionTitle, margin: 0 } as const;
const TAX_YEARS = [2024, 2023, 2022]; // the three tax periods ruling 0045 holds, newest first

// The figures shown for each tax period, each named for what the return calls it and where
// on the form it sits (ruling 0045 clause 3). There is no single "giving" row.
const FIGURE_ROWS: { label: string; where: string; key: keyof FigureRow }[] = [
  { label: "Fair market value of all assets, end of year", where: "Part I, line 16 (column c)", key: "fmv_assets_eoy_amt" },
  { label: "Net assets or fund balances, end of year", where: "Part II, line 30", key: "net_assets_eoy_amt" },
  { label: "Contributions, gifts and grants received", where: "Part I, line 1 (column a)", key: "contributions_received_per_books_amt" },
  { label: "Total revenue, per books", where: "Part I, line 12 (column a)", key: "total_revenue_per_books_amt" },
  { label: "Total expenses, per books", where: "Part I, line 26 (column a)", key: "total_expenses_per_books_amt" },
  { label: "Contributions, gifts and grants paid, per books", where: "Part I, line 25 (column a)", key: "contributions_paid_per_books_amt" },
  { label: "Contributions, gifts and grants paid, cash disbursements", where: "Part I, line 25 (column d)", key: "contributions_paid_disbursements_amt" },
  { label: "Total expenses and disbursements for charitable purposes", where: "Part I, line 26 (column d)", key: "total_expenses_charitable_disbursements_amt" },
  { label: "Qualifying distributions", where: "Part XII, line 4", key: "qualifying_distributions_amt" },
  { label: "Grants paid, as the return states the total", where: "Part XV, line 3a", key: "grants_paid_stated_total_amt" },
];

export default async function FunderPageRoute({
  params,
  searchParams,
}: {
  params: { ein: string };
  searchParams: Record<string, string | string[] | undefined>;
}) {
  if (!/^\d{9}$/.test(params.ein)) notFound();
  const supabase = createClient();
  const period = typeof searchParams.period === "string" && /^\d{4}-\d{2}-\d{2}$/.test(searchParams.period) ? searchParams.period : null;
  const gp = Number.parseInt(typeof searchParams.gpage === "string" ? searchParams.gpage : "1", 10);
  const gpage = Number.isFinite(gp) && gp >= 1 ? gp : 1;

  const [page, statuses] = await Promise.all([loadFunderPage(supabase, params.ein, period, gpage), loadStateStatuses(supabase)]);
  if (!page) notFound();

  const f = page.foundation;
  const stateStatus = f.state ? statuses[f.state] : undefined;

  return (
    <div style={{ maxWidth: 1100 }}>
      <Link href="/funders" style={{ ...buttonSecondary, padding: "6px 12px" }}>
        ← All funders
      </Link>

      <header style={{ marginTop: spacing.lg }}>
        <h1 style={{ fontSize: typeScale.pageTitle, margin: 0 }}>{funderName([f.legal_name_line1, f.legal_name_line2].filter(Boolean).join(" "))}</h1>
        <p style={{ color: colors.textMuted, fontSize: typeScale.body, marginTop: spacing.xs }}>
          {placeLine(f.city, f.state)} · EIN {formatEin(f.ein)} · Private foundation (Form 990-PF)
        </p>
        <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap", marginTop: spacing.sm }}>
          {stateStatus === "verified" && <span style={chipStyle("teal")}>{US_STATES[f.state!]}: sample check passed</span>}
          {stateStatus === "not_verified" && <span style={chipStyle("amber")}>{US_STATES[f.state!]}: not yet verified</span>}
          {stateStatus === "not_loaded" && <span style={chipStyle("neutral")}>{US_STATES[f.state!]}: load not recorded</span>}
        </div>
      </header>

      <div style={{ display: "grid", gap: spacing.xl, marginTop: spacing.xl }}>
        <Identity page={page} />
        <Figures page={page} />
        <Apply page={page} />
        <People page={page} />
        <Grants page={page} gpage={gpage} />
        <Sources page={page} />
      </div>
      <p style={{ ...muted, marginTop: spacing.xl }}>
        Every value on this page was read from the IRS filing named beside it. A value the filing does not carry is shown as
        “{NOT_STATED.toLowerCase()}”, never as zero, and a tax period the database does not hold is shown as “{NOT_HELD.toLowerCase()}”,
        never as a year the funder gave nothing.
      </p>
    </div>
  );
}

function FilingLink({ objectId, children }: { objectId: string; children?: React.ReactNode }) {
  return (
    <a href={`#${filingAnchor(objectId)}`} style={{ color: colors.primary, fontSize: typeScale.meta }} title={`Filing ${objectId}`} aria-label={`Open the source details for filing ${objectId}`}>
      {children ?? "Filing"}
    </a>
  );
}

function Absent({ children = NOT_STATED }: { children?: React.ReactNode }) {
  return <span style={{ color: colors.textFaint, fontSize: typeScale.meta }}>{children}</span>;
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  // Label and value sit side by side when there is room and stack when there is not.
  return (
    <div style={{ display: "flex", flexWrap: "wrap", columnGap: spacing.md, rowGap: 2, padding: `${spacing.xs}px 0` }}>
      <dt style={{ ...muted, margin: 0, flex: "0 0 200px" }}>{term}</dt>
      <dd style={{ margin: 0, fontSize: typeScale.body, flex: "1 1 240px", minWidth: 0, overflowWrap: "anywhere" }}>{children}</dd>
    </div>
  );
}

function Identity({ page }: { page: FunderPage }) {
  const f = page.foundation;
  const addr = [f.care_of_name ? `c/o ${f.care_of_name}` : null, f.address_line1, f.address_line2, [f.city, f.state, f.zip].filter(Boolean).join(" "), f.country]
    .filter((x) => x && String(x).trim())
    .join(", ");
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return (
    <section aria-labelledby="identity" style={sectionStyle}>
      <h2 id="identity" style={h2}>
        Who it is
      </h2>
      <dl style={{ margin: 0 }}>
        <Row term="Address">{addr || <Absent />}</Row>
        <Row term="Phone, as stated">{f.phone_as_stated ? f.phone_as_stated : <Absent />}</Row>
        <Row term="Website, as stated">
          {f.website_as_stated ? f.website_as_stated : <Absent />}
          {f.website_as_stated && <span style={{ ...muted, display: "block" }}>Exactly what the return wrote; it is not checked or turned into a link.</span>}
        </Row>
        <Row term="Fiscal year ends">{f.fiscal_year_end_month ? months[f.fiscal_year_end_month - 1] : <Absent />}</Row>
        <Row term="Private operating foundation">
          {f.private_operating_foundation_ind === null ? <Absent /> : f.private_operating_foundation_ind ? "Yes, as the return states" : "No, as the return states"}
        </Row>
        <Row term="Read from">
          The return for the period ending {formatPeriodEnd(f.source_tax_period_end)} · <FilingLink objectId={f.source_object_id} />
        </Row>
      </dl>
    </section>
  );
}

function Figures({ page }: { page: FunderPage }) {
  const figs = page.figures;
  const byYear = new Map<number, FigureRow>();
  for (const x of figs) byYear.set(Number(x.tax_period_end.slice(0, 4)), x);
  const covByYear = new Map(page.coverage.map((c) => [c.period_year, c]));
  const years = Array.from(new Set([...TAX_YEARS, ...figs.map((x) => Number(x.tax_period_end.slice(0, 4)))])).sort((a, b) => b - a);

  return (
    <section aria-labelledby="size" style={sectionStyle}>
      <h2 id="size" style={h2}>
        Size and giving by tax period
      </h2>
      <p id="figures-note" style={{ ...muted, margin: 0 }}>
        Each row is one line of the form, named as the form names it. These figures are not interchangeable: there is no single “giving” number.
      </p>
      <div style={tableWrapStyle}>
        <table style={tableStyle} aria-describedby="figures-note">
          <thead>
            <tr>
              <th scope="col" style={thStyle}>Figure</th>
              {years.map((y) => {
                const fig = byYear.get(y);
                return (
                  <th key={y} scope="col" style={{ ...thStyle, textAlign: "right" }}>
                    {fig ? (
                      <>
                        {formatPeriodEnd(fig.tax_period_end)}
                        <div>
                          <FilingLink objectId={fig.filing_object_id} />
                        </div>
                      </>
                    ) : (
                      <>Tax year {y}</>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {FIGURE_ROWS.map((r) => (
              <tr key={r.key}>
                <th scope="row" style={{ ...tdStyle, textAlign: "left", fontWeight: 500 }}>
                  {r.label}
                  <div style={muted}>{r.where}</div>
                </th>
                {years.map((y) => {
                  const fig = byYear.get(y);
                  const v = fig ? (fig[r.key] as number | null) : undefined;
                  return (
                    <td key={y} style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {!fig ? <Absent>{NOT_HELD}</Absent> : v === null ? <Absent /> : formatAmount(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <th scope="row" style={{ ...tdStyle, textAlign: "left", fontWeight: 500 }}>Tax periods held</th>
              {years.map((y) => {
                const c = covByYear.get(y);
                const fig = byYear.get(y);
                return (
                  <td key={y} style={{ ...tdStyle, textAlign: "right", fontSize: typeScale.meta }}>
                    {fig && !c ? "Held" : coverageText(c?.status, c?.note)}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>

      <h3 style={{ fontSize: typeScale.subsectionTitle, margin: `${spacing.sm}px 0 0` }}>How it gives: the grants the return lists</h3>
      <p style={muted}>
        Worked out by the loader from the grants listed on each return. Each column says which grants it ranged over; the return’s own stated total
        for grants paid is in the table above, and the two can differ.
      </p>
      <div style={tableWrapStyle}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th scope="col" style={thStyle}>Listed grants</th>
              {years.map((y) => {
                const fig = byYear.get(y);
                return (
                  <th key={y} scope="col" style={{ ...thStyle, textAlign: "right" }}>
                    {fig ? formatPeriodEnd(fig.tax_period_end) : `Tax year ${y}`}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["Number of grants listed", "grants_listed_count", "count"],
                ["Total of the grants listed", "grants_listed_sum_amt", "amount"],
                ["Average grant", "grants_listed_avg_amt", "amount"],
                ["Median grant", "grants_listed_median_amt", "amount"],
                ["Smallest grant", "grants_listed_min_amt", "amount"],
                ["Largest grant", "grants_listed_max_amt", "amount"],
                ["Grants listed to recipients in the funder’s own state", "grants_listed_in_filer_state_count", "count"],
                ["Total of those grants", "grants_listed_in_filer_state_sum_amt", "amount"],
                ["Qualifying distributions, as a multiple of the minimum investment return", "qualifying_to_minimum_investment_return_ratio", "ratio"],
              ] as const
            ).map(([label, key, kind]) => (
              <tr key={key}>
                <th scope="row" style={{ ...tdStyle, textAlign: "left", fontWeight: 500 }}>{label}</th>
                {years.map((y) => {
                  const fig = byYear.get(y);
                  const v = fig ? (fig[key] as number | null) : undefined;
                  return (
                    <td key={y} style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {!fig ? (
                        <Absent>{NOT_HELD}</Absent>
                      ) : v === null ? (
                        <Absent />
                      ) : kind === "count" ? (
                        formatCount(v)
                      ) : kind === "ratio" ? (
                        `${Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 })} times`
                      ) : (
                        formatAmount(v)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details>
        <summary style={{ ...muted, cursor: "pointer" }}>What each worked-out figure ranged over</summary>
        <ul style={{ margin: `${spacing.sm}px 0 0`, paddingLeft: spacing.xl, ...muted }}>
          {figs.map((x) => (
            <li key={x.filing_object_id}>
              <strong>{formatPeriodEnd(x.tax_period_end)}:</strong> {x.grants_listed_derivation ?? NOT_STATED}
              {x.payout_ratio_derivation ? ` ${x.payout_ratio_derivation}` : ""}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function Apply({ page }: { page: FunderPage }) {
  const latest = page.terms[0];
  const held = Boolean(latest);
  const pre = preselectedText(latest?.only_preselected_charities_box_checked, held);
  const groups = latest?.application_groups ?? [];
  return (
    <section aria-labelledby="apply" style={sectionStyle}>
      <h2 id="apply" style={h2}>
        Whether it takes new requests
      </h2>
      {!held ? (
        <Absent>{NOT_HELD}</Absent>
      ) : (
        <>
          <p style={{ margin: 0, fontSize: typeScale.body }}>
            <strong>{pre.label}</strong> <span style={muted}>(return for the period ending {formatPeriodEnd(latest.tax_period_end)} · <FilingLink objectId={latest.filing_object_id} />)</span>
          </p>
          {pre.note && <p style={{ ...muted, margin: 0 }}>{pre.note}</p>}
          {groups.length === 0 ? (
            <p style={{ ...muted, margin: 0 }}>The return carries no application instructions.</p>
          ) : (
            <div style={{ display: "grid", gap: spacing.sm }}>
              <h3 style={{ fontSize: typeScale.subsectionTitle, margin: 0 }}>Application instructions, as the return states them</h3>
              {groups.map((g) => (
                <div key={g.ordinal} style={cardStyle}>
                  <dl style={{ margin: 0 }}>
                    {Object.entries(g.fields).map(([path, value]) => (
                      <Row key={path} term={path.split("/").slice(-1)[0]}>
                        {value}
                      </Row>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function People({ page }: { page: FunderPage }) {
  const periods = Array.from(new Set(page.people.map((p) => p.tax_period_end))).sort().reverse();
  return (
    <section aria-labelledby="people" style={sectionStyle}>
      <h2 id="people" style={h2}>
        People named on the returns
      </h2>
      <p style={{ ...muted, margin: 0 }}>
        Shown as each return names them. Two returns naming the same person are two entries here: the database does not decide they are the same person.
      </p>
      {periods.length === 0 ? (
        <Absent>No people are named on the returns held.</Absent>
      ) : (
        periods.map((pe) => {
          const rows = page.people.filter((p) => p.tax_period_end === pe);
          return (
            <div key={pe}>
              <h3 style={{ fontSize: typeScale.subsectionTitle, margin: `${spacing.sm}px 0` }}>
                Return for the period ending {formatPeriodEnd(pe)} · <FilingLink objectId={rows[0].filing_object_id} />
              </h3>
              <div style={tableWrapStyle}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th scope="col" style={thStyle}>Name</th>
                      <th scope="col" style={thStyle}>Title, as stated</th>
                      <th scope="col" style={thStyle}>Hours per week, as stated</th>
                      <th scope="col" style={{ ...thStyle, textAlign: "right" }}>Compensation</th>
                      <th scope="col" style={thStyle}>Listed as</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => (
                      <tr key={`${p.filing_object_id}-${p.listed_in}-${p.ordinal}`}>
                        <th scope="row" style={{ ...tdStyle, textAlign: "left", fontWeight: 500 }}>{p.name_as_named ?? <Absent />}</th>
                        <td style={tdStyle}>{p.title_as_stated ?? <Absent />}</td>
                        <td style={tdStyle}>{p.hours_per_week_as_stated ?? <Absent />}</td>
                        <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {p.compensation_amt === null ? <Absent /> : formatAmount(p.compensation_amt)}
                        </td>
                        <td style={tdStyle}>{p.listed_in === "signer_on_return_header" ? "Signer on the return" : "Officer, director or trustee (Part VIII)"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}

function Grants({ page, gpage }: { page: FunderPage; gpage: number }) {
  const { rows, total, period } = page.grants;
  const pages = pageCount(total, GRANTS_PAGE_SIZE);
  const ein = page.foundation.ein;
  const href = (p: string | null, g: number) => `/funders/${ein}?${new URLSearchParams({ ...(p ? { period: p } : {}), ...(g > 1 ? { gpage: String(g) } : {}) }).toString()}`;
  const fig = page.figures.find((x) => x.tax_period_end === period);
  return (
    <section aria-labelledby="grants" style={sectionStyle}>
      <h2 id="grants" style={h2}>
        Grants listed on the return
      </h2>
      {page.figures.length === 0 || !period ? (
        <Absent>{NOT_HELD}</Absent>
      ) : (
        <>
          <nav aria-label="Tax period of the grants" style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap" }}>
            {page.figures.map((x) => (
              <Link
                key={x.tax_period_end}
                href={href(x.tax_period_end, 1)}
                aria-current={x.tax_period_end === period ? "true" : undefined}
                style={{ ...buttonSecondary, padding: "6px 12px", ...(x.tax_period_end === period ? { background: colors.primary, color: colors.primaryText, borderColor: colors.primary } : {}) }}
              >
                {formatPeriodEnd(x.tax_period_end)}
              </Link>
            ))}
          </nav>
          <p style={{ ...muted, margin: 0 }}>
            {total.toLocaleString("en-US")} {total === 1 ? "grant" : "grants"} listed for the period ending {formatPeriodEnd(period)}
            {fig ? <> · <FilingLink objectId={fig.filing_object_id} /></> : null}. Largest first; recipients and purposes are as the return states them.
          </p>
          {rows.length === 0 ? (
            <Absent>The return lists no grants for this period.</Absent>
          ) : (
            <div style={tableWrapStyle}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th scope="col" style={thStyle}>Recipient</th>
                    <th scope="col" style={thStyle}>Place</th>
                    <th scope="col" style={thStyle}>Purpose, as stated</th>
                    <th scope="col" style={thStyle}>Kind</th>
                    <th scope="col" style={{ ...thStyle, textAlign: "right" }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((g) => (
                    <tr key={`${g.kind}-${g.ordinal}`}>
                      <th scope="row" style={{ ...tdStyle, textAlign: "left", fontWeight: 500 }}>
                        {[g.recipient_name_line1, g.recipient_name_line2].filter(Boolean).join(" ") || g.recipient_person_name || <Absent />}
                        {g.relationship_as_stated || g.recipient_status_as_stated ? (
                          <div style={muted}>{[g.relationship_as_stated, g.recipient_status_as_stated].filter(Boolean).join(" · ")}</div>
                        ) : null}
                      </th>
                      <td style={tdStyle}>{[g.recipient_city, g.recipient_state, g.recipient_country].filter(Boolean).join(", ") || <Absent />}</td>
                      <td style={{ ...tdStyle, minWidth: 180 }}>{g.purpose_as_stated ?? <Absent />}</td>
                      <td style={tdStyle}>{g.kind === "paid_during_year" ? "Paid during the year" : "Approved for future payment"}</td>
                      <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{g.amount_amt === null ? <Absent /> : formatAmount(g.amount_amt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pages > 1 && (
            <nav aria-label="Pages of grants" style={{ display: "flex", gap: spacing.sm, alignItems: "center", flexWrap: "wrap" }}>
              {gpage > 1 && (
                <Link href={href(period, gpage - 1)} style={buttonSecondary} rel="prev">
                  ← Previous
                </Link>
              )}
              <span style={muted}>
                Page {gpage.toLocaleString("en-US")} of {pages.toLocaleString("en-US")}
              </span>
              {gpage < pages && (
                <Link href={href(period, gpage + 1)} style={buttonSecondary} rel="next">
                  Next →
                </Link>
              )}
            </nav>
          )}
        </>
      )}
    </section>
  );
}

function Sources({ page }: { page: FunderPage }) {
  return (
    <section aria-labelledby="sources" style={sectionStyle}>
      <h2 id="sources" style={h2}>
        The filings behind this page
      </h2>
      <p style={{ ...muted, margin: 0 }}>Each filing the database considered for this funder, with where the document can be read and which version of the loader read it.</p>
      {page.filings.length === 0 ? (
        <Absent>{NOT_HELD}</Absent>
      ) : (
        <div style={{ display: "grid", gap: spacing.sm }}>
          {page.filings.map((x) => (
            <div key={x.object_id} id={filingAnchor(x.object_id)} style={{ ...cardStyle, scrollMarginTop: spacing.xl }}>
              <div style={{ display: "flex", gap: spacing.sm, alignItems: "center", flexWrap: "wrap" }}>
                <strong>{x.tax_period_end ? `Period ending ${formatPeriodEnd(x.tax_period_end)}` : "Period not read"}</strong>
                <span style={chipStyle(x.status === "loaded" ? "teal" : x.status === "unread" ? "red" : "neutral")}>
                  {x.status === "loaded" ? "Loaded" : x.status === "unread" ? "Could not be read" : x.status === "superseded" ? "Replaced by a later return" : "Held below the size threshold"}
                </span>
              </div>
              <dl style={{ margin: `${spacing.sm}px 0 0` }}>
                <Row term="IRS object id">{x.object_id}</Row>
                <Row term="Form">{x.return_type}</Row>
                {x.status_note && <Row term="Note">{x.status_note}</Row>}
                <Row term="Where to read it">
                  {/^https:\/\//.test(x.document_archive_url) ? (
                    <a href={x.document_archive_url} target="_blank" rel="noreferrer noopener" style={{ color: colors.primary }}>
                      IRS archive file
                    </a>
                  ) : (
                    x.document_archive_url
                  )}
                  <span style={{ ...muted, display: "block" }}>Document inside the archive: {x.document_member}</span>
                </Row>
                <Row term="Loaded">
                  {formatPeriodEnd(x.loaded_at.slice(0, 10))} · {x.loader_version}
                </Row>
              </dl>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
