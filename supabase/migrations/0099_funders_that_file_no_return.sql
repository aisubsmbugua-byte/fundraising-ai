-- STATE item 119 (rulings 0051 and 0052, stage one): funders that file no return, found from the grants other organizations' filings
-- already name them in. Additive: three derived tables, a set of named functions, one read function. It changes no loader
-- table and writes no reference row.
--
-- A "lead" is a recipient named in the loaded grants that (a) no loaded funder or charity matches, by stated EIN or by
-- normalized name and state, and (b) is named in at least one grant whose stated purpose or recipient name points to giving
-- rather than doing (donor advised fund, gift fund, extension fund, loan fund, re-granting, grantmaking). The rule is fixed,
-- named and versioned (no-filing-lead-v1). Nothing here calls a model or reads a web page.
--
-- The curated table (ruling 0052 clause 9) is different in kind: funders recorded by hand, each with the source a person read. It is
-- kept apart from the derived leads so no rebuild removes it, is shown first, and is not subject to the relevance test below.
--
-- Relevance (ruling 0050: only dissimilar work excludes a funder): a lead is offered only when at least one funder that named
-- it itself has enough faith-named grants to go on (reference_suggestion_floor()). A recipient that only secular funders name
-- is left out; the lead table keeps it with a zero count, so "left out" is a read-time rule, not a deletion.

-- ---------------------------------------------------------------------------------------------------------
-- the rule, in one place
-- ---------------------------------------------------------------------------------------------------------
create function funder_reference_nofiling_rule_version() returns text language sql immutable as $$ select 'no-filing-lead-v1' $$;

-- the same name written two ways must be one key: upper case, a leading "(230)" grant number and a leading "THE" removed,
-- punctuation collapsed to single spaces
create function funder_reference_name_key(p text) returns text language sql immutable as $$
  select nullif(btrim(regexp_replace(regexp_replace(regexp_replace(upper(coalesce(p, '')), '^\s*\([0-9]+\)\s*', ''), '^THE\s+', ''), '[^A-Z0-9]+', ' ', 'g')), '')
$$;

create function funder_reference_nofiling_purpose_signal(p text) returns boolean language sql immutable as $$
  select coalesce(p ~* '(donor[ -]?advised|gift fund|extension fund|loan fund|re-?grant|grantmak)', false)
$$;
create function funder_reference_nofiling_name_signal(p text) returns boolean language sql immutable as $$
  select coalesce(p ~* '(church extension|extension fund|loan fund|charitable gift|gift fund|donor[ -]?advised)', false)
$$;
create function funder_reference_nofiling_daf_signal(p text) returns boolean language sql immutable as $$
  select coalesce(p ~* '(donor[ -]?advised|gift fund|charitable gift)', false)
$$;
comment on function funder_reference_nofiling_purpose_signal(text) is
  'no-filing-lead-v1: true when a grant''s stated purpose contains: donor advised (fund), gift fund, extension fund, loan fund, regrant/re-grant, grantmak(ing/er).';
comment on function funder_reference_nofiling_name_signal(text) is
  'no-filing-lead-v1: true when a recipient name contains: church extension, extension fund, loan fund, charitable gift, gift fund, donor advised.';

-- ---------------------------------------------------------------------------------------------------------
-- the derived tables: shared, read-only to the application, written only by the offline refresh below
-- ---------------------------------------------------------------------------------------------------------
create table funder_reference_nofiling_keys (
  lead_key text primary key
);
create table funder_reference_nofiling_rows (
  lead_key text not null,
  src text not null check (src in ('f', 'c')),
  funder_ein text not null,
  filing_object_id text not null,
  kind text not null default '',
  ordinal integer not null,
  tax_period_end date,
  recipient_name text,
  recipient_city text,
  recipient_state text,
  stated_ein text,
  purpose text,
  amount_amt bigint,
  purpose_signal boolean not null,
  name_signal boolean not null,
  daf_signal boolean not null,
  primary key (src, filing_object_id, kind, ordinal)
);
create index funder_reference_nofiling_rows_key_idx on funder_reference_nofiling_rows (lead_key);

