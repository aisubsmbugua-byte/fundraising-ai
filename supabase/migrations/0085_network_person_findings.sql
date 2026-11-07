-- STATE item 112, slice B of item 107, authorized by ruling 0044 (clauses 3, 4,
-- 5, 9 and 10, and clause 2's gate): once a human has CONFIRMED who a recorded
-- person is, the platform may research that one person on the public web and
-- record what it finds as FINDINGS of a closed list of kinds, each kept with
-- the page and passage the web search actually returned, labelled "not yet
-- reviewed by a person", and strikeable by a human. Findings are sourced and
-- strikeable; they are NOT approved one at a time (clause 5), and they feed
-- nothing yet: no path, strategy, draft or funder-facing text reads this table.
--
-- One new table, network_person_findings, plus triggers on it and one trigger on
-- network_connections.
--
--   * kind is a CLOSED list (clause 3): employer; title; board_seat (board,
--     trustee or officer seat); school (school attended); org_leadership_role
--     (leadership or staff role in a church or other organization);
--     public_affiliation (a publicly listed affiliation held in an
--     organization's name). A finding of any other kind -- family, children,
--     health, finances, politics, a private religious membership, a home
--     address -- cannot be stored: the CHECK refuses it, whatever the code does.
--   * organization_named is the entity as the SOURCE states it (null only for a
--     bare title), role_text what the source says they hold there. A model
--     selected these; they are a CLAIM, not a fact. source_url / source_title /
--     source_passage are what the web search RETURNED (the capture contract);
--     the model never types them. `supported` is computed by CODE, by token
--     containment of the claim in the captured text (the attestation precedent);
--     a finding the captured text does not support is stored with
--     supported = false, never deleted.
--   * status is included or struck. Only a human moves it, and the decision
--     check ties who/when to it, in the manner of 0077's
--     network_path_suggestions_decision_check and 0083's identity decision check:
--     a struck finding carries who struck it and when and nothing about a
--     restore; an included finding carries no strike, and, if it was restored,
--     who restored it and when. A struck finding STAYS RECORDED (clause 5): there
--     is no DELETE policy, so nobody can make one disappear.
--   * NO column holds a contact detail (clause 1); the only URL is the captured
--     source_url.
--
-- WHAT THE DATABASE ENFORCES, beyond shape (each is exercised against a real
-- Postgres by scripts/test-network-research-migration.ts):
--   * Org match on EVERY cross-table reference (hard rule 6; 0077's reasoning: a
--     foreign-key check runs as the table owner and does not respect RLS).
--     Security-definer triggers, in 0066/0077/0083's exact pattern (set
--     search_path = public), fire on insert OR update of the referencing columns:
--       finding.network_connection_id -> the connection's organization
--       finding.ai_run_id             -> the run's organization
--       finding.struck_by / restored_by -> the human belongs to the same
--                                          organization, and when a database
--                                          session is acting that human IS the
--                                          session's user
--   * A finding can be born only for a person whose identity is CONFIRMED and who
--     is not marked do_not_research (ruling 0044 clause 2's gate and clause 10):
--     an unconfirmed, "none of these" or do-not-research person cannot be given a
--     finding by any path, whatever the application does.
--   * Nothing about a finding is editable except striking it and restoring it.
--     A BEFORE UPDATE trigger refuses a change to any other column (the only
--     other change allowed is the foreign key's own ai_run_id -> null when a
--     ledger row is deleted, which keeps the table erasable).
--   * Findings rest on the identity a human confirmed, so they cannot outlive
--     it. An AFTER UPDATE trigger on network_connections DELETES a person's
--     findings whenever they stop being confirmed (editing the identifying
--     facts of a confirmed person, which 0083's trigger already resets to
--     unconfirmed; a human reset; "none of these"; the chosen candidate being
--     deleted), whenever the confirmed candidate is changed, and whenever the
--     person is marked do_not_research. This is a trigger so that no path --
--     the application, an import, a maintenance script -- can keep stale
--     findings. Erasing the person erases their findings (ON DELETE CASCADE).
--   * A source_url must be http(s) and must not be on a social or professional
--     network or a people-data broker (ruling 0044 clause 4). The list here is
--     the same list as 0083's candidate constraint and as
--     lib/network-identity.ts (SOCIAL_NETWORK_HOSTS, PEOPLE_DATA_BROKER_HOSTS);
--     scripts/test-network-research-migration.ts fails if they drift.
--   * One finding is stored once per person: a unique index over person, kind,
--     organization, role (case-insensitive, a missing value read as empty so a
--     bare title cannot be duplicated either) and source, so a second research
--     run does not duplicate -- and cannot resurrect a struck finding.
--
-- Tenant isolation (hard rule 6, 0033_multi_tenant_rls.sql): organization_id
-- references organizations(id) default my_organization_id() with RLS scoped by
-- it. Select, insert and update policies exist for authenticated (update exists
-- so a human can strike; the trigger above limits what an update may touch);
-- there is deliberately NO delete policy.
--
-- Additive under ruling 0020: one new table, its constraints, indexes, policies,
-- functions and triggers, and one new trigger (with its own function) on the
-- existing network_connections table. No existing column, policy, function or
-- trigger is dropped or redefined. Migrations 0001-0083 are untouched.
--
-- DEPLOY ORDER, both ways:
--   * MIGRATION AHEAD OF THE CODE: nothing reads the table; the Network page,
--     capture, import, identity and path-finding behave exactly as before. Safe.
--   * CODE AHEAD OF THE MIGRATION: the research controls read the table first.
--     When it is not there they are hidden and the page says why, and the
--     research action refuses BEFORE any ledger run is born or any model is
--     called (so no AI run is spent for findings that could not be saved).
--     Nothing is sent to anyone in either order.
--
-- SQL-editor caveat: the Supabase SQL editor runs a pasted script as one
-- transaction, so this applies together or not at all. Re-running after
-- success fails on the existing table, index, policy and trigger names (no IF
-- NOT EXISTS) -- a refusal that rolls the whole script back, not damage.

create table network_person_findings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) default my_organization_id(),
  -- Erasing a person erases what was found about them.
  network_connection_id uuid not null references network_connections (id) on delete cascade,
  -- The ledger row of the research run that produced this finding. ai_runs rows
  -- are retained, never deleted; SET NULL only keeps this table erasable.
  ai_run_id uuid references ai_runs (id) on delete set null,
  kind text not null,
  -- The entity as the source states it. Null only for a bare title.
  organization_named text,
  -- What the source says they hold there (a title, a seat, a degree).
  role_text text,
  -- The three below are what the web search actually RETURNED. The model chose
  -- an index into the captured list; it never typed any of these.
  source_url text not null,
  source_title text,
  source_passage text,
  -- Computed by code: every distinctive word of organization_named and role_text
  -- appears in the captured title, passage or address. A failure is stored as
  -- false (and shown under "could not be checked"), never deleted.
  supported boolean not null,
  support_detail jsonb not null default '{}'::jsonb,
  status text not null default 'included',
  struck_by uuid references auth.users (id),
  struck_at timestamptz,
  restored_by uuid references auth.users (id),
  restored_at timestamptz,
  created_at timestamptz not null default now()
);

