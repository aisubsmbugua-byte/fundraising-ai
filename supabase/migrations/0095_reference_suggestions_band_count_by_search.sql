-- STATE item 117 (ruling 0049): the suggestions count a funder's grants in a size band. Migration 0094 did it by unpacking
-- every funder's array of amounts; measured on the live table that was too slow to open a page on. The amounts are kept
-- largest first, so the count is two binary searches instead. The count is the same number; only how it is reached changes.
-- Replaces one function and adds two helpers. No table, column or index changes.

-- how many elements of a LARGEST-FIRST array are >= x
create function funder_reference_count_at_least(p_amounts bigint[], p_x bigint)
returns bigint
language plpgsql
immutable
as $$
declare
  n integer := coalesce(cardinality(p_amounts), 0);
  lo integer := 1;
  hi integer := n;
  mid integer;
  found integer := 0;
begin
  if n = 0 then return 0; end if;
  -- the last position whose value is >= p_x
  while lo <= hi loop
    mid := (lo + hi) / 2;
    if p_amounts[mid] >= p_x then
      found := mid;
      lo := mid + 1;
    else
      hi := mid - 1;
    end if;
  end loop;
  return found;
end;
$$;

-- how many elements of a largest-first array lie in [p_lo, p_hi]; a null bound is open
create function funder_reference_count_in_band(p_amounts bigint[], p_lo bigint, p_hi bigint)
returns bigint
language sql
immutable
as $$
  select case when p_lo is null and p_hi is null then coalesce(cardinality(p_amounts), 0)::bigint
              else greatest(0, (case when p_lo is null then coalesce(cardinality(p_amounts), 0)::bigint else funder_reference_count_at_least(p_amounts, p_lo) end)
                             - (case when p_hi is null then 0 else funder_reference_count_at_least(p_amounts, p_hi + 1) end))
         end
$$;

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
                else funder_reference_count_in_band(j.faith_amounts, p_band_lo, p_band_hi) end as in_band
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