create table funder_reference_nofiling_leads (
  lead_key text primary key,
  display_name text not null,
  city text,
  state text,
  stated_ein text,
  funders_count integer not null,
  faith_funders_count integer not null,
  grants_count integer not null,
  periods_count integer not null,
  last_period_end date,
  signal text not null check (signal in ('purpose', 'name', 'both')),
  daf_signal boolean not null,
  sample jsonb not null default '[]'::jsonb,
  rule_version text not null,
  computed_at timestamptz not null default now()
);
create index funder_reference_nofiling_leads_rank_idx on funder_reference_nofiling_leads (funders_count desc, last_period_end desc nulls last, lead_key) where faith_funders_count > 0;

comment on table funder_reference_nofiling_leads is
  'Derived (ruling 0051): recipients named in loaded grants that no loaded funder or charity matches and whose grants state a giving purpose. A lead is offered when faith_funders_count > 0 (a funder with enough faith-named grants named it). Counts come from the grant rows; the sample carries filing ids.';
comment on column funder_reference_nofiling_leads.faith_funders_count is
  'How many of the funders that named it have at least reference_suggestion_floor() faith-named grants (funder_reference_faith_giving). Zero means only funders without that giving named it.';

alter table funder_reference_nofiling_keys enable row level security;
alter table funder_reference_nofiling_rows enable row level security;
alter table funder_reference_nofiling_leads enable row level security;
revoke all on table funder_reference_nofiling_keys, funder_reference_nofiling_rows, funder_reference_nofiling_leads from anon, authenticated;
grant select on table funder_reference_nofiling_leads to authenticated;
create policy funder_reference_nofiling_leads_members_read on funder_reference_nofiling_leads
  for select to authenticated using ((select my_organization_id()) is not null);


-- ---------------------------------------------------------------------------------------------------------
-- the curated table (ruling 0052 clause 9): enduring, shared, written only by a migration or the owner's script
-- ---------------------------------------------------------------------------------------------------------
create table funder_reference_curated_funders (
  id uuid primary key default gen_random_uuid(),
  lead_key text not null unique,
  name text not null,
  city text,
  state text,
  address text,
  website text,
  contact text,
  kind text not null check (kind in ('donor_advised_fund_sponsor', 'church_extension_fund', 'religious_funder', 'other_funder')),
  offers text,
  ein text check (ein is null or ein ~ '^[0-9]{9}$'),
  ein_note text,
  no_filing_note text,
  sources jsonb not null check (jsonb_typeof(sources) = 'array' and jsonb_array_length(sources) >= 1),
  recorded_on date not null,
  recorded_note text,
  created_at timestamptz not null default now()
);
comment on table funder_reference_curated_funders is
  'Enduring (ruling 0052 clause 9): funders that file no return, recorded by hand with the source a person read. Never rebuilt by the leads refresh; written only by a migration or the owner''s script, never by a member or a model.';
comment on column funder_reference_curated_funders.offers is
  'What the funder''s own source says it offers, as stated and not rewritten.';
comment on column funder_reference_curated_funders.ein is
  'Only where a source states or lists one; ein_note says which source and that it is unverified until checked against the IRS.';
alter table funder_reference_curated_funders enable row level security;
revoke all on table funder_reference_curated_funders from anon, authenticated;
grant select on table funder_reference_curated_funders to authenticated;
create policy funder_reference_curated_funders_members_read on funder_reference_curated_funders
  for select to authenticated using ((select my_organization_id()) is not null);

-- the first record, 2026-11-16 (owner's direction: "add it to the enduring database"). Every field below was read from the
-- sources listed; nothing is recalled or inferred.
insert into funder_reference_curated_funders (lead_key, name, city, state, address, website, contact, kind, offers, ein, ein_note, no_filing_note, sources, recorded_on, recorded_note)
values (
  'SOLOMON FOUNDATION|CO',
  'The Solomon Foundation',
  'Parker', 'CO',
  '16995 Pine Lane, Parker, Colorado 80134',
  'https://thesolomonfoundation.org/',
  'giving@thesolomonfoundation.org; 855.873.5873 (info@thesolomonfoundation.org)',
  'church_extension_fund',
  'Describes itself as a church extension fund serving congregations in the Restoration Movement (investment certificates and loans to churches). Its Giving page offers a Legacy Fund, "a type of Donor Advised Fund (DAF)": donors recommend grants to approved charities of their choice on their own timeline, with no setup charges or fees; start with the Legacy Fund Agreement, the online DocuSign form, or an email to giving@thesolomonfoundation.org. It also lists a Field of Interest Fund, Disaster Relief Fund, Missions & Ministry Fund, Ministry Education Fund and Restoration Movement Expansion Fund. The site states no grant application process or eligibility rules for recipients, and no legal entity name or EIN.',
  '274214240',
  'Listed by ProPublica Nonprofit Explorer as "Solomon Foundation", Parker, CO; the foundation''s own site states no EIN. Matched by name and city and not verified against the IRS list.',
  'ProPublica lists no Form 990 filings and states the organization is not required to file because the IRS designates it a religious organization.',
  '[{"url": "https://thesolomonfoundation.org/", "title": "The Solomon Foundation (home page)", "read_on": "2026-11-16"},
    {"url": "https://thesolomonfoundation.org/giving/", "title": "Giving - The Solomon Foundation", "read_on": "2026-11-16"},
    {"url": "https://projects.propublica.org/nonprofits/organizations/274214240", "title": "Solomon Foundation, Parker CO - ProPublica Nonprofit Explorer", "read_on": "2026-11-16"}]'::jsonb,
  date '2026-11-16',
  'Found missing from the filings-based database when Village Worship asked; five grants in loaded filings name it, from five different funders, one as a contribution to a donor advised fund. A search result said it ended ECFA membership in 2025 and carries a low donor-confidence score; not verified, not recorded as a fact.'
);

