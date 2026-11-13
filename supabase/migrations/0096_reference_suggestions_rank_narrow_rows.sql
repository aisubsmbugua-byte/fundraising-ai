-- STATE item 117 (ruling 0049): measured on the live table, migrations 0094 and 0095 sorted every candidate funder with its
-- whole array of amounts and its sample grants attached (about 4 seconds for a page). The ranking only needs a few small
-- columns; the sample, the per-state counts and the rule version are fetched afterwards for the 25 funders shown. The
-- same funders in the same order with the same numbers; only the work changes. Replaces one function; no table, column,
-- index or grant changes.
create or replace function reference_funder_suggestions(
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
    select f.ein as j_ein, f.source as j_source, d.name as j_name, d.city as j_city, d.state as j_state, false as j_daf,
           f.grants_counted as j_grants, f.faith_count as j_faith, f.faith_last_period_end as j_last,
           case when p_band_lo is null and p_band_hi is null then f.faith_count
                else funder_reference_count_in_band(f.faith_amounts, p_band_lo, p_band_hi) end as j_in_band,
           d.contributions_paid_per_books_amt as j_giving, d.figures_period_end as j_giving_end,
           coalesce(d.only_preselected_charities_box_checked, false) as j_no_unsolicited
    from funder_reference_faith_giving f
    join funder_reference_directory_snapshot d on d.ein = f.ein
    where f.source = 'private_foundation' and f.faith_count > 0 and f.ein not in (select e from mine)
    union all
    select f.ein, f.source, d.name, d.city, d.state, coalesce(d.is_daf_sponsor, false),
           f.grants_counted, f.faith_count, f.faith_last_period_end,
           case when p_band_lo is null and p_band_hi is null then f.faith_count
                else funder_reference_count_in_band(f.faith_amounts, p_band_lo, p_band_hi) end,
           d.grants_domestic_orgs_amt, d.figures_period_end, false
    from funder_reference_faith_giving f
    join charity_reference_directory_snapshot d on d.ein = f.ein
    where f.source = 'public_charity' and f.faith_count > 0 and f.ein not in (select e from mine)
  ),
  ranked as (
    select j.*, round(j.j_faith::numeric / nullif(j.j_grants, 0), 4) as j_share, count(*) over () as j_total
    from joined j
    where j.j_in_band > 0 and j.j_no_unsolicited = coalesce(p_held_out, false)
    order by j.j_in_band desc, round(j.j_faith::numeric / nullif(j.j_grants, 0), 4) desc nulls last, j.j_last desc nulls last, j.j_ein
    limit lim offset off
  )
  select r.j_ein, r.j_source, r.j_name, r.j_city, r.j_state, r.j_daf, r.j_grants, g.periods_counted, r.j_faith, r.j_in_band, r.j_share, r.j_last,
         case when st is null then null else coalesce((g.faith_by_state ->> st)::bigint, 0) end,
         r.j_giving, r.j_giving_end,
         case when r.j_source = 'public_charity' then null::boolean else r.j_no_unsolicited end,
         g.faith_amounts_capped, g.faith_sample, g.rule_version, r.j_total::bigint
  from ranked r
  join funder_reference_faith_giving g on g.ein = r.j_ein and g.source = r.j_source
  order by r.j_in_band desc, r.j_share desc nulls last, r.j_last desc nulls last, r.j_ein;
end;
$$;
