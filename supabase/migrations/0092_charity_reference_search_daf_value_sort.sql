-- STATE items 113 + 116 (ruling 0048 clause 4): one more sort for the charity search, 'daf_value' (the value of the
-- donor-advised funds the latest Schedule D reports, end of year). Found on the first look at the live data:
-- some filers type a dollar amount into the Schedule D "number of funds" field (a hospital foundation reports 7.8
-- million funds), so sorting by the count puts those first. The count is still shown exactly as filed; the value
-- is the better way to find a real sponsor. Replaces the function only: same arguments, same result columns, same
-- access (signed-in members; a stranger gets nothing). No table, view or index is touched.

create or replace function charity_reference_search(
  p_query text default null,
  p_state text default null,
  p_kind text default 'any',
  p_min_grants bigint default null,
  p_max_grants bigint default null,
  p_sort text default 'name',
  p_descending boolean default false,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  ein text,
  name text,
  city text,
  state text,
  is_grantmaking_public_charity boolean,
  is_daf_sponsor boolean,
  figures_period_end date,
  figures_filing_object_id text,
  grants_domestic_orgs_amt bigint,
  grants_domestic_orgs_max_amt bigint,
  total_assets_eoy_amt bigint,
  daf_held_max_cnt bigint,
  daf_value_eoy_amt bigint,
  daf_period_end date,
  periods_held integer,
  total_matches bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  q text := lower(btrim(coalesce(p_query, '')));
  digits text := regexp_replace(lower(btrim(coalesce(p_query, ''))), '[^0-9]', '', 'g');
  ein_search boolean := lower(btrim(coalesce(p_query, ''))) ~ '^[0-9][0-9-]*$'
                        and length(regexp_replace(lower(btrim(coalesce(p_query, ''))), '[^0-9]', '', 'g')) >= 3;
  patterns text[];
  order_expr text;
  dir text := case when coalesce(p_descending, false) then 'desc' else 'asc' end;
  lim integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  off integer := greatest(coalesce(p_offset, 0), 0);
begin
  -- the read rule of ruling 0045 clause 1: a signed-in member of an organization; anyone else gets nothing
  if my_organization_id() is null then
    return;
  end if;
  if p_kind not in ('any', 'charity', 'daf', 'both') then
    raise exception 'charity_reference_search: unknown p_kind %', p_kind;
  end if;
  order_expr := case p_sort
    when 'name' then 'lower(d.name)'
    when 'grants' then 'd.grants_domestic_orgs_max_amt'
    when 'daf_funds' then 'd.daf_held_max_cnt'
    when 'daf_value' then 'd.daf_value_eoy_amt'
    else null
  end;
  if order_expr is null then
    raise exception 'charity_reference_search: unknown p_sort %', p_sort;
  end if;

  select coalesce(array_agg('%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%'), '{}')
    into patterns
    from unnest(regexp_split_to_array(q, '\s+')) as w
    where w <> '' and not ein_search;

  return query execute format($f$
    select d.ein, d.name, d.city, d.state, d.is_grantmaking_public_charity, d.is_daf_sponsor,
           d.figures_period_end, d.figures_filing_object_id, d.grants_domestic_orgs_amt, d.grants_domestic_orgs_max_amt,
           d.total_assets_eoy_amt, d.daf_held_max_cnt, d.daf_value_eoy_amt, d.daf_period_end, d.periods_held,
           count(*) over ()::bigint as total_matches
    from charity_reference_directory_snapshot d
    where (not $1 or d.ein like $2)
      and d.search_text ilike all ($3)
      and ($4::text is null or d.state = $4)
      and ($5 = 'any'
           or ($5 = 'charity' and d.is_grantmaking_public_charity)
           or ($5 = 'daf' and d.is_daf_sponsor)
           or ($5 = 'both' and d.is_grantmaking_public_charity and d.is_daf_sponsor))
      and ($6::bigint is null or d.grants_domestic_orgs_max_amt >= $6)
      and ($7::bigint is null or d.grants_domestic_orgs_max_amt <= $7)
    order by %s %s nulls last, d.ein
    limit $8 offset $9
  $f$, order_expr, dir)
  using ein_search, digits || '%', patterns, nullif(btrim(p_state), ''), p_kind, p_min_grants, p_max_grants, lim, off;
end;
$$;

revoke all on function charity_reference_search(text, text, text, bigint, bigint, text, boolean, integer, integer) from public, anon;
grant execute on function charity_reference_search(text, text, text, bigint, bigint, text, boolean, integer, integer) to authenticated;