-- The closed list (ruling 0044 clause 3). Keep in step with FINDING_KINDS in
-- lib/network-research.ts; the migration test fails if they drift.
alter table network_person_findings
  add constraint network_person_findings_kind_check
  check (kind in ('employer', 'title', 'board_seat', 'school', 'org_leadership_role', 'public_affiliation'));

-- A finding names something. A bare title names only the role; every other kind
-- names an organization.
alter table network_person_findings
  add constraint network_person_findings_shape_check
  check (
    (kind = 'title' and role_text is not null)
    or (kind <> 'title' and organization_named is not null)
  );

alter table network_person_findings
  add constraint network_person_findings_text_check
  check (
    (organization_named is null or (length(btrim(organization_named)) > 0 and length(organization_named) <= 300))
    and (role_text is null or (length(btrim(role_text)) > 0 and length(role_text) <= 300))
    and (source_title is null or length(source_title) <= 600)
    and (source_passage is null or length(source_passage) <= 4000)
  );

alter table network_person_findings
  add constraint network_person_findings_support_detail_check
  check (jsonb_typeof(support_detail) = 'object');

alter table network_person_findings
  add constraint network_person_findings_status_check
  check (status in ('included', 'struck'));

-- The status and the who/when say one thing, never two (0077's and 0083's
-- decision-check pattern). Struck: who and when, and no restore. Included:
-- no strike; a restore, if there is one, carries both who and when.
alter table network_person_findings
  add constraint network_person_findings_decision_check
  check (
    (status = 'struck'
      and struck_by is not null and struck_at is not null
      and restored_by is null and restored_at is null)
    or (status = 'included'
      and struck_by is null and struck_at is null
      and ((restored_by is null and restored_at is null) or (restored_by is not null and restored_at is not null)))
  );

