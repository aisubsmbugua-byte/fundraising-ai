-- Ruling 0026: a run is recorded before it runs, and how it ended is a
-- second fact -- no metering, and no run, without a record.
--
-- ai_runs is the unified run ledger decision 0006 requires before any
-- billing: every live AI operation writes one row here, and the row is
-- born BEFORE the model is called (see beginRun in lib/ai-runs.ts). The
-- birth row carries the facts known at start -- which operation, which
-- organization, when. Everything else -- model, tokens, how it ended --
-- is written exactly once, at the end, by the code that observed it
-- (finalizeRun).
--
-- The load-bearing encoding, inherited from 0066's absence pattern but
-- inverted to fit the fact being recorded: there is deliberately NO
-- 'killed' outcome value. A platform-killed run writes nothing at its
-- death, so a born row whose outcome is still null past its operation's
-- deadline IS the evidence of a killed run. A column that could store
-- "killed" would let code fake an observation nobody made; the absence
-- of a terminal outcome is the honest state ("interrupted, and known to
-- be"). Absence of a ROW means the run never started -- nothing may
-- infer a run from any other table.
--
-- Existing run tables (discovery_search_runs, research_runs,
-- strategy_runs) are wrapped, not rewritten (ruling 0026 clause 5,
-- ruling 0020): they keep their shapes, and an operation that has its
-- own row records that row's id here in source_table/source_id so the
-- two views of one run stay joinable.
--
-- Additive under ruling 0020: one new table, two new indexes, three new
-- policies, one new function, one new trigger. No existing table, column
-- or policy is touched -- there is no `add column` in this file -- so it
-- is safe to apply ahead of its code.

create table ai_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) default my_organization_id(),
  -- Which operation ran, e.g. 'discovery_search', 'research', 'strategy'.
  -- Deliberately unconstrained text: the vocabulary is owned by
  -- AI_RUN_OPERATIONS in lib/ai-runs.ts (a TS union, so a typo is a
  -- compile error at every call site), and decision 0006 prices per
  -- operation, so new operations will arrive. A check constraint here
  -- would force a migration per new operation without adding a guarantee
  -- the type system does not already give the only code that writes this.
  operation text not null,
  started_at timestamptz not null default now(),
  -- Nullable until known, all of them. Consumption is CAPTURED from the
  -- API response the operation actually received, never estimated
  -- (ruling 0026 clause 3) -- a run whose response never arrived keeps
  -- these null, which is a fact ("no consumption figures"), not a zero.
  -- For an operation that makes several model calls (discovery,
  -- research, strategy), tokens are the aggregate across its calls and
  -- model is the FIRST call's model; the per-call split, where it
  -- exists, lives in the operation's own run table (see source_* below).
  model text,
  input_tokens integer,
  output_tokens integer,
  ended_at timestamptz,
  -- How the run ended, written once by the code that observed it.
  -- 'empty' means ran to completion and produced nothing usable -- only
  -- recorded where the operation already distinguishes that itself.
  -- NO 'killed' value, on purpose -- see the header.
  outcome text,
  error_note text,
  -- Soft reference to the operation's own row (e.g. 'research_runs' +
  -- that run's id), set at birth where the row already exists. NOT a
  -- foreign key, deliberately: the referenced table differs per
  -- operation, and a single-table FK cannot express that. With no FK
  -- there is also no cross-table FK integrity hole to close with an
  -- org-match trigger (0066's pattern guards real FKs; this column
  -- cannot hold a row hostage or be dereferenced past RLS -- reading
  -- the referenced row is still org-scoped by that table's own policy).
  source_table text,
  source_id uuid
);

alter table ai_runs
  add constraint ai_runs_outcome_check
  check (outcome in ('completed', 'failed', 'empty'));
  -- null passes an IN check (unknown, not false) -- an unfinalized row
  -- is legal; 'killed' or any other value is not.

