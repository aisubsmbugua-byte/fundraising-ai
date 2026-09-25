-- STATE item 73: drafts hardening -- the three holes item 72 found, closed
-- before outside orgs touch send. Standing invariants, no new one: hard rule
-- 6 (every org-scoped table tenant-isolated; the drafts.prospect_id gap is
-- recorded in docs/decisions/0001-multi-tenancy.md) and ruling 0029 clauses
-- 3-4 (sent facts are written once and cannot be asserted from nowhere).
--
-- (i) Org-match on drafts.prospect_id. drafts' RLS scopes by its OWN
--     organization_id, but the FK to prospects is checked with RLS bypassed,
--     so Org B could insert a draft (carrying Org B's own organization_id)
--     that links to Org A's prospect. 0066's exact pattern, extended from
--     insert-only to `insert or update of prospect_id` because a draft's
--     prospect can also be re-pointed by an update. SECURITY DEFINER with
--     search_path = public, exactly as 0066's sibling functions and 0069's
--     drafts triggers: the guard reads prospects, whose select policy is
--     org-scoped, and run as the invoker a caller whose org context did not
--     resolve would read no prospect row and the comparison would be against
--     null -- definer makes the read independent of the caller's RLS view,
--     so the refusal is uniform across roles (including the service role).
--     A null lookup (no such prospect) also refuses; prospect_id is NOT NULL
--     with an FK, so that branch is unreachable for a legal row.
--
-- (ii) Sent facts cannot be born on INSERT. 0069's drafts_sent_once is a
--     BEFORE UPDATE trigger, so an INSERT could carry sent_at / sent_by /
--     resend_message_id directly and skip the "must mirror a confirmed
--     attempt" check entirely. Sent facts are only ever born by the guarded
--     UPDATE that mirrors a confirmed attempt; this BEFORE INSERT trigger
--     refuses any row arriving with any of the three set. Plain plpgsql, no
--     table read, so no security definer is needed. Checked against the app
--     (grep of app/, lib/, components/ for sent_at, sent_by,
--     resend_message_id): the only writer is the send handler's UPDATE
--     (send-actions.ts); every drafts insert in draft-actions.ts omits all
--     three. No legitimate path inserts them.
--
-- (iii) Serialising send-birth against a concurrent un-approve. Item 72's
--     trigger (0074, drafts_unapprove_guard) reads draft_send_attempts; 0069's
--     birth trigger reads drafts.status. Under READ COMMITTED each sees only
--     committed rows of the other, so a birth and an un-approve running at
--     the same instant could each pass and leave an approved-then-reverted
--     draft carrying a live attempt. The birth trigger's read of the draft
--     row now takes FOR UPDATE: whichever transaction reaches the draft row
--     second waits for the first to finish, then re-evaluates against the
--     committed result -- if the un-approve wins, the birth reads status
--     'draft' and refuses; if the birth wins, the un-approve's trigger sees
--     the committed attempt and refuses. One of the two always sees the other.
--
--     ADDITIVE IN EFFECT despite the `create or replace function`, following
--     0070's precedent: draft_send_attempts_enforce_birth from 0069 is
--     already applied in the live database, so the lock cannot arrive as a
--     new function -- it must replace the function in place. The replacement
--     only WIDENS a guard (one added lock clause), changes no data, drops
--     nothing, and removes no check the 0069 version performed: every insert
--     the old function refused, this one refuses too, and the body is
--     byte-for-byte 0069's apart from the two words `for update` and the
--     comment above them. Migration 0069 itself is untouched.
--
-- Additive under ruling 0020: two new functions and two new triggers on
-- drafts, one create-or-replace that only adds a row lock. No column, table,
-- policy or data is touched; migrations 0001-0074 are untouched. The new
-- drafts triggers coexist with drafts_sent_once (0069) and
-- drafts_unapprove_guard (0074), which are BEFORE UPDATE and unchanged; they
-- only raise or return new, so firing order changes no outcome.
--
-- SAFE TO APPLY AHEAD OF ITS CODE. Nothing in the app performs a transition
-- these refuse: every drafts insert names a prospect in the caller's own org
-- (its organization_id defaults to my_organization_id() and the prospect is
-- selected through the caller's RLS) and none sets a send fact; the send
-- handler's sent-fact write is an UPDATE that does not touch prospect_id; and
-- the added lock changes only timing under contention. The reverse order is
-- ALSO safe: code deployed before this migration behaves exactly as it does
-- today, with 0069/0074 and the app-level checks as the only walls.
--
-- Combined with 0074: the owner may paste 0074 and 0075 in one script; they
-- are independent (0075 neither reads nor replaces anything 0074 creates).
--
-- SQL-editor caveat: the Supabase SQL editor runs a pasted script as one
-- transaction, so everything here applies together or not at all; nothing
-- needs to run outside a transaction. Re-running after success fails on the
-- existing function and trigger names (no IF NOT EXISTS here) -- a no-op
-- refusal that rolls the whole script back, not damage. Only the (iii)
-- replace is itself re-runnable. Adding the triggers takes a brief lock on
-- drafts.

-- (i)
create function enforce_draft_prospect_org_match() returns trigger as $$
begin
  if new.organization_id is distinct from (select organization_id from prospects where id = new.prospect_id) then
    raise exception 'drafts: organization_id must match the referenced prospect''s organization_id';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger drafts_prospect_org_match
  before insert or update of prospect_id on drafts
  for each row execute function enforce_draft_prospect_org_match();

-- (ii)
create function drafts_refuse_insert_with_sent_facts() returns trigger as $$
begin
  if new.sent_at is not null or new.sent_by is not null or new.resend_message_id is not null then
    raise exception 'drafts: sent facts cannot be born on insert -- they are only written by the guarded update that mirrors a confirmed send attempt (ruling 0029 clauses 3-4)';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger drafts_no_insert_with_sent_facts
  before insert on drafts
  for each row execute function drafts_refuse_insert_with_sent_facts();

-- (iii) Byte-for-byte the 0069 function, plus `for update` on the draft read.
create or replace function draft_send_attempts_enforce_birth() returns trigger as $$
declare
  d record;
begin
  -- FOR UPDATE: lock the draft row so this birth and a concurrent un-approve
  -- (0074's trigger reads draft_send_attempts) serialise -- under READ
  -- COMMITTED the later one waits, then re-reads the committed result, so
  -- one of the two always sees the other (STATE item 73).
  select organization_id, status, sent_at into d from drafts where id = new.draft_id for update;
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
