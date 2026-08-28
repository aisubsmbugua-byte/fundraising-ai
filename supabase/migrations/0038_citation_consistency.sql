-- Stage 4 (Citation Consistency Validation) of the Research Department
-- redesign. Deterministic, code-only -- no new model call. Compares the
-- extraction step's claimed source_excerpt against the search step's own
-- citation text for that source (real API data, not model-typed). This
-- proves the extraction step didn't drift from what was actually cited at
-- search time -- it does NOT independently verify the live webpage still
-- says that; see docs/decisions/0002-research-agent.md for the full
-- distinction and the outlined (not built) real-snapshot follow-up.
alter table research_sources
  add column search_time_excerpts text[] not null default '{}';

-- text, not an enum: see lib/research.ts RESEARCH_CITATION_CONSISTENCY_STATUSES
-- -- deliberately a shared-constant + app-validated vocabulary while this
-- and the rest of the Research Department verification-state model is
-- still being worked out, per explicit direction not to lock evolving
-- states into rigid DB enums during this phase.
alter table research_claim_sources
  add column citation_consistency text;
