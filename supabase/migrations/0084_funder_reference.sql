-- STATE item 110, authorized by ruling 0045: the platform's own reference
-- database of US grant-making organizations, built from public IRS Form 990-PF
-- filings (California pilot).
--
-- THIS IS DELIBERATELY NOT TENANT DATA. Hard rule 6 (organization_id + an RLS
-- policy scoped by it) does NOT apply to these tables, and ruling 0045 clause 1
-- says so on purpose: they hold public documents that are the same for every
-- organization and nothing any organization wrote. What replaces the rule:
--
--   * READ: every signed-in member of any organization (my_organization_id() is
--     not null), no one else. anon reads nothing.
--   * WRITE: no application role. Row-level security has NO insert/update/delete
--     policy for any role, AND the table privileges for insert/update/delete/
--     truncate are revoked from anon and authenticated (Supabase grants them by
--     default; relying on RLS alone would leave one missing policy away from an
--     open table). Only service_role writes, and only the offline loader
--     (scripts/load-funder-reference.ts) holds that key. Nothing in app/ or lib/
--     (outside lib/funder-reference/) touches these tables; a source scan in
--     scripts/test-funder-reference-migration.ts holds that line.
--   * Everything an organization adds about a funder (notes, status, a prospect)
--     stays in its own org-scoped tables and refers to a funder here by EIN.
--
-- WHAT EVERY VALUE CARRIES (clause 2). Each data row names its filing by
-- (filing_object_id, ein, tax_period_end) through a COMPOSITE foreign key to
-- funder_reference_filings, so the denormalized EIN and period cannot disagree
-- with the filing. The filing row carries where the document can be read (the
-- IRS archive URL and the member inside it), when it was loaded and by which
-- loader version, and the SHA-256 of the exact XML that was read.
--
-- WHAT A FIGURE IS (clause 3). Keyed by tax period END DATE. Figures that sound
-- alike are separate columns named for the form's own line. There is no column
-- called "giving". Derived figures sit beside a column that names the set they
-- were computed over and the figures they used.
--
-- WHAT IS ABSENT STAYS ABSENT (clause 4). Every value column is nullable; null
-- means "the filing does not carry it", never zero or empty text. A tax period
-- the IRS index does not list is a funder_reference_period_coverage row with
-- status 'no_filing_in_index', not a row of zeros.
--
-- PEOPLE (clause 5). One row per person per filing, as named. No person table,
-- no key shared across filings.
--
-- THE LOADER (clause 6). It writes a filing and everything under it through ONE
-- function, funder_reference_apply_filing(jsonb), so a filing is replaced
-- atomically and a crash never leaves half of one. The function is executable
-- by service_role only.

-- ---------------------------------------------------------------------------
-- runs: recorded before they run (ruling 0026), finished at the end
-- ---------------------------------------------------------------------------
create table funder_reference_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  loader_version text not null,
  status text not null check (status in ('running', 'completed', 'failed', 'interrupted')),
  parameters jsonb not null,            -- every knob the run used, incl. the size threshold
  sources jsonb not null default '[]',  -- index files / archives read, with sizes and hashes
  counts jsonb not null default '{}',   -- rows read / loaded / rejected, by name
  rejected_filings jsonb not null default '[]', -- each unread filing: object_id, ein, reason
  notes text
);

