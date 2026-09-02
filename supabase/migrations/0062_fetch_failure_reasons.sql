-- WHY a page could not be read, not just how many could not be.
--
-- The run recorded fetch_attempts and fetch_failures and discarded everything
-- that would explain them. A targeted follow-up on The Stewardship Foundation
-- failed 3 of 6 fetches and still could not read the 990 grant schedule it was
-- aimed at -- and there was no way to tell whether the filing was unreachable,
-- the wrong content type, too large for the content budget, or simply a page
-- the model chose badly. Those call for completely different fixes, and a
-- count distinguishes none of them.
--
-- Server-tool errors arrive as a 200 with an error block, so a failure has
-- always been visible here; it was just thrown away at the point it was
-- counted.
alter table research_runs add column fetch_failure_reasons text[];

comment on column research_runs.fetch_failure_reasons is
  'One entry per failed web_fetch: the API error code and the URL it was attempted on. Null on runs that predate this, which is not the same fact as an empty array (no failures).';
