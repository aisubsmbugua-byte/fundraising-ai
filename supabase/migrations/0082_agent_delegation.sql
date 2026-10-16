-- Ruling 0039: an external agent is a scoped, revocable delegate of one user,
-- and never decides a gate on its own call. STATE item 98.
--
-- Three tables and one function.
--
-- (i) agent_tokens: the personal access token a user creates inside the
--     platform for their own desktop agent. Only a SHA-256 hash of the token
--     is stored -- never the token -- so a leak of this table does not leak
--     the credential (clause 1). A token stands for one user in one
--     organization and carries a scope (read, or act), an expiry, a name and
--     a last-used stamp. It can be revoked, once, by its owner; it can never
--     be un-revoked, re-scoped or extended, and it can never be deleted.
--
-- (ii) agent_call_log: the append-only record of every call an agent makes
--     (clause 4). A write is two rows tied by call_id: `started`, born BEFORE
--     the effect and carrying the exact arguments and what the write is about
--     to replace; then one terminal row (executed | failed). A call refused
--     before its effect is one `refused` row, and a read is one terminal row.
--     The log does NOT claim the user said anything: `agent_statement` is
--     whatever instruction text the agent says it relied on, stored as the
--     agent's own UNVERIFIED statement. It also holds the two things the
--     user does by clicking, as `user_click` rows: deciding an approval link,
--     and restoring replaced draft text.
--
-- (iii) agent_approval_requests: the single-use, short-lived link behind
--     which a decision gate (approving a strategy or a draft) is decided
--     (clause 3). It pins the exact content fingerprint. No agent call
--     approves anything; the signed-in owner opens the link, sees the full
--     content and clicks, and that click consumes the request.
--
-- and verify_agent_token(p_hash): the one function callable WITHOUT a
-- session. It takes the hash of a presented token and returns the owner, the
-- organization, the scope and the expiry ONLY when the hash matches a live
-- (not revoked, not expired) token, stamping last_used_at. On a miss it
-- returns no row -- it does not say whether the hash was unknown, revoked or
-- expired. It takes a 256-bit-derived hash, so there is nothing to
-- enumerate: it can be asked about any hash and answers only for one that
-- could not have been guessed. It writes nothing but last_used_at, and only
-- for a live token.
--
-- Enforcement is in the database as well as in code (a policy is not the only
-- wall, per 0080 and 0081):
--   * RLS: every policy is scoped by organization AND user. There is NO
--     delete policy on any table; agent_call_log has no update policy.
--   * Column-level grants: the only column a signed-in user can UPDATE on a
--     token is revoked_at, and on an approval request used_at.
--   * BEFORE UPDATE triggers pin every other column and make revoke and use
--     happen once; a BEFORE UPDATE trigger on agent_call_log rejects every
--     update for every role.
--   * agent_call_log's insert trigger (security definer, fixed search_path,
--     the shape 0066 / 0078 / 0080 / 0081 use) checks what a foreign key
--     cannot: the token belongs to the same organization and user, an agent
--     WRITE can only be started by a live token whose scope is `act`, a
--     terminal row follows its started row, and no agent-origin row can ever
--     name an approval.
--   * Partial unique indexes: one started row and one terminal row per call.
--
-- Cross-table integrity: a foreign key check runs as the table owner and
-- does not respect RLS (docs/decisions/0001-multi-tenancy.md's known hole),
-- so these tables are new and the hole is closed at birth, in triggers.
--
-- Additive under ruling 0020: three new tables, their indexes, policies,
-- functions, triggers and grants. No existing table, column, function or
-- policy is touched, so it is safe to apply ahead of its code. Code deployed
-- ahead of this migration answers the connector's requests with "setup
-- pending -- apply migration 0082" and writes nothing.

-- ---------------------------------------------------------------------------
-- agent_tokens
-- ---------------------------------------------------------------------------

create table agent_tokens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) default my_organization_id(),
  user_id uuid not null default auth.uid() references auth.users (id),
  -- What the owner calls it ("Muse on my laptop").
  name text not null,
  -- sha256 hex of the token. The token itself is shown once and never stored.
  token_hash text not null,
  -- The first characters of the token, for display only.
  token_prefix text not null,
  scope text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table agent_tokens
  add constraint agent_tokens_scope_check check (scope in ('read', 'act'));

alter table agent_tokens
  add constraint agent_tokens_hash_check check (token_hash ~ '^[0-9a-f]{64}$');