-- ---------------------------------------------------------------------------
-- filings: one row per IRS return the loader considered in scope
-- ---------------------------------------------------------------------------
create table funder_reference_filings (
  object_id text primary key check (object_id ~ '^[0-9]{18}$'),   -- the IRS OBJECT_ID
  ein text not null check (ein ~ '^[0-9]{9}$'),
  return_type text not null,                                      -- '990PF'
  index_tax_period text not null check (index_tax_period ~ '^[0-9]{6}$'), -- yyyymm as the IRS index gives it
  tax_period_end date,                                            -- from the return itself; null only when unread
  tax_period_begin date,
  tax_year text,
  return_version text,
  return_ts timestamptz,
  status text not null check (status in ('loaded', 'superseded', 'unread', 'skipped_below_threshold')),
  status_note text,                                               -- the reason, for every status but 'loaded'
  superseded_by_object_id text references funder_reference_filings (object_id),
  -- where the document can be read
  index_file text not null,                                       -- e.g. index_2025.csv
  index_return_id text,
  index_sub_year integer,
  document_archive_url text not null,                             -- the IRS zip
  document_member text not null,                                  -- the file inside it
  xml_sha256 text,                                                -- of the exact bytes parsed
  xml_bytes integer,
  -- when and by what
  run_id uuid references funder_reference_runs (id),
  loaded_at timestamptz not null,
  loader_version text not null,
  unique (object_id, ein, tax_period_end),
  check (status = 'unread' or tax_period_end is not null),
  check ((status = 'loaded') = (status_note is null)),
  check ((status = 'superseded') = (superseded_by_object_id is not null))
);
create index funder_reference_filings_ein_idx on funder_reference_filings (ein, tax_period_end);

-- ---------------------------------------------------------------------------
-- foundations: one row per EIN, as it identified itself on its latest filing
-- ---------------------------------------------------------------------------
create table funder_reference_foundations (
  ein text primary key check (ein ~ '^[0-9]{9}$'),
  source_object_id text not null,
  source_tax_period_end date not null,           -- the filing every column below was read from
  legal_name_line1 text,
  legal_name_line2 text,
  care_of_name text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  zip text,
  country text,                                  -- null for a US address
  phone_as_stated text,
  fiscal_year_end_month integer check (fiscal_year_end_month between 1 and 12),
  private_operating_foundation_ind boolean,      -- null = the return does not say
  website_as_stated text,                        -- exactly what the return wrote, e.g. 'N/A'; never a derived URL
  books_contact_name text,
  books_contact_phone text,
  loaded_at timestamptz not null,
  loader_version text not null,
  foreign key (source_object_id, ein, source_tax_period_end)
    references funder_reference_filings (object_id, ein, tax_period_end)
);

-- ---------------------------------------------------------------------------
-- figures: one row per EIN and tax period end
-- ---------------------------------------------------------------------------
create table funder_reference_figures (
  ein text not null check (ein ~ '^[0-9]{9}$'),
  tax_period_end date not null,
  filing_object_id text not null,
  -- Each column below is ONE element of the return, named for what the form calls it.
  fmv_assets_eoy_amt bigint,                           -- FMVAssetsEOYAmt: fair market value of all assets, end of year
  total_assets_boy_amt bigint,                         -- Part II total assets, beginning of year (book)
  total_assets_eoy_book_amt bigint,                    -- Part II total assets, end of year, book value
  total_assets_eoy_fmv_amt bigint,                     -- Part II total assets, end of year, fair market value
  total_liabilities_eoy_amt bigint,
  net_assets_eoy_amt bigint,                           -- total net assets or fund balances, end of year
  contributions_received_per_books_amt bigint,         -- Part I line 1, column (a)
  total_revenue_per_books_amt bigint,                  -- Part I line 12, column (a): revenue and expenses per books
  total_expenses_per_books_amt bigint,                 -- Part I line 26, column (a)
  contributions_paid_per_books_amt bigint,             -- Part I line 25, column (a): contributions, gifts, grants paid, per books
  contributions_paid_disbursements_amt bigint,         -- Part I line 25, column (d): the cash-basis disbursements column
  total_expenses_charitable_disbursements_amt bigint,  -- Part I line 26, column (d): total expenses and disbursements for charitable purposes
  net_value_noncharitable_assets_amt bigint,           -- Part X line 5
  minimum_investment_return_amt bigint,                -- Part X line 6: 5% of the line above
  distributable_amount_amt bigint,                     -- Part XI line 7: distributable amount as adjusted
  qualifying_distributions_amt bigint,                 -- Part XII line 4: qualifying distributions (NOT the distributable amount)
  undistributed_income_current_year_amt bigint,
  grants_paid_stated_total_amt bigint,                 -- Part XV line 3a: the total the return states for grants paid in the year
  grants_approved_future_stated_total_amt bigint,      -- Part XV line 3b
  -- every leaf of the financial-statement groups as filed: 'Group/ElementName' -> text
  financial_statement_values jsonb not null,
  -- DERIVED by the loader (ruling 0045 clause 3 / 0021): each says the set it ranged over
  grants_listed_count integer,
  grants_listed_sum_amt bigint,
  grants_listed_avg_amt numeric(20, 2),
  grants_listed_median_amt numeric(20, 2),
  grants_listed_min_amt bigint,
  grants_listed_max_amt bigint,
  grants_listed_in_filer_state_count integer,
  grants_listed_in_filer_state_sum_amt bigint,
  grants_listed_minus_stated_amt bigint,               -- grants_listed_sum_amt - grants_paid_stated_total_amt
  grants_listed_derivation text,                       -- names the set and the figures used, or why it is empty
  qualifying_to_minimum_investment_return_ratio numeric(14, 4),
  payout_ratio_derivation text,
  loaded_at timestamptz not null,
  loader_version text not null,
  primary key (ein, tax_period_end),
  unique (filing_object_id),
  foreign key (filing_object_id, ein, tax_period_end)
    references funder_reference_filings (object_id, ein, tax_period_end),
  -- a derived value never appears without the sentence that names its set
  check (grants_listed_derivation is not null),
  check (qualifying_to_minimum_investment_return_ratio is null or payout_ratio_derivation is not null)
);

