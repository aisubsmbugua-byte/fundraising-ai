import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadCharityPage, loadCharityStateStatuses, type CharityFigureRow, type CharityPage } from "@/lib/funder-reference/charity-read";
import { DAF_COUNT_CAVEAT, NO_DONOR_STATEMENT, charityStateChip, kindLabels } from "@/lib/funder-reference/charity-browse";
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
} from "@/lib/funder-reference/browse";
import { buttonSecondary, cardStyle, chipStyle, colors, sectionStyle, spacing, tableStyle, tableWrapStyle, tdStyle, thStyle, type as typeScale } from "@/lib/ui";

export const dynamic = "force-dynamic";

const muted = { color: colors.textMuted, fontSize: typeScale.meta } as const;
const h2 = { fontSize: typeScale.sectionTitle, margin: 0 } as const;
const TAX_YEARS = [2024, 2023, 2022]; // the three tax periods the database holds, newest first

// Each figure is named for what the return calls it and where on the form it sits (ruling 0045 clause 3).
const FIGURE_ROWS: { label: string; where: string; key: keyof CharityFigureRow }[] = [
  { label: "Grants and other assistance to domestic organizations and governments", where: "Part IX, line 1 (column A): the figure the public-charity rule tests", key: "part_ix_line_1_grants_domestic_orgs_total_amt" },
  { label: "Grants and other assistance outside the United States (organizations, governments and individuals)", where: "Part IX, line 3 (column A): not tested, it mixes organizations and individuals", key: "part_ix_line_3_grants_outside_us_total_amt" },
  { label: "Cash grants listed on Schedule I (sum of the rows held)", where: "Schedule I, Part II: derived by the loader from the rows below", key: "schedule_i_cash_grants_listed_sum_amt" },
  { label: "Contributions and grants received, current year", where: "Part I, line 8", key: "part_i_line_8_cy_contributions_grants_amt" },
  { label: "Total revenue, current year", where: "Part I, line 12", key: "part_i_line_12_cy_total_revenue_amt" },
  { label: "Grants and similar amounts paid, current year (includes grants to individuals)", where: "Part I, line 13", key: "part_i_line_13_cy_grants_and_similar_paid_amt" },
  { label: "Total expenses, current year", where: "Part I, line 18", key: "part_i_line_18_cy_total_expenses_amt" },
  { label: "Total assets, end of year", where: "Part I, line 20", key: "part_i_line_20_total_assets_eoy_amt" },
  { label: "Net assets or fund balances, end of year", where: "Part I, line 22", key: "part_i_line_22_net_assets_eoy_amt" },
];