alter table agent_tokens
  add constraint agent_tokens_name_check check (char_length(btrim(name)) between 1 and 80);

alter table agent_tokens
  add constraint agent_tokens_prefix_check check (char_length(token_prefix) between 4 and 12);

create unique index agent_tokens_hash_idx on agent_tokens (token_hash);
create index agent_tokens_owner_idx on agent_tokens (organization_id, user_id, created_at desc);

comment on table agent_tokens is
  'Ruling 0039 clause 1: a delegate token for one user. Only the SHA-256 hash is stored. Scope read or act, expires, revocable once by its owner, never deleted.';

-- A token is born live: never revoked, never used, and it expires within a
-- year. (The settings page offers shorter choices; this is the wall.)
create function agent_tokens_guard_insert() returns trigger as $$
begin
  if new.revoked_at is not null or new.last_used_at is not null then
    raise exception 'a new agent token is born live and unused';
  end if;
  if new.expires_at <= now() then
    raise exception 'an agent token must expire in the future';
  end if;
  if new.expires_at > now() + interval '366 days' then
    raise exception 'an agent token cannot last longer than a year';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger agent_tokens_guard_insert
  before insert on agent_tokens
  for each row execute function agent_tokens_guard_insert();

-- After birth the only change is revocation, once. last_used_at is stamped by
-- verify_agent_token (running as its owner), never by a signed-in role.
create function agent_tokens_guard_update() returns trigger as $$
begin
  if new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id
     or new.user_id is distinct from old.user_id
     or new.name is distinct from old.name
     or new.token_hash is distinct from old.token_hash
     or new.token_prefix is distinct from old.token_prefix
     or new.scope is distinct from old.scope
     or new.expires_at is distinct from old.expires_at
     or new.created_at is distinct from old.created_at then
    raise exception 'an agent token cannot be changed after it is created -- it can only be revoked';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'a revoked agent token stays revoked';
  end if;
  if new.last_used_at is distinct from old.last_used_at and current_user in ('authenticated', 'anon') then
    raise exception 'last_used_at is stamped by the platform, not by a user';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger agent_tokens_guard_update
  before update on agent_tokens
  for each row execute function agent_tokens_guard_update();

alter table agent_tokens enable row level security;

create policy "users can create their own agent tokens"
  on agent_tokens for insert
  to authenticated
  with check (
    organization_id = my_organization_id()
    and user_id = auth.uid()
    and revoked_at is null
    and last_used_at is null
  );

create policy "users can read their own agent tokens"
  on agent_tokens for select
  to authenticated
  using (organization_id = my_organization_id() and user_id = auth.uid());

create policy "users can revoke their own agent tokens"
  on agent_tokens for update
  to authenticated
  using (organization_id = my_organization_id() and user_id = auth.uid())
  with check (organization_id = my_organization_id() and user_id = auth.uid());

-- Column level: a signed-in user can change revoked_at and nothing else.
revoke all on agent_tokens from anon;
revoke update on agent_tokens from authenticated;
grant update (revoked_at) on agent_tokens to authenticated;

-- ---------------------------------------------------------------------------
-- verify_agent_token: the one function callable without a session
-- ---------------------------------------------------------------------------

create function verify_agent_token(p_hash text)
returns table (token_id uuid, user_id uuid, organization_id uuid, scope text, expires_at timestamptz)
language sql
volatile
security definer
set search_path = public
as $$
  update agent_tokens t
     set last_used_at = now()
   where t.token_hash = p_hash
     and t.revoked_at is null
     and t.expires_at > now()
  returning t.id, t.user_id, t.organization_id, t.scope, t.expires_at;
$$;

revoke all on function verify_agent_token(text) from public;
grant execute on function verify_agent_token(text) to anon, authenticated;

comment on function verify_agent_token(text) is
  'Ruling 0039 clause 1: returns the owner, organization, scope and expiry of a token ONLY when the presented hash matches a live (not revoked, not expired) token, and stamps last_used_at. Returns no row on a miss and does not say why. Callable without a session; writes nothing else.';

-- ---------------------------------------------------------------------------
-- agent_call_log
-- ---------------------------------------------------------------------------

