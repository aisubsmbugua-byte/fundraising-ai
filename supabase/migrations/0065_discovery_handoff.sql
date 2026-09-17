-- The Discovery -> Research handoff contract.
--
-- The settled unit of pursuit is the OPPORTUNITY. Qualification cannot evaluate
-- one that Discovery collapsed into a display name and then discarded the
-- source for -- and that is exactly what was happening: `candidates` already
-- captures source_url and source_title, and intake copied neither into
-- `prospects`. The most specific thing known about a funding opportunity was
-- being thrown away one row before the system that needed it.
--
-- Measured cost of that loss: supplying a known opportunity name took one
-- funder's page shortlist recall from 0/4 to 4/4, finding /innovation/ and
-- /innovation/2023-innovation-fund -- pages no keyword vocabulary could have
-- predicted, because grant programmes are named arbitrarily.
--
-- Additive. Existing rows keep handoff_version 0 and are reported as LEGACY
-- rather than back-filled: repairing them by hand would improve a measurement
-- without improving the system.

alter table prospects
  -- The exact page a search returned. Never generated, never reconstructed --
  -- the capture contract, one level further down the pipeline.
  add column source_url text,
  add column source_title text,
  -- Which result in that sweep, so a claim traces to the search that produced
  -- it rather than to a model's recollection.
  add column source_result_index integer,
  -- Whose page it was -- the funder's own, or a directory writing about them.
  -- Kept separate from source_domain: provenance and officialness are
  -- different facts and conflating them is a documented past defect.
  add column source_classification text,
  add column parent_organization text,
  -- named_opportunity | general_funder | intermediary | unknown.
  -- A missing opportunity name is NOT automatically a defect: a general
  -- foundation legitimately has no named programme.
  add column prospect_kind text not null default 'unknown',
  add column handoff_version integer not null default 0;

alter table prospects
  add constraint prospects_prospect_kind_check
  check (prospect_kind in ('named_opportunity', 'general_funder', 'intermediary', 'unknown'));

create index prospects_handoff_version_idx on prospects (handoff_version);

comment on column prospects.source_url is
  'The exact search result Discovery found this funder at. Bypasses the Tier 2 manifest cap -- a human already saw this page describing the opportunity. Selected from real results, never generated. See lib/discovery-handoff.ts.';

comment on column prospects.prospect_kind is
  'What we are being asked to qualify. "unknown" is used deliberately where a display name still carries a programme phrase that was never captured structurally -- asserting general_funder there would claim the funder has no programme, which the evidence does not support.';

comment on column prospects.handoff_version is
  '0 = created before the handoff contract; reported as legacy and NOT back-filled. Rows at the current version are expected to carry a source_url and, where a named opportunity exists, its name.';
