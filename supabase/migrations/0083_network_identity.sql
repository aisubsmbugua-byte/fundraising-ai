-- STATE item 107, slice A, authorized by ruling 0044 (clauses 1, 2, 9, 10 and
-- the part of clause 4 that governs where candidates may come from): a
-- recorded person carries the facts that identify them, the platform may
-- PROPOSE up to three candidate matches from the public web, and a HUMAN says
-- which one is the real person, or "none of these". Nothing is researched
-- about a person beyond finding those candidates.
--
-- Two changes.
--
-- (i) network_connections gains the identifying facts and the identity
--     decision. title, city and state are optional text (the employer is the
--     existing `affiliation`). do_not_research is a flag a human sets and code
--     honours. identity_status is unconfirmed / confirmed / none_of_these, NOT
--     NULL DEFAULT 'unconfirmed': nobody is identified until a human says so.
--       * network_connections_identity_decision_check ties the decision
--         columns to the status in the manner of 0077's
--         network_path_suggestions_decision_check: unconfirmed carries no
--         candidate, decider or time; confirmed carries all three; none_of_these
--         carries a decider and a time and NO candidate. A row cannot be
--         "confirmed" without a candidate and a person who decided, nor
--         carry a decider while still unconfirmed.
--       * NO contact-detail column is added (ruling 0044 clause 1: no email,
--         phone, social handle or profile link is stored, ever).
--
-- (ii) network_identity_candidates: one row per candidate the platform
--     proposes for a person. It is the AI's PROPOSAL and nothing more -- it is
--     never "chosen" on its own row; the choice lives on the connection
--     (identity_candidate_id). There is no human edit of a candidate's content
--     (no update policy). A candidate keeps the URL, title and passage the web
--     search actually RETURNED (the capture contract); the model only selected
--     which captured source it came from. `agreement` is computed by CODE, not
--     by the model: for each recorded fact, whether its distinctive tokens all
--     appear in the captured text. rank is 1..3 and unique per person, so the
--     database itself holds at most three candidates per person.
--
-- WHAT THE DATABASE ENFORCES, beyond shape (each is exercised against a real
-- Postgres by scripts/test-network-identity-migration.ts):
--   * Org match on EVERY cross-table reference (hard rule 6; 0077's reasoning:
--     a foreign-key check runs as the table owner and does not respect RLS).
--     Security-definer triggers, in 0066/0077's exact pattern (set search_path =
--     public), fire on insert OR update of the referencing columns:
--       candidate.network_connection_id -> the connection's organization
--       candidate.ai_run_id             -> the run's organization
--       connection.identity_candidate_id-> the candidate's organization, and
--                                          the candidate must be THIS person's
--                                          own
--       connection.identity_decided_by  -> the decider belongs to the same
--                                          organization, and when a database
--                                          session is acting the decider IS
--                                          that session's user
--   * A candidate can be born only for a person who is not marked
--     do_not_research and whose identity is still unconfirmed: a person who is
--     confirmed, "none of these", or do-not-research cannot be given candidates
--     by any path, whatever the application does.
--   * A candidate's source_url must be http(s) and must not be on a social or
--     professional network or a people-data broker (ruling 0044 clause 4). The
--     list here and the list in lib/network-identity.ts are the same list; the
--     migration test fails if they drift.
--   * Editing the identifying facts of a CONFIRMED person (person_name,
--     affiliation, title, city, state) resets identity_status to unconfirmed,
--     clears the decision columns and deletes that person's candidates,
--     because the confirmation was of the facts as recorded. The server action
--     does the same; this trigger is what makes it true for every path.
--     "None of these" is NOT reset by an edit: it is a recorded no, and only a
--     human resets it.
--   * Marking a person do_not_research deletes their candidates (and a
--     confirmation that rested on one is voided with it): nothing is kept that
--     was found about someone who has been marked off limits.
--   * Deleting a candidate that is the chosen one voids the confirmation
--     (unconfirmed, decision cleared) instead of leaving it dangling. The
--     foreign key is ON DELETE SET NULL, NOT RESTRICT: erasing a person must
--     always work, and deleting a connection cascades to its candidates.
--
-- Tenant isolation (hard rule 6, 0033_multi_tenant_rls.sql): the candidates
-- table carries organization_id references organizations(id) default
-- my_organization_id() with RLS scoped by it. Insert, select and delete
-- policies exist for authenticated; there is deliberately NO update policy.
--
-- Additive under ruling 0020: eight new columns on one existing table, one new
-- table, their constraints, indexes, policies, functions and triggers. No
-- existing column, policy or function is dropped or redefined, and every
-- existing row takes the defaults (unconfirmed, not do-not-research, no facts).
-- Migrations 0001-0082 are untouched.
--
-- DEPLOY ORDER, both ways:
--   * MIGRATION AHEAD OF THE CODE: the new columns default safely and nothing
--     reads them; the existing Network page, capture, import and path-finding
--     behave exactly as before. Safe.
--   * CODE AHEAD OF THE MIGRATION: adding or importing a person that has NO
--     title, city or state still works (the code leaves those columns out of
--     the write when they are empty); a person WITH one of them cannot be
--     saved and the user is told why. The identity screen and "Find matches"
--     read tables and columns that do not exist yet; every read is tolerant
--     and says so in plain words, and no run is born and no model is called
--     (the candidate-finding action reads the person's identity columns
--     before the ledger birth and refuses when they cannot be read). Nothing
--     is sent to anyone in either order.
--
-- SQL-editor caveat: the Supabase SQL editor runs a pasted script as one
-- transaction, so this applies together or not at all. Re-running after
-- success fails on the existing column, table, policy and trigger names (no
-- IF NOT EXISTS) -- a refusal that rolls the whole script back, not damage.

