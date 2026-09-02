-- The entity ranking, materialized on the run that produced it.
--
-- loadProspectIntelligence recomputed it on EVERY page render: fetch all of a
-- run's sources, fetch every evidence fragment, rebuild candidates, re-score.
-- Measured at 879ms of a 1791ms server-data budget -- and a confirm click pays
-- the whole budget again, because the action writes one row and then
-- router.refresh() re-runs the tree. Half the wait for "confirm" was the page
-- recomputing an answer that had not changed.
--
-- Recomputing was not paranoia: a stored ranking goes stale the moment the
-- resolver improves, and reading a stale column is exactly what made
-- pipeline-readiness report four prospects as blocked while the page showed
-- them resolved. So the fix is not "stop recomputing", it is "record which
-- resolver produced this". A row whose version does not match the current
-- resolver is recomputed on read, as before; a row that matches is read.
--
-- entity_ranking deliberately omits each candidate's matchText -- the whole
-- captured corpus for that entity, easily hundreds of KB, and used only while
-- scoring. Storing it would trade a slow read for a fat one.
alter table research_runs add column entity_ranking jsonb;
alter table research_runs add column entity_ranking_version integer;

comment on column research_runs.entity_ranking is
  'Materialized output of scoreEntityCandidates for this run: leader, margin, achievable, abstain reasons and the ranked candidates (without matchText). Display cache only -- never evidence, and never a substitute for research_sources.';
comment on column research_runs.entity_ranking_version is
  'ENTITY_RANKING_VERSION that produced entity_ranking. When it does not match the code''s current value the ranking is recomputed on read and this row is stale, not wrong.';
