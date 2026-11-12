-- STATE items 113 + 116 (ruling 0048): make a funder page with many recipient rows fast. Found on the first look at
-- the live data: the biggest donor-advised fund sponsors have 80,000 recipient rows in one tax period, and the read
-- policy of migration 0089 called my_organization_id() once for EVERY row (the planner cannot hoist a bare function
-- call), so one page took about 10 seconds. Wrapping the call in a sub-select makes the planner evaluate it once per
-- query. The rule is identical: a signed-in member of an organization may read; nobody else may; nobody may write.
-- Only the six read policies of the charity tables are replaced; no table, column, index or grant changes.

do $$
declare t text;
begin
  foreach t in array array[
    'charity_reference_filings', 'charity_reference_organizations', 'charity_reference_figures',
    'charity_reference_daf_figures', 'charity_reference_grants', 'charity_reference_period_coverage'
  ] loop
    execute format('drop policy %I on %I', t || '_members_read', t);
    execute format(
      'create policy %I on %I for select to authenticated using ((select my_organization_id()) is not null)',
      t || '_members_read', t);
  end loop;
end $$;