create table agent_call_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) default my_organization_id(),
  user_id uuid not null default auth.uid() references auth.users (id),
  -- Generated by code; ties a started row to its terminal row.
  call_id uuid not null,
  token_id uuid not null references agent_tokens (id),
  -- started | executed | failed | refused
  event text not null,
  -- agent: a call made on a token's delegation. user_click: a decision the
  -- signed-in user made by clicking (deciding an approval link, restoring
  -- replaced text) -- never a call.
  origin text not null default 'agent',
  -- read: one terminal row. write: a started row, then one terminal row.
  access text not null,
  tool text not null,
  -- The exact validated arguments. Never the token.
  arguments jsonb not null,
  -- Any instruction text the agent says it relied on. THE AGENT'S OWN
  -- STATEMENT, UNVERIFIED: the platform cannot see what the user said to an
  -- external agent, and this column never claims otherwise (ruling 0039
  -- clause 4).
  agent_statement text,
  subject_table text,
  subject_id uuid,
  -- Born with the started row: what the write is about to replace.
  previous jsonb,
  -- Written with the terminal row: what the entry point reported.
  result jsonb,
  error_note text,
  -- Written with the terminal row: how long the call took.
  duration_ms integer,
  -- A restore points at the call it undoes.
  restores_call_id uuid,
  created_at timestamptz not null default now()
);

alter table agent_call_log
  add constraint agent_call_log_duration_check check (duration_ms is null or duration_ms >= 0);

alter table agent_call_log
  add constraint agent_call_log_event_check check (event in ('started', 'executed', 'failed', 'refused'));

alter table agent_call_log
  add constraint agent_call_log_origin_check check (origin in ('agent', 'user_click'));

alter table agent_call_log
  add constraint agent_call_log_access_check check (access in ('read', 'write'));

-- The closed list of recorded tools, enforced here as well as in code.
alter table agent_call_log
  add constraint agent_call_log_tool_check
  check (
    tool in (
      'fundraising_report',
      'whoami',
      'get_dashboard_summary',
      'list_followups_due',
      'list_supporters_needing_stewardship',
      'search_prospects',
      'get_prospect',
      'list_recent_activity',
      'get_strategy_for_review',
      'get_drafts',
      'add_prospect',
      'log_prospect_interaction',
      'log_supporter_interaction',
      'set_prospect_next_action',
      'set_prospect_ask_amount',
      'edit_draft',
      'push_back_on_strategy',
      'unapprove_draft',
      'request_approval',
      'approve_strategy',
      'approve_draft',
      'restore_draft_text'
    )
  );

-- An agent call can never be recorded as an approval, and an approval or a
-- restore is only ever a click. (The agent's only approval-shaped tool is
-- request_approval, which executes nothing.)
alter table agent_call_log
  add constraint agent_call_log_origin_shape_check
  check (
    (
      origin = 'agent'
      and tool not in ('approve_strategy', 'approve_draft', 'restore_draft_text')
      and restores_call_id is null
    )
    or (
      origin = 'user_click'
      and tool in ('approve_strategy', 'approve_draft', 'restore_draft_text')
      and access = 'write'
      and agent_statement is null
      and ((tool = 'restore_draft_text') = (restores_call_id is not null))
    )
  );

-- A read is one terminal row; it is never "started".
alter table agent_call_log
  add constraint agent_call_log_access_shape_check
  check (access = 'write' or event in ('executed', 'failed', 'refused'));

alter table agent_call_log
  add constraint agent_call_log_subject_check
  check (
    (subject_table is null and subject_id is null)
    or (subject_table in ('prospects', 'supporters', 'drafts', 'strategy_runs') and subject_id is not null)
  );

alter table agent_call_log
  add constraint agent_call_log_json_check
  check (
    jsonb_typeof(arguments) = 'object'
    and (previous is null or jsonb_typeof(previous) = 'object')
    and (result is null or jsonb_typeof(result) = 'object')
  );

alter table agent_call_log
  add constraint agent_call_log_statement_check
  check (agent_statement is null or char_length(agent_statement) <= 1000);

-- Shape by event. `previous` lives on the started row only, and a started row
-- carries no outcome; a failure or a refusal always says why.
alter table agent_call_log
  add constraint agent_call_log_event_shape_check
  check (
    (event = 'started' and result is null and error_note is null)
    or (event = 'executed' and error_note is null and previous is null)
    or (event in ('failed', 'refused') and error_note is not null and previous is null)
  );

create unique index agent_call_log_one_started_idx
  on agent_call_log (call_id) where event = 'started';
create unique index agent_call_log_one_terminal_idx
  on agent_call_log (call_id) where event <> 'started';