export default async function CharityPageRoute({ params, searchParams }: { params: { ein: string }; searchParams: Record<string, string | string[] | undefined> }) {
  if (!/^\d{9}$/.test(params.ein)) notFound();
  const supabase = createClient();
  const period = typeof searchParams.period === "string" && /^\d{4}-\d{2}-\d{2}$/.test(searchParams.period) ? searchParams.period : null;
  const gp = Number.parseInt(typeof searchParams.gpage === "string" ? searchParams.gpage : "1", 10);
  const gpage = Number.isFinite(gp) && gp >= 1 ? gp : 1;

  const [page, statuses] = await Promise.all([loadCharityPage(supabase, params.ein, period, gpage), loadCharityStateStatuses(supabase)]);
  if (!page) notFound();

  const o = page.org;
  const chip = o.state ? charityStateChip(statuses[o.state]) : null;
  const kinds = kindLabels(o.is_grantmaking_public_charity, o.is_daf_sponsor);

  return (
    <div style={{ maxWidth: 1100 }}>
      <Link href="/funders/charities" style={{ ...buttonSecondary, padding: "6px 12px" }}>
        ← All public charities and sponsors
      </Link>

      <header style={{ marginTop: spacing.lg }}>
        <h1 style={{ fontSize: typeScale.pageTitle, margin: 0 }}>{funderName([o.legal_name_line1, o.legal_name_line2].filter(Boolean).join(" "))}</h1>
        <p style={{ color: colors.textMuted, fontSize: typeScale.body, marginTop: spacing.xs }}>
          {placeLine(o.city, o.state)} · EIN {formatEin(o.ein)} · Form 990 filer
        </p>
        <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap", marginTop: spacing.sm }}>
          {kinds.map((k) => (
            <span key={k} style={chipStyle(k.startsWith("Donor") ? "amber" : "teal")}>
              {k}
            </span>
          ))}
          {chip && (
            <span style={chipStyle(chip.tone)}>
              {US_STATES[o.state!]}: {chip.text}
            </span>
          )}
        </div>
      </header>

      <div style={{ display: "grid", gap: spacing.xl, marginTop: spacing.xl }}>
        <Identity page={page} />
        <Kind page={page} />
        <Figures page={page} />
        {(o.is_daf_sponsor || page.daf.length > 0) && <Daf page={page} />}
        <Recipients page={page} gpage={gpage} />
        <Sources page={page} />
      </div>
      <p style={{ ...muted, marginTop: spacing.xl }}>
        Every value on this page was read from the IRS filing named beside it. A value the filing does not carry is shown as “{NOT_STATED.toLowerCase()}”, never as zero, and a tax period the database does not hold is shown as “{NOT_HELD.toLowerCase()}”, never as a year the funder gave nothing. {NO_DONOR_STATEMENT}
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
  return (
    <div style={{ display: "flex", flexWrap: "wrap", columnGap: spacing.md, rowGap: 2, padding: `${spacing.xs}px 0` }}>
      <dt style={{ ...muted, margin: 0, flex: "0 0 200px" }}>{term}</dt>
      <dd style={{ margin: 0, fontSize: typeScale.body, flex: "1 1 240px", minWidth: 0, overflowWrap: "anywhere" }}>{children}</dd>
    </div>
  );
}

function Amt({ v }: { v: number | null | undefined }) {
  return v === null || v === undefined ? <Absent /> : <>{formatAmount(v)}</>;
}

function Identity({ page }: { page: CharityPage }) {
  const o = page.org;
  const addr = [o.care_of_name ? `c/o ${o.care_of_name}` : null, o.address_line1, o.address_line2, [o.city, o.state, o.zip].filter(Boolean).join(" "), o.country].filter((x) => x && String(x).trim()).join(", ");
  return (
    <section aria-labelledby="identity" style={sectionStyle}>
      <h2 id="identity" style={h2}>
        Who it is
      </h2>
      <p style={{ ...muted, margin: 0 }}>
        As given on its latest return held, period ending {formatPeriodEnd(o.source_tax_period_end)} · <FilingLink objectId={o.source_object_id}>filing {o.source_object_id}</FilingLink>.
      </p>
      <dl style={{ margin: 0 }}>
        <Row term="Name">{funderName([o.legal_name_line1, o.legal_name_line2].filter(Boolean).join(" "))}</Row>
        <Row term="Address">{addr || <Absent />}</Row>
        <Row term="Phone">{o.phone_as_stated ?? <Absent />}</Row>
        <Row term="Website, as written">{o.website_as_stated ?? <Absent />}</Row>
        <Row term="Mission, as written">{o.mission_as_stated ?? <Absent />}</Row>
      </dl>
    </section>
  );
}

function Kind({ page }: { page: CharityPage }) {
  const o = page.org;
  const basis = [...o.kind_basis].sort((a, b) => b.tax_period_end.localeCompare(a.tax_period_end));
  const figureFiling = (end: string) => page.figures.find((f) => f.tax_period_end === end)?.filing_object_id;
  return (
    <section aria-labelledby="kind" style={sectionStyle}>
      <h2 id="kind" style={h2}>
        Why it is in this list
      </h2>
      <p style={{ margin: 0, fontSize: typeScale.body }}>
        {o.is_grantmaking_public_charity && <>A grantmaking public charity: a return states grants to domestic organizations of at least {formatAmount(o.kind_threshold_org_grants_amt)}. </>}
        {o.is_daf_sponsor && <>A donor-advised fund sponsor: a return states at least one donor-advised fund on Schedule D, Part I, line 1, column (a).</>}
      </p>
      <p style={{ ...muted, margin: 0 }}>The rule, as the loader applied it: {o.kind_rule}</p>
      <div style={tableWrapStyle}>
        <table style={tableStyle}>
          <caption style={{ ...muted, textAlign: "left", padding: `${spacing.xs}px 0` }}>The two figures the rule used, for every return it read (a figure a return does not state is shown as not stated, not zero)</caption>
          <thead>
            <tr>
              <th scope="col" style={thStyle}>Period ending</th>
              <th scope="col" style={{ ...thStyle, textAlign: "right" }}>Grants to domestic organizations (Part IX, line 1)</th>
              <th scope="col" style={{ ...thStyle, textAlign: "right" }}>Donor-advised funds held (Schedule D)</th>
              <th scope="col" style={thStyle}>Main form box (Part IV, line 6)</th>
              <th scope="col" style={thStyle}>Source</th>
            </tr>
          </thead>
          <tbody>
            {basis.map((b, i) => (
              <tr key={`${b.tax_period_end}-${i}`}>
                <th scope="row" style={{ ...tdStyle, textAlign: "left", fontWeight: 500 }}>{formatPeriodEnd(b.tax_period_end)}</th>
                <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}><Amt v={b.grants_to_domestic_orgs_amt} /></td>
                <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{b.donor_advised_funds_held_cnt === null ? <Absent /> : formatCount(b.donor_advised_funds_held_cnt)}</td>
                <td style={tdStyle}>{b.donor_advised_fund_box === null ? <Absent /> : b.donor_advised_fund_box ? "Ticked" : "Not ticked"}</td>
                <td style={tdStyle}>{figureFiling(b.tax_period_end) ? <FilingLink objectId={figureFiling(b.tax_period_end)!} /> : <Absent>Replaced by a later return</Absent>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Figures({ page }: { page: CharityPage }) {
  return (
    <section aria-labelledby="figures" style={sectionStyle}>
      <h2 id="figures" style={h2}>
        Size and giving, by tax period
      </h2>
      <p style={{ ...muted, margin: 0 }}>One column per tax period the database holds. There is no single “giving” figure: each row is named for the line it comes from.</p>
      <div style={tableWrapStyle}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th scope="col" style={thStyle}>Figure</th>
              {TAX_YEARS.map((y) => (
                <th key={y} scope="col" style={{ ...thStyle, textAlign: "right" }}>{y}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FIGURE_ROWS.map((r) => (
              <tr key={r.key}>
                <th scope="row" style={{ ...tdStyle, textAlign: "left", fontWeight: 500, minWidth: 280 }}>
                  {r.label}
                  <div style={muted}>{r.where}</div>
                </th>
                {TAX_YEARS.map((y) => {
                  const f = page.figures.find((x) => x.tax_period_end.startsWith(String(y)));
                  return (
                    <td key={y} style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {!f ? <Absent>{NOT_HELD}</Absent> : (
                        <>
                          <Amt v={f[r.key] as number | null} />
                          <div><FilingLink objectId={f.filing_object_id} /></div>
                        </>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <h3 style={{ fontSize: typeScale.body, margin: `${spacing.sm}px 0 ${spacing.xs}px` }}>Which years the database holds</h3>
        <ul style={{ margin: 0, paddingLeft: spacing.lg, fontSize: typeScale.body }}>
          {TAX_YEARS.map((y) => {
            const c = page.coverage.find((x) => x.period_year === y);
            return (
              <li key={y}>
                <strong>{y}:</strong> {coverageText(c?.status, c?.note)} {c?.filing_object_id && <FilingLink objectId={c.filing_object_id} />}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function Daf({ page }: { page: CharityPage }) {
  return (
    <section aria-labelledby="daf" style={sectionStyle}>
      <h2 id="daf" style={h2}>
        Donor-advised funds (Schedule D, Part I)
      </h2>
      <p style={{ ...muted, margin: 0 }}>Counts and totals as filed. Column (a) is donor-advised funds; column (b), “funds and other accounts”, is not donor-advised funds and is shown on its own rows. {NO_DONOR_STATEMENT} {DAF_COUNT_CAVEAT}</p>
      {page.daf.length === 0 ? (
        <Absent>No Schedule D figures held for this funder.</Absent>
      ) : (
        <div style={tableWrapStyle}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th scope="col" style={thStyle}>Period ending</th>
                <th scope="col" style={{ ...thStyle, textAlign: "right" }}>Funds held (a)</th>
                <th scope="col" style={{ ...thStyle, textAlign: "right" }}>Contributions (a)</th>
                <th scope="col" style={{ ...thStyle, textAlign: "right" }}>Grants paid out (a)</th>
                <th scope="col" style={{ ...thStyle, textAlign: "right" }}>Value, end of year (a)</th>
                <th scope="col" style={{ ...thStyle, textAlign: "right" }}>Other funds held (b)</th>
                <th scope="col" style={{ ...thStyle, textAlign: "right" }}>Other funds, value (b)</th>
                <th scope="col" style={thStyle}>Source</th>
              </tr>
            </thead>
            <tbody>
              {page.daf.map((d) => (
                <tr key={d.filing_object_id}>
                  <th scope="row" style={{ ...tdStyle, textAlign: "left", fontWeight: 500 }}>{formatPeriodEnd(d.tax_period_end)}</th>
                  <td style={{ ...tdStyle, textAlign: "right" }}>{d.daf_held_cnt === null ? <Absent /> : formatCount(d.daf_held_cnt)}</td>
                  <td style={{ ...tdStyle, textAlign: "right" }}><Amt v={d.daf_contributions_amt} /></td>
                  <td style={{ ...tdStyle, textAlign: "right" }}><Amt v={d.daf_grants_amt} /></td>
                  <td style={{ ...tdStyle, textAlign: "right" }}><Amt v={d.daf_value_eoy_amt} /></td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>{d.other_funds_held_cnt === null ? <Absent /> : formatCount(d.other_funds_held_cnt)}</td>
                  <td style={{ ...tdStyle, textAlign: "right" }}><Amt v={d.other_funds_value_eoy_amt} /></td>
                  <td style={tdStyle}><FilingLink objectId={d.filing_object_id} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Recipients({ page, gpage }: { page: CharityPage; gpage: number }) {
  const g = page.grants;
  const o = page.org;
  const pages = pageCount(g.total, GRANTS_PAGE_SIZE);
  const href = (p: string | null, n: number) => {
    const q = new URLSearchParams();
    if (p) q.set("period", p);
    if (n > 1) q.set("gpage", String(n));
    const s = q.toString();
    return `/funders/charities/${o.ein}${s ? `?${s}` : ""}#recipients`;
  };
  return (
    <section aria-labelledby="recipients" style={sectionStyle}>
      <h2 id="recipients" style={h2}>
        Recipients listed on Schedule I
      </h2>
      <p style={{ ...muted, margin: 0 }}>
        The recipient organizations the return lists, largest cash grant first, for the period chosen. Only recipients that are organizations are held; no grant to an individual is stored. {o.is_daf_sponsor ? NO_DONOR_STATEMENT : ""}
      </p>
      {page.figures.length > 1 && (
        <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap" }}>
          {page.figures.map((f) => (
            <Link key={f.tax_period_end} href={href(f.tax_period_end, 1)} aria-current={f.tax_period_end === g.period ? "true" : undefined} style={{ ...buttonSecondary, padding: "4px 10px", fontWeight: f.tax_period_end === g.period ? 700 : 400 }}>
              {formatPeriodEnd(f.tax_period_end)}
            </Link>
          ))}
        </div>
      )}
      {!g.period ? (
        <Absent>{NOT_HELD}</Absent>
      ) : g.total === 0 ? (
        <Absent>The return for the period ending {formatPeriodEnd(g.period)} lists no recipient on Schedule I in this database.</Absent>
      ) : (
        <>
          <p style={{ margin: 0, fontSize: typeScale.body }}>
            <strong>{g.total.toLocaleString("en-US")}</strong> recipient {g.total === 1 ? "row" : "rows"} for the period ending {formatPeriodEnd(g.period)} · <FilingLink objectId={g.rows[0]?.filing_object_id ?? ""}>source filing</FilingLink>
          </p>
          <div style={tableWrapStyle}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th scope="col" style={thStyle}>Recipient</th>
                  <th scope="col" style={thStyle}>Place</th>
                  <th scope="col" style={thStyle}>EIN, as written</th>
                  <th scope="col" style={{ ...thStyle, textAlign: "right" }}>Cash grant</th>
                  <th scope="col" style={{ ...thStyle, textAlign: "right" }}>Non-cash assistance</th>
                  <th scope="col" style={thStyle}>Purpose, as written</th>
                </tr>
              </thead>
              <tbody>
                {g.rows.map((r) => (
                  <tr key={`${r.filing_object_id}-${r.ordinal}`}>
                    <th scope="row" style={{ ...tdStyle, textAlign: "left", fontWeight: 500, minWidth: 220 }}>{funderName([r.recipient_name_line1, r.recipient_name_line2].filter(Boolean).join(" ")).replace("Name not stated on the return", NOT_STATED)}</th>
                    <td style={tdStyle}>{[r.recipient_city, r.recipient_state, r.recipient_country].filter(Boolean).join(", ") || <Absent />}</td>
                    <td style={tdStyle}>{r.recipient_ein_as_stated ?? <Absent />}</td>
                    <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}><Amt v={r.cash_grant_amt} /></td>
                    <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      <Amt v={r.noncash_assistance_amt} />
                      {r.noncash_assistance_desc && <div style={muted}>{r.noncash_assistance_desc}</div>}
                    </td>
                    <td style={{ ...tdStyle, minWidth: 200 }}>{r.purpose_as_stated ?? <Absent />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <nav aria-label="Pages of recipients" style={{ display: "flex", gap: spacing.sm, alignItems: "center", flexWrap: "wrap" }}>
              {gpage > 1 && (
                <Link href={href(g.period, gpage - 1)} style={buttonSecondary} rel="prev">
                  ← Previous
                </Link>
              )}
              <span style={muted}>
                Page {gpage.toLocaleString("en-US")} of {pages.toLocaleString("en-US")}
              </span>
              {gpage < pages && (
                <Link href={href(g.period, gpage + 1)} style={buttonSecondary} rel="next">
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

function Sources({ page }: { page: CharityPage }) {
  return (
    <section aria-labelledby="sources" style={sectionStyle}>
      <h2 id="sources" style={h2}>
        The filings behind this page
      </h2>
      <p style={{ ...muted, margin: 0 }}>Each filing the database holds for this funder, with where the document can be read and which version of the loader read it.</p>
      {page.filings.length === 0 ? (
        <Absent>{NOT_HELD}</Absent>
      ) : (
        <div style={{ display: "grid", gap: spacing.sm }}>
          {page.filings.map((x) => (
            <div key={x.object_id} id={filingAnchor(x.object_id)} style={{ ...cardStyle, scrollMarginTop: spacing.xl }}>
              <div style={{ display: "flex", gap: spacing.sm, alignItems: "center", flexWrap: "wrap" }}>
                <strong>{x.tax_period_end ? `Period ending ${formatPeriodEnd(x.tax_period_end)}` : "Period not read"}</strong>
                <span style={chipStyle(x.status === "loaded" ? "teal" : x.status === "unread" ? "red" : "neutral")}>
                  {x.status === "loaded" ? "Loaded" : x.status === "unread" ? "Could not be read" : "Replaced by a later return"}
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