-- ---------------------------------------------------------------------------------------------------------
-- the offline refresh: service key only. Pass 1 finds the keys that carry a signal, pass 2 collects every grant naming those
-- keys, build aggregates. Both passes run one funder EIN range at a time so each call stays inside the statement limit.
-- ---------------------------------------------------------------------------------------------------------
create function funder_reference_nofiling_scan_keys(p_from text, p_to text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  insert into funder_reference_nofiling_keys (lead_key)
  select distinct funder_reference_name_key(x.recipient_name_line1) || '|' || coalesce(upper(btrim(x.recipient_state)), '')
  from funder_reference_grants x
  where x.kind = 'paid_during_year' and x.ein >= p_from and x.ein < p_to
    and funder_reference_name_key(x.recipient_name_line1) is not null
    and (funder_reference_nofiling_purpose_signal(x.purpose_as_stated) or funder_reference_nofiling_name_signal(x.recipient_name_line1))
  on conflict do nothing;
  get diagnostics n = row_count;
  insert into funder_reference_nofiling_keys (lead_key)
  select distinct funder_reference_name_key(x.recipient_name_line1) || '|' || coalesce(upper(btrim(x.recipient_state)), '')
  from charity_reference_grants x
  where x.ein >= p_from and x.ein < p_to
    and funder_reference_name_key(x.recipient_name_line1) is not null
    and (funder_reference_nofiling_purpose_signal(x.purpose_as_stated) or funder_reference_nofiling_name_signal(x.recipient_name_line1))
  on conflict do nothing;
  return n;
end;
$$;

create function funder_reference_nofiling_scan_rows(p_from text, p_to text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer; m integer;
begin
  delete from funder_reference_nofiling_rows t where t.funder_ein >= p_from and t.funder_ein < p_to;
  insert into funder_reference_nofiling_rows (lead_key, src, funder_ein, filing_object_id, kind, ordinal, tax_period_end, recipient_name, recipient_city,
    recipient_state, stated_ein, purpose, amount_amt, purpose_signal, name_signal, daf_signal)
  select k.lead_key, 'f', x.ein, x.filing_object_id, x.kind, x.ordinal, x.tax_period_end, nullif(btrim(x.recipient_name_line1), ''), nullif(btrim(x.recipient_city), ''),
         upper(nullif(btrim(x.recipient_state), '')), null, x.purpose_as_stated, x.amount_amt,
         funder_reference_nofiling_purpose_signal(x.purpose_as_stated), funder_reference_nofiling_name_signal(x.recipient_name_line1),
         funder_reference_nofiling_daf_signal(x.purpose_as_stated) or funder_reference_nofiling_daf_signal(x.recipient_name_line1)
  from funder_reference_grants x
  join funder_reference_nofiling_keys k
    on k.lead_key = funder_reference_name_key(x.recipient_name_line1) || '|' || coalesce(upper(btrim(x.recipient_state)), '')
  where x.kind = 'paid_during_year' and x.ein >= p_from and x.ein < p_to;
  get diagnostics n = row_count;
  insert into funder_reference_nofiling_rows (lead_key, src, funder_ein, filing_object_id, kind, ordinal, tax_period_end, recipient_name, recipient_city,
    recipient_state, stated_ein, purpose, amount_amt, purpose_signal, name_signal, daf_signal)
  select k.lead_key, 'c', x.ein, x.filing_object_id, '', x.ordinal, x.tax_period_end, nullif(btrim(x.recipient_name_line1), ''), nullif(btrim(x.recipient_city), ''),
         upper(nullif(btrim(x.recipient_state), '')), nullif(regexp_replace(coalesce(x.recipient_ein_as_stated, ''), '[^0-9]', '', 'g'), ''), x.purpose_as_stated, x.cash_grant_amt,
         funder_reference_nofiling_purpose_signal(x.purpose_as_stated), funder_reference_nofiling_name_signal(x.recipient_name_line1),
         funder_reference_nofiling_daf_signal(x.purpose_as_stated) or funder_reference_nofiling_daf_signal(x.recipient_name_line1)
  from charity_reference_grants x
  join funder_reference_nofiling_keys k
    on k.lead_key = funder_reference_name_key(x.recipient_name_line1) || '|' || coalesce(upper(btrim(x.recipient_state)), '')
  where x.ein >= p_from and x.ein < p_to;
  get diagnostics m = row_count;
  return n + m;
end;
$$;

create function funder_reference_nofiling_build()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer; floor_n integer := reference_suggestion_floor();
begin
  delete from funder_reference_nofiling_leads;
  insert into funder_reference_nofiling_leads (lead_key, display_name, city, state, stated_ein, funders_count, faith_funders_count, grants_count, periods_count,
    last_period_end, signal, daf_signal, sample, rule_version)
  with filer_eins as (
    select ein from funder_reference_directory_snapshot union select ein from charity_reference_directory_snapshot
  ),
  filer_keys as (
    select funder_reference_name_key(name) || '|' || coalesce(upper(btrim(state)), '') as k from funder_reference_directory_snapshot
    union
    select funder_reference_name_key(name) || '|' || coalesce(upper(btrim(state)), '') from charity_reference_directory_snapshot
  ),
  fnames as (
    select distinct on (ein) ein, name from (
      select ein, name, 1 as o from funder_reference_directory_snapshot union all select ein, name, 2 from charity_reference_directory_snapshot) u order by ein, o
  ),
  r as (
    select x.*, case when x.src = 'f' then 'private_foundation' else 'public_charity' end as fsource
    from funder_reference_nofiling_rows x
  ),
  grp as (
    select r.lead_key,
           mode() within group (order by r.recipient_name) as display_name,
           mode() within group (order by r.recipient_city) as city,
           mode() within group (order by r.recipient_state) as state,
           mode() within group (order by r.stated_ein) filter (where r.stated_ein ~ '^[0-9]{9}$') as stated_ein,
           count(distinct r.funder_ein) as funders_count,
           count(*) as grants_count,
           count(distinct r.tax_period_end) as periods_count,
           max(r.tax_period_end) as last_period_end,
           bool_or(r.purpose_signal) as p_sig, bool_or(r.name_signal) as n_sig, bool_or(r.daf_signal) as daf_sig,
           bool_or(r.stated_ein is not null and r.stated_ein in (select ein from filer_eins)) as has_filer_ein
    from r group by r.lead_key
  ),
  faith as (
    select r.lead_key, count(distinct r.funder_ein) as c
    from r join funder_reference_faith_giving g on g.ein = r.funder_ein and g.source = r.fsource and g.faith_count >= floor_n
    group by r.lead_key
  ),
  sample as (
    select lead_key, jsonb_agg(jsonb_build_object('funder_ein', funder_ein, 'funder_name', fn, 'source', fsource, 'recipient', recipient_name, 'amount_amt', amount_amt,
                                                  'tax_period_end', tax_period_end, 'filing_object_id', filing_object_id, 'kind', kind, 'ordinal', ordinal,
                                                  'purpose', purpose) order by rn) as s
    from (select r.*, fnm.name as fn, row_number() over (partition by r.lead_key order by r.tax_period_end desc, r.amount_amt desc nulls last, r.funder_ein, r.ordinal) as rn
          from r left join fnames fnm on fnm.ein = r.funder_ein) q
    where rn <= 5 group by lead_key
  )
  select g.lead_key, g.display_name, g.city, g.state, g.stated_ein, g.funders_count, coalesce(f.c, 0), g.grants_count, g.periods_count, g.last_period_end,
         case when g.p_sig and g.n_sig then 'both' when g.p_sig then 'purpose' else 'name' end, g.daf_sig, coalesce(s.s, '[]'::jsonb), funder_reference_nofiling_rule_version()
  from grp g
  left join faith f on f.lead_key = g.lead_key
  left join sample s on s.lead_key = g.lead_key
  where g.display_name is not null
    and not g.has_filer_ein
    and g.lead_key not in (select k from filer_keys where k is not null);
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function funder_reference_nofiling_scan_keys(text, text), funder_reference_nofiling_scan_rows(text, text), funder_reference_nofiling_build() from public, anon, authenticated;
grant execute on function funder_reference_nofiling_scan_keys(text, text), funder_reference_nofiling_scan_rows(text, text), funder_reference_nofiling_build() to service_role;

-- ---------------------------------------------------------------------------------------------------------
-- the read: members only; curated records first, then leads a faith-giving funder named; leaves out anything already in the
-- caller's own queue or pipeline (by name key)
-- ---------------------------------------------------------------------------------------------------------
create function reference_nofiling_leads(p_limit integer default 25, p_offset integer default 0)
returns table (
  lead_key text,
  display_name text,
  city text,
  state text,
  stated_ein text,
  funders_count integer,
  faith_funders_count integer,
  grants_count integer,
  periods_count integer,
  last_period_end date,
  signal text,
  daf_signal boolean,
  sample jsonb,
  rule_version text,
  origin text,
  curated jsonb,
  total_matches bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org uuid := my_organization_id();
  lim integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  off integer := greatest(coalesce(p_offset, 0), 0);
begin
  if org is null then
    return;
  end if;
  return query
  with mine as (
    select funder_reference_name_key(c.name) as k from candidates c where c.organization_id = org
    union select funder_reference_name_key(c.funder_name) from candidates c where c.organization_id = org
    union select funder_reference_name_key(p.name) from prospects p where p.organization_id = org
  ),
  cur as (
    select 0 as grp, c.lead_key as lk, c.name as dn, c.city as ci, c.state as st, c.ein as se,
           coalesce(l.funders_count, 0) as fc, coalesce(l.faith_funders_count, 0) as ffc, coalesce(l.grants_count, 0) as gc, coalesce(l.periods_count, 0) as pc,
           l.last_period_end as lpe, 'curated'::text as sg, (c.kind = 'donor_advised_fund_sponsor' or coalesce(l.daf_signal, false)) as ds,
           coalesce(l.sample, '[]'::jsonb) as sm, coalesce(l.rule_version, funder_reference_nofiling_rule_version()) as rv, 'curated'::text as og,
           jsonb_build_object('id', c.id, 'kind', c.kind, 'address', c.address, 'website', c.website, 'contact', c.contact, 'offers', c.offers, 'ein_note', c.ein_note,
                              'no_filing_note', c.no_filing_note, 'sources', c.sources, 'recorded_on', c.recorded_on) as cj
    from funder_reference_curated_funders c
    left join funder_reference_nofiling_leads l on l.lead_key = c.lead_key
    where split_part(c.lead_key, '|', 1) not in (select k from mine where k is not null)
  ),
  drv as (
    select 1 as grp, l.lead_key as lk, l.display_name as dn, l.city as ci, l.state as st, l.stated_ein as se,
           l.funders_count as fc, l.faith_funders_count as ffc, l.grants_count as gc, l.periods_count as pc, l.last_period_end as lpe,
           l.signal as sg, l.daf_signal as ds, l.sample as sm, l.rule_version as rv, 'filings'::text as og, null::jsonb as cj
    from funder_reference_nofiling_leads l
    where l.faith_funders_count > 0
      and l.lead_key not in (select c.lead_key from funder_reference_curated_funders c)
      and split_part(l.lead_key, '|', 1) not in (select k from mine where k is not null)
  ),
  u as (select * from cur union all select * from drv)
  select u.lk, u.dn, u.ci, u.st, u.se, u.fc, u.ffc, u.gc, u.pc, u.lpe, u.sg, u.ds, u.sm, u.rv, u.og, u.cj, count(*) over ()::bigint
  from u
  order by u.grp, u.fc desc, u.lpe desc nulls last, u.lk
  limit lim offset off;
end;
$$;
revoke all on function reference_nofiling_leads(integer, integer) from public, anon;
grant execute on function reference_nofiling_leads(integer, integer) to authenticated;
