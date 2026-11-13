-- STATE item 117 (ruling 0049): two things found by running the suggestions against the whole national table.
--
-- 1. SPEED. A page took about 6 seconds. The binary search re-read its array parameter on every step (a large stored array
--    is re-expanded each time it is subscripted); it now copies the array to a local variable once. The in-band count is also
--    computed once per funder (a materialized step) instead of once in the filter, once in the list and once in the sort.
--    The same counts; only the work changes.
-- 2. KINDS STAY SEPARATE (ruling 0049 clause 6, ruling 0047 clause 2). Ordered by the printed rule, the first fifteen funders
--    for a small ministry were all donor-advised fund sponsors and gift funds (they give to everything, so their counts are
--    the largest), and a sponsor's grants are donor-directed: a ministry cannot approach the sponsor as it would a foundation.
--    The suggestions now come in three separate groups, each ordered by the same printed rule:
--      main      funders that are not donor-advised fund sponsors and do not say "pre-selected charities only"
--      daf       donor-advised fund sponsors (public charities that hold donor-advised funds)
--      held_out  funders whose filing says they give only to pre-selected charities
--    The function's last-but-three argument changes from a yes/no to a group name, so the 0094 to 0096 function is dropped
--    and replaced. It has been live for hours and nothing else calls it.

create or replace function funder_reference_count_at_least(p_amounts bigint[], p_x bigint)
returns bigint
language plpgsql
immutable
as $$
declare
  a bigint[] := p_amounts;
  n integer := coalesce(cardinality(p_amounts), 0);
  lo integer := 1;
  hi integer := n;
  mid integer;
  found integer := 0;
begin
  if n = 0 then return 0; end if;
  while lo <= hi loop
    mid := (lo + hi) / 2;
    if a[mid] >= p_x then
      found := mid;
      lo := mid + 1;
    else
      hi := mid - 1;
    end if;
  end loop;
  return found;
end;
$$;

drop function reference_funder_suggestions(bigint, bigint, text, boolean, integer, integer);

create function reference_funder_suggestions(
  p_band_lo bigint default null,
  p_band_hi bigint default null,
  p_state text default null,
  p_group text default 'main',
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
  if p_group not in ('main', 'daf', 'held_out') then
    raise exception 'reference_funder_suggestions: unknown p_group %', p_group;
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
    select j.*, round(j.j_faith::numeric / nullif(j.j_grants, 0), 4) as j_share, count(*) over () as j_total
    from joined j
    where j.j_in_band > 0
      and case p_group
            when 'daf' then j.j_daf
            when 'held_out' then j.j_no_unsolicited and not j.j_daf
            else not j.j_daf and not j.j_no_unsolicited
          end
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
revoke all on function reference_funder_suggestions(bigint, bigint, text, text, integer, integer) from public, anon;
grant execute on function reference_funder_suggestions(bigint, bigint, text, text, integer, integer) to authenticated;
