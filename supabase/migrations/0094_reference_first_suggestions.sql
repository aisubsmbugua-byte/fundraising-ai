-- STATE item 117 (ruling 0049): funders from the national database are suggested first in the Donor Finder.
-- Additive: two columns on candidates, one shared derived table, three functions. It changes no loader table
-- and writes no reference row.
--
-- What is stored and what it means:
--   candidates.ein              the funder's EIN, set only when a person adds a suggested funder (ruling 0049 clause 2)
--   candidates.reference_basis  the figures and filings the suggestion rested on at the moment it was added
--   funder_reference_faith_giving  per funder, counts computed from the grant rows the database holds, by a NAMED rule
--
-- "Faith-named" is a fixed word list over a grant's recipient name and stated purpose (ruling 0049 clause 4). It is
-- approximate by design and its version is stored beside every figure it produced. Changing the list is a new
-- version and a full recompute.

alter table candidates add column ein text;
alter table candidates add column reference_basis jsonb;
alter table candidates add constraint candidates_ein_format check (ein is null or ein ~ '^[0-9]{9}$');
create index candidates_org_ein_idx on candidates (organization_id, ein) where ein is not null;
comment on column candidates.ein is
  'The funder''s EIN. Set only by adding a funder suggested from the national database (ruling 0049); a candidate found by web search or typed by hand has none.';
comment on column candidates.reference_basis is
  'The figures and filings a suggestion rested on when a person added it: rule version, counts, band and sample grants with their filing ids. A snapshot, not a live value.';

-- ---------------------------------------------------------------------------------------------------------
-- the rule, in one place
-- ---------------------------------------------------------------------------------------------------------
create function funder_reference_faith_rule_version() returns text language sql immutable as $$ select 'faith-name-v1' $$;

create function funder_reference_faith_named(p text) returns boolean language sql immutable as $$
  select coalesce(
    lower(p) ~ '\y(church|churches|ministry|ministries|christian|christians|christ|gospel|bible|biblical|baptist|lutheran|presbyterian|methodist|evangelical|evangelism|evangelistic|missionary|missionaries|missions|worship|discipleship|pentecostal|apostolic|jesus|salvation army|assemblies of god|assembly of god)\y',
    false)
$$;
comment on function funder_reference_faith_named(text) is
  'faith-name-v1: true when the text contains one of: church(es), ministry/ministries, christian(s), christ, gospel, bible/biblical, baptist, lutheran, presbyterian, methodist, evangelical, evangelism/evangelistic, missionary/missionaries, missions, worship, discipleship, pentecostal, apostolic, jesus, salvation army, assemblies/assembly of god. Whole words only. Approximate: it misses some ministries and includes some that are not.';

-- ---------------------------------------------------------------------------------------------------------
-- the derived table: shared, read-only to the application, written only by the offline refresh below
-- ---------------------------------------------------------------------------------------------------------
create table funder_reference_faith_giving (
  ein text not null,
  source text not null check (source in ('private_foundation', 'public_charity')),
  rule_version text not null,
  periods_counted integer not null,
  first_period_end date,
  last_period_end date,
  grants_counted bigint not null,
  faith_count bigint not null,
  faith_sum_amt bigint,
  faith_amounts bigint[] not null default '{}',
  faith_amounts_capped boolean not null default false,
  faith_by_state jsonb not null default '{}'::jsonb,
  faith_last_period_end date,
  faith_sample jsonb not null default '[]'::jsonb,
  computed_at timestamptz not null default now(),
  primary key (ein, source)
);
create index funder_reference_faith_giving_faith_idx on funder_reference_faith_giving (faith_count desc) where faith_count > 0;

comment on table funder_reference_faith_giving is
  'Derived (ruling 0049): per funder, counts of grants whose recipient name or stated purpose matches the named faith rule, computed over the paid grants the database holds for the periods it holds. A funder with no row has not been computed; a row with faith_count 0 was computed and had none.';
comment on column funder_reference_faith_giving.faith_amounts is
  'The dollar amounts of the faith-named grants that state one, largest first, kept so a size band can be counted exactly; capped at 5000 (faith_amounts_capped says so).';
comment on column funder_reference_faith_giving.faith_sample is
  'Up to five faith-named grants, most recent period then largest: recipient as filed, amount, tax period end, filing object id, and the row''s position in that filing.';

alter table funder_reference_faith_giving enable row level security;
revoke all on table funder_reference_faith_giving from anon, authenticated;
grant select on table funder_reference_faith_giving to authenticated;
create policy funder_reference_faith_giving_members_read on funder_reference_faith_giving
  for select to authenticated using ((select my_organization_id()) is not null);

