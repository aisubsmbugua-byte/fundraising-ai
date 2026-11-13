-- STATE item 117 as amended (ruling 0050, which supersedes 0049): one list, ordered by how much of a funder's giving goes to
-- faith-named recipients, and nobody held apart.
--
-- 0049 clause 5 put the number of faith-named grants in band first. Run on the real data that favored organizations that give
-- very many small grants. 0050 clause 5 puts first the funders that have at least five such grants in band ("enough to go
-- on"), orders those by the SHARE of their listed grants that are faith-named, then by the count in band, then by recency;
-- funders with fewer than five follow, in the same order, and are marked.
-- 0049 clause 6 held back funders that say "pre-selected charities only" and set donor-advised fund sponsors apart. 0050
-- clause 6 removes both: one list, kind and manner of taking requests are labels only.
--
-- The group argument therefore goes (the 0097 function is dropped and replaced), and one column is added to the result:
-- meets_floor. The five is defined once, here, in reference_suggestion_floor(); the application reads it back from this
-- function rather than keeping its own copy.

create or replace function reference_suggestion_floor()
returns integer
language sql
immutable
as $$ select 5 $$;
grant execute on function reference_suggestion_floor() to authenticated;

drop function reference_funder_suggestions(bigint, bigint, text, text, integer, integer);

create function reference_funder_suggestions(
  p_band_lo bigint default null,
  p_band_hi bigint default null,
  p_state text default null,
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
  total_matches bigint,
  meets_floor boolean
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
  floor_n integer := reference_suggestion_floor();
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
  joined as materialized (
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
    select j.*, round(j.j_faith::numeric / nullif(j.j_grants, 0), 4) as j_share, (j.j_in_band >= floor_n) as j_meets,
           count(*) over () as j_total
    from joined j
    where j.j_in_band > 0
    order by (j.j_in_band >= floor_n) desc, round(j.j_faith::numeric / nullif(j.j_grants, 0), 4) desc nulls last,
             j.j_in_band desc, j.j_last desc nulls last, j.j_ein
    limit lim offset off
  )
  select r.j_ein, r.j_source, r.j_name, r.j_city, r.j_state, r.j_daf, r.j_grants, g.periods_counted, r.j_faith, r.j_in_band, r.j_share, r.j_last,
         case when st is null then null else coalesce((g.faith_by_state ->> st)::bigint, 0) end,
         r.j_giving, r.j_giving_end,
         case when r.j_source = 'public_charity' then null::boolean else r.j_no_unsolicited end,
         g.faith_amounts_capped, g.faith_sample, g.rule_version, r.j_total::bigint, r.j_meets
  from ranked r
  join funder_reference_faith_giving g on g.ein = r.j_ein and g.source = r.j_source
  order by r.j_meets desc, r.j_share desc nulls last, r.j_in_band desc, r.j_last desc nulls last, r.j_ein;
end;
$$;
revoke all on function reference_funder_suggestions(bigint, bigint, text, integer, integer) from public, anon;
grant execute on function reference_funder_suggestions(bigint, bigint, text, integer, integer) to authenticated;