-- A source is an http(s) page, and never a social or professional network or a
-- people-data broker (ruling 0044 clause 4). The host is read the same way the
-- code reads it: scheme://[userinfo@]host[:port][/...]. KEEP THIS LIST IN STEP
-- WITH 0083 (network_identity_candidates_source_url_check) AND
-- lib/network-identity.ts (SOCIAL_NETWORK_HOSTS, PEOPLE_DATA_BROKER_HOSTS);
-- scripts/test-network-research-migration.ts fails if they drift.
alter table network_person_findings
  add constraint network_person_findings_source_url_check
  check (
    source_url ~* '^https?://[^/?#[:space:]]+'
    and lower(substring(source_url from '^[hH][tT][tT][pP][sS]?://(?:[^/?#@]*@)?([^/?#:]+)'))
      !~ '(^|\.)(linkedin\.com|lnkd\.in|facebook\.com|fb\.com|fb\.me|messenger\.com|instagram\.com|twitter\.com|x\.com|t\.co|threads\.net|tiktok\.com|snapchat\.com|pinterest\.com|reddit\.com|tumblr\.com|vk\.com|weibo\.com|xing\.com|whatsapp\.com|t\.me|bsky\.app|mastodon\.social|zoominfo\.com|rocketreach\.co|apollo\.io|lusha\.com|signalhire\.com|spokeo\.com|whitepages\.com|radaris\.com|beenverified\.com|truepeoplesearch\.com|fastpeoplesearch\.com|peoplefinders\.com|intelius\.com|pipl\.com)$'
  );

-- Once per person (a re-run does not duplicate, and cannot bring back a struck
-- finding): person, kind, organization, role and source. Case-insensitive, and a
-- missing organization or role reads as empty, so a bare title is unique too.
create unique index network_person_findings_unique_finding
  on network_person_findings (
    network_connection_id,
    kind,
    lower(coalesce(organization_named, '')),
    lower(coalesce(role_text, '')),
    source_url
  );

create index network_person_findings_organization_id_idx on network_person_findings (organization_id);
create index network_person_findings_connection_idx on network_person_findings (network_connection_id);
create index network_person_findings_ai_run_id_idx on network_person_findings (ai_run_id) where ai_run_id is not null;

comment on table network_person_findings is
  'Ruling 0044 clauses 3-5: what the public web says about a CONFIRMED recorded person, of a closed list of kinds, each with the page and passage the search returned. Labelled not yet reviewed by a person; a human may strike (and restore) a finding but never edit or delete one. Deleted only with its person, or when the identity it rests on stops being confirmed. Feeds nothing yet (paths use it from slice D).';
comment on column network_person_findings.kind is
  'employer | title | board_seat | school | org_leadership_role | public_affiliation. A CLOSED list (ruling 0044 clause 3); any other kind is refused here.';
comment on column network_person_findings.organization_named is
  'The entity as the SOURCE states it. A model selected it from the captured text: a claim, not a fact. Null only for a bare title.';
comment on column network_person_findings.supported is
  'Computed by CODE: every distinctive word of organization_named and role_text appears in the captured title, passage or address (token containment). false is stored, shown under "could not be checked against the source" and never used -- not deleted (the attestation precedent).';
comment on column network_person_findings.source_passage is
  'The text the web search returned for the source, scrubbed of contact details. The capture contract: the model never types it.';
comment on column network_person_findings.status is
  'included | struck. Only a human moves it (ruling 0044 clause 5). A struck finding stays recorded and is never used.';

-- Tenant isolation.
alter table network_person_findings enable row level security;

create policy "team members can read network person findings"
  on network_person_findings for select
  to authenticated
  using (organization_id = my_organization_id());