-- (i) the identifying facts and the identity decision
alter table network_connections
  add column title text,
  add column city text,
  add column state text,
  add column do_not_research boolean not null default false,
  add column identity_status text not null default 'unconfirmed',
  add column identity_decided_by uuid references auth.users (id),
  add column identity_decided_at timestamptz,
  -- The chosen candidate. The foreign key is added below, after the
  -- candidates table exists.
  add column identity_candidate_id uuid;

alter table network_connections
  add constraint network_connections_identity_status_check
  check (identity_status in ('unconfirmed', 'confirmed', 'none_of_these'));

-- The decision columns and the status say one thing, never two.
alter table network_connections
  add constraint network_connections_identity_decision_check
  check (
    (identity_status = 'unconfirmed'
      and identity_candidate_id is null and identity_decided_by is null and identity_decided_at is null)
    or (identity_status = 'confirmed'
      and identity_candidate_id is not null and identity_decided_by is not null and identity_decided_at is not null)
    or (identity_status = 'none_of_these'
      and identity_candidate_id is null and identity_decided_by is not null and identity_decided_at is not null)
  );

-- A fact is absent (null) or real: never an empty string, never unbounded.
alter table network_connections
  add constraint network_connections_title_check
  check (title is null or (length(btrim(title)) > 0 and length(title) <= 300));
alter table network_connections
  add constraint network_connections_city_check
  check (city is null or (length(btrim(city)) > 0 and length(city) <= 200));
alter table network_connections
  add constraint network_connections_state_check
  check (state is null or (length(btrim(state)) > 0 and length(state) <= 100));

comment on column network_connections.title is
  'Ruling 0044 clause 1: the person''s title or role, as the recorder knows it. Optional. Part of the facts a confirmed identity rests on: editing it resets a confirmation.';
comment on column network_connections.city is
  'Ruling 0044 clause 1: city, as recorded. Optional.';
comment on column network_connections.state is
  'Ruling 0044 clause 1: state or region, as recorded. Optional.';
comment on column network_connections.do_not_research is
  'Ruling 0044 clause 10: a human has marked this person off limits for research. Honoured in code BEFORE any run is born, and by the candidates insert trigger.';
comment on column network_connections.identity_status is
  'unconfirmed | confirmed | none_of_these. Only a human moves it off unconfirmed (ruling 0044 clause 2). The system never confirms an identity itself.';
comment on column network_connections.identity_candidate_id is
  'The candidate a human confirmed as this person. Set only with identity_status = confirmed, by the decision check.';

-- (ii)
create table network_identity_candidates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) default my_organization_id(),
  network_connection_id uuid not null references network_connections (id) on delete cascade,
  -- The ledger row of the look that produced this candidate. ai_runs rows are
  -- retained, never deleted; SET NULL only keeps this table erasable.
  ai_run_id uuid references ai_runs (id) on delete set null,
  -- The name as found on the source.
  label text not null,
  -- What the source says they do (employer / title as found). The model's
  -- wording of it, selected from the captured source: a claim, not a fact.
  headline text,
  location_text text,
  -- The three below are what the web search actually RETURNED. The model chose
  -- an index into the captured list; it never typed any of these.
  source_url text not null,
  source_title text,
  source_passage text,
  -- Computed by code from the recorded facts and the captured text; see
  -- lib/network-identity.ts (computeAgreement).
  agreement jsonb not null,
  rank integer not null,
  created_at timestamptz not null default now()
);

alter table network_identity_candidates
  add constraint network_identity_candidates_label_check
  check (length(btrim(label)) > 0 and length(label) <= 300);