-- ---------------------------------------------------------------------------------------------------------
-- the offline refresh: service key only, one EIN range at a time so each call stays inside the statement limit
-- ---------------------------------------------------------------------------------------------------------
create function funder_reference_refresh_faith_giving(p_from text, p_to text)
returns table (source text, funders integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v text := funder_reference_faith_rule_version();
  n_f integer;
  n_c integer;
begin
  delete from funder_reference_faith_giving t where t.ein >= p_from and t.ein < p_to;

  insert into funder_reference_faith_giving (ein, source, rule_version, periods_counted, first_period_end, last_period_end,
    grants_counted, faith_count, faith_sum_amt, faith_amounts, faith_amounts_capped, faith_by_state, faith_last_period_end, faith_sample)
  with g as (
    select x.ein, x.tax_period_end, x.filing_object_id, x.kind as fkind, x.ordinal, x.amount_amt as amt,
           nullif(btrim(concat_ws(' ', x.recipient_name_line1, x.recipient_name_line2)), '') as recipient,
           upper(nullif(btrim(x.recipient_state), '')) as st,
           funder_reference_faith_named(concat_ws(' ', x.recipient_name_line1, x.recipient_name_line2, x.purpose_as_stated)) as f
    from funder_reference_grants x
    where x.kind = 'paid_during_year' and x.ein >= p_from and x.ein < p_to
  ),
  states as (
    select ein, jsonb_object_agg(st, c) as by_state from (
      select ein, st, count(*) as c from g where f and st is not null group by ein, st) s group by ein
  ),
  sample as (
    select ein, jsonb_agg(jsonb_build_object('recipient', recipient, 'amount_amt', amt, 'tax_period_end', tax_period_end,
                                             'filing_object_id', filing_object_id, 'kind', fkind, 'ordinal', ordinal) order by rn) as s
    from (select g.*, row_number() over (partition by ein order by tax_period_end desc, amt desc nulls last, ordinal) as rn from g where f) r
    where rn <= 5 group by ein
  )
  select a.ein, 'private_foundation', v, a.periods, a.first_p, a.last_p, a.n, a.fn, a.fsum, coalesce(a.amts[1:5000], '{}'), coalesce(cardinality(a.amts), 0) > 5000,
         coalesce(st.by_state, '{}'::jsonb), a.flast, coalesce(sm.s, '[]'::jsonb)
  from (
    select ein, count(distinct tax_period_end)::integer as periods, min(tax_period_end) as first_p, max(tax_period_end) as last_p,
           count(*) as n, count(*) filter (where f) as fn, sum(amt) filter (where f) as fsum,
           array_agg(amt order by amt desc) filter (where f and amt is not null) as amts,
           max(tax_period_end) filter (where f) as flast
    from g group by ein
  ) a
  left join states st on st.ein = a.ein
  left join sample sm on sm.ein = a.ein;
  get diagnostics n_f = row_count;

  insert into funder_reference_faith_giving (ein, source, rule_version, periods_counted, first_period_end, last_period_end,
    grants_counted, faith_count, faith_sum_amt, faith_amounts, faith_amounts_capped, faith_by_state, faith_last_period_end, faith_sample)
  with g as (
    select x.ein, x.tax_period_end, x.filing_object_id, x.ordinal, x.cash_grant_amt as amt,
           nullif(btrim(concat_ws(' ', x.recipient_name_line1, x.recipient_name_line2)), '') as recipient,
           upper(nullif(btrim(x.recipient_state), '')) as st,
           funder_reference_faith_named(concat_ws(' ', x.recipient_name_line1, x.recipient_name_line2, x.purpose_as_stated)) as f
    from charity_reference_grants x
    where x.ein >= p_from and x.ein < p_to
  ),
  states as (
    select ein, jsonb_object_agg(st, c) as by_state from (
      select ein, st, count(*) as c from g where f and st is not null group by ein, st) s group by ein
  ),
  sample as (
    select ein, jsonb_agg(jsonb_build_object('recipient', recipient, 'amount_amt', amt, 'tax_period_end', tax_period_end,
                                             'filing_object_id', filing_object_id, 'kind', 'schedule_i', 'ordinal', ordinal) order by rn) as s
    from (select g.*, row_number() over (partition by ein order by tax_period_end desc, amt desc nulls last, ordinal) as rn from g where f) r
    where rn <= 5 group by ein
  )
  select a.ein, 'public_charity', v, a.periods, a.first_p, a.last_p, a.n, a.fn, a.fsum, coalesce(a.amts[1:5000], '{}'), coalesce(cardinality(a.amts), 0) > 5000,
         coalesce(st.by_state, '{}'::jsonb), a.flast, coalesce(sm.s, '[]'::jsonb)
  from (
    select ein, count(distinct tax_period_end)::integer as periods, min(tax_period_end) as first_p, max(tax_period_end) as last_p,
           count(*) as n, count(*) filter (where f) as fn, sum(amt) filter (where f) as fsum,
           array_agg(amt order by amt desc) filter (where f and amt is not null) as amts,
           max(tax_period_end) filter (where f) as flast
    from g group by ein
  ) a
  left join states st on st.ein = a.ein
  left join sample sm on sm.ein = a.ein;
  get diagnostics n_c = row_count;

  return query select 'private_foundation'::text, n_f union all select 'public_charity'::text, n_c;
end;
$$;
revoke all on function funder_reference_refresh_faith_giving(text, text) from public, anon, authenticated;
grant execute on function funder_reference_refresh_faith_giving(text, text) to service_role;

-- ---------------------------------------------------------------------------------------------------------
-- the suggestions: members only; excludes funders already in the caller's own queue or pipeline
-- ---------------------------------------------------------------------------------------------------------
-- p_band_lo / p_band_hi  the size band a grant must fall in to count as "in band"; both null means no band is set
--                        and every faith-named grant counts. When a band is set, a funder with no faith-named grant in
--                        it is left out (it would only be noise at the foot of the list).
-- p_state                the organization's own state, used only to report how many of the faith-named grants went there;
--                        it changes no order and filters nothing.
-- p_held_out             false: funders whose filing does not say pre-selected charities only. true: only those that do.
-- Order: grants in the band (most first); then share of the funder's listed grants that are faith-named; then the most
-- recent period with a faith-named grant; then EIN so a page is stable. faith_amounts is capped at 5000 per funder, so the
-- in-band count of a funder with more than that is a floor (faith_amounts_capped says so on the row).
create function reference_funder_suggestions(
  p_band_lo bigint default null,
  p_band_hi bigint default null,
  p_state text default null,
  p_held_out boolean default false,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  ein text,
  source text,
  name text,
  city text,
  state text,
  is_daf_sponsor boolean,
  grants_counted bigint,
  periods_counted integer,
  faith_count bigint,
  faith_in_band_count bigint,
  faith_share numeric,
  faith_last_period_end date,
  faith_in_state_count bigint,
  giving_amt bigint,
  giving_period_end date,
  takes_no_unsolicited boolean,
  faith_amounts_capped boolean,
  faith_sample jsonb,
  rule_version text,
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
  st text := upper(nullif(btrim(coalesce(p_state, '')), ''));
begin
  if org is null then
    return;
  end if;
  return query
  with mine as (
    select c.ein as e from candidates c where c.organization_id = org and c.ein is not null
    union
    select regexp_replace(p.ein, '[^0-9]', '', 'g') from prospects p where p.organization_id = org and p.ein is not null
  ),
  joined as (
    select f.ein, f.source, d.name, d.city, d.state, false as daf, f.grants_counted, f.periods_counted, f.faith_count,
           f.faith_amounts, f.faith_amounts_capped, f.faith_by_state, f.faith_last_period_end, f.faith_sample, f.rule_version,
           d.contributions_paid_per_books_amt as giving, d.figures_period_end as giving_end,
           coalesce(d.only_preselected_charities_box_checked, false) as no_unsolicited
    from funder_reference_faith_giving f
    join funder_reference_directory_snapshot d on d.ein = f.ein
    where f.source = 'private_foundation' and f.faith_count > 0
    union all
    select f.ein, f.source, d.name, d.city, d.state, coalesce(d.is_daf_sponsor, false), f.grants_counted, f.periods_counted, f.faith_count,
           f.faith_amounts, f.faith_amounts_capped, f.faith_by_state, f.faith_last_period_end, f.faith_sample, f.rule_version,
           d.grants_domestic_orgs_amt, d.figures_period_end, null::boolean
    from funder_reference_faith_giving f
    join charity_reference_directory_snapshot d on d.ein = f.ein
    where f.source = 'public_charity' and f.faith_count > 0
  ),
  scored as (
    select j.*,
           case when p_band_lo is null and p_band_hi is null then j.faith_count
                else (select count(*) from unnest(j.faith_amounts) a where (p_band_lo is null or a >= p_band_lo) and (p_band_hi is null or a <= p_band_hi)) end as in_band
    from joined j
    where j.ein not in (select e from mine)
      and coalesce(j.no_unsolicited, false) = coalesce(p_held_out, false)
  )
  select s.ein, s.source, s.name, s.city, s.state, s.daf, s.grants_counted, s.periods_counted, s.faith_count, s.in_band,
         round(s.faith_count::numeric / nullif(s.grants_counted, 0), 4),
         s.faith_last_period_end,
         case when st is null then null else coalesce((s.faith_by_state ->> st)::bigint, 0) end,
         s.giving, s.giving_end, s.no_unsolicited, s.faith_amounts_capped, s.faith_sample, s.rule_version,
         count(*) over ()::bigint
  from scored s
  where s.in_band > 0
  order by s.in_band desc, round(s.faith_count::numeric / nullif(s.grants_counted, 0), 4) desc nulls last, s.faith_last_period_end desc nulls last, s.ein
  limit lim offset off;
end;
$$;
revoke all on function reference_funder_suggestions(bigint, bigint, text, boolean, integer, integer) from public, anon;
grant execute on function reference_funder_suggestions(bigint, bigint, text, boolean, integer, integer) to authenticated;
