-- Organizations have a history, and until now a prospect could only record a
-- present tense.
--
-- Overseas Council International stopped filing in 2017 after a short-period
-- return and was absorbed into another ministry. Research surfaced the
-- surviving organization -- but only as a RIVAL in the disambiguation list,
-- because the resolver's model of the world is "several organizations share
-- this name, one of them is yours". It has no way to express "these are the
-- same organization at different times", so confirming the pre-merger EIN
-- pinned every future run to a defunct entity, deterministically and with
-- more confidence than before.
--
-- predecessor_eins records the ones it used to be. ein stays the single
-- surviving entity, so nothing downstream has to learn about multiplicity:
-- resolution, gating and strategy all keep asking one prospect for one EIN.
-- This is history a person supplied, kept so a later run can recognise an old
-- filing as this prospect's own past rather than a different organization.
alter table prospects add column predecessor_eins text[];

comment on column prospects.predecessor_eins is
  'EINs this prospect previously operated under (merger, rename). ein remains the current, surviving entity.';
