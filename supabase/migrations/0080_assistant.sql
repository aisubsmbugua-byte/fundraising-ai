-- Ruling 0037: an assistant acts as the signed-in user, reads and prepares
-- freely, and acts only on a human's approval of exactly what it will do.
-- STATE item 87.
--
-- Three tables.
--
-- (i) assistant_threads: one conversation. Personal to the user it acts as --
--     a teammate cannot read it (ruling 0037 clause 1: the assistant is the
--     signed-in user, not a shared process, so its history is that user's).
--
-- (ii) assistant_messages: what was said, in order. The assistant's own
--     message row is BORN `running` before the model is called, naming the
--     provider and the model it was addressed to (ruling 0037 clause 4, with
--     ruling 0026): a turn that is killed is a row with no terminal status,
--     never an absence. It is finalized exactly once, to completed or failed.
--     A user message is born terminal and is never updated.
--
-- (iii) assistant_proposals: the ONLY thing an act-on-approval ability can
--     write (ruling 0037 clause 2). A stored record of exactly what will be
--     done, in full, which the model cannot execute. The payload, the action,
--     the subject, the code-built summary and the expiry are fixed at birth by
--     a trigger. The only moves after birth are: claim the approval (once),
--     then execute-or-fail it; or dismiss it; or expire it. Each is written
--     once. A decided proposal is immutable for every role.
--
-- No delete policy on any of the three. Retained like outcomes (ruling 0026
-- clause 4): a conversation and the changes proposed in it are history.
--
-- Cross-table org integrity. A foreign key check runs as the table owner and
-- does NOT respect RLS (docs/decisions/0001-multi-tenancy.md's known hole), so
-- the policies below stop one org READING another's row and do not stop one
-- org POINTING AT it. These tables are new, so the hole is closed at birth
-- with security definer triggers, the shape 0066 and 0078 use. They also check
-- created_by, because a thread is personal: a message may not be filed into a
-- teammate's thread.
--
-- The proposal's subject (a prospect or a supporter) is a soft reference, the
-- way ai_runs.source_id is: the subject table differs per action, a single
-- foreign key cannot express that, and a deleted subject must simply make the
-- approval refuse as "not found", not cascade away the record of what was
-- proposed. The approve path re-reads the subject through the session client,
-- so RLS decides whether it is visible.
--
-- Additive under ruling 0020: three new tables, their indexes, policies,
-- functions and triggers. No existing table, column, function or policy is
-- touched, so it is safe to apply ahead of its code. Code deployed ahead of
-- this migration reports "setup pending" on the Assistant page and from the
-- turn route and writes nothing.

create table assistant_threads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) default my_organization_id(),
  created_by uuid not null default auth.uid() references auth.users (id),
  -- Built by code from the first user message; never model-written.
  title text,
  created_at timestamptz not null default now()
);

create index assistant_threads_owner_idx on assistant_threads (organization_id, created_by, created_at desc);

comment on table assistant_threads is
  'Ruling 0037: one assistant conversation, personal to the user it acts as. No update or delete policy.';

create table assistant_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) default my_organization_id(),
  thread_id uuid not null references assistant_threads (id) on delete cascade,
  created_by uuid not null default auth.uid() references auth.users (id),
  role text not null,
  -- running | completed | failed. A user message is born completed; an
  -- assistant message is born running, BEFORE the model call, and moves to
  -- completed or failed exactly once.
  status text not null,
  content text not null default '',
  -- Which provider and which model this turn was ADDRESSED to, written at
  -- birth (ruling 0037 clause 4). response_model is what the provider
  -- reported answering, written at finalization, null when it reported none.
  provider text,
  model text,
  response_model text,
  -- Figures and lists the code rendered from tool results (ruling 0037
  -- clause 3), kept so a reloaded thread shows the same cards.
  cards jsonb not null default '[]'::jsonb,
  -- answered | step_cap | deadline | provider_error | error, written at
  -- finalization. Vocabulary owned by the TypeScript union, as ai_runs.operation.
  stop_reason text,
  input_tokens integer,
  output_tokens integer,
  error_note text,
  created_at timestamptz not null default now(),
  finalized_at timestamptz
);