-- ---------------------------------------------------------------------------
-- people: one row per person per filing, as named (clause 5)
-- ---------------------------------------------------------------------------
create table funder_reference_people (
  filing_object_id text not null,
  listed_in text not null check (listed_in in ('part_viii_officers_directors_trustees', 'signer_on_return_header')),
  ordinal integer not null check (ordinal >= 1),
  ein text not null check (ein ~ '^[0-9]{9}$'),
  tax_period_end date not null,
  name_as_named text,
  title_as_stated text,
  hours_per_week_as_stated text,          -- the text the return gave; not interpreted
  compensation_amt bigint,
  employee_benefit_amt bigint,
  expense_account_amt bigint,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  zip text,
  country text,
  loaded_at timestamptz not null,
  loader_version text not null,
  primary key (filing_object_id, listed_in, ordinal),
  foreign key (filing_object_id, ein, tax_period_end)
    references funder_reference_filings (object_id, ein, tax_period_end) on delete cascade
);
create index funder_reference_people_ein_idx on funder_reference_people (ein);

-- ---------------------------------------------------------------------------
-- grants: one row per listed grant (Part XV)
-- ---------------------------------------------------------------------------
create table funder_reference_grants (
  filing_object_id text not null,
  kind text not null check (kind in ('paid_during_year', 'approved_for_future_payment')),
  ordinal integer not null check (ordinal >= 1),
  ein text not null check (ein ~ '^[0-9]{9}$'),
  tax_period_end date not null,
  listed_in_element text not null,        -- the return element that held the row
  recipient_name_line1 text,
  recipient_name_line2 text,
  recipient_person_name text,
  recipient_address_line1 text,
  recipient_address_line2 text,
  recipient_city text,
  recipient_state text,
  recipient_zip text,
  recipient_country text,                 -- null for a US address
  relationship_as_stated text,
  recipient_status_as_stated text,
  purpose_as_stated text,
  amount_amt bigint,
  unmapped_fields jsonb not null default '{}', -- any element of the row no column reads; kept, not dropped
  loaded_at timestamptz not null,
  loader_version text not null,
  primary key (filing_object_id, kind, ordinal),
  foreign key (filing_object_id, ein, tax_period_end)
    references funder_reference_filings (object_id, ein, tax_period_end) on delete cascade
);
create index funder_reference_grants_ein_idx on funder_reference_grants (ein, tax_period_end);

