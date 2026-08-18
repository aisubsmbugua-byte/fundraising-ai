-- Slice 3+ extension: organization knowledge base, stage 5.
-- Apply after 0007_org_profile_funders_tags.sql.
--
-- Splits outcomes and org_values (single text blobs, in practice
-- entered one item per line) into proper arrays -- preserves
-- existing lines as separate list items. Converts notable_funders
-- from a flat text[] of names into a jsonb array of
-- {name, location} objects (location null for existing entries).
--
-- Postgres doesn't allow a subquery inside ALTER COLUMN ... TYPE ...
-- USING, so this uses add-column -> populate via UPDATE -> drop old
-- -> rename instead of an in-place type change.

alter table org_profile add column outcomes_new text[];
update org_profile
set outcomes_new = (
  select array_agg(trim(line))
  from unnest(string_to_array(outcomes, E'\n')) as line
  where trim(line) <> ''
)
where outcomes is not null and trim(outcomes) <> '';
alter table org_profile drop column outcomes;
alter table org_profile rename column outcomes_new to outcomes;

alter table org_profile add column org_values_new text[];
update org_profile
set org_values_new = (
  select array_agg(trim(line))
  from unnest(string_to_array(org_values, E'\n')) as line
  where trim(line) <> ''
)
where org_values is not null and trim(org_values) <> '';
alter table org_profile drop column org_values;
alter table org_profile rename column org_values_new to org_values;

alter table org_profile add column notable_funders_new jsonb;
update org_profile
set notable_funders_new = (
  select jsonb_agg(jsonb_build_object('name', elem, 'location', null))
  from unnest(notable_funders) as elem
)
where notable_funders is not null;
alter table org_profile drop column notable_funders;
alter table org_profile rename column notable_funders_new to notable_funders;