alter table assistant_messages
  add constraint assistant_messages_role_check
  check (role in ('user', 'assistant'));

alter table assistant_messages
  add constraint assistant_messages_status_check
  check (status in ('running', 'completed', 'failed'));

-- A user message names no provider and is born completed. An assistant message
-- cannot exist without saying who it was addressed to.
alter table assistant_messages
  add constraint assistant_messages_role_shape_check
  check (
    (role = 'user' and status = 'completed' and provider is null and model is null)
    or (role = 'assistant' and provider is not null and model is not null)
  );

-- Running means not finished; anything else means finished. No third state.
alter table assistant_messages
  add constraint assistant_messages_terminal_shape_check
  check (
    (status = 'running' and finalized_at is null)
    or (status <> 'running' and finalized_at is not null)
  );

alter table assistant_messages
  add constraint assistant_messages_bounds_check
  check (
    char_length(content) <= 20000
    and jsonb_typeof(cards) = 'array'
    and (input_tokens is null or input_tokens >= 0)
    and (output_tokens is null or output_tokens >= 0)
  );

create index assistant_messages_thread_idx on assistant_messages (thread_id, created_at);
create index assistant_messages_organization_id_idx on assistant_messages (organization_id);

comment on table assistant_messages is
  'Ruling 0037 clause 4: the turn''s own record. The assistant row is born running BEFORE the model call, naming provider and model; finalized once. The run ledger row (ai_runs, source_table assistant_messages) points here.';

create table assistant_proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) default my_organization_id(),
  thread_id uuid not null references assistant_threads (id) on delete cascade,
  message_id uuid not null references assistant_messages (id) on delete cascade,
  created_by uuid not null default auth.uid() references auth.users (id),
  -- The closed list of act-on-approval abilities, enforced here as well as in
  -- code. Adding one is a reviewed migration, not a prompt.
  action_key text not null,
  -- EXACTLY what will be executed, and exactly what the user is shown.
  payload jsonb not null,
  subject_table text not null,
  subject_id uuid not null,
  -- Built by code from the payload, never taken from the model's text.
  summary text not null,
  status text not null default 'pending',
  expires_at timestamptz not null default (now() + interval '24 hours'),
  -- Set once, atomically, by the approve action BEFORE it executes anything.
  -- It is what makes execution happen at most once: a second approval cannot
  -- claim a proposal whose approval has already started. A proposal that is
  -- claimed and never decided is an attempted-and-unconfirmed approval -- an
  -- honest state, never retried by the system.
  claimed_at timestamptz,
  decided_at timestamptz,
  result jsonb,
  error_note text,
  created_at timestamptz not null default now()
);

alter table assistant_proposals
  add constraint assistant_proposals_action_check
  check (action_key in ('log_prospect_interaction', 'set_prospect_next_action', 'log_supporter_interaction'));

alter table assistant_proposals
  add constraint assistant_proposals_subject_check
  check (
    (action_key in ('log_prospect_interaction', 'set_prospect_next_action') and subject_table = 'prospects')
    or (action_key = 'log_supporter_interaction' and subject_table = 'supporters')
  );

alter table assistant_proposals
  add constraint assistant_proposals_status_check
  check (status in ('pending', 'executed', 'failed', 'dismissed', 'expired'));

alter table assistant_proposals
  add constraint assistant_proposals_payload_check
  check (jsonb_typeof(payload) = 'object' and char_length(summary) between 1 and 2000);

alter table assistant_proposals
  add constraint assistant_proposals_expiry_check
  check (expires_at > created_at);

-- Pending means undecided and carries no outcome; anything else was decided.
alter table assistant_proposals
  add constraint assistant_proposals_terminal_shape_check
  check (
    (status = 'pending' and decided_at is null and result is null and error_note is null)
    or (status <> 'pending' and decided_at is not null)
  );

-- Executed or failed means an approval was claimed first; dismissed or expired
-- means it never was. A proposal cannot be both approved and dismissed.
alter table assistant_proposals
  add constraint assistant_proposals_claim_shape_check
  check (
    (status in ('executed', 'failed') and claimed_at is not null)
    or (status in ('dismissed', 'expired') and claimed_at is null)
    or status = 'pending'
  );