-- The window counts (rate limit and write cap) read by token and time.
create index agent_call_log_token_time_idx on agent_call_log (token_id, created_at desc);
create index agent_call_log_owner_idx on agent_call_log (organization_id, user_id, created_at desc);
create index agent_call_log_restores_idx on agent_call_log (restores_call_id) where restores_call_id is not null;

comment on table agent_call_log is
  'Ruling 0039 clause 4: the append-only record of every agent call. A write is a started row (born before the effect, holding the arguments and what will be replaced) and one terminal row; a refusal is one row; a read is one terminal row. agent_statement is the agent''s own UNVERIFIED statement -- the platform never claims the user said anything. Insert and select only; no update or delete policy; updates rejected for every role.';

comment on column agent_call_log.agent_statement is
  'Any instruction text the agent says it relied on. The agent''s OWN statement, UNVERIFIED: the platform cannot see what the user said to an external agent.';

-- Append-only for every role, the service role included.
create function agent_call_log_reject_update() returns trigger as $$
begin
  raise exception 'agent_call_log: the agent call record is append-only -- rows are never updated';
end;
$$ language plpgsql;

create trigger agent_call_log_append_only
  before update on agent_call_log
  for each row execute function agent_call_log_reject_update();

-- Cross-table integrity (see the header).
create function enforce_agent_call_log() returns trigger as $$
declare
  k_org uuid;
  k_user uuid;
  k_scope text;
  k_revoked timestamptz;
  k_expires timestamptz;
  s_org uuid;
  s_user uuid;
  s_token uuid;
  s_tool text;
  s_origin text;
  s_access text;
  has_terminal boolean;
begin
  select organization_id, user_id, scope, revoked_at, expires_at
    into k_org, k_user, k_scope, k_revoked, k_expires
    from agent_tokens where id = new.token_id;
  if not found then
    raise exception 'the token this call names does not exist';
  end if;
  if new.organization_id is distinct from k_org then
    raise exception 'organization_id must match the token''s organization_id';
  end if;
  if new.user_id is distinct from k_user then
    raise exception 'a call record must be written by the user the token belongs to';
  end if;

  if new.event = 'started' then
    -- An agent WRITE is begun only by a live token whose scope is act. A
    -- read token, a revoked token and an expired token cannot start one.
    if new.origin = 'agent' then
      if k_scope is distinct from 'act' then
        raise exception 'a read-scope token cannot start a write';
      end if;
      if k_revoked is not null or k_expires <= now() then
        raise exception 'a revoked or expired token cannot start a write';
      end if;
    end if;
    select exists (
      select 1 from agent_call_log where call_id = new.call_id and event <> 'started'
    ) into has_terminal;
    if has_terminal then
      raise exception 'a call that already has an outcome cannot be started again';
    end if;
    return new;
  end if;

  -- A terminal row of a write follows the started row of the SAME call; a
  -- refusal and a read stand alone.
  select organization_id, user_id, token_id, tool, origin, access
    into s_org, s_user, s_token, s_tool, s_origin, s_access
    from agent_call_log where call_id = new.call_id and event = 'started';
  if found then
    if new.organization_id is distinct from s_org
       or new.user_id is distinct from s_user
       or new.token_id is distinct from s_token
       or new.tool is distinct from s_tool
       or new.origin is distinct from s_origin
       or new.access is distinct from s_access then
      raise exception 'a terminal row must match the started row of the same call';
    end if;
  elsif new.access = 'write' and new.event in ('executed', 'failed') then
    raise exception 'an executed or failed write must follow a started row of the same call';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger agent_call_log_refs_match
  before insert on agent_call_log
  for each row execute function enforce_agent_call_log();

alter table agent_call_log enable row level security;

create policy "users can record calls made on their own agent tokens"
  on agent_call_log for insert
  to authenticated
  with check (organization_id = my_organization_id() and user_id = auth.uid());

create policy "users can read the record of their own agent calls"
  on agent_call_log for select
  to authenticated
  using (organization_id = my_organization_id() and user_id = auth.uid());

revoke all on agent_call_log from anon;
revoke update on agent_call_log from authenticated;

-- ---------------------------------------------------------------------------
-- agent_approval_requests
-- ---------------------------------------------------------------------------