alter table network_identity_candidates
  add constraint network_identity_candidates_text_length_check
  check (
    (headline is null or length(headline) <= 600)
    and (location_text is null or length(location_text) <= 300)
    and (source_title is null or length(source_title) <= 600)
    and (source_passage is null or length(source_passage) <= 4000)
  );
alter table network_identity_candidates
  add constraint network_identity_candidates_agreement_check
  check (jsonb_typeof(agreement) = 'object');
-- At most three per person, enforced by the database.
alter table network_identity_candidates
  add constraint network_identity_candidates_rank_check
  check (rank between 1 and 3);
alter table network_identity_candidates
  add constraint network_identity_candidates_unique_rank
  unique (network_connection_id, rank);
alter table network_identity_candidates
  add constraint network_identity_candidates_unique_candidate
  unique (network_connection_id, source_url, label);

-- A source is an http(s) page, and never a social or professional network or a
-- people-data broker (ruling 0044 clause 4). The host is read the same way the
-- code reads it: scheme://[userinfo@]host[:port][/...]. KEEP THIS LIST IN STEP
-- WITH lib/network-identity.ts (SOCIAL_NETWORK_HOSTS, PEOPLE_DATA_BROKER_HOSTS);
-- scripts/test-network-identity-migration.ts fails if they drift.
alter table network_identity_candidates
  add constraint network_identity_candidates_source_url_check
  check (
    source_url ~* '^https?://[^/?#[:space:]]+'
    and lower(substring(source_url from '^[hH][tT][tT][pP][sS]?://(?:[^/?#@]*@)?([^/?#:]+)'))
      !~ '(^|\.)(linkedin\.com|lnkd\.in|facebook\.com|fb\.com|fb\.me|messenger\.com|instagram\.com|twitter\.com|x\.com|t\.co|threads\.net|tiktok\.com|snapchat\.com|pinterest\.com|reddit\.com|tumblr\.com|vk\.com|weibo\.com|xing\.com|whatsapp\.com|t\.me|bsky\.app|mastodon\.social|zoominfo\.com|rocketreach\.co|apollo\.io|lusha\.com|signalhire\.com|spokeo\.com|whitepages\.com|radaris\.com|beenverified\.com|truepeoplesearch\.com|fastpeoplesearch\.com|peoplefinders\.com|intelius\.com|pipl\.com)$'
  );

-- The chosen candidate. SET NULL, not RESTRICT: erasing a person must always
-- work (the cascade from the connection deletes its candidates), and deleting
-- the chosen candidate on its own voids the confirmation first (trigger below),
-- so SET NULL never meets a row it would leave in a half-state.
alter table network_connections
  add constraint network_connections_identity_candidate_fk
  foreign key (identity_candidate_id) references network_identity_candidates (id) on delete set null;

create index network_identity_candidates_organization_id_idx on network_identity_candidates (organization_id);
create index network_identity_candidates_ai_run_id_idx on network_identity_candidates (ai_run_id) where ai_run_id is not null;
create index network_connections_identity_candidate_id_idx on network_connections (identity_candidate_id) where identity_candidate_id is not null;
create index network_connections_identity_status_idx on network_connections (organization_id, identity_status);

comment on table network_identity_candidates is
  'Ruling 0044 clause 2: the AI''s PROPOSAL that a real person found on the public web could be a recorded person. Never chosen on its own row -- the human''s choice is network_connections.identity_candidate_id. No human edit of its content; deleted with its person.';
comment on column network_identity_candidates.agreement is
  'Computed by CODE: per recorded fact (name, employer, title, city, state), found / not_found / not_recorded by token containment in the captured source text. "not_found" is not a proven disagreement -- code cannot prove one.';

-- Tenant isolation.
alter table network_identity_candidates enable row level security;

create policy "team members can read network identity candidates"
  on network_identity_candidates for select
  to authenticated
  using (organization_id = my_organization_id());

create policy "team members can record network identity candidates"
  on network_identity_candidates for insert
  to authenticated
  with check (organization_id = my_organization_id());

-- A fresh look replaces an unconfirmed person's candidates, and a human can
-- reset a person; both delete candidates. No UPDATE policy: a candidate's
-- content is never edited.
create policy "team members can clear network identity candidates"
  on network_identity_candidates for delete
  to authenticated
  using (organization_id = my_organization_id());

-- Cross-table org integrity on EVERY reference, 0066/0077's pattern.
create function enforce_network_candidate_connection_org_match() returns trigger as $$
declare
  c record;
begin
  select organization_id, do_not_research, identity_status into c
    from network_connections where id = new.network_connection_id;
  if new.organization_id is distinct from c.organization_id then
    raise exception 'organization_id must match the referenced network connection''s organization_id';
  end if;
  if tg_op = 'INSERT' then
    if c.do_not_research then
      raise exception 'candidates cannot be recorded for a person marked do not research';
    end if;
    if c.identity_status <> 'unconfirmed' then
      raise exception 'candidates can be recorded only for a person whose identity is unconfirmed';
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger network_identity_candidates_connection_org_match
  before insert or update of organization_id, network_connection_id on network_identity_candidates
  for each row execute function enforce_network_candidate_connection_org_match();

