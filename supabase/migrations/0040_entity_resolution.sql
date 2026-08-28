-- Stage 1 entity resolution (see docs/decisions/0002-research-agent.md).
--
-- Identity becomes a determined property of a run rather than something that
-- emerges from counting search results. Three problems this addresses, all
-- found in real runs:
--   1. The same organization received different verdicts at different URLs,
--      because classification was per-URL and a bare-domain title carries no
--      name to match (Maclellan v21: one sibling foundation, three URLs, two
--      verdicts).
--   2. The run's EIN was decided by majority vote across captured text, which
--      let a formatting coincidence elevate a different real organization to
--      the highest trust tier (Servants Heart v1).
--   3. There was nowhere to record an authoritative identifier, so every run
--      re-derived identity from scratch.
--
-- Fully additive. Every column is nullable and null on existing rows means
-- "not evaluated by this stage" -- never "passed".

-- Authoritative identity on the prospect itself. Once ein is set, entity
-- resolution is deterministic for every future run of that prospect.
-- Populated only by an explicit human action (see hard rule 3 in CLAUDE.md --
-- AI-derived identity is proposed on the run, never written here silently).
alter table prospects add column ein text;
alter table prospects add column legal_name text;
alter table prospects add column aliases text[];

-- The EIN a given source appears to describe, detected from its captured text
-- and its URL. This is what lets sources be grouped into entities so a verdict
-- can be reached once per entity instead of once per URL.
alter table research_sources add column source_ein text;

-- What identity the run resolved, and how. entity_resolution_method is text
-- validated against a shared TypeScript constant rather than a Postgres enum,
-- matching the convention for vocabularies still being worked out
-- (entity_validation_status, evidence kind).
alter table research_runs add column confirmed_ein text;
alter table research_runs add column entity_resolution_method text;

create index research_sources_source_ein_idx on research_sources (source_ein);
create index prospects_ein_idx on prospects (ein);
