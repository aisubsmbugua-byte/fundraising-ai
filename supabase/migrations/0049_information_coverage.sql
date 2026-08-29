-- Replaces a single "complete" label with what a fundraiser actually needs to
-- know: which categories of information this dossier contains.
--
-- One summary label was trying to represent too many things at once. Three
-- runs were marked "complete" while containing no grant information at all --
-- technically correct under the rule, and misleading in the way that matters,
-- because a user has no reason to doubt it. Different fundraising decisions
-- need different information, so no single flag can mean "done".
--
-- Coverage is judged on OUTCOMES rather than on which pages were read. The
-- previous approach matched source URLs against known patterns, and that
-- detector never once recognised the source that actually supplied 20 named
-- grants -- a pattern list is a list we will always be behind on. Whether the
-- run obtained grant recipients is a question with a reliable answer.
alter table research_runs add column missing_information text[];

-- Retrieval diagnostics (searches_used, fetch_attempts, fetch_failures,
-- official_site_fetched, filing_fetched, missing_source_classes) are kept as
-- they are, but they are OPERATIONAL. They explain why a gap exists; they do
-- not tell a fundraiser whether the dossier holds what they need.