create function enforce_network_candidate_run_org_match() returns trigger as $$
begin
  if new.ai_run_id is not null
     and new.organization_id is distinct from (select organization_id from ai_runs where id = new.ai_run_id) then
    raise exception 'organization_id must match the referenced ai run''s organization_id';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger network_identity_candidates_run_org_match
  before insert or update of organization_id, ai_run_id on network_identity_candidates
  for each row execute function enforce_network_candidate_run_org_match();

create function enforce_network_connection_candidate_match() returns trigger as $$
declare
  c record;
begin
  if new.identity_candidate_id is null then
    return new;
  end if;
  select organization_id, network_connection_id into c
    from network_identity_candidates where id = new.identity_candidate_id;
  if new.organization_id is distinct from c.organization_id then
    raise exception 'organization_id must match the referenced identity candidate''s organization_id';
  end if;
  if new.id is distinct from c.network_connection_id then
    raise exception 'the confirmed candidate must be one of this person''s own candidates';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger network_connections_identity_candidate_match
  before insert or update of organization_id, identity_candidate_id on network_connections
  for each row execute function enforce_network_connection_candidate_match();

create function enforce_network_connection_decider() returns trigger as $$
begin
  if new.identity_decided_by is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.identity_decided_by is not distinct from old.identity_decided_by then
    return new;
  end if;
  if new.organization_id is distinct from (select organization_id from profiles where id = new.identity_decided_by) then
    raise exception 'the person who decided an identity must belong to the same organization';
  end if;
  -- A decision made through a signed-in session is recorded as that session's
  -- user. (A session-less context, such as a maintenance script, is not
  -- pinned.)
  if auth.uid() is not null and new.identity_decided_by <> auth.uid() then
    raise exception 'an identity decision is recorded as the person who made it';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger network_connections_identity_decider
  before insert or update of organization_id, identity_decided_by on network_connections
  for each row execute function enforce_network_connection_decider();

-- A confirmation is of the facts as recorded. Editing them (or marking the
-- person do-not-research) voids a confirmation. BEFORE: rewrites NEW. The
-- candidates are deleted by the AFTER trigger below, not here, because a
-- candidate delete may itself touch this row.
create function reset_network_identity_on_edit() returns trigger as $$
begin
  if old.identity_status = 'confirmed' and (
       new.person_name is distinct from old.person_name
    or new.affiliation is distinct from old.affiliation
    or new.title is distinct from old.title
    or new.city is distinct from old.city
    or new.state is distinct from old.state
    or (new.do_not_research and not old.do_not_research)
  ) then
    new.identity_status := 'unconfirmed';
    new.identity_decided_by := null;
    new.identity_decided_at := null;
    new.identity_candidate_id := null;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger network_connections_identity_reset
  before update on network_connections
  for each row execute function reset_network_identity_on_edit();

-- AFTER: a person who goes back to unconfirmed (an edit, or a human reset)
-- starts clean, and a person marked do-not-research keeps nothing that was
-- found. pg_trigger_depth() > 1 means this update came from inside another
-- trigger (the candidate-delete trigger below voiding a decision), where the
-- OTHER candidates must survive and a nested delete of the row being deleted
-- would raise.
create function clear_network_candidates_after_identity_reset() returns trigger as $$
begin
  if pg_trigger_depth() > 1 then
    return null;
  end if;
  if (old.identity_status <> 'unconfirmed' and new.identity_status = 'unconfirmed')
     or (new.do_not_research and not old.do_not_research) then
    delete from network_identity_candidates where network_connection_id = new.id;
  end if;
  return null;
end;
$$ language plpgsql security definer set search_path = public;

create trigger network_connections_identity_clear_candidates
  after update on network_connections
  for each row execute function clear_network_candidates_after_identity_reset();

-- Deleting the chosen candidate on its own voids the confirmation rather than
-- leaving it dangling. When the delete is the cascade from erasing the person,
-- the person is already gone and this updates no row.
create function void_network_identity_when_candidate_deleted() returns trigger as $$
begin
  update network_connections
     set identity_status = 'unconfirmed',
         identity_decided_by = null,
         identity_decided_at = null,
         identity_candidate_id = null
   where identity_candidate_id = old.id;
  return old;
end;
$$ language plpgsql security definer set search_path = public;

create trigger network_identity_candidates_void_decision
  before delete on network_identity_candidates
  for each row execute function void_network_identity_when_candidate_deleted();
