-- Ruling 0029: one send path, born behind one human click. This is the
-- schema half of Slice 8 (docs/slices/slice-08-email-send.md) -- the first
-- capability that can reach a funder's inbox, so every clause the ruling
-- states is enforced HERE, in the database, not in prose or interface.
--
-- Two shapes, both proven elsewhere in this codebase:
--
--  * Sent facts on `drafts` (sent_at, sent_by, resend_message_id), written
--    once and never cleared -- the terminal-written-once trigger pattern
--    from migration 0067 (ai_runs), pointed at the send columns (ruling
--    0029 clause 3: one draft, one send, ever; re-sending is a new draft).
--
--  * A send-attempt ledger (`draft_send_attempts`), born BEFORE the
--    provider is called and finalized once after -- 0067's birth-before-run
--    pattern. There is deliberately NO 'unconfirmed' outcome value: an
--    attempt whose provider response never arrived keeps outcome null, and
--    that absence IS the recorded attempted-unconfirmed state (ruling 0029
--    clause 4 -- never silently absent, never assumed delivered, and no
--    column a model or a handler could use to fake an observation nobody
--    made). The attempt row captures the exact recipient, subject and body
--    handed to the provider, at birth -- what was sent is captured, not
--    retyped, even when the response never comes back.
--
-- Once-only is enforced three independent ways, all in the database:
--  1. a partial unique index allows at most ONE live (outcome null)
--     attempt per draft -- two concurrent confirmation clicks cannot both
--     birth an attempt, so they cannot both send;
--  2. a partial unique index allows at most ONE 'sent' attempt per draft;
--  3. the birth trigger refuses a new attempt for a draft that is not
--     'approved', already carries sent_at, or already has a live or 'sent'
--     attempt -- and an attempt that is never confirmed (outcome null
--     forever) permanently blocks re-sending that draft, because the
--     message MAY have been delivered; a re-send is a new draft.
--
-- The attempt's FK to drafts deliberately has NO cascade: a draft that has
-- ever had a send attempt cannot be deleted (and, transitively, neither can
-- its prospect through the prospects->drafts cascade). Deleting the draft
-- would clear the record of a message that reached, or may have reached, a
-- real funder -- sent facts are never cleared, including by deletion.
--
-- Additive under ruling 0020: three nullable columns on drafts, one new
-- table, four new indexes (two of them partial unique), three new
-- policies, three new functions, three new triggers. No existing column,
-- policy or trigger is dropped or altered.
--
-- SAFE TO APPLY AHEAD OF ITS CODE. The new drafts columns are nullable and
-- written by nothing that exists before Slice 8's code; the new drafts
-- trigger is a no-op for every row whose sent_at is null and whose update
-- does not touch the send columns (i.e. every write the pre-0069 code
-- performs); the new table is written by nothing until the send handler
-- exists. The reverse order is ALSO safe: the send handler writes the
-- attempt birth row BEFORE calling the provider, so with this migration
-- absent that insert fails (42P01) and the handler refuses without sending
-- anything -- the code, not the schema, is the gated side.

alter table drafts
  add column sent_at timestamptz,
  add column sent_by uuid references auth.users (id),
  add column resend_message_id text;

comment on column drafts.sent_at is
  'When this draft was confirmed sent (provider responded with a message id). Written once by the send handler, never cleared -- the trigger below refuses any change after it is set. Null means never confirmed sent; the attempt ledger says whether a send was ever attempted.';

comment on column drafts.resend_message_id is
  'The provider message id, CAPTURED from Resend''s response -- never typed by a model or a human (ruling 0029 clause 4). Present exactly when sent_at is.';

-- The attempt ledger. One row per human confirmation click, born before
-- the provider call with the exact payload about to be sent.
create table draft_send_attempts (
  id uuid primary key default gen_random_uuid(),
  -- NO cascade, deliberately -- see the header. A draft (or prospect)
  -- with send history cannot be deleted out from under its record.
  draft_id uuid not null references drafts (id),
  -- The payload, captured at birth: exactly what is handed to the
  -- provider. recipient comes from the prospect's contact_email AT SEND
  -- TIME; subject/body from the approved draft. If the response never
  -- arrives, this row is still the full record of what may have gone out.
  recipient_email text not null,
  subject text not null,
  body text not null,
  attempted_by uuid not null references auth.users (id),
  attempted_at timestamptz not null default now(),
  -- 'sent' | 'failed', written once at the end by the code that observed
  -- the provider's response. NO 'unconfirmed' value on purpose: a null
  -- outcome IS attempted-unconfirmed (see the header).
  outcome text,
  completed_at timestamptz,
  error_note text,
  -- Captured from the provider's response, never typed (clause 4).
  resend_message_id text,
  organization_id uuid not null references organizations (id) default my_organization_id()
);

