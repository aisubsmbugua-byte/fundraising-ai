-- Whether a dossier actually read what a dossier needs.
--
-- A run can finish cleanly, report facts, and still have missed the single
-- page carrying the information a fundraiser most wants. That already
-- happened twice: four application-process fields vanished because the
-- funder's own FAQ was listed and never fetched, and named grant recipients
-- went from 20 in one run to 0 in the next because the grant schedule was not
-- read. Both runs looked successful.
--
--   complete  every required source class for this funder was read
--   partial   usable research, but a required class was missed
--   blocked   identity was never established, so nothing can be trusted
--             to describe the intended organization
--
-- Null for identity and screen runs: those are not attempting to be dossiers,
-- and judging them against a dossier's requirements would be meaningless.
alter table research_runs add column completion_state text;

-- Exactly what was missing, so "partial" is actionable rather than a mood.
alter table research_runs add column missing_source_classes text[];

create index research_runs_completion_state_idx on research_runs (completion_state);
