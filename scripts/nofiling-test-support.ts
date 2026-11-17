// Shared seeding for the tests of funders that file no return (item 119): a foundation or a charity with filings, figures and grants, on a
// real Postgres (PGlite) with every migration applied. Used by test-nofiling-leads.ts and test-exempt-list.ts.
import type { PGlite } from "@electric-sql/pglite";

let counter = 1;
export const objId = () => "2024" + String(counter++).padStart(14, "0");

export interface Grant { name: string; amt: number | null; st?: string; purpose?: string; end?: string; city?: string; rein?: string }

export async function seedFoundation(db: PGlite, ein: string, name: string, preselected: boolean, grants: Grant[]): Promise<void> {
  const byEnd = new Map<string, string>();
  for (const g of grants) {
    const end = g.end ?? "2024-12-31";
    if (!byEnd.has(end)) {
      const id = objId();
      byEnd.set(end, id);
      await db.query(
        `insert into funder_reference_filings (object_id, ein, return_type, index_tax_period, tax_period_end, status, index_file, document_archive_url, document_member, loaded_at, loader_version)
         values ($1, $2, '990PF', $3, $4, 'loaded', 'i.csv', 'https://apps.irs.gov/x.zip', $5, now(), 't')`,
        [id, ein, end.slice(0, 4) + end.slice(5, 7), end, `${id}_public.xml`]
      );
      await db.query(
        `insert into funder_reference_figures (ein, tax_period_end, filing_object_id, fmv_assets_eoy_amt, contributions_paid_per_books_amt, financial_statement_values, grants_listed_count, grants_listed_derivation, loaded_at, loader_version)
         values ($1, $2, $3, 9000000, 400000, '{}', $4, 'x', now(), 't')`,
        [ein, end, id, grants.length]
      );
      await db.query(
        `insert into funder_reference_application_terms (filing_object_id, ein, tax_period_end, only_preselected_charities_raw, only_preselected_charities_box_checked, loaded_at, loader_version)
         values ($1, $2, $3, $4, $5, now(), 't')`,
        [id, ein, end, preselected ? "X" : null, preselected]
      );
    }
  }
  const latestEnd = [...byEnd.keys()].sort().reverse()[0];
  await db.query(
    `insert into funder_reference_foundations (ein, source_object_id, source_tax_period_end, legal_name_line1, city, state, loaded_at, loader_version)
     values ($1, $2, $3, $4, 'TULSA', 'OK', now(), 't')`,
    [ein, byEnd.get(latestEnd), latestEnd, name]
  );
  let ord = 0;
  for (const g of grants) {
    const end = g.end ?? "2024-12-31";
    await db.query(
      `insert into funder_reference_grants (filing_object_id, kind, ordinal, ein, tax_period_end, listed_in_element, recipient_name_line1, recipient_state, recipient_city, purpose_as_stated, amount_amt, loaded_at, loader_version)
       values ($1, 'paid_during_year', $2, $3, $4, 'SupplementaryInformationGrp', $5, $6, $9, $7, $8, now(), 't')`,
      [byEnd.get(end), ++ord, ein, end, g.name, g.st ?? null, g.purpose ?? null, g.amt, g.city ?? null]
    );
  }
}

export async function seedCharity(db: PGlite, ein: string, name: string, grants: Grant[], daf = false): Promise<void> {
  const id = objId();
  await db.query(
    `insert into charity_reference_filings (object_id, ein, return_type, index_tax_period, tax_period_end, status, index_file, document_archive_url, document_member, loaded_at, loader_version)
     values ($1, $2, '990', '202412', '2024-12-31', 'loaded', 'i.csv', 'https://apps.irs.gov/x.zip', $3, now(), 't')`,
    [id, ein, `${id}_public.xml`]
  );
  await db.query(
    `insert into charity_reference_figures (ein, tax_period_end, filing_object_id, part_ix_line_1_grants_domestic_orgs_total_amt, part_i_line_20_total_assets_eoy_amt, has_schedule_i, has_schedule_d, schedule_i_rows_listed_count, schedule_i_listed_derivation, form_places, loaded_at, loader_version)
     values ($1, '2024-12-31', $2, 900000, 5000000, true, false, $3, 'x', '{}', now(), 't')`,
    [ein, id, grants.length]
  );
  await db.query(`insert into charity_reference_period_coverage (ein, period_year, status, filing_object_id, note, checked_at) values ($1, 2024, 'loaded', $2, 'loaded', now())`, [ein, id]);
  await db.query(
    `insert into charity_reference_organizations (ein, source_object_id, source_tax_period_end, legal_name_line1, city, state, is_grantmaking_public_charity, is_daf_sponsor, kind_rule, kind_threshold_org_grants_amt, kind_basis, loaded_at, loader_version)
     values ($1, $2, '2024-12-31', $3, 'AUSTIN', 'TX', true, $4, 'r', 100000, '[]'::jsonb, now(), 't')`,
    [ein, id, name, daf]
  );
  let ord = 0;
  for (const g of grants) {
    await db.query(
      `insert into charity_reference_grants (filing_object_id, ordinal, ein, tax_period_end, form_type, source_location, recipient_name_line1, recipient_state, purpose_as_stated, cash_grant_amt, recipient_ein_as_stated, recipient_city, loaded_at, loader_version)
       values ($1, $2, $3, '2024-12-31', '990', 'Schedule I', $4, $5, $6, $7, $8, $9, now(), 't')`,
      [id, ++ord, ein, g.name, g.st ?? null, g.purpose ?? null, g.amt, g.rein ?? null, g.city ?? null]
    );
  }
}