alter table draft_send_attempts
  add constraint draft_send_attempts_outcome_check
  check (outcome in ('sent', 'failed'));
  -- null passes an IN check (unknown, not false) -- attempted-unconfirmed
  -- is legal and is the absence; 'unconfirmed' or anything else is not.

-- A row cannot claim it ended without saying when, and cannot carry
-- terminal facts while still live -- so an attempt really is BORN
-- unfinalized (nothing can insert a pre-finalized 'sent' record and skip
-- the birth; the birth trigger below enforces the insert half).
alter table draft_send_attempts
  add constraint draft_send_attempts_terminal_shape_check
  check (
    (outcome is null and completed_at is null and error_note is null and resend_message_id is null)
    or (outcome is not null and completed_at is not null)
  );

-- The provider message id exists exactly when the provider confirmed the
-- send; an error note only on a refusal.
alter table draft_send_attempts
  add constraint draft_send_attempts_message_id_check
  check (
    (outcome = 'sent' and resend_message_id is not null and error_note is null)
    or (outcome = 'failed' and resend_message_id is null)
    or (outcome is null)
  );

-- Once-only under concurrency, in the database (ruling 0029 clause 3):
-- at most one live attempt, at most one confirmed send, per draft, ever.
create unique index draft_send_attempts_one_live_idx
  on draft_send_attempts (draft_id) where outcome is null;
create unique index draft_send_attempts_one_sent_idx
  on draft_send_attempts (draft_id) where outcome = 'sent';

create index draft_send_attempts_draft_idx on draft_send_attempts (draft_id);
create index draft_send_attempts_organization_id_idx on draft_send_attempts (organization_id);

comment on table draft_send_attempts is
  'The send-attempt ledger (ruling 0029). One row per human confirmation click, born BEFORE the provider is called, carrying the exact payload handed over. outcome null means attempted-unconfirmed -- the response never arrived, the message may or may not have been delivered, and the system never re-sends: a live or unconfirmed attempt permanently blocks new attempts for its draft. Retained, never deleted.';

comment on column draft_send_attempts.outcome is
  'sent | failed, written once by the code that observed the provider''s response. Null means attempted-unconfirmed. There is no way to write ''unconfirmed'' because nobody ever observes it.';

-- The one-send-per-draft guarantee on the drafts row itself (clause 3),
-- for every role including service role. Legal transitions only:
--   never-sent -> never-sent: any ordinary edit (subject, content, status).
--   never-sent -> sent: the ONE sent-write -- requires the draft to be
--     'approved' at that moment, all three send facts written together,
--     content untouched by the same write, and a matching confirmed
--     attempt already in the ledger (the sent fact MIRRORS the captured
--     attempt; it cannot be asserted from nowhere).
--   sent -> anything: refused. Sent facts never change, and what was sent
--     (subject, content, kind, prospect) is pinned exactly as sent.
create function drafts_enforce_sent_once() returns trigger as $$
begin
  if old.sent_at is not null then
    if new.sent_at is distinct from old.sent_at
       or new.sent_by is distinct from old.sent_by
       or new.resend_message_id is distinct from old.resend_message_id then
      raise exception 'drafts: sent facts are written once and never cleared (ruling 0029 clause 3)';
    end if;
    if new.subject is distinct from old.subject
       or new.content is distinct from old.content
       or new.status is distinct from old.status
       or new.kind is distinct from old.kind
       or new.prospect_id is distinct from old.prospect_id then
      raise exception 'drafts: a sent draft is immutable -- what was sent stays exactly as sent';
    end if;
  elsif new.sent_at is not null then
    if new.sent_by is null or new.resend_message_id is null then
      raise exception 'drafts: a sent fact carries who confirmed it and the provider message id together, or not at all';
    end if;
    if old.status <> 'approved' then
      raise exception 'drafts: only an approved draft can be marked sent (ruling 0029 clause 2)';
    end if;
    if new.subject is distinct from old.subject or new.content is distinct from old.content then
      raise exception 'drafts: the sent-write may not rewrite the content it claims was sent';
    end if;
    if not exists (
      select 1 from draft_send_attempts
      where draft_id = new.id
        and outcome = 'sent'
        and resend_message_id = new.resend_message_id
    ) then
      raise exception 'drafts: a sent fact must mirror a confirmed attempt in draft_send_attempts -- it cannot be asserted from nowhere (ruling 0029 clause 4)';
    end if;
  elsif new.sent_by is not null or new.resend_message_id is not null then
    raise exception 'drafts: sent_by and resend_message_id cannot exist without sent_at';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger drafts_sent_once
  before update on drafts
  for each row execute function drafts_enforce_sent_once();

