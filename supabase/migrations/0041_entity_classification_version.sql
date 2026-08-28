-- Records which version of the entity-classification logic produced a run's
-- verdicts, and makes "identity was never established" a backend state that
-- downstream work must gate on rather than a convention.
--
-- Why version rather than rewrite: a stored entity_validation_status is a
-- record of what that version of the logic actually decided. Rewriting
-- historical rows would destroy the audit trail the evidence ledger exists to
-- provide, and would make old runs unexplainable ("why did v21 admit this?").
-- Readers map an old value to current meaning via entityStatusMeaning() in
-- lib/research.ts instead.
--
-- Version 1 rows: classified per URL, and emitted "affiliate_related_entity"
-- for a differing EIN whose name matched -- asserting an affiliation that was
-- never established, and admitting that evidence to extraction.
-- Version 2 rows: classified per entity, and emit
-- "different_entity_unverified_relation", whose evidence is withheld from
-- extraction in code.
alter table research_runs add column entity_classification_version integer;

-- Whether this run's research may be treated as a confirmed dossier for the
-- prospect. False when identity was refused (ambiguous_filings / unresolved):
-- several competing organizations then sit at the same trust level, and only
-- the extraction model's reading separates them -- which is exactly the
-- dependency this design removes elsewhere. Such a run is still valuable as
-- candidate intelligence and is kept; it simply must not advance into
-- Strategy/Outreach until a human confirms the entity.
--
-- Stored rather than derived at read time so a consumer cannot forget the
-- rule, and so the gate survives future changes to the resolution vocabulary.
alter table research_runs add column dossier_confirmed boolean not null default false;

create index research_runs_dossier_confirmed_idx on research_runs (dossier_confirmed);
