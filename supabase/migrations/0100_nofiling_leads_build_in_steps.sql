-- STATE item 119 (ruling 0052): the lead build of 0099 ran as one statement over every staged grant and did not finish inside the
-- database's statement limit on the real data (536,540 staged grants, 9,414 groups). Same rule, same result, written as steps over
-- small working tables: the name keys and EINs of every loaded funder and charity are collected once and indexed, groups are
-- aggregated once, and the sample and faith counts are computed only for groups that survive the exclusions. No table, column or
-- rule changes; the 0099 version is replaced in place (create or replace).

create or replace function funder_reference_nofiling_build()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer; floor_n integer := reference_suggestion_floor();
begin
  create temp table _nf_fk on commit drop as
    select distinct k from (
      select funder_reference_name_key(name) || '|' || coalesce(upper(btrim(state)), '') as k from funder_reference_directory_snapshot
      union all
      select funder_reference_name_key(name) || '|' || coalesce(upper(btrim(state)), '') from charity_reference_directory_snapshot) z
    where k is not null;
  create index on _nf_fk (k);
  create temp table _nf_fe on commit drop as
    select ein from funder_reference_directory_snapshot union select ein from charity_reference_directory_snapshot;
  create index on _nf_fe (ein);

  create temp table _nf_g on commit drop as
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
           bool_or(fe.ein is not null) as has_filer_ein
    from funder_reference_nofiling_rows r
    left join _nf_fe fe on fe.ein = r.stated_ein
    group by r.lead_key;

  create temp table _nf_ok on commit drop as
    select g.* from _nf_g g
    where g.display_name is not null
      and not g.has_filer_ein
      and not exists (select 1 from _nf_fk f where f.k = g.lead_key);
  create index on _nf_ok (lead_key);

  create temp table _nf_faith on commit drop as
    select r.lead_key, count(distinct r.funder_ein) as c
    from funder_reference_nofiling_rows r
    join _nf_ok o on o.lead_key = r.lead_key
    join funder_reference_faith_giving g on g.ein = r.funder_ein and g.source = case when r.src = 'f' then 'private_foundation' else 'public_charity' end and g.faith_count >= floor_n
    group by r.lead_key;

  create temp table _nf_sample on commit drop as
    select lead_key, jsonb_agg(jsonb_build_object('funder_ein', funder_ein, 'funder_name', fn, 'source', fsource, 'recipient', recipient_name, 'amount_amt', amount_amt,
                                                  'tax_period_end', tax_period_end, 'filing_object_id', filing_object_id, 'kind', kind, 'ordinal', ordinal,
                                                  'purpose', purpose) order by rn) as s
    from (
      select r.*, case when r.src = 'f' then 'private_foundation' else 'public_charity' end as fsource,
             coalesce(fd.name, cd.name) as fn,
             row_number() over (partition by r.lead_key order by r.tax_period_end desc, r.amount_amt desc nulls last, r.funder_ein, r.ordinal) as rn
      from funder_reference_nofiling_rows r
      join _nf_ok o on o.lead_key = r.lead_key
      left join funder_reference_directory_snapshot fd on r.src = 'f' and fd.ein = r.funder_ein
      left join charity_reference_directory_snapshot cd on r.src = 'c' and cd.ein = r.funder_ein
    ) q
    where rn <= 5 group by lead_key;

  delete from funder_reference_nofiling_leads;
  insert into funder_reference_nofiling_leads (lead_key, display_name, city, state, stated_ein, funders_count, faith_funders_count, grants_count, periods_count,
    last_period_end, signal, daf_signal, sample, rule_version)
  select g.lead_key, g.display_name, g.city, g.state, g.stated_ein, g.funders_count, coalesce(f.c, 0), g.grants_count, g.periods_count, g.last_period_end,
         case when g.p_sig and g.n_sig then 'both' when g.p_sig then 'purpose' else 'name' end, g.daf_sig, coalesce(s.s, '[]'::jsonb), funder_reference_nofiling_rule_version()
  from _nf_ok g
  left join _nf_faith f on f.lead_key = g.lead_key
  left join _nf_sample s on s.lead_key = g.lead_key;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function funder_reference_nofiling_build() from public, anon, authenticated;
grant execute on function funder_reference_nofiling_build() to service_role;