create index assistant_proposals_thread_idx on assistant_proposals (thread_id, created_at);
create index assistant_proposals_message_idx on assistant_proposals (message_id);
create index assistant_proposals_organization_id_idx on assistant_proposals (organization_id);

comment on table assistant_proposals is
  'Ruling 0037 clause 2: a stored record of exactly what an act-on-approval ability will do. The model can only write this row; only the user''s approval of the rendered proposal executes it, once, with exactly this payload. Fixed at birth by trigger; decided once.';

-- Messages: a running assistant message may be finalized once; nothing else
-- about it may change, and a terminal message is immutable for every role.
create function assistant_messages_enforce_finalize_once() returns trigger as $$
begin
  if old.status <> 'running' then
    raise exception 'assistant_messages: a finished message is immutable -- terminal is written once';
  end if;
  if new.status = 'running' then
    raise exception 'assistant_messages: an update must write a terminal status -- running to terminal is the only legal transition';
  end if;
  if new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id
     or new.thread_id is distinct from old.thread_id
     or new.created_by is distinct from old.created_by
     or new.role is distinct from old.role
     or new.provider is distinct from old.provider
     or new.model is distinct from old.model
     or new.created_at is distinct from old.created_at then
    raise exception 'assistant_messages: birth facts (id, organization, thread, author, role, provider, model, created_at) cannot be rewritten';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger assistant_messages_finalize_once
  before update on assistant_messages
  for each row execute function assistant_messages_enforce_finalize_once();