-- One row cannot assert "ended" without saying how, and cannot carry an
-- error note while claiming to still be running. This is what keeps the
-- killed-run encoding honest: ended_at set with outcome null would be a
-- third state nobody defined.
alter table ai_runs
  add constraint ai_runs_terminal_shape_check
  check (
    (outcome is null and ended_at is null and error_note is null)
    or (outcome is not null and ended_at is not null)
  );

-- A reference names its table and its row together or not at all.
alter table ai_runs
  add constraint ai_runs_source_pairing_check
  check ((source_table is null) = (source_id is null));

alter table ai_runs
  add constraint ai_runs_token_counts_check
  check (
    (input_tokens is null or input_tokens >= 0)
    and (output_tokens is null or output_tokens >= 0)
  );

create index ai_runs_organization_id_started_at_idx on ai_runs (organization_id, started_at desc);
create index ai_runs_source_idx on ai_runs (source_table, source_id) where source_id is not null;

comment on table ai_runs is
  'The run ledger (ruling 0026, decision 0006). One row per live AI operation, born BEFORE the model is called. A row with no terminal outcome past its operation''s deadline IS a platform-killed run -- there is deliberately no ''killed'' value. Absence of a row means the run never started. Retained, never deleted.';

comment on column ai_runs.outcome is
  'completed | failed | empty, written once at the end by the code that observed it. Null means unfinalized: still running, or killed by the platform before it could report. There is no way to write ''killed'' because nobody ever observes it.';

comment on column ai_runs.model is
  'From the API response, never configured-and-assumed. For a multi-call operation, the first call''s model; the per-call split lives in the operation''s own run table, joinable via source_table/source_id.';

comment on column ai_runs.source_table is
  'Soft reference (with source_id) to the operation''s own row where one exists -- discovery_search_runs, research_runs, strategy_runs -- so the ledger view and the operation''s view of one run stay joinable (ruling 0026 clause 5). Not an FK; see the in-file note.';

-- Terminal outcome is written once, enforced in the database rather than
-- by convention (ruling 0026 clause 4: updates only from unfinalized to
-- terminal). The RLS update policy below already stops the ordinary
-- session client from touching a finalized row; this trigger closes the
-- same door for EVERY role, service-role included, and additionally pins
-- the birth facts -- a finalization may add what the run consumed and
-- how it ended, never rewrite what ran, for whom, or when.
create function ai_runs_enforce_terminal_once() returns trigger as $$
begin
  if old.outcome is not null then
    raise exception 'ai_runs: a run with a terminal outcome is immutable -- terminal is written once';
  end if;
  if new.outcome is null then
    raise exception 'ai_runs: an update must write a terminal outcome -- unfinalized to terminal is the only legal transition';
  end if;
  if new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id
     or new.operation is distinct from old.operation
     or new.started_at is distinct from old.started_at
     or new.source_table is distinct from old.source_table
     or new.source_id is distinct from old.source_id then
    raise exception 'ai_runs: birth facts (id, organization, operation, started_at, source) cannot be rewritten';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger ai_runs_terminal_once
  before update on ai_runs
  for each row execute function ai_runs_enforce_terminal_once();

-- Tenant isolation. Hard rule 6, following 0033/0066. Nothing in the
-- codebase catches a table that skips this, so it is done here and
-- checked by scripts/test-tenant-isolation.ts.
alter table ai_runs enable row level security;

create policy "team members can record an ai run"
  on ai_runs for insert
  to authenticated
  with check (organization_id = my_organization_id());

create policy "team members can read their org's ai runs"
  on ai_runs for select
  to authenticated
  using (organization_id = my_organization_id());

-- Update reaches only UNFINALIZED rows of the caller's own org -- once a
-- terminal outcome exists the row is out of reach through any code path
-- using the ordinary session client, and the trigger above covers the
-- rest. No delete policy at all: run records are retained like outcomes
-- (ruling 0026 clause 4) -- a meter whose history can be deleted is not
-- a meter.
create policy "team members can finalize an unfinalized ai run"
  on ai_runs for update
  to authenticated
  using (organization_id = my_organization_id() and outcome is null)
  with check (organization_id = my_organization_id());
