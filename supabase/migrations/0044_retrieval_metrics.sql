-- Retrieval instrumentation.
--
-- Extraction can be measured by replaying a frozen evidence ledger, but
-- retrieval cannot be replayed -- the whole point of it is going out and
-- finding something new. So it has to be measured by recording properties of
-- what came back, per run.
--
-- The motivating failure: four application-process fields vanished between
-- two runs, and it took a stored-evidence investigation three runs later to
-- find that the funder's own FAQ page had been listed as a source and never
-- fetched. Application rules, eligibility and exclusions exist only on a
-- funder's own site and never in a filing, so "found the page, never read it"
-- is a silent, specific, recurring failure. official_site_fetched would have
-- shown it on the first run.
--
-- All nullable: null means "not instrumented" (every run before this).
alter table research_runs add column searches_used integer;
alter table research_runs add column fetch_attempts integer;
alter table research_runs add column fetch_failures integer;
-- Did we read the funder's OWN site in full? Null when the prospect has no
-- website on file, which is a different situation from failing to fetch one.
alter table research_runs add column official_site_fetched boolean;
-- Did we read at least one IRS filing source in full? The only reliable
-- origin of dated financial figures.
alter table research_runs add column filing_fetched boolean;
-- Total characters of evidence captured, the closest single proxy for how
-- much the run actually had to work with.
alter table research_runs add column captured_chars integer;
