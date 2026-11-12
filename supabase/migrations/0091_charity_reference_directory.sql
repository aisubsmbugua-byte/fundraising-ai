-- STATE items 113 + 116 (rulings 0048 clause 4 and 0047): what the internal funder screen reads for the grantmaking
-- public charities and donor-advised fund sponsors of item 116. Additive: one view, one snapshot (a materialized
-- view with its own indexes, on a NEW object, not on the loader's tables), three functions. It creates no table the
-- loader writes, writes nothing, and adds no index to charity_reference_*.
--
-- Applied on the owner's go of 2026-11-12 ("Charities in the same screen"), the clause 7 go of ruling 0048.
--
-- The kinds stay separate labels (ruling 0047 clause 2): a funder carries is_grantmaking_public_charity,
-- is_daf_sponsor, or both, and nothing here blends them with private foundations. No donor is named anywhere
-- (ruling 0047 clause 3): none is stored.
--
-- Every column is one stored value or one named aggregate, and says which:
--   grants_domestic_orgs_amt           Part IX line 1 column (A), the LATEST tax period held
--   grants_domestic_orgs_max_amt       the LARGEST such figure over the periods held (the figure the public-charity rule tests)
--   daf_held_max_cnt                   the LARGEST Schedule D Part I line 1 column (a) count over the periods held (the figure the sponsor rule tests)
-- A figure a return does not state is null, never zero.

create view charity_reference_directory with (security_invoker = true) as
select
  o.ein,
  nullif(btrim(concat_ws(' ', o.legal_name_line1, o.legal_name_line2)), '') as name,
  o.city,
  o.state,
  o.zip,
  o.is_grantmaking_public_charity,
  o.is_daf_sponsor,
  o.source_object_id,
  o.source_tax_period_end,
  lf.tax_period_end                                   as figures_period_end,
  lf.filing_object_id                                 as figures_filing_object_id,
  lf.part_ix_line_1_grants_domestic_orgs_total_amt    as grants_domestic_orgs_amt,
  lf.part_i_line_20_total_assets_eoy_amt              as total_assets_eoy_amt,
  lf.schedule_i_rows_listed_count,
  mx.grants_domestic_orgs_max_amt,
  dm.daf_held_max_cnt,
  ld.daf_value_eoy_amt                                as daf_value_eoy_amt,
  ld.tax_period_end                                   as daf_period_end,
  (select count(*) from charity_reference_period_coverage c where c.ein = o.ein and c.status = 'loaded')::integer as periods_held,
  lower(concat_ws(' ', o.legal_name_line1, o.legal_name_line2, o.city)) as search_text
from charity_reference_organizations o
left join lateral (
  select x.tax_period_end, x.filing_object_id, x.part_ix_line_1_grants_domestic_orgs_total_amt,
         x.part_i_line_20_total_assets_eoy_amt, x.schedule_i_rows_listed_count
  from charity_reference_figures x where x.ein = o.ein order by x.tax_period_end desc limit 1
) lf on true
left join lateral (
  select max(x.part_ix_line_1_grants_domestic_orgs_total_amt) as grants_domestic_orgs_max_amt
  from charity_reference_figures x where x.ein = o.ein
) mx on true
left join (
  select ein, max(daf_held_cnt) as daf_held_max_cnt from charity_reference_daf_figures group by ein
) dm on dm.ein = o.ein
left join (
  select distinct on (ein) ein, tax_period_end, daf_value_eoy_amt from charity_reference_daf_figures order by ein, tax_period_end desc
) ld on ld.ein = o.ein;

revoke all on table charity_reference_directory from anon, authenticated;
grant select on table charity_reference_directory to authenticated;

-- the snapshot, with the indexes a search uses (a materialized view cannot carry row-level security, so nobody
-- reads it directly; the search below reads it after checking the caller is a signed-in member)
create materialized view charity_reference_directory_snapshot as
select d.*, now() as refreshed_at from charity_reference_directory d with data;

create unique index charity_reference_directory_snapshot_ein_idx on charity_reference_directory_snapshot (ein);
create index charity_reference_directory_snapshot_state_idx on charity_reference_directory_snapshot (state);
create index charity_reference_directory_snapshot_name_idx on charity_reference_directory_snapshot ((lower(name)), ein);
create index charity_reference_directory_snapshot_grants_desc_idx on charity_reference_directory_snapshot (grants_domestic_orgs_max_amt desc nulls last, ein);
create index charity_reference_directory_snapshot_grants_asc_idx on charity_reference_directory_snapshot (grants_domestic_orgs_max_amt asc nulls last, ein);
create index charity_reference_directory_snapshot_daf_desc_idx on charity_reference_directory_snapshot (daf_held_max_cnt desc nulls last, ein);

revoke all on table charity_reference_directory_snapshot from public, anon, authenticated;

create function charity_reference_refresh_directory()
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
begin
  refresh materialized view concurrently charity_reference_directory_snapshot;
  return (select max(refreshed_at) from charity_reference_directory_snapshot);
end;
$$;
revoke all on function charity_reference_refresh_directory() from public, anon, authenticated;
grant execute on function charity_reference_refresh_directory() to service_role;

create function charity_reference_directory_refreshed_at()
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select case when my_organization_id() is null then null else (select max(refreshed_at) from charity_reference_directory_snapshot) end
$$;
revoke all on function charity_reference_directory_refreshed_at() from public, anon;
grant execute on function charity_reference_directory_refreshed_at() to authenticated;

-- ---------------------------------------------------------------------------
-- search: name, EIN or city, with state, kind and size filters, sorted and paged on the server
-- ---------------------------------------------------------------------------
-- p_kind   'any' | 'charity' (is a grantmaking public charity) | 'daf' (is a donor-advised fund sponsor) |
--          'both' (is both). A funder that is both appears under 'charity' and under 'daf'; counts are never added across kinds.
-- p_min_grants / p_max_grants  bounds on the largest Part IX line 1 grants-to-organizations figure over the periods held
--          (a funder with no such figure is left out when either bound is set, never counted as zero).
-- p_sort   'name' | 'grants' | 'daf_funds' (an unknown value is refused, not quietly replaced)
create function charity_reference_search(
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
