// Item 110: what is in the funder reference tables, measured. Read-only.
//
// Prints, from the data itself: row counts and on-disk sizes, the runs and their
// recorded outcomes, filings by status, why filings are unread, which tax periods
// are held and which are not, the quality of the grant lists (stated total against
// listed rows, foreign recipients, unmapped elements), and how funders say they
// take requests. Every number names the set it ranges over (ruling 0021).
//
// Usage: npx tsx scripts/funder-reference-stats.ts --db pglite:<dir>

import { resolve } from "node:path";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const spec = arg("db");
  if (!spec?.startsWith("pglite:")) {
    console.error("usage: --db pglite:<dir>   (the live-project reader is the verifier; this script measures a local load)");
    process.exit(2);
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite(resolve(spec.slice(7)));
  await db.waitReady;
  const q = async (sql: string) => (await db.query(sql)).rows as Array<Record<string, unknown>>;
  const show = async (title: string, sql: string) => {
    console.log(`\n== ${title}`);
    const rows = await q(sql);
    if (rows.length === 0) console.log("   (no rows)");
    else console.table(rows);
  };

  await show(
    "table row counts and on-disk size (heap + indexes + toast)",
    `select c.relname as table_name,
            (xpath('/row/c/text()', query_to_xml('select count(*) as c from '||c.relname, false, true, '')))[1]::text::bigint as row_count,
            pg_size_pretty(pg_total_relation_size(c.oid)) as size
       from pg_class c where c.relname like 'funder\\_reference\\_%' escape '\\' and c.relkind = 'r' order by 1`
  );
  await show("runs", `select left(id::text, 8) as run, status, loader_version, to_char(started_at,'HH24:MI:SS') as started, extract(epoch from (finished_at - started_at))::int as seconds, parameters->'threshold' as threshold, parameters->>'state' as state, (counts->>'index_rows_considered') as considered from funder_reference_runs order by started_at`);
  await show(
    "outcomes of the latest completed run (each index row ends in exactly one of these)",
    `select k as outcome, v::text as rows from funder_reference_runs r, jsonb_each(r.counts) e(k, v)
      where r.id = (select id from funder_reference_runs where status = 'completed' order by started_at desc limit 1)
        and k in ('index_rows_considered','out_of_scope_state','status_unread','unread_not_located','status_skipped_below_threshold','status_loaded','status_superseded','outcomes_sum_check','rows_written','rows_unchanged','full_reads','header_reads_used','header_said_in_state_but_return_disagrees','foundations_in_scope','foundations_below_threshold','coverage_loaded','coverage_unread','coverage_no_filing_in_index','loaded_filings_with_unmapped_grant_fields','loaded_filings_whose_listed_grants_differ_from_stated_total','loaded_filings_with_stated_grants_and_no_listed_rows')`
  );
  await show("header audit of the latest completed run", `select counts->'header_audit' as header_audit from funder_reference_runs where status = 'completed' order by started_at desc limit 1`);
  await show("filings by status", `select status, count(*)::int as filings, count(distinct ein)::int as funders from funder_reference_filings group by 1 order by 2 desc`);
  await show(
    "why filings are unread (first words of the recorded reason)",
    `select left(regexp_replace(regexp_replace(status_note, '[0-9]{4}_TEOS_XML_[0-9]{2}[A-Za-z]', '<archive>', 'g'), '[0-9]{9,}', '#', 'g'), 110) as reason, count(*)::int as filings from funder_reference_filings where status = 'unread' group by 1 order by 2 desc limit 15`
  );
  await show(
    "unread filings whose funder is otherwise held (a gap inside a funder we have)",
    `select f.index_tax_period as index_period, count(*)::int as unread_filings from funder_reference_filings f
      where f.status = 'unread' and exists (select 1 from funder_reference_foundations o where o.ein = f.ein) group by 1 order by 1`
  );
  await show("tax periods held per funder in scope (coverage), by period year", `select period_year, status, count(*)::int as funders from funder_reference_period_coverage group by 1, 2 order by 1, 2`);
  await show(
    "how many of the three periods each funder in scope holds",
    `select held as periods_held, count(*)::int as funders from (select ein, count(*) filter (where status = 'loaded') as held from funder_reference_period_coverage group by ein) x group by 1 order by 1`
  );
  await show("funders by state of the filer's address (every row should be the requested state)", `select state, count(*)::int as funders from funder_reference_foundations group by 1 order by 2 desc limit 5`);
  await show("funders: private operating foundation flag as stated", `select coalesce(private_operating_foundation_ind::text, 'not stated') as private_operating, count(*)::int as funders from funder_reference_foundations group by 1 order by 2 desc`);
  await show(
    "funders by largest fair-market-value assets over their periods (set: funders in scope)",
    `select case when m >= 100000000 then '>= 100M' when m >= 10000000 then '10M-100M' when m >= 5000000 then '5M-10M' when m >= 1000000 then '1M-5M' when m is null then 'not stated' else '< 1M' end as band, count(*)::int as funders
       from (select ein, max(coalesce(total_assets_eoy_fmv_amt, fmv_assets_eoy_amt)) as m from funder_reference_figures group by ein) x group by 1 order by min(coalesce(m, -1)) desc`
  );
  await show(
    "funders by largest contributions paid per books over their periods",
    `select case when m >= 5000000 then '>= 5M' when m >= 1000000 then '1M-5M' when m >= 250000 then '250k-1M' when m >= 100000 then '100k-250k' when m is null then 'not stated' else '< 100k' end as band, count(*)::int as funders
       from (select ein, max(contributions_paid_per_books_amt) as m from funder_reference_figures group by ein) x group by 1 order by min(coalesce(m, -1)) desc`
  );
  await show(
    "grant lists: rows per standing filing (set: standing filings with a figures row)",
    `select count(*)::int as filings, min(n) as fewest, percentile_disc(0.5) within group (order by n) as median, percentile_disc(0.9) within group (order by n) as p90, max(n) as most,
            count(*) filter (where n = 0)::int as filings_with_no_listed_grants
       from (select f.filing_object_id, (select count(*) from funder_reference_grants g where g.filing_object_id = f.filing_object_id and g.kind = 'paid_during_year') as n from funder_reference_figures f) x`
  );
  await show(
    "grant lists against what the return says it paid (set: standing filings with a figures row)",
    `select case when grants_paid_stated_total_amt is null then 'Part XV total: not stated' when grants_paid_stated_total_amt = 0 then 'Part XV total: 0' else 'Part XV total: > 0' end as stated_total,
            case when grants_listed_count is null then 'no rows listed' else 'rows listed' end as listed,
            case when contributions_paid_per_books_amt is null then 'paid per books: not stated' when contributions_paid_per_books_amt = 0 then 'paid per books: 0' else 'paid per books: > 0' end as paid_per_books,
            count(*)::int as filings, coalesce(sum(contributions_paid_per_books_amt), 0)::bigint as sum_paid_per_books
       from funder_reference_figures group by 1, 2, 3 order by 4 desc`
  );
  await show(
    "listed rows against the stated Part XV total (set: standing filings that state a total and list rows)",
    `select count(*)::int as filings, count(*) filter (where grants_listed_minus_stated_amt = 0)::int as listed_equals_stated, count(*) filter (where grants_listed_minus_stated_amt <> 0)::int as listed_differs_from_stated
       from funder_reference_figures where grants_paid_stated_total_amt is not null and grants_listed_count is not null`
  );
  await show(
    "filings where the listed grants differ from the stated total, by size of the gap",
    `select case when abs(grants_listed_minus_stated_amt) <= 5 then '<= $5 (rounding)' when abs(grants_listed_minus_stated_amt) <= 1000 then '<= $1,000' when grants_paid_stated_total_amt > 0 and abs(grants_listed_minus_stated_amt)::numeric / grants_paid_stated_total_amt > 0.1 then '> 10% of stated' else '$1,000 .. 10% of stated' end as gap, count(*)::int as filings
       from funder_reference_figures where grants_listed_minus_stated_amt <> 0 group by 1 order by 2 desc`
  );
  await show("grant rows: kinds, foreign recipients, rows using the person-name field (filers sometimes put an organization there), rows with no amount, rows with unmapped elements", `select kind, count(*)::int as rows, count(*) filter (where recipient_country is not null)::int as foreign_recipient, count(*) filter (where recipient_person_name is not null)::int as person_recipient, count(*) filter (where amount_amt is null)::int as no_amount, count(*) filter (where unmapped_fields <> '{}'::jsonb)::int as with_unmapped_elements, count(*) filter (where purpose_as_stated is null)::int as no_purpose from funder_reference_grants group by 1`);
  await show(
    "where the grant rows are listed (the return element that held them)",
    `select listed_in_element, count(*)::int as rows from funder_reference_grants group by 1 order by 2 desc`
  );
  await show(
    "how funders say they take requests (set: standing filings)",
    `select coalesce(only_preselected_charities_raw, '(no mark on the return)') as preselected_box, count(*)::int as filings, count(distinct ein)::int as funders, count(*) filter (where jsonb_array_length(application_groups) > 0)::int as filings_with_application_details from funder_reference_application_terms group by 1 order by 2 desc`
  );
  await show(
    "funders with at least one filing that leaves the preselected box unmarked and gives application details",
    `select count(distinct a.ein)::int as funders from funder_reference_application_terms a where a.only_preselected_charities_raw is null and jsonb_array_length(a.application_groups) > 0`
  );
  await show("people: rows by where listed; with compensation; hours not stated", `select listed_in, count(*)::int as rows, count(distinct ein)::int as funders, count(*) filter (where compensation_amt > 0)::int as with_compensation, count(*) filter (where hours_per_week_as_stated is null)::int as hours_not_stated, count(*) filter (where name_as_named is null)::int as no_name from funder_reference_people group by 1`);
  await show("websites as stated on the returns (set: funders in scope)", `select case when website_as_stated is null then '(no element)' when upper(website_as_stated) in ('N/A','NA','NONE','N.A.') then 'N/A or none' else 'a value' end as website, count(*)::int as funders from funder_reference_foundations group by 1 order by 2 desc`);
  await show(
    "privacy scan: SSN-shaped strings (NNN-NN-NNNN or nine digits in a row) in any stored text of people, grants, foundations and application terms",
    `select (select count(*) from funder_reference_people x where to_jsonb(x)::text ~ '[0-9]{3}-[0-9]{2}-[0-9]{4}')::int as people_rows,
            (select count(*) from funder_reference_grants x where (to_jsonb(x) - 'amount_amt' - 'recipient_zip' - 'ein' - 'filing_object_id')::text ~ '[0-9]{3}-[0-9]{2}-[0-9]{4}')::int as grant_rows,
            (select count(*) from funder_reference_foundations x where to_jsonb(x)::text ~ '[0-9]{3}-[0-9]{2}-[0-9]{4}')::int as foundation_rows,
            (select count(*) from funder_reference_application_terms x where to_jsonb(x)::text ~ '[0-9]{3}-[0-9]{2}-[0-9]{4}')::int as application_rows`
  );
  await show("raw sizes: average XML bytes per standing filing", `select count(*)::int as filings, pg_size_pretty(avg(xml_bytes)::bigint) as avg_xml, pg_size_pretty(sum(xml_bytes)::bigint) as total_xml_read from funder_reference_filings where status = 'loaded'`);
  await db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
