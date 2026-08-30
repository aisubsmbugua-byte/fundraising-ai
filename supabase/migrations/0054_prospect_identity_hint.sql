-- What the user knows that we don't.
--
-- When a funder's name is generic -- "Presbyterian...", "Community
-- Foundation..." -- name-based resolution cannot succeed, and the
-- disambiguation list degenerated into twenty EINs a fundraiser has no way
-- to tell apart. Asking them to identify an organization by EIN asks for the
-- expertise they came to the platform lacking.
--
-- So the question changes to one they can answer: a website, a city, a
-- denomination or parent body, a grant program name, where they came across
-- the funder. Any one of those narrows a search that a name alone cannot.
--
-- Stored on the prospect rather than the run because it is durable knowledge
-- about the organization, not an observation of one attempt to research it:
-- every future run should have it.
alter table prospects add column identity_hint text;

comment on column prospects.identity_hint is
  'A human-supplied detail that identifies this funder when its name is ambiguous (website, city, denomination, program). Passed to the research search.';
