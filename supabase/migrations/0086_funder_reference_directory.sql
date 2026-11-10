-- STATE item 113 (ruling 0048): what the internal, read-only funder database screen
-- reads. Additive: one view and one function over the shared reference tables of
-- migration 0084. It creates no table, writes nothing, and adds no index.
--
-- DO NOT APPLY TO THE LIVE DATABASE UNTIL THE OWNER SAYS THE NATIONAL LOAD CAN TAKE
-- IT (ruling 0048 clause 7). A view takes no write lock, but the owner asked that
-- nothing new touch the live tables while item 114's national load is running.
--
-- Access is exactly 0084's: the view is security_invoker, so the signed-in caller's
-- own row-level-security policies on the underlying tables decide what is read (a
-- signed-in member of any organization; no write policy exists for any role). The
-- screen is limited to superadmins by the web application's access check
-- (lib/funder-reference/access.ts); the database permission stays as ruling 0045
-- clause 1 set it, so opening the screen to others later changes no data permission.

-- ---------------------------------------------------------------------------
-- the directory: one row per funder, with the figures of its latest tax period held
-- ---------------------------------------------------------------------------
-- Every column is one stored value or one named count -- nothing is blended. The
-- figures are those of ONE tax period (figures_period_end), the latest the database
-- holds for the funder, read from ONE filing (figures_filing_object_id); no column
-- combines periods. There is deliberately no single "giving" column (ruling 0045
-- clause 3): grants_paid_per_books is Part I line 25 column (a), by that name.
create view funder_reference_directory with (security_invoker = true) as
select
  f.ein,
  nullif(btrim(concat_ws(' ', f.legal_name_line1, f.legal_name_line2)), '') as name,
  f.city,
  f.state,
  f.zip,
  f.source_object_id,
  f.source_tax_period_end,
  lf.tax_period_end            as figures_period_end,
  lf.filing_object_id          as figures_filing_object_id,
  lf.fmv_assets_eoy_amt,
  lf.contributions_paid_per_books_amt,
  lf.grants_listed_count,
  terms.only_preselected_charities_box_checked,
  (select count(*) from funder_reference_period_coverage c
    where c.ein = f.ein and c.status = 'loaded')::integer as periods_held,
  lower(concat_ws(' ', f.legal_name_line1, f.legal_name_line2, f.city)) as search_text
from funder_reference_foundations f
left join lateral (
  select x.tax_period_end, x.filing_object_id, x.fmv_assets_eoy_amt,
         x.contributions_paid_per_books_amt, x.grants_listed_count
  from funder_reference_figures x
  where x.ein = f.ein
  order by x.tax_period_end desc
  limit 1
) lf on true
left join funder_reference_application_terms terms
  on terms.filing_object_id = lf.filing_object_id;

revoke all on table funder_reference_directory from anon, authenticated;
grant select on table funder_reference_directory to authenticated;

-- ---------------------------------------------------------------------------
-- search: by name, EIN or city, with filters, sorted and paged on the server
-- ---------------------------------------------------------------------------
-- p_query   words are matched against the funder's name and city, ALL of them
--           (case-insensitive, anywhere); a query that is only digits and dashes
--           (3 or more digits) is matched against the start of the EIN instead.
-- p_state   the two-letter state of the funder's address on its latest return.
-- p_min_assets / p_max_assets  bounds on fair market value of all assets, end of
--           year, in the latest tax period held (a funder with no such figure is
--           left out when either bound is set, never counted as zero).
-- p_preselected  'any' | 'marked' (the return ticks the box saying it gives only to
--           pre-selected charities) | 'not_marked' (it does not tick it; this is not
--           a statement that the funder accepts requests).
-- p_sort    'name' | 'assets' | 'grants_paid' (an unknown value is refused, not
--           quietly replaced by another order).
-- total_matches is the number of funders that match, whatever the page; it repeats
-- on every row of the page. An empty page has no rows, so the caller counts by
-- asking for the first page of the same search.
create function funder_reference_search(
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
security invoker
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
    from funder_reference_directory d
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

revoke all on function funder_reference_search(text, text, bigint, bigint, text, text, boolean, integer, integer)
  from public, anon;
grant execute on function funder_reference_search(text, text, bigint, bigint, text, text, boolean, integer, integer)
  to authenticated;
