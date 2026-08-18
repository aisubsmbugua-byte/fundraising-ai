-- Slice 3+ extension: organization knowledge base, stage 5.
-- Apply after 0007_org_profile_funders_tags.sql.
--
-- Splits outcomes and org_values (single text blobs, in practice
-- entered one item per line) into proper arrays -- preserves
-- existing lines as separate list items. Converts notable_funders
-- from a flat text[] of names into a jsonb array of
-- {name, location} objects (location null for existing entries).

alter table org_profile
  alter column outcomes type text[]
  using (
    case
      when outcomes is null or trim(outcomes) = '' then null
      else (
        select array_agg(trim(line))
        from unnest(string_to_array(outcomes, E'\n')) as line
        where trim(line) <> ''
      )
    end
  );

alter table org_profile
  alter column org_values type text[]
  using (
    case
      when org_values is null or trim(org_values) = '' then null
      else (
        select array_agg(trim(line))
        from unnest(string_to_array(org_values, E'\n')) as line
        where trim(line) <> ''
      )
    end
  );

alter table org_profile
  alter column notable_funders type jsonb
  using (
    case
      when notable_funders is null then null
      else (
        select jsonb_agg(jsonb_build_object('name', elem, 'location', null))
        from unnest(notable_funders) as elem
      )
    end
  );
