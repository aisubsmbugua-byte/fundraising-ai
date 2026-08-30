-- Keep the URLs the search already returned.
--
-- Donor Finder ran a web search, kept only the prose the model wrote about
-- it, and then had a second model call extract structured candidates from
-- that prose. The web_search_tool_result blocks -- which carry the real URLs
-- the API actually visited -- were discarded. So `website` was whatever the
-- model could recall, usually nothing, and a candidate could be invented
-- entirely with no way to tell.
--
-- This is the same defect the Research Agent was rebuilt to remove: a model
-- TYPING structured facts rather than SELECTING from data already captured.
-- The fix here is much lighter, because nothing needs verifying -- it just
-- needs keeping.
--
-- A cited URL is NOT the funder's website. It is as likely to be ProPublica,
-- a news article or a grant directory. Storing one as `website` would be
-- actively dangerous now that entity resolution consults a prospect's domain
-- ahead of filing ambiguity: an aggregator page would be read as the
-- organization speaking about itself. So provenance and officialness are
-- recorded separately, and never conflated.
alter table candidates add column funder_name text;
alter table candidates add column opportunity_name text;
alter table candidates add column source_url text;
alter table candidates add column source_domain text;
alter table candidates add column official_website_candidate text;

-- official_candidate | third_party_source. Deliberately NOT a Postgres enum:
-- this vocabulary is expected to move once Research starts confirming
-- domains, same reasoning as citation_consistency and the depth tiers.
--
-- Donor Finder can never write 'official_confirmed'. Confirmation is earned
-- by Research, which is the only step that actually tests a domain -- and it
-- is earned through corroboration (reciprocal links from filings, matching
-- legal name and address, a registry link, a redirect from a verified legacy
-- domain), NOT by requiring an EIN on the page. Plenty of legitimate
-- nonprofits never publish one.
alter table candidates add column website_status text;

-- captured | source_missing. A candidate the extractor could not attribute to
-- any returned search result is the fabrication signal -- the same thing
-- evidence_missing catches in Research. It is kept for audit, never shown in
-- the queue, and must never become a prospect.
alter table candidates add column capture_status text not null default 'captured';

-- domain + normalized funder name + normalized opportunity name.
--
-- Never domain alone: pcusa.org hosts many agencies and programs, and
-- collapsing on it would merge distinct funding opportunities into one.
-- Two programs from the same funder stay separate; the same program found
-- twice consolidates.
alter table candidates add column dedupe_key text;

create index candidates_dedupe_key_idx on candidates (dedupe_key);

-- Carried across on acceptance so entity resolution knows whether this
-- prospect's website is the funder's own or a third party's page about them.
-- Null means hand-entered or pre-dating this, which is treated as official --
-- only an explicit third_party_source is withheld from domain resolution.
alter table prospects add column website_status text;

comment on column candidates.website_status is
  'official_candidate | third_party_source. Donor Finder never writes official_confirmed -- that is earned in Research.';
comment on column candidates.capture_status is
  'captured | source_missing. source_missing candidates are audit-only and must not become prospects.';
