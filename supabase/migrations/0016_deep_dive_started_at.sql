-- Advancement workflow: fix a real bug, not just a UX tweak.
-- Apply after 0015_candidate_funder_intel.sql.
--
-- Previously, Accept triggered the deep-dive research from the
-- candidates page and immediately navigated away to the new prospect
-- page. If the browser cancels an in-flight request when the
-- triggering component unmounts, the research may never actually
-- run -- which matches "waited 3-4 minutes, saw nothing." Moving the
-- trigger to the destination page (which stays mounted) fixes this,
-- but needs a lock so a page refresh doesn't fire a duplicate run.

alter table deep_dive_runs add column started_at timestamptz;
