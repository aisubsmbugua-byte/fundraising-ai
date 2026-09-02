-- What a run was asked to go and get, when it was a targeted follow-up.
--
-- "Gather more intelligence" now aims at what the previous run recorded as
-- missing -- a 990 grant schedule, recent grants, whatever that funder
-- actually lacked -- rather than repeating a general dossier search. Without
-- recording the aim, a follow-up and a first pass are indistinguishable
-- afterwards, and the only question worth asking about this feature is
-- whether targeting a gap actually closes it more often than not targeting
-- it. That question needs the two populations separable.
--
-- Null on every run that was not targeted, which is not the same fact as an
-- empty array: null means "this run had no targets", [] would mean "it was a
-- follow-up that found nothing to aim at".
alter table research_runs add column research_focus text[];

comment on column research_runs.research_focus is
  'Information sections and source classes this run was asked to prioritise, derived from the previous run''s gaps. Null when the run was not a targeted follow-up.';
