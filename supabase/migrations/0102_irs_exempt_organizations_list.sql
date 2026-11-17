-- STATE item 119, stage two (ruling 0053, which carries out ruling 0052 clause 6): the IRS list of exempt organizations.
--
-- WHAT THIS ADDS. One shared table holding only the rows of the IRS Exempt Organizations Business Master File extract that the
-- ruling keeps (clause 2): the religious organizations the IRS says are not required to file, in three tiers by the IRS's own fields,
-- and any listed organization whose normalized name and state equal a lead's, so the lead can be matched. A function that judges
-- those rows against the loaded funders and charities (the owner's script calls it after loading), and the member read of the
-- leads, replaced so that it carries the IRS facts, leaves out a lead that is a loaded funder under another name, and adds the
-- listed church extension and grantmaking funders. The Solomon Foundation's EIN is checked against the list.
--
-- NOT HERE: the 1.98 million rows (read offline by the owner's script, never stored), any outside request, any model.
-- Additive: no loader table is changed; the read function of 0099 is replaced because its result gains one column.

-- ---------------------------------------------------------------------------------------------------------
-- the table: shared, written only by the owner's script (service role), read by members only through the function below
-- ---------------------------------------------------------------------------------------------------------
create table funder_reference_exempt_list (
  ein text primary key check (ein ~ '^[0-9]{9}$'),
  name text not null,
  in_care_of text,
  street text,
  city text,
  state text,
  zip text,
  ruling_ym text,
  subsection text,
  foundation_code text,
  ntee_cd text,
  filing_req_cd text not null,
  status_cd text,
  -- set by funder_reference_exempt_list_apply(), from the stored fields, never by the loader
  name_key text,
  key_count integer,
  tier smallint check (tier in (1, 2, 3)),
  offered boolean not null default false,
  loaded_ein boolean not null default false,
  loaded_name boolean not null default false,
  list_version text not null,
  list_posted date not null,
  loaded_on date not null default current_date
);
create index funder_reference_exempt_list_key_idx on funder_reference_exempt_list (name_key);
create index funder_reference_exempt_list_offer_idx on funder_reference_exempt_list (tier, name_key) where offered;

comment on table funder_reference_exempt_list is
  'Derived (ruling 0053): rows of the IRS Exempt Organizations Business Master File extract kept for the leads of funders that file no return: religious organizations the IRS says are not required to file (filing requirement 06 church, 13 religious organization) in tiers 1 to 3, and any listed organization whose normalized name and state equal a lead''s. Facts as listed. Written only by scripts/load-exempt-list.ts with the service key.';
comment on column funder_reference_exempt_list.tier is
  '1: name says church extension / extension fund / loan fund / charitable gift / gift fund / donor advised. 2: IRS category (NTEE) T20 to T59. 3: name has foundation, fund, trust or endowment as a whole word and the IRS foundation code is not 10 (church). Null: kept only to match a lead.';
comment on column funder_reference_exempt_list.offered is
  'True for the tiers the page offers (funder_reference_exempt_list_offered_tier()). Tier 3 is kept and not offered (ruling 0053 clause 5).';

alter table funder_reference_exempt_list enable row level security;
revoke all on table funder_reference_exempt_list from anon, authenticated;

-- the highest tier the page offers; changing what is offered is a change of this one value (ruling 0053 clause 5)
create function funder_reference_exempt_list_offered_tier() returns integer language sql immutable as $$ select 2 $$;

-- ---------------------------------------------------------------------------------------------------------
-- apply: judge the stored rows. Service role only. Safe to run again.
--   1. the name key and state, by the same function every other lead uses
--   2. the tier, from the stored fields (filing requirement 06 or 13, unconditional exemption)
--   3. drop what has no tier and matches no lead and no curated record (the loader's prefilter is deliberately wider)
--   4. how many stored rows share each key, so a key shared by two is never matched
--   5. whether the EIN, or the name and state, is a loaded funder or charity
-- ---------------------------------------------------------------------------------------------------------
create function funder_reference_exempt_list_apply()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare out jsonb;
begin
  update funder_reference_exempt_list
     set name_key = funder_reference_name_key(name) || '|' || coalesce(upper(btrim(state)), '');

  update funder_reference_exempt_list e
     set tier = case
           when e.filing_req_cd in ('06', '13') and coalesce(e.status_cd, '') = '01' then
             case
               when funder_reference_nofiling_name_signal(e.name) then 1
               when coalesce(e.ntee_cd, '') ~ '^T[2-5]' then 2
               when funder_reference_nofiling_funder_like(e.name) and coalesce(e.foundation_code, '') <> '10' then 3
               else null
             end
           else null
         end;

  delete from funder_reference_exempt_list e
   where e.tier is null
     and not exists (select 1 from funder_reference_nofiling_leads l where l.lead_key = e.name_key)
     and not exists (select 1 from funder_reference_curated_funders c where c.lead_key = e.name_key or c.ein = e.ein);

  update funder_reference_exempt_list e
     set key_count = k.c
    from (select name_key, count(*) as c from funder_reference_exempt_list group by name_key) k
   where k.name_key = e.name_key;

  update funder_reference_exempt_list e
     set loaded_ein = exists (select 1 from funder_reference_directory_snapshot s where s.ein = e.ein)
                      or exists (select 1 from charity_reference_directory_snapshot s where s.ein = e.ein);

  drop table if exists _el_fk;
  create temp table _el_fk on commit drop as
    select distinct k from (
      select funder_reference_name_key(name) || '|' || coalesce(upper(btrim(state)), '') as k from funder_reference_directory_snapshot
      union all
      select funder_reference_name_key(name) || '|' || coalesce(upper(btrim(state)), '') from charity_reference_directory_snapshot) z
    where k is not null;
  create index on _el_fk (k);
  update funder_reference_exempt_list e set loaded_name = exists (select 1 from _el_fk f where f.k = e.name_key);

  update funder_reference_exempt_list set offered = (tier is not null and tier <= funder_reference_exempt_list_offered_tier());

  select jsonb_build_object(
    'rows', count(*),
    'tier1', count(*) filter (where tier = 1), 'tier2', count(*) filter (where tier = 2), 'tier3', count(*) filter (where tier = 3),
    'kept_only_to_match_a_lead', count(*) filter (where tier is null),
    'offered', count(*) filter (where offered and not loaded_ein and not loaded_name),
    'loaded_by_ein', count(*) filter (where loaded_ein), 'loaded_by_name', count(*) filter (where loaded_name),
    'keys_shared_by_two_or_more', count(*) filter (where key_count > 1))
    into out
    from funder_reference_exempt_list;
  return out;
end;
$$;
revoke all on function funder_reference_exempt_list_apply() from public, anon, authenticated;
grant execute on function funder_reference_exempt_list_apply() to service_role;

-- ---------------------------------------------------------------------------------------------------------
-- the Solomon Foundation (ruling 0053 clause 6): its EIN, listed by ProPublica and labelled unverified, is the IRS list's
-- ---------------------------------------------------------------------------------------------------------
update funder_reference_curated_funders
   set ein_note = 'Listed by ProPublica Nonprofit Explorer as "Solomon Foundation", Parker, CO; the foundation''s own site states no EIN. Checked 2026-11-17 against the IRS Exempt Organizations Business Master File (data posted 2026-11-10, file eo3.csv): one organization has this EIN, SOLOMON FOUNDATION, 16995 PINE LN, PARKER CO 80134, ruling 2011-03, NTEE X19, filing requirement 13 (not required to file, religious organization). Name, city and street agree with this record.',
       sources = sources || '[{"url": "https://www.irs.gov/charities-non-profits/exempt-organizations-business-master-file-extract-eo-bmf", "title": "IRS Exempt Organizations Business Master File extract, eo3.csv (data posted 2026-11-10): the row for EIN 274214240", "read_on": "2026-11-17"}]'::jsonb
 where lead_key = 'SOLOMON FOUNDATION|CO' and ein = '274214240';

-- ---------------------------------------------------------------------------------------------------------
-- the member read, replaced (its result gains the IRS facts). Same caller filter as 0099: a member never sees an organization
-- already in their own queue or pipeline. Groups: 0 curated, 1 found in filings, 2 listed by the IRS.
-- ---------------------------------------------------------------------------------------------------------
drop function reference_nofiling_leads(integer, integer);
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
  irs jsonb,
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
  -- the IRS facts as listed, as one object; match says how it was tied to the lead
  irs_json as (
    select e.ein, e.name_key, e.key_count, e.loaded_ein, e.tier,
           jsonb_build_object('ein', e.ein, 'name', e.name, 'in_care_of', e.in_care_of, 'street', e.street, 'city', e.city, 'state', e.state, 'zip', e.zip,
                              'ruling_ym', e.ruling_ym, 'ntee_cd', e.ntee_cd, 'foundation_code', e.foundation_code, 'filing_req_cd', e.filing_req_cd,
                              'status_cd', e.status_cd, 'tier', e.tier, 'list_version', e.list_version, 'list_posted', e.list_posted, 'ambiguous', false) as j
    from funder_reference_exempt_list e
  ),
  cur as (
    select 0 as grp, 0 as tr, c.lead_key as lk, c.name as dn, c.city as ci, c.state as st, c.ein as se,
           coalesce(l.funders_count, 0) as fc, coalesce(l.faith_funders_count, 0) as ffc, coalesce(l.grants_count, 0) as gc, coalesce(l.periods_count, 0) as pc,
           l.last_period_end as lpe, 'curated'::text as sg, (c.kind = 'donor_advised_fund_sponsor' or coalesce(l.daf_signal, false)) as ds,
           coalesce(l.sample, '[]'::jsonb) as sm, coalesce(l.rule_version, funder_reference_nofiling_rule_version()) as rv, 'curated'::text as og,
           jsonb_build_object('id', c.id, 'kind', c.kind, 'address', c.address, 'website', c.website, 'contact', c.contact, 'offers', c.offers, 'ein_note', c.ein_note,
                              'no_filing_note', c.no_filing_note, 'sources', c.sources, 'recorded_on', c.recorded_on) as cj,
           (select i.j || jsonb_build_object('match', 'ein') from irs_json i where i.ein = c.ein) as ij
    from funder_reference_curated_funders c
    left join funder_reference_nofiling_leads l on l.lead_key = c.lead_key
    where split_part(c.lead_key, '|', 1) not in (select k from mine where k is not null)
  ),
  drv as (
    select 1 as grp, 0 as tr, l.lead_key as lk, l.display_name as dn, l.city as ci, l.state as st, l.stated_ein as se,
           l.funders_count as fc, l.faith_funders_count as ffc, l.grants_count as gc, l.periods_count as pc, l.last_period_end as lpe,
           l.signal as sg, l.daf_signal as ds, l.sample as sm, l.rule_version as rv, 'filings'::text as og, null::jsonb as cj,
           case
             when (select count(*) from irs_json i where i.name_key = l.lead_key) = 1
               then (select i.j || jsonb_build_object('match', 'name_and_state') from irs_json i where i.name_key = l.lead_key)
             when (select count(*) from irs_json i where i.name_key = l.lead_key) > 1
               then jsonb_build_object('ambiguous', true, 'matches', (select count(*) from irs_json i where i.name_key = l.lead_key), 'match', 'name_and_state')
             else null::jsonb
           end as ij
    from funder_reference_nofiling_leads l
    where l.faith_funders_count > 0
      and l.lead_key not in (select c.lead_key from funder_reference_curated_funders c)
      and split_part(l.lead_key, '|', 1) not in (select k from mine where k is not null)
      -- the same organization as a loaded funder or charity under another name: it is in the ranked list already (ruling 0053 clause 4)
      and not exists (select 1 from irs_json i where i.name_key = l.lead_key and i.key_count = 1 and i.loaded_ein)
  ),
  lst as (
    select 2 as grp, i.tier::integer as tr, e.name_key as lk, e.name as dn, e.city as ci, e.state as st, null::text as se,
           0 as fc, 0 as ffc, 0 as gc, 0 as pc, null::date as lpe, 'irs_list'::text as sg, (i.tier = 1 and funder_reference_nofiling_daf_signal(e.name)) as ds,
           '[]'::jsonb as sm, 'exempt-list-lead-v1'::text as rv, 'irs_list'::text as og, null::jsonb as cj,
           i.j || jsonb_build_object('match', 'listed') as ij
    from funder_reference_exempt_list e
    join irs_json i on i.ein = e.ein
    where e.offered and not e.loaded_ein and not e.loaded_name
      and split_part(e.name_key, '|', 1) not in (select k from mine where k is not null)
      and e.name_key not in (select c.lead_key from funder_reference_curated_funders c)
      and e.ein not in (select c.ein from funder_reference_curated_funders c where c.ein is not null)
      and e.name_key not in (select l.lead_key from funder_reference_nofiling_leads l where l.faith_funders_count > 0)
  ),
  u as (select * from cur union all select * from drv union all select * from lst)
  select u.lk, u.dn, u.ci, u.st, u.se, u.fc, u.ffc, u.gc, u.pc, u.lpe, u.sg, u.ds, u.sm, u.rv, u.og, u.cj, u.ij, count(*) over ()::bigint
  from u
  order by u.grp, u.fc desc, u.lpe desc nulls last, u.tr, u.lk
  limit lim offset off;
end;
$$;
revoke all on function reference_nofiling_leads(integer, integer) from public, anon;
grant execute on function reference_nofiling_leads(integer, integer) to authenticated;
