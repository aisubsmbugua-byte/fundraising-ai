-- STATE item 76, authorized by ruling 0033: network capture v1. An
-- organization's people record, by hand, the people they know; the platform
-- may then PROPOSE which of them could open a door to a prospect, each
-- proposal grounded in two captured facts -- a person a human recorded and a
-- funder-side research claim a human approved.
--
-- Two tables.
--
-- (i) network_connections: the recorder's claim about a person they know.
--     Holds a name, an affiliation, how the recorder knows them, a strength
--     chosen from a closed list, and free-text notes. NOTHING ELSE about the
--     person: there is NO email, phone, address or social-handle column of
--     any kind, and none may be added without a new ruling. The system never
--     contacts these people (ruling 0033 clause 5), so it has no need of a way
--     to, and a column that cannot exist cannot leak, be imported into, or be
--     emailed from. Free-text `notes` is the one place a person could type a
--     contact detail; the capture form's disclosure sentence says notes are
--     shared with the AI provider and asks users not to record sensitive
--     details (clause 3) -- the schema cannot police free text and does not
--     pretend to.
--       * strength is a closed list (close / warm / acquaintance), NOT NULL
--         WITH NO DEFAULT, in the manner of 0066's disposition: an insert
--         that omits it fails loudly instead of quietly taking a strength
--         nobody chose.
--       * Unlike outcomes and send attempts (retained: records of acts toward
--         a funder), a connection is an organization's private note about a
--         third party. It is therefore editable AND deletable by team members
--         -- all four RLS policies exist by design (clause 2).
--
-- (ii) network_path_suggestions: one row per proposed path, the AI's proposal
--     and nothing more.
--       * network_connection_id references network_connections ON DELETE
--         CASCADE: deleting a person deletes every path derived from them
--         (clause 2). funder_claim_id references research_claims (0035) ON
--         DELETE CASCADE: a suggestion must not outlive the anchor it cites
--         (research_claims itself cascades from research_runs and prospects).
--         prospect_id cascades from prospects.
--       * status is suggested / accepted / dismissed, NOT NULL DEFAULT
--         'suggested': the AI-produced state is the review state. A check
--         constraint ties the decision columns to the status, so a row cannot
--         be accepted or dismissed without a decider and a time, nor carry a
--         decider while still 'suggested'. The insert policy admits only
--         status = 'suggested', so a path cannot be BORN decided; only an
--         update by a human moves it (ruling 0033 clause 5). Accepting
--         changes nothing else -- no message, no draft, no stage.
--       * model_confidence is low / medium / high (nullable: the model did
--         not always say). It is the MODEL'S claim, labelled so in the UI.
--       * unique (prospect_id, network_connection_id, funder_claim_id): the
--         same path is stored once, so a re-run cannot resurrect a dismissed
--         suggestion as a new one.
--       * No delete policy: a dismissed path is kept, which is what stops it
--         being proposed again. Cascades from the parents still remove it.
--
-- Tenant isolation (hard rule 6, 0033_multi_tenant_rls.sql): both tables
-- carry organization_id references organizations(id) default
-- my_organization_id() with RLS scoped by it. And because a foreign key check
-- runs as the table owner and does NOT respect RLS (docs/decisions/
-- 0001-multi-tenancy.md's known hole class), EVERY cross-table reference on
-- the suggestions table -- prospect, connection, claim -- gets a security
-- definer org-match trigger in 0066's exact pattern (set search_path =
-- public). One deliberate difference: 0066's triggers fire on insert only;
-- these fire on insert OR on update of the referencing columns, because a
-- suggestion is updatable (a human decides it) and an insert-only trigger
-- would let an update repoint the row at another organization's connection.
-- The claim trigger additionally requires the claim to belong to the same
-- prospect as the suggestion.
--
-- Additive under ruling 0020: two new tables, their indexes, policies and
-- triggers. No existing table, column, policy or function is touched -- there
-- is no `alter table` of an existing table and no `add column` in this file --
-- so nothing already deployed can break on it. Migrations 0001-0076 are
-- untouched.
--
-- DEPLOY ORDER, both ways:
--   * MIGRATION AHEAD OF THE CODE: nothing reads or writes these tables yet,
--     so nothing changes. Safe.
--   * CODE AHEAD OF THE MIGRATION: the Network page, the prospect page panel
--     and findNetworkPaths select from tables that do not exist. Every read
--     is tolerant (an error reads as "no network recorded yet") and every
--     write returns the error to the user as a plain message; no model call is
--     made because path-finding refuses before it when the connection list
--     cannot be read. Nothing is sent to anyone in either order.
--
-- SQL-editor caveat: the Supabase SQL editor runs a pasted script as one
-- transaction, so this applies together or not at all. Re-running after
-- success fails on the existing table, policy and trigger names (no IF NOT
-- EXISTS) -- a refusal that rolls the whole script back, not damage.

-- (i)
create table network_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) default my_organization_id(),
  recorded_by uuid not null references auth.users (id),
  person_name text not null,
  affiliation text,
  how_known text,
  -- No default, deliberately (see header).
  strength text not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table network_connections
  add constraint network_connections_strength_check
  check (strength in ('close', 'warm', 'acquaintance'));

alter table network_connections
  add constraint network_connections_person_name_check
  check (length(btrim(person_name)) > 0);

