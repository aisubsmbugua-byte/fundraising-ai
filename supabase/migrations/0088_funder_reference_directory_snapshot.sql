-- STATE item 113 (ruling 0048): make the funder search fast. Additive. Applied on the
-- owner's go of 2026-11-10 ("can you fix the speed?"), which is the clause 7 go for the
-- indexes below. They sit on a NEW materialized view, not on the loader's tables, so the
-- running national load is not blocked or slowed by them.
--
-- Why: measured on the live database, sorting a common word by assets took about 7
-- seconds, because every search had to find the latest figures of every match one funder
-- at a time. A search needs one row per funder with its latest figures already worked
-- out, in a table with the indexes a search uses. That is a snapshot of
-- funder_reference_directory (0086), taken by funder_reference_refresh_directory().
--
-- THE SNAPSHOT CAN LAG THE LOADER. It is refreshed when someone with the service key
-- calls the refresh function (the owner's person, after a load; the loader itself is
-- not changed by this ruling). Every search page says when it was last refreshed, so a
-- reader is never told the list is current when it is not. The funder page reads the
-- loader's tables directly and is always current.
--
-- A materialized view cannot carry row-level security, so nobody can read it directly
-- (all privileges revoked). The search reads it through a SECURITY DEFINER function
-- that first checks the caller is a signed-in member of an organization, which is
-- exactly what ruling 0045's read policy requires of the underlying tables.

create materialized view funder_reference_directory_snapshot as
select d.*, now() as refreshed_at
from funder_reference_directory d
with data;

create unique index funder_reference_directory_snapshot_ein_idx on funder_reference_directory_snapshot (ein);
create index funder_reference_directory_snapshot_state_idx on funder_reference_directory_snapshot (state);
create index funder_reference_directory_snapshot_name_idx on funder_reference_directory_snapshot ((lower(name)), ein);
create index funder_reference_directory_snapshot_assets_desc_idx on funder_reference_directory_snapshot (fmv_assets_eoy_amt desc nulls last, ein);
create index funder_reference_directory_snapshot_assets_asc_idx on funder_reference_directory_snapshot (fmv_assets_eoy_amt asc nulls last, ein);
create index funder_reference_directory_snapshot_paid_desc_idx on funder_reference_directory_snapshot (contributions_paid_per_books_amt desc nulls last, ein);
create index funder_reference_directory_snapshot_paid_asc_idx on funder_reference_directory_snapshot (contributions_paid_per_books_amt asc nulls last, ein);

revoke all on table funder_reference_directory_snapshot from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- refresh: service role only
-- ---------------------------------------------------------------------------
create function funder_reference_refresh_directory()
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
begin
  refresh materialized view concurrently funder_reference_directory_snapshot;
  return (select max(refreshed_at) from funder_reference_directory_snapshot);
end;
$$;
revoke all on function funder_reference_refresh_directory() from public, anon, authenticated;
grant execute on function funder_reference_refresh_directory() to service_role;

-- ---------------------------------------------------------------------------
-- when the snapshot was last refreshed (null if it holds no funder yet)
-- ---------------------------------------------------------------------------
create function funder_reference_directory_refreshed_at()
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select case when my_organization_id() is null then null else (select max(refreshed_at) from funder_reference_directory_snapshot) end
$$;
revoke all on function funder_reference_directory_refreshed_at() from public, anon;
grant execute on function funder_reference_directory_refreshed_at() to authenticated;

-- ---------------------------------------------------------------------------
-- the search, now over the snapshot (same arguments and result columns as 0086/0087)
-- ---------------------------------------------------------------------------
create or replace function funder_reference_search(
  p_query text default null,
  p_state text default null,
  p_min_assets bigint default null,
  p_max_assets bigint default null,
  p_preselected text default 'any',
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
  figures_period_end date,
  figures_filing_object_id text,
  fmv_assets_eoy_amt bigint,
  contributions_paid_per_books_amt bigint,
  grants_listed_count integer,
  only_preselected_charities_box_checked boolean,
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
  if p_preselected not in ('any', 'marked', 'not_marked') then
    raise exception 'funder_reference_search: unknown p_preselected %', p_preselected;
  end if;
  order_expr := case p_sort
    when 'name' then 'lower(d.name)'
    when 'assets' then 'd.fmv_assets_eoy_amt'
    when 'grants_paid' then 'd.contributions_paid_per_books_amt'
    else null
  end;
  if order_expr is null then
    raise exception 'funder_reference_search: unknown p_sort %', p_sort;
  end if;

  select coalesce(array_agg('%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%'), '{}')
    into patterns
    from unnest(regexp_split_to_array(q, '\s+')) as w
    where w <> '' and not ein_search;

  return query execute format($f$
    select d.ein, d.name, d.city, d.state, d.figures_period_end, d.figures_filing_object_id,
           d.fmv_assets_eoy_amt, d.contributions_paid_per_books_amt, d.grants_listed_count,
           d.only_preselected_charities_box_checked, d.periods_held,
           count(*) over ()::bigint as total_matches
    from funder_reference_directory_snapshot d
    where (not $1 or d.ein like $2)
      and d.search_text ilike all ($3)
      and ($4::text is null or d.state = $4)
      and ($5::bigint is null or d.fmv_assets_eoy_amt >= $5)
      and ($6::bigint is null or d.fmv_assets_eoy_amt <= $6)
      and ($7 = 'any'
           or ($7 = 'marked' and d.only_preselected_charities_box_checked is true)
           or ($7 = 'not_marked' and d.only_preselected_charities_box_checked is not true))
    order by %s %s nulls last, d.ein
    limit $8 offset $9
  $f$, order_expr, dir)
  using ein_search, digits || '%', patterns, nullif(btrim(p_state), ''), p_min_assets, p_max_assets,
        p_preselected, lim, off;
end;
$$;
