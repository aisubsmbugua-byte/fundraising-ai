-- STATE item 119, stage two (ruling 0053): the apply function of 0102, replaced in place.
--
-- WHY. 0102 was applied to the live database and its first run refused: "UPDATE requires a WHERE clause". The Supabase platform (the
-- safeupdate setting) refuses an UPDATE or DELETE with no WHERE when it is reached through the API, and the test database does not, so the
-- five whole-table updates of the function were written with `where true` here. Same rule, same result. No table, column or grant changes;
-- 0102 is not edited (an applied migration is never rewritten). The same refusal applies to the lead build of 0100, which began with a
-- whole-table delete and so could not have run from scripts/refresh-nofiling-leads.ts (it had been run through the SQL connector, which does
-- not set that rule); it is replaced here too, with the one `where true`.

create or replace function funder_reference_exempt_list_apply()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare out jsonb;
begin
  update funder_reference_exempt_list
     set name_key = funder_reference_name_key(name) || '|' || coalesce(upper(btrim(state)), '')
   where true;

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
         end
   where true;

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
                      or exists (select 1 from charity_reference_directory_snapshot s where s.ein = e.ein)
   where true;

  drop table if exists _el_fk;
  create temp table _el_fk on commit drop as
    select distinct k from (
      select funder_reference_name_key(name) || '|' || coalesce(upper(btrim(state)), '') as k from funder_reference_directory_snapshot
      union all
      select funder_reference_name_key(name) || '|' || coalesce(upper(btrim(state)), '') from charity_reference_directory_snapshot) z
    where k is not null;
  create index on _el_fk (k);
  update funder_reference_exempt_list e set loaded_name = exists (select 1 from _el_fk f where f.k = e.name_key) where true;

  update funder_reference_exempt_list set offered = (tier is not null and tier <= funder_reference_exempt_list_offered_tier()) where true;

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

-- the lead build of 0100, with its whole-table delete qualified
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

  delete from funder_reference_nofiling_leads where true;
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