create policy "team members can record network person findings"
  on network_person_findings for insert
  to authenticated
  with check (organization_id = my_organization_id());

-- Striking and restoring. RLS cannot limit WHICH columns an update touches; the
-- guard trigger below does. There is deliberately NO delete policy.
create policy "team members can strike network person findings"
  on network_person_findings for update
  to authenticated
  using (organization_id = my_organization_id())
  with check (organization_id = my_organization_id());

-- Cross-table org integrity on EVERY reference, 0066/0077/0083's pattern, and
-- the gate: a finding is born only for a confirmed person who may be researched.
create function enforce_network_finding_connection() returns trigger as $$
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
      raise exception 'findings cannot be recorded for a person marked do not research';
    end if;
    if c.identity_status <> 'confirmed' then
      raise exception 'findings can be recorded only for a person whose identity is confirmed';
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger network_person_findings_connection_org_match
  before insert or update of organization_id, network_connection_id on network_person_findings
  for each row execute function enforce_network_finding_connection();

create function enforce_network_finding_run_org_match() returns trigger as $$
begin
  if new.ai_run_id is not null
     and new.organization_id is distinct from (select organization_id from ai_runs where id = new.ai_run_id) then
    raise exception 'organization_id must match the referenced ai run''s organization_id';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger network_person_findings_run_org_match
  before insert or update of organization_id, ai_run_id on network_person_findings
  for each row execute function enforce_network_finding_run_org_match();

-- A strike or a restore is recorded as the human who made it, in the same
-- organization; a session-less context (a maintenance script) is not pinned.
create function enforce_network_finding_human() returns trigger as $$
declare
  who uuid;
begin
  foreach who in array array[new.struck_by, new.restored_by] loop
    if who is not null then
      if new.organization_id is distinct from (select organization_id from profiles where id = who) then
        raise exception 'the person who struck or restored a finding must belong to the same organization';
      end if;
      if auth.uid() is not null and who <> auth.uid() then
        raise exception 'a strike or restore is recorded as the person who made it';
      end if;
    end if;
  end loop;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger network_person_findings_human
  before insert or update of organization_id, struck_by, restored_by on network_person_findings
  for each row execute function enforce_network_finding_human();

-- Nothing about a finding is editable except striking and restoring it. (The one
-- other change allowed is the foreign key's own ai_run_id -> null, which keeps
-- the table erasable if a ledger row is ever deleted.)
create function guard_network_finding_update() returns trigger as $$
begin
  if new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id
     or new.network_connection_id is distinct from old.network_connection_id
     or (new.ai_run_id is distinct from old.ai_run_id and new.ai_run_id is not null)
     or new.kind is distinct from old.kind
     or new.organization_named is distinct from old.organization_named
     or new.role_text is distinct from old.role_text
     or new.source_url is distinct from old.source_url
     or new.source_title is distinct from old.source_title
     or new.source_passage is distinct from old.source_passage
     or new.supported is distinct from old.supported
     or new.support_detail is distinct from old.support_detail
     or new.created_at is distinct from old.created_at then
    raise exception 'a finding cannot be edited; it can only be struck or restored';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger network_person_findings_guard
  before update on network_person_findings
  for each row execute function guard_network_finding_update();

-- Findings rest on the identity a human confirmed. When a person stops being
-- confirmed, or is confirmed as someone else, or is marked do-not-research,
-- everything found about them is deleted. AFTER, so it sees the row as 0083's
-- BEFORE trigger left it (an edit to a confirmed person's facts has already been
-- turned into "unconfirmed" by then). Deliberately NOT guarded by
-- pg_trigger_depth(): when deleting the chosen candidate voids a decision (0083),
-- the findings must go with it.
create function clear_network_findings_after_identity_change() returns trigger as $$
begin
  if (old.identity_status = 'confirmed'
      and (new.identity_status <> 'confirmed' or new.identity_candidate_id is distinct from old.identity_candidate_id))
     or (new.do_not_research and not old.do_not_research) then
    delete from network_person_findings where network_connection_id = new.id;
  end if;
  return null;
end;
$$ language plpgsql security definer set search_path = public;

create trigger network_connections_clear_findings
  after update on network_connections
  for each row execute function clear_network_findings_after_identity_change();