create index network_connections_organization_id_idx on network_connections (organization_id);

comment on table network_connections is
  'Ruling 0033: a person an organization''s team knows, recorded by hand. The recorder''s claim, editable and deletable by the organization; deleting a row deletes every path suggestion derived from it. NO email, phone or handle column exists or may be added -- the system never contacts these people.';

comment on column network_connections.strength is
  'close | warm | acquaintance, chosen by the recorder. Not null with no default: an insert that omits it errors rather than guessing.';

-- (ii)
create table network_path_suggestions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) default my_organization_id(),
  prospect_id uuid not null references prospects (id) on delete cascade,
  network_connection_id uuid not null references network_connections (id) on delete cascade,
  funder_claim_id uuid not null references research_claims (id) on delete cascade,
  reasoning text not null,
  model_confidence text,
  status text not null default 'suggested',
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

alter table network_path_suggestions
  add constraint network_path_suggestions_confidence_check
  check (model_confidence is null or model_confidence in ('low', 'medium', 'high'));

alter table network_path_suggestions
  add constraint network_path_suggestions_status_check
  check (status in ('suggested', 'accepted', 'dismissed'));

-- The decision columns and the status say one thing, never two.
alter table network_path_suggestions
  add constraint network_path_suggestions_decision_check
  check (
    (status = 'suggested' and decided_by is null and decided_at is null)
    or (status <> 'suggested' and decided_by is not null and decided_at is not null)
  );

alter table network_path_suggestions
  add constraint network_path_suggestions_unique_path
  unique (prospect_id, network_connection_id, funder_claim_id);

create index network_path_suggestions_prospect_id_idx on network_path_suggestions (prospect_id);
create index network_path_suggestions_connection_id_idx on network_path_suggestions (network_connection_id);
create index network_path_suggestions_claim_id_idx on network_path_suggestions (funder_claim_id);
create index network_path_suggestions_organization_id_idx on network_path_suggestions (organization_id);

comment on table network_path_suggestions is
  'Ruling 0033: the AI''s PROPOSAL that a recorded connection could open a door to a prospect, anchored to an approved research claim. Lands as ''suggested''; only a human moves it to accepted or dismissed, and that changes nothing else. Deleted with its connection, its claim or its prospect.';

comment on column network_path_suggestions.model_confidence is
  'The MODEL''s stated confidence, low | medium | high -- its claim, never a fact, and labelled so in the UI.';

-- Tenant isolation.
alter table network_connections enable row level security;
alter table network_path_suggestions enable row level security;

-- Connections: all four operations, org-scoped. Team members manage them.
create policy "team members can read network connections"
  on network_connections for select
  to authenticated
  using (organization_id = my_organization_id());

create policy "team members can record network connections"
  on network_connections for insert
  to authenticated
  with check (recorded_by = auth.uid() and organization_id = my_organization_id());

create policy "team members can edit network connections"
  on network_connections for update
  to authenticated
  using (organization_id = my_organization_id())
  with check (organization_id = my_organization_id());

create policy "team members can delete network connections"
  on network_connections for delete
  to authenticated
  using (organization_id = my_organization_id());

-- Suggestions: select, insert (born 'suggested' only) and update (a human's
-- decision). No delete policy -- see header.
create policy "team members can read network path suggestions"
  on network_path_suggestions for select
  to authenticated
  using (organization_id = my_organization_id());

create policy "team members can propose network path suggestions"
  on network_path_suggestions for insert
  to authenticated
  with check (organization_id = my_organization_id() and status = 'suggested');

create policy "team members can decide network path suggestions"
  on network_path_suggestions for update
  to authenticated
  using (organization_id = my_organization_id())
  with check (organization_id = my_organization_id());

-- Cross-table org integrity on EVERY reference, 0066's pattern.
create function enforce_network_suggestion_prospect_org_match() returns trigger as $$
begin
  if new.organization_id is distinct from (select organization_id from prospects where id = new.prospect_id) then
    raise exception 'organization_id must match the referenced prospect''s organization_id';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger network_path_suggestions_prospect_org_match
  before insert or update of organization_id, prospect_id on network_path_suggestions
  for each row execute function enforce_network_suggestion_prospect_org_match();

create function enforce_network_suggestion_connection_org_match() returns trigger as $$
begin
  if new.organization_id is distinct from (select organization_id from network_connections where id = new.network_connection_id) then
    raise exception 'organization_id must match the referenced network connection''s organization_id';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger network_path_suggestions_connection_org_match
  before insert or update of organization_id, network_connection_id on network_path_suggestions
  for each row execute function enforce_network_suggestion_connection_org_match();

create function enforce_network_suggestion_claim_org_match() returns trigger as $$
declare
  c record;
begin
  select organization_id, prospect_id into c from research_claims where id = new.funder_claim_id;
  if new.organization_id is distinct from c.organization_id then
    raise exception 'organization_id must match the referenced research claim''s organization_id';
  end if;
  if new.prospect_id is distinct from c.prospect_id then
    raise exception 'the anchoring research claim must belong to the same prospect as the suggestion';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger network_path_suggestions_claim_org_match
  before insert or update of organization_id, prospect_id, funder_claim_id on network_path_suggestions
  for each row execute function enforce_network_suggestion_claim_org_match();