create table agent_approval_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) default my_organization_id(),
  user_id uuid not null default auth.uid() references auth.users (id),
  -- The token whose agent asked for the link.
  token_id uuid not null references agent_tokens (id),
  -- strategy: subject_id is a strategy_runs id. draft: a drafts id.
  kind text not null,
  subject_id uuid not null,
  -- Soft reference: the prospect the subject belongs to.
  prospect_id uuid not null,
  -- The content fingerprint the link is bound to. If the content differs when
  -- the link is opened, nothing is approved.
  fingerprint text not null,
  -- Built by code, never the agent's words.
  summary text not null,
  expires_at timestamptz not null,
  -- Set once, by the signed-in owner's click.
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table agent_approval_requests
  add constraint agent_approval_requests_kind_check check (kind in ('strategy', 'draft'));

alter table agent_approval_requests
  add constraint agent_approval_requests_fingerprint_check check (fingerprint ~ '^[0-9a-f]{64}$');

alter table agent_approval_requests
  add constraint agent_approval_requests_summary_check check (char_length(summary) between 1 and 600);

create index agent_approval_requests_owner_idx on agent_approval_requests (organization_id, user_id, created_at desc);
create index agent_approval_requests_token_idx on agent_approval_requests (token_id);

comment on table agent_approval_requests is
  'Ruling 0039 clause 3: a single-use, short-lived approval link bound to a content fingerprint. An agent can create one; only the signed-in owner''s click consumes it. Never deleted.';

-- Born unused, short-lived (an hour at the very most; the application uses
-- far less), from a live act token of the same organization and user.
create function enforce_agent_approval_insert() returns trigger as $$
declare
  k_org uuid;
  k_user uuid;
  k_scope text;
  k_revoked timestamptz;
  k_expires timestamptz;
begin
  if new.used_at is not null then
    raise exception 'an approval request is born unused';
  end if;
  if new.expires_at <= now() or new.expires_at > now() + interval '1 hour' then
    raise exception 'an approval request must expire within the hour';
  end if;
  select organization_id, user_id, scope, revoked_at, expires_at
    into k_org, k_user, k_scope, k_revoked, k_expires
    from agent_tokens where id = new.token_id;
  if not found then
    raise exception 'the token this request names does not exist';
  end if;
  if new.organization_id is distinct from k_org then
    raise exception 'organization_id must match the token''s organization_id';
  end if;
  if new.user_id is distinct from k_user then
    raise exception 'an approval request is made for the user the token belongs to';
  end if;
  if k_scope is distinct from 'act' or k_revoked is not null or k_expires <= now() then
    raise exception 'only a live act-scope token can ask for an approval link';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger agent_approval_requests_refs_match
  before insert on agent_approval_requests
  for each row execute function enforce_agent_approval_insert();

-- After birth the only change is used_at, null to non-null, once, and only
-- before expiry.
create function enforce_agent_approval_update() returns trigger as $$
begin
  if new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id
     or new.user_id is distinct from old.user_id
     or new.token_id is distinct from old.token_id
     or new.kind is distinct from old.kind
     or new.subject_id is distinct from old.subject_id
     or new.prospect_id is distinct from old.prospect_id
     or new.fingerprint is distinct from old.fingerprint
     or new.summary is distinct from old.summary
     or new.expires_at is distinct from old.expires_at
     or new.created_at is distinct from old.created_at then
    raise exception 'an approval request cannot be changed -- it can only be used, once';
  end if;
  if old.used_at is not null then
    raise exception 'that approval request was already used';
  end if;
  if new.used_at is null then
    raise exception 'an approval request can only move from unused to used';
  end if;
  if now() > old.expires_at then
    raise exception 'that approval request has expired';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger agent_approval_requests_guard_update
  before update on agent_approval_requests
  for each row execute function enforce_agent_approval_update();

alter table agent_approval_requests enable row level security;

create policy "users can create approval requests for themselves"
  on agent_approval_requests for insert
  to authenticated
  with check (organization_id = my_organization_id() and user_id = auth.uid() and used_at is null);

create policy "users can read their own approval requests"
  on agent_approval_requests for select
  to authenticated
  using (organization_id = my_organization_id() and user_id = auth.uid());

create policy "users can use their own approval requests"
  on agent_approval_requests for update
  to authenticated
  using (organization_id = my_organization_id() and user_id = auth.uid() and used_at is null)
  with check (organization_id = my_organization_id() and user_id = auth.uid());

revoke all on agent_approval_requests from anon;
revoke update on agent_approval_requests from authenticated;
grant update (used_at) on agent_approval_requests to authenticated;
