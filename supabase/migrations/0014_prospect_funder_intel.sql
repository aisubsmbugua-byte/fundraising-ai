-- Advancement workflow, stage 1b: AI-extracted funder intelligence.
-- Apply after 0013_deep_dive.sql.
--
-- The deep dive already researches the specific funder -- this
-- extracts structured intel (location, type, geographic focus,
-- typical grant size, focus areas) from that same research instead
-- of requiring manual entry. Landed on deep_dive_runs first (AI
-- proposes); only copied onto the prospect record when the human
-- approves the strategy (human decides) -- same single approval gate
-- covers both.

alter table prospects
  add column location text,
  add column funder_type text,
  add column geographic_focus text,
  add column typical_grant_size text,
  add column focus_areas text[];

alter table deep_dive_runs
  add column organization_intel jsonb;