-- ---------------------------------------------------------------------------
-- application terms: whether it takes new requests, and how, as the return says
-- ---------------------------------------------------------------------------
create table funder_reference_application_terms (
  filing_object_id text primary key,
  ein text not null check (ein ~ '^[0-9]{9}$'),
  tax_period_end date not null,
  -- The "only preselected charities, no unsolicited requests" box exactly as the
  -- return carries it ('X' when ticked). null = the return carries no mark. The
  -- boolean is true only for a ticked box; null stays null (an unmarked box is
  -- not turned into a statement that the foundation accepts requests).
  only_preselected_charities_raw text,
  only_preselected_charities_box_checked boolean,
  -- Every ApplicationSubmissionInfoGrp the return carries, each as
  -- {"ordinal": n, "fields": {"<element path>": "<text>"}}; [] when it carries none.
  application_groups jsonb not null default '[]',
  loaded_at timestamptz not null,
  loader_version text not null,
  foreign key (filing_object_id, ein, tax_period_end)
    references funder_reference_filings (object_id, ein, tax_period_end) on delete cascade
);

-- ---------------------------------------------------------------------------
-- coverage: which tax periods are held, and which are not, for each funder
-- ---------------------------------------------------------------------------
create table funder_reference_period_coverage (
  ein text not null check (ein ~ '^[0-9]{9}$'),
  period_year integer not null,           -- calendar year of the tax period END date
  status text not null check (status in ('loaded', 'unread', 'no_filing_in_index')),
  filing_object_id text references funder_reference_filings (object_id),
  note text not null,
  run_id uuid references funder_reference_runs (id),
  checked_at timestamptz not null,
  primary key (ein, period_year),
  check ((status = 'no_filing_in_index') = (filing_object_id is null))
);

-- ---------------------------------------------------------------------------
-- access: read for signed-in members, write for nobody but service_role
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'funder_reference_runs', 'funder_reference_filings', 'funder_reference_foundations',
    'funder_reference_figures', 'funder_reference_people', 'funder_reference_grants',
    'funder_reference_application_terms', 'funder_reference_period_coverage'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
    execute format('grant select on table %I to authenticated', t);
    execute format(
      'create policy %I on %I for select to authenticated using (my_organization_id() is not null)',
      t || '_members_read', t);
    -- No insert, update or delete policy exists for any role. That absence is the
    -- point (ruling 0045 clause 1); the revoke above is the second lock on the same door.
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- the one write path
-- ---------------------------------------------------------------------------
-- doc = { filing: {...every funder_reference_filings column...},
--         foundation: {...}|null, figures: {...}|null,
--         people: [...], grants: [...], application: {...}|null }
-- Replaces everything stored for this filing in one transaction (a function call
-- is one). Returns 'loaded', 'superseded' (a later return for the same EIN and
-- period exists), 'unread' or 'skipped_below_threshold'.
create function funder_reference_apply_filing(doc jsonb)
returns text
language plpgsql
as $$
declare
  f funder_reference_filings%rowtype;
  winner text;
  st text;
