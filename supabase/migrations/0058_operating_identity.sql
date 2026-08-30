-- Identity in two layers, and the evidence needed to settle the first one.
--
-- The resolver was offering a three-way choice between organizations where one
-- was plainly right. "Discipleship Ministries - Racial Ethnic Local Church
-- Grants (UMC)" produced three candidates, all carrying the same single reason
-- (`Name contains "Discipleship"`), and the tiebreak went to whichever
-- aggregator had been scraped twice.
--
-- Everything needed to rank them was already on the record. It just never
-- reached the resolver:
--
--   * "(UMC)" in the prospect's own name -- discarded, because the matcher
--     took ONE token from the name and threw away the rest.
--   * nccumc.org, the domain Donor Finder captured it from -- a United
--     Methodist body, corroborating exactly one of the three candidates.
--   * "Racial Ethnic Local Church Grants", the programme name -- the most
--     specific thing anyone knows about a funding opportunity.
--
-- The last two died at the acceptance boundary: acceptCandidate copied
-- funder_name into legal_name and dropped opportunity_name and source_domain
-- on the floor. The capture contract built yesterday stopped at the door of
-- the pipeline.

-- Carried across on acceptance so the resolver can use them.
alter table prospects add column opportunity_name text;
alter table prospects add column source_domain text;

comment on column prospects.opportunity_name is
  'The programme this prospect was found through, e.g. "Racial Ethnic Local Church Grants". Scored heavily in entity resolution -- funders rarely share programme names.';
comment on column prospects.source_domain is
  'The domain Donor Finder captured this prospect from. Provenance, not the funder''s own site -- see candidates.website_status for that distinction.';

-- WHICH ORGANIZATION this is, as distinct from which legal entity.
--
-- An operating identity may be established automatically from an official
-- opportunity page or a decisive scored match. A legal entity (confirmed_ein)
-- may not -- it needs deterministic evidence tying the organization to a
-- filing, because financial claims read off the wrong filing are worse than no
-- financial claims at all.
--
-- Both null is the honest state for every run before this migration: not
-- evaluated, which is not the same as unresolved.
alter table research_runs add column operating_identity_name text;
alter table research_runs add column operating_identity_method text;

-- The plain-language reasons the leading candidate won, in the order they
-- moved the score. Stored rather than recomputed so what a person was shown
-- when they approved is still recoverable afterwards -- scores are relative to
-- the candidate set of that run and cannot be reproduced later.
alter table research_runs add column operating_identity_evidence jsonb;

comment on column research_runs.operating_identity_method is
  'official_opportunity_page | scored_match | user_selected | unresolved. Null = not evaluated (runs predating two-layer identity).';
comment on column research_runs.operating_identity_evidence is
  'Plain-language reasons the operating identity was chosen, as shown to the user at the time.';
