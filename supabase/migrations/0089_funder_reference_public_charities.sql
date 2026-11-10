-- STATE item 116 (ruling 0047): grantmaking public charities and donor-advised fund sponsors in the
-- funder reference database, as labeled kinds, from Form 990 returns. Additive.
--
-- NOT TO BE APPLIED to the live database until ruling 0047 clause 7 is satisfied: the item-114
-- national load is complete and verified, and the owner has said so. It is written and tested here
-- on a local PostgreSQL only.
--
-- WHAT KIND OF DATA THIS IS. Exactly ruling 0045's: shared reference data, written only by the
-- offline loader (service role) through one function, read by any signed-in member, no
-- organization_id (hard rule 6's pattern deliberately does not apply; ruling 0045 clause 1 says why),
-- every value tied to its filing, and a fact the filing does not carry is absent (null), not filled in.
--
-- WHY SEPARATE TABLES (ruling 0047 clause 2). A figure that sounds like a private foundation's but is
-- defined differently on Form 990 is a different column in a different table: nothing here reuses a
-- Form 990-PF column for a Form 990 meaning. Every table says which form it comes from, and every
-- figure column is named for the form and line it is read from; form_places records the place in
-- words beside the values. There is no column that holds a Form 990-PF figure and no single "giving".
--
-- WHAT IS NEVER STORED. Grants to individuals (Part IX line 2, Schedule I Part III). Anything that
-- could name a person behind a donor-advised fund (ruling 0047 clause 3): Schedule D Part I states
-- counts and totals only, and that is all there is; the sponsor's Schedule I recipients are THE
-- SPONSOR'S grants, and no column anywhere relates a recipient to a donor. People (Part VII) are not
-- stored in this stage.
--
-- WHAT IS NOT STORED ON PURPOSE. A Form 990 return that is outside the scope rule (clause 8) is
-- counted in the run record and stored nowhere: about nine in ten Form 990 returns are not
-- grantmaking charities, and a row for each would be about a million rows and most of the loader's
-- time for no use. A return that cannot be read IS stored, as unread, with the reason (ruling 0045
-- clause 6).

-- ---------------------------------------------------------------------------
-- filings: one row per Form 990 return considered and stored (loaded, superseded or unread)
-- ---------------------------------------------------------------------------
create table charity_reference_filings (
  object_id text primary key check (object_id ~ '^[0-9]{18}$'),   -- the IRS OBJECT_ID
  ein text not null check (ein ~ '^[0-9]{9}$'),
  return_type text not null check (return_type = '990'),           -- Form 990 only; 990-EZ, 990-N and 990-PF are not this table's
  index_tax_period text not null check (index_tax_period ~ '^[0-9]{6}$'),
  tax_period_end date,
  tax_period_begin date,
  tax_year text,
  return_version text,
  return_ts timestamptz,
  status text not null check (status in ('loaded', 'superseded', 'unread')),
  status_note text,
  superseded_by_object_id text references charity_reference_filings (object_id),
  index_file text not null,
  index_return_id text,
  index_sub_year integer,
  document_archive_url text not null,
  document_member text not null,
  xml_sha256 text,
  xml_bytes integer,
  run_id uuid references funder_reference_runs (id),
  loaded_at timestamptz not null,
  loader_version text not null,
  unique (object_id, ein, tax_period_end),
  check (status = 'unread' or tax_period_end is not null),
  check ((status = 'loaded') = (status_note is null)),
  check ((status = 'superseded') = (superseded_by_object_id is not null))
);
create index charity_reference_filings_ein_idx on charity_reference_filings (ein, tax_period_end);

-- ---------------------------------------------------------------------------
-- charities: one row per EIN, as it identified itself on its latest filing, WITH ITS KIND(S)
-- ---------------------------------------------------------------------------
-- The kind is a label computed by the loader from the stored figures under the rule in kind_rule and
-- the threshold in kind_threshold_org_grants_amt; kind_basis lists, per tax period, the two figures
-- the rule read. An organization can carry both labels.
create table charity_reference_organizations (
  ein text primary key check (ein ~ '^[0-9]{9}$'),
  source_object_id text not null,
  source_tax_period_end date not null,
  form_type text not null default '990' check (form_type = '990'),
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
  website_as_stated text,                        -- exactly what the return wrote; never a derived URL
  mission_as_stated text,
  legal_domicile_state_as_stated text,
  is_grantmaking_public_charity boolean not null,
  is_daf_sponsor boolean not null,
  kind_rule text not null,
  kind_threshold_org_grants_amt bigint not null,
  kind_basis jsonb not null,
  loaded_at timestamptz not null,
  loader_version text not null,
  check (is_grantmaking_public_charity or is_daf_sponsor),   -- a funder in this table is in scope under at least one kind
  foreign key (source_object_id, ein, source_tax_period_end)
    references charity_reference_filings (object_id, ein, tax_period_end)
);

-- ---------------------------------------------------------------------------
-- figures: one row per EIN and tax period end, from Form 990 (main form) and Schedule I (the list)
-- ---------------------------------------------------------------------------
create table charity_reference_figures (
  ein text not null check (ein ~ '^[0-9]{9}$'),
  tax_period_end date not null,
  filing_object_id text not null,
  form_type text not null default '990' check (form_type = '990'),
  part_i_line_8_cy_contributions_grants_amt bigint,           -- Part I line 8, current year
  part_i_line_12_cy_total_revenue_amt bigint,                 -- Part I line 12, current year
  part_i_line_13_cy_grants_and_similar_paid_amt bigint,       -- Part I line 13: INCLUDES grants to individuals
  part_i_line_18_cy_total_expenses_amt bigint,                -- Part I line 18, current year
  part_i_line_20_total_assets_eoy_amt bigint,                 -- Part I line 20, end of year
  part_i_line_22_net_assets_eoy_amt bigint,                   -- Part I line 22, end of year
  part_ix_line_1_grants_domestic_orgs_total_amt bigint,       -- Part IX line 1 column (A): the figure the public-charity rule tests
  part_ix_line_3_grants_outside_us_total_amt bigint,          -- Part IX line 3 column (A): organizations, governments AND individuals outside the US; not tested
  part_iv_line_6_donor_advised_fund_box boolean,              -- null = the return does not say
  part_iv_line_6_donor_advised_fund_box_as_written text,      -- '1', 'true', 'X' ... as the return wrote it
  part_iv_line_21_grants_to_domestic_orgs_box boolean,
  part_iv_line_21_grants_to_domestic_orgs_box_as_written text,
  has_schedule_i boolean not null,
  has_schedule_d boolean not null,
  schedule_i_grant_records_maintained_ind boolean,
  schedule_i_total_501c3_org_cnt integer,
  schedule_i_total_other_org_cnt integer,
  -- DERIVED by the loader from the Schedule I rows stored for this filing; each says the set it ranged over
  schedule_i_rows_listed_count integer not null,
  schedule_i_cash_grants_listed_sum_amt bigint,               -- null when no row states a cash grant
  schedule_i_listed_derivation text not null,
  form_places jsonb not null,                                 -- column name -> the schedule, part and line it is read from
  loaded_at timestamptz not null,
  loader_version text not null,
  primary key (ein, tax_period_end),
  unique (filing_object_id),
  foreign key (filing_object_id, ein, tax_period_end)
    references charity_reference_filings (object_id, ein, tax_period_end)
);

-- ---------------------------------------------------------------------------
-- donor-advised fund figures: Schedule D Part I, one row per filing that has a Schedule D
-- ---------------------------------------------------------------------------
-- Counts and totals as filed. Column (a) is donor advised funds; column (b) is "funds and other
-- accounts", which is NOT donor advised funds and has its own columns. No donor, advisor or fund is
-- named here or anywhere in this schema.
create table charity_reference_daf_figures (
  filing_object_id text primary key,
  ein text not null check (ein ~ '^[0-9]{9}$'),
  tax_period_end date not null,
  form_type text not null default '990' check (form_type = '990'),
  daf_held_cnt bigint,
  daf_contributions_amt bigint,
  daf_grants_amt bigint,
  daf_value_eoy_amt bigint,
  other_funds_held_cnt bigint,
  other_funds_contributions_amt bigint,
  other_funds_grants_amt bigint,
  other_funds_value_eoy_amt bigint,
  form_places jsonb not null,
  loaded_at timestamptz not null,
  loader_version text not null,
  foreign key (filing_object_id, ein, tax_period_end)
    references charity_reference_filings (object_id, ein, tax_period_end) on delete cascade
);

-- ---------------------------------------------------------------------------
-- grants: Schedule I Part II, one row per listed recipient. These are THE FILER'S grants; for a
-- donor-advised fund sponsor they are the sponsor's, and carry no donor.
-- ---------------------------------------------------------------------------
create table charity_reference_grants (
  filing_object_id text not null,
  ordinal integer not null check (ordinal >= 1),
  ein text not null check (ein ~ '^[0-9]{9}$'),
  tax_period_end date not null,
  form_type text not null default '990' check (form_type = '990'),
  source_location text not null,            -- the schedule and part that held the row
  recipient_name_line1 text,
  recipient_name_line2 text,
  recipient_ein_as_stated text,
  recipient_address_line1 text,
  recipient_address_line2 text,
  recipient_city text,
  recipient_state text,
  recipient_zip text,
  recipient_country text,                   -- null for a US address
  irc_section_as_stated text,
  cash_grant_amt bigint,
  noncash_assistance_amt bigint,
  noncash_assistance_desc text,
  valuation_method_desc text,
  purpose_as_stated text,
  unmapped_fields jsonb not null default '{}',   -- any element of the row no column reads; kept, not dropped
  loaded_at timestamptz not null,
  loader_version text not null,
  primary key (filing_object_id, ordinal),
  foreign key (filing_object_id, ein, tax_period_end)
    references charity_reference_filings (object_id, ein, tax_period_end) on delete cascade
);
create index charity_reference_grants_ein_idx on charity_reference_grants (ein, tax_period_end);

-- ---------------------------------------------------------------------------
-- coverage: which tax periods are held, and which are not, for each stored funder
-- ---------------------------------------------------------------------------
create table charity_reference_period_coverage (
  ein text not null check (ein ~ '^[0-9]{9}$'),
  period_year integer not null,
  status text not null check (status in ('loaded', 'unread', 'no_filing_in_index')),
  filing_object_id text references charity_reference_filings (object_id),
  note text not null,
  run_id uuid references funder_reference_runs (id),
  checked_at timestamptz not null,
  primary key (ein, period_year),
  check ((status = 'no_filing_in_index') = (filing_object_id is null))
);

-- ---------------------------------------------------------------------------
-- access: read for signed-in members, write for nobody but service_role (ruling 0045 clause 1)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'charity_reference_filings', 'charity_reference_organizations', 'charity_reference_figures',
    'charity_reference_daf_figures', 'charity_reference_grants', 'charity_reference_period_coverage'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
    execute format('grant select on table %I to authenticated', t);
    execute format(
      'create policy %I on %I for select to authenticated using (my_organization_id() is not null)',
      t || '_members_read', t);
    -- No insert, update or delete policy exists for any role; the revoke above is the second lock.
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- the one write path
-- ---------------------------------------------------------------------------
-- doc = { filing: {...every charity_reference_filings column...},
--         charity: {...}|null, figures: {...}|null, daf: {...}|null, grants: [...] }
-- Replaces everything stored for this filing in one transaction (a function call is one). Returns
-- 'loaded', 'superseded' (a later return for the same EIN and period exists) or 'unread'.
create function charity_reference_apply_filing(doc jsonb)
returns text
language plpgsql
as $$
declare
  f charity_reference_filings%rowtype;
  winner text;
  st text;
begin
  f := jsonb_populate_record(null::charity_reference_filings, doc -> 'filing');
  if f.object_id is null or f.ein is null then
    raise exception 'charity_reference_apply_filing: filing.object_id and filing.ein are required';
  end if;

  -- A filing is replaced whole: clear what hangs off it, then write it again.
  delete from charity_reference_grants where filing_object_id = f.object_id;
  delete from charity_reference_daf_figures where filing_object_id = f.object_id;
  delete from charity_reference_figures where filing_object_id = f.object_id;
  delete from charity_reference_organizations where source_object_id = f.object_id;

  insert into charity_reference_filings
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

  -- Among the returns for this EIN and period, the latest submitted one stands.
  select object_id into winner
  from charity_reference_filings
  where ein = f.ein and tax_period_end = f.tax_period_end and status in ('loaded', 'superseded')
  order by return_ts desc nulls last, object_id desc
  limit 1;

  if winner <> f.object_id then
    update charity_reference_filings
       set status = 'superseded', superseded_by_object_id = winner,
           status_note = 'a later return for the same EIN and tax period end exists'
     where object_id = f.object_id;
    return 'superseded';
  end if;

  for st in
    select object_id from charity_reference_filings
    where ein = f.ein and tax_period_end = f.tax_period_end and object_id <> f.object_id and status = 'loaded'
  loop
    delete from charity_reference_grants where filing_object_id = st;
    delete from charity_reference_daf_figures where filing_object_id = st;
    delete from charity_reference_figures where filing_object_id = st;
    delete from charity_reference_organizations where source_object_id = st;
    update charity_reference_filings
       set status = 'superseded', superseded_by_object_id = f.object_id,
           status_note = 'a later return for the same EIN and tax period end exists'
     where object_id = st;
  end loop;

  update charity_reference_filings
     set superseded_by_object_id = f.object_id
   where ein = f.ein and tax_period_end = f.tax_period_end and status = 'superseded'
     and object_id <> f.object_id and superseded_by_object_id is distinct from f.object_id;

  insert into charity_reference_figures
  select * from jsonb_populate_record(null::charity_reference_figures, doc -> 'figures');

  if doc -> 'daf' is not null and doc -> 'daf' <> 'null'::jsonb then
    insert into charity_reference_daf_figures
    select * from jsonb_populate_record(null::charity_reference_daf_figures, doc -> 'daf');
  end if;

  insert into charity_reference_grants
  select * from jsonb_populate_recordset(null::charity_reference_grants, coalesce(doc -> 'grants', '[]'::jsonb));

  -- The charity row describes the funder as of its latest period held.
  if not exists (
    select 1 from charity_reference_organizations
    where ein = f.ein and source_tax_period_end > f.tax_period_end
  ) then
    delete from charity_reference_organizations where ein = f.ein;
    insert into charity_reference_organizations
    select * from jsonb_populate_record(null::charity_reference_organizations, doc -> 'charity');
  end if;

  return 'loaded';
end;
$$;

revoke all on function charity_reference_apply_filing(jsonb) from public, anon, authenticated;
grant execute on function charity_reference_apply_filing(jsonb) to service_role;
