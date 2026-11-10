-- STATE item 113 (ruling 0048): a faster funder_reference_search. Additive, and it
-- replaces only the function body of 0086; the signature, the result columns, the
-- privileges and every answer it gives are unchanged (the test compares it, funder by
-- funder, with the directory view).
--
-- Why: measured on the live database (60,925 funders, the loader still running), 0086's
-- search took 5 to 9 seconds for a common word, because it built every funder's full
-- directory row (latest figures, terms, held periods) for every match before sorting.
-- This version sorts and filters on the light columns only, joining the latest figures
-- ONLY when the sort, a size bound or the pre-selected filter needs them, and fetches
-- the full row for the (at most 100) funders on the page.
--
-- No table, no index, no write: still read-only, still the caller's own permissions.

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
  needs_figures boolean;
  needs_terms boolean;
  fig_join text;
  terms_join text;
  fmv_expr text;
  paid_expr text;
  box_expr text;
begin
  if p_preselected not in ('any', 'marked', 'not_marked') then
    raise exception 'funder_reference_search: unknown p_preselected %', p_preselected;
  end if;
  order_expr := case p_sort
    when 'name' then 'lower(b.name)'
    when 'assets' then 'b.fmv'
    when 'grants_paid' then 'b.paid'
    else null
  end;
  if order_expr is null then
    raise exception 'funder_reference_search: unknown p_sort %', p_sort;
  end if;

  select coalesce(array_agg('%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%'), '{}')
    into patterns
    from unnest(regexp_split_to_array(q, '\s+')) as w
    where w <> '' and not ein_search;

  needs_terms := p_preselected <> 'any';
  needs_figures := p_sort in ('assets', 'grants_paid') or p_min_assets is not null or p_max_assets is not null or needs_terms;
  fig_join := case when needs_figures then
    'left join lateral (select x.filing_object_id as fid, x.fmv_assets_eoy_amt as fmv, x.contributions_paid_per_books_amt as paid
                        from funder_reference_figures x where x.ein = f.ein
                        order by x.tax_period_end desc limit 1) lf on true' else '' end;
  terms_join := case when needs_terms then
    'left join funder_reference_application_terms t on t.filing_object_id = lf.fid' else '' end;
  fmv_expr := case when needs_figures then 'lf.fmv' else 'null::bigint' end;
  paid_expr := case when needs_figures then 'lf.paid' else 'null::bigint' end;
  box_expr := case when needs_terms then 't.only_preselected_charities_box_checked' else 'null::boolean' end;

  return query execute format($f$
    with base as (
      select f.ein,
             nullif(btrim(concat_ws(' ', f.legal_name_line1, f.legal_name_line2)), '') as name,
             %1$s as fmv,
             %2$s as paid
      from funder_reference_foundations f
      %3$s
      %4$s
      where (not $1 or f.ein like $2)
        and lower(concat_ws(' ', f.legal_name_line1, f.legal_name_line2, f.city)) ilike all ($3)
        and ($4::text is null or f.state = $4)
        and ($5::bigint is null or %1$s >= $5)
        and ($6::bigint is null or %1$s <= $6)
        and ($7 = 'any'
             or ($7 = 'marked' and %5$s is true)
             or ($7 = 'not_marked' and %5$s is not true))
    ), page as (
      select b.ein, b.name,
             row_number() over (order by %6$s %7$s nulls last, b.ein) as rn,
             count(*) over ()::bigint as total
      from base b
      order by rn
      limit $8 offset $9
    )
    select p.ein, p.name, fo.city, fo.state, lf.tax_period_end, lf.filing_object_id,
           lf.fmv_assets_eoy_amt, lf.contributions_paid_per_books_amt, lf.grants_listed_count,
           terms.only_preselected_charities_box_checked,
           (select count(*) from funder_reference_period_coverage c
             where c.ein = p.ein and c.status = 'loaded')::integer,
           p.total
    from page p
    join funder_reference_foundations fo on fo.ein = p.ein
    left join lateral (
      select x.tax_period_end, x.filing_object_id, x.fmv_assets_eoy_amt,
             x.contributions_paid_per_books_amt, x.grants_listed_count
      from funder_reference_figures x
      where x.ein = p.ein
      order by x.tax_period_end desc
      limit 1
    ) lf on true
    left join funder_reference_application_terms terms on terms.filing_object_id = lf.filing_object_id
    order by p.rn
  $f$, fmv_expr, paid_expr, fig_join, terms_join, box_expr, order_expr, dir)
  using ein_search, digits || '%', patterns, nullif(btrim(p_state), ''), p_min_assets, p_max_assets,
        p_preselected, lim, off;
end;
$$;