-- Birth preconditions, enforced for every role (clause 2 in the schema):
-- an attempt can only be born against the caller's own org's APPROVED,
-- never-sent draft with no live and no confirmed attempt -- and it is
-- born unfinalized, or not at all (birth-before-send is not optional).
create function draft_send_attempts_enforce_birth() returns trigger as $$
declare
  d record;
begin
  select organization_id, status, sent_at into d from drafts where id = new.draft_id;
  if d.organization_id is distinct from new.organization_id then
    raise exception 'draft_send_attempts: organization_id must match the referenced draft''s organization_id';
  end if;
  if d.status <> 'approved' then
    raise exception 'draft_send_attempts: only an approved draft can be sent (ruling 0029 clause 2)';
  end if;
  if d.sent_at is not null then
    raise exception 'draft_send_attempts: this draft has already been sent -- one draft, one send, ever (ruling 0029 clause 3)';
  end if;
  if exists (
    select 1 from draft_send_attempts
    where draft_id = new.draft_id and (outcome = 'sent' or outcome is null)
  ) then
    raise exception 'draft_send_attempts: a live, unconfirmed or confirmed attempt already exists for this draft -- it will not be sent twice';
  end if;
  if new.outcome is not null or new.completed_at is not null
     or new.error_note is not null or new.resend_message_id is not null then
    raise exception 'draft_send_attempts: an attempt is born unfinalized, before the provider is called -- terminal facts are written after (ruling 0029 clause 4)';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger draft_send_attempts_birth
  before insert on draft_send_attempts
  for each row execute function draft_send_attempts_enforce_birth();

-- Terminal outcome written once, birth facts pinned -- 0067's shape.
-- A finalization may add what the provider answered, never rewrite what
-- was handed to it, by whom, or when.
create function draft_send_attempts_enforce_terminal_once() returns trigger as $$
begin
  if old.outcome is not null then
    raise exception 'draft_send_attempts: an attempt with a terminal outcome is immutable -- terminal is written once';
  end if;
  if new.outcome is null then
    raise exception 'draft_send_attempts: an update must write a terminal outcome -- unfinalized to terminal is the only legal transition';
  end if;
  if new.id is distinct from old.id
     or new.draft_id is distinct from old.draft_id
     or new.recipient_email is distinct from old.recipient_email
     or new.subject is distinct from old.subject
     or new.body is distinct from old.body
     or new.attempted_by is distinct from old.attempted_by
     or new.attempted_at is distinct from old.attempted_at
     or new.organization_id is distinct from old.organization_id then
    raise exception 'draft_send_attempts: birth facts (id, draft, payload, who, when, organization) cannot be rewritten';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger draft_send_attempts_terminal_once
  before update on draft_send_attempts
  for each row execute function draft_send_attempts_enforce_terminal_once();

-- Tenant isolation. Hard rule 6, following 0033/0066/0067. Checked by
-- scripts/test-tenant-isolation.ts. Insert additionally requires the
-- attempt to name its real author (0066's recorded_by pattern) -- a send
-- confirmation is a personal act. Update reaches only UNFINALIZED rows of
-- the caller's own org; the trigger above covers every other role. NO
-- delete policy at all: a send record whose history can be deleted is not
-- a record.
alter table draft_send_attempts enable row level security;

create policy "team members can record a send attempt"
  on draft_send_attempts for insert
  to authenticated
  with check (attempted_by = auth.uid() and organization_id = my_organization_id());

create policy "team members can read their org's send attempts"
  on draft_send_attempts for select
  to authenticated
  using (organization_id = my_organization_id());

create policy "team members can finalize an unfinalized send attempt"
  on draft_send_attempts for update
  to authenticated
  using (organization_id = my_organization_id() and outcome is null)
  with check (organization_id = my_organization_id());