begin
  f := jsonb_populate_record(null::funder_reference_filings, doc -> 'filing');
  if f.object_id is null or f.ein is null then
    raise exception 'funder_reference_apply_filing: filing.object_id and filing.ein are required';
  end if;

  -- A filing is replaced whole: clear what hangs off it, then write it again.
  delete from funder_reference_people where filing_object_id = f.object_id;
  delete from funder_reference_grants where filing_object_id = f.object_id;
  delete from funder_reference_application_terms where filing_object_id = f.object_id;
  delete from funder_reference_figures where filing_object_id = f.object_id;
  delete from funder_reference_foundations where source_object_id = f.object_id;

  insert into funder_reference_filings
  select f.*
  on conflict (object_id) do update set
    ein = excluded.ein, return_type = excluded.return_type, index_tax_period = excluded.index_tax_period,
    tax_period_end = excluded.tax_period_end, tax_period_begin = excluded.tax_period_begin,
    tax_year = excluded.tax_year, return_version = excluded.return_version, return_ts = excluded.return_ts,
    status = excluded.status, status_note = excluded.status_note,
    superseded_by_object_id = excluded.superseded_by_object_id,
    index_file = excluded.index_file, index_return_id = excluded.index_return_id,
    index_sub_year = excluded.index_sub_year, document_archive_url = excluded.document_archive_url,
    document_member = excluded.document_member, xml_sha256 = excluded.xml_sha256, xml_bytes = excluded.xml_bytes,
    run_id = excluded.run_id, loaded_at = excluded.loaded_at, loader_version = excluded.loader_version;

  if f.status <> 'loaded' then
    return f.status;
  end if;

  -- Among the returns for this EIN and period, the latest submitted one stands;
  -- the others are kept as filings but hold no figures, people or grants.
  select object_id into winner
  from funder_reference_filings
  where ein = f.ein and tax_period_end = f.tax_period_end and status in ('loaded', 'superseded')
  order by return_ts desc nulls last, object_id desc
  limit 1;

  if winner <> f.object_id then
    update funder_reference_filings
       set status = 'superseded', superseded_by_object_id = winner,
           status_note = 'a later return for the same EIN and tax period end exists'
     where object_id = f.object_id;
    return 'superseded';
  end if;

  -- This filing stands: demote any earlier return for the same EIN and period.
  for st in
    select object_id from funder_reference_filings
    where ein = f.ein and tax_period_end = f.tax_period_end and object_id <> f.object_id and status = 'loaded'
  loop
    delete from funder_reference_people where filing_object_id = st;
    delete from funder_reference_grants where filing_object_id = st;
    delete from funder_reference_application_terms where filing_object_id = st;
    delete from funder_reference_figures where filing_object_id = st;
    delete from funder_reference_foundations where source_object_id = st;
    update funder_reference_filings
       set status = 'superseded', superseded_by_object_id = f.object_id,
           status_note = 'a later return for the same EIN and tax period end exists'
     where object_id = st;
  end loop;

  -- However many amendments there have been for this period, every earlier return names the
  -- one that stands now (not the one that stood when it was demoted).
  update funder_reference_filings
     set superseded_by_object_id = f.object_id
   where ein = f.ein and tax_period_end = f.tax_period_end and status = 'superseded'
     and object_id <> f.object_id and superseded_by_object_id is distinct from f.object_id;

  insert into funder_reference_figures
  select * from jsonb_populate_record(null::funder_reference_figures, doc -> 'figures');

  insert into funder_reference_people
  select * from jsonb_populate_recordset(null::funder_reference_people, coalesce(doc -> 'people', '[]'::jsonb));

  insert into funder_reference_grants
  select * from jsonb_populate_recordset(null::funder_reference_grants, coalesce(doc -> 'grants', '[]'::jsonb));

  if doc -> 'application' is not null and doc -> 'application' <> 'null'::jsonb then
    insert into funder_reference_application_terms
    select * from jsonb_populate_record(null::funder_reference_application_terms, doc -> 'application');
  end if;

  -- The foundation row describes the funder as of its latest period held.
  if not exists (
    select 1 from funder_reference_foundations
    where ein = f.ein and source_tax_period_end > f.tax_period_end
  ) then
    delete from funder_reference_foundations where ein = f.ein;
    insert into funder_reference_foundations
    select * from jsonb_populate_record(null::funder_reference_foundations, doc -> 'foundation');
  end if;

  return 'loaded';
end;
$$;

revoke all on function funder_reference_apply_filing(jsonb) from public, anon, authenticated;
grant execute on function funder_reference_apply_filing(jsonb) to service_role;