-- Proposals: what was proposed is fixed at birth. After birth the only legal
-- writes are, in order, (1) claim the approval, once, while pending, and then
-- (2) record executed or failed; or (2') dismiss or expire an UNCLAIMED
-- proposal. A decided proposal never changes again.
create function assistant_proposals_enforce_transitions() returns trigger as $$
begin
  if new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id
     or new.thread_id is distinct from old.thread_id
     or new.message_id is distinct from old.message_id
     or new.created_by is distinct from old.created_by
     or new.action_key is distinct from old.action_key
     or new.payload is distinct from old.payload
     or new.subject_table is distinct from old.subject_table
     or new.subject_id is distinct from old.subject_id
     or new.summary is distinct from old.summary
     or new.expires_at is distinct from old.expires_at
     or new.created_at is distinct from old.created_at then
    raise exception 'assistant_proposals: what was proposed (action, payload, subject, summary, expiry) is fixed at birth and cannot be rewritten';
  end if;
  if old.status <> 'pending' then
    raise exception 'assistant_proposals: a decided proposal is immutable -- decided once';
  end if;
  if old.claimed_at is not null and new.claimed_at is distinct from old.claimed_at then
    raise exception 'assistant_proposals: a claimed approval cannot be re-claimed or cleared';
  end if;

  if new.status = 'pending' then
    -- The only legal pending-to-pending write is the claim, and nothing may
    -- ride along with it.
    if old.claimed_at is null
       and new.claimed_at is not null
       and new.decided_at is null
       and new.result is null
       and new.error_note is null then
      if now() > old.expires_at then
        raise exception 'assistant_proposals: an expired proposal cannot be approved';
      end if;
      return new;
    end if;
    raise exception 'assistant_proposals: an update must claim the approval or record a decision';
  end if;

  if new.status in ('executed', 'failed') and old.claimed_at is null then
    raise exception 'assistant_proposals: a proposal can only be executed or failed after its approval was claimed';
  end if;
  if new.status in ('dismissed', 'expired') and old.claimed_at is not null then
    raise exception 'assistant_proposals: a proposal whose approval has started cannot be dismissed or expired';
  end if;
  if new.status = 'expired' and now() <= old.expires_at then
    raise exception 'assistant_proposals: a proposal cannot be marked expired before its expiry';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger assistant_proposals_transitions
  before update on assistant_proposals
  for each row execute function assistant_proposals_enforce_transitions();

-- Cross-table org integrity (see the header).
create function enforce_assistant_message_thread_match() returns trigger as $$
declare
  t_org uuid;
  t_owner uuid;
begin
  select organization_id, created_by into t_org, t_owner from assistant_threads where id = new.thread_id;
  if new.organization_id is distinct from t_org then
    raise exception 'organization_id must match the referenced thread''s organization_id';
  end if;
  if new.created_by is distinct from t_owner then
    raise exception 'a message must be written by the user who owns the thread';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger assistant_messages_thread_match
  before insert or update of thread_id on assistant_messages
  for each row execute function enforce_assistant_message_thread_match();

create function enforce_assistant_proposal_refs_match() returns trigger as $$
declare
  t_org uuid;
  t_owner uuid;
  m_org uuid;
  m_thread uuid;
  m_role text;
  m_status text;
begin
  select organization_id, created_by into t_org, t_owner from assistant_threads where id = new.thread_id;
  if new.organization_id is distinct from t_org then
    raise exception 'organization_id must match the referenced thread''s organization_id';
  end if;
  if new.created_by is distinct from t_owner then
    raise exception 'a proposal must be written by the user who owns the thread';
  end if;
  select organization_id, thread_id, role, status into m_org, m_thread, m_role, m_status
    from assistant_messages where id = new.message_id;
  if new.organization_id is distinct from m_org then
    raise exception 'organization_id must match the referenced message''s organization_id';
  end if;
  if new.thread_id is distinct from m_thread then
    raise exception 'a proposal''s message must belong to the same thread';
  end if;
  -- A proposal is born during the turn that proposed it, never afterwards.
  if m_role is distinct from 'assistant' or m_status is distinct from 'running' then
    raise exception 'a proposal can only be created by a running assistant turn';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger assistant_proposals_refs_match
  before insert on assistant_proposals
  for each row execute function enforce_assistant_proposal_refs_match();

-- Tenant isolation. Hard rule 6, following 0033_multi_tenant_rls.sql. Nothing
-- in the codebase catches a table that skips this, so it is done here and
-- checked by scripts/test-tenant-isolation.ts.
alter table assistant_threads enable row level security;
alter table assistant_messages enable row level security;
alter table assistant_proposals enable row level security;

-- Every policy is scoped by organization AND by author: a thread is personal
-- to the user the assistant acts as. There is no delete policy anywhere.
create policy "users can start their own assistant threads"
  on assistant_threads for insert
  to authenticated
  with check (organization_id = my_organization_id() and created_by = auth.uid());

create policy "users can read their own assistant threads"
  on assistant_threads for select
  to authenticated
  using (organization_id = my_organization_id() and created_by = auth.uid());

-- An assistant message can only be born running (a user message, completed).
create policy "users can write their own assistant messages"
  on assistant_messages for insert
  to authenticated
  with check (
    organization_id = my_organization_id()
    and created_by = auth.uid()
    and (role = 'user' or status = 'running')
  );

create policy "users can read their own assistant messages"
  on assistant_messages for select
  to authenticated
  using (organization_id = my_organization_id() and created_by = auth.uid());

-- Update reaches only a RUNNING message of the caller's own; the trigger above
-- pins everything except the finalization fields and closes the same door for
-- every role.
create policy "users can finalize their own running assistant messages"
  on assistant_messages for update
  to authenticated
  using (organization_id = my_organization_id() and created_by = auth.uid() and status = 'running')
  with check (organization_id = my_organization_id() and created_by = auth.uid());

-- A proposal is born pending and unclaimed; nothing else is insertable.
create policy "users can record their own assistant proposals"
  on assistant_proposals for insert
  to authenticated
  with check (
    organization_id = my_organization_id()
    and created_by = auth.uid()
    and status = 'pending'
    and claimed_at is null
  );

create policy "users can read their own assistant proposals"
  on assistant_proposals for select
  to authenticated
  using (organization_id = my_organization_id() and created_by = auth.uid());

create policy "users can decide their own pending assistant proposals"
  on assistant_proposals for update
  to authenticated
  using (organization_id = my_organization_id() and created_by = auth.uid() and status = 'pending')
  with check (organization_id = my_organization_id() and created_by = auth.uid());
