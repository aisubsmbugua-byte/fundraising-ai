-- Renames the deep-dive tables to say what they now hold.
--
-- "Deep dive" was accurate when that step WAS the research: one call searched
-- the web and proposed a strategy together. Research is now its own agent,
-- its own tab and its own tables, and this step only turns approved
-- intelligence into a strategy. Keeping the old name meant a button labelled
-- "Run New Deep Dive" that did not run research, and a deep_dive_runs table
-- holding strategies -- the kind of mismatch that misleads whoever reads it
-- next.
--
-- A rename preserves the rows, indexes, constraints, policies and triggers;
-- nothing is copied or dropped. Safe here in any case: two pre-beta testers,
-- and the data is test data.
alter table deep_dive_runs rename to strategy_runs;
alter table drafts rename column deep_dive_run_id to strategy_run_id;

-- Indexes and policies survive the table rename but keep their old names, so
-- rename them too -- a policy still called "log deep dive runs" on a table
-- called strategy_runs is the same mismatch one level down.
alter index deep_dive_runs_prospect_idx rename to strategy_runs_prospect_idx;
alter index deep_dive_runs_organization_id_idx rename to strategy_runs_organization_id_idx;
alter policy "team members can log deep dive runs" on strategy_runs rename to "team members can log strategy runs";
alter policy "team members can read deep dive runs" on strategy_runs rename to "team members can read strategy runs";
alter policy "team members can update deep dive runs" on strategy_runs rename to "team members can update strategy runs";
