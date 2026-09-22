-- STATE item 59, ruling 0029 clause 4 extended: the attempt ledger captures
-- the IDENTITY it sent, not just the recipient, subject and body. Item 57
-- made the send present as the organization (`"{org name}" <platform
-- address>`) with the clicking human as reply-to -- both built into the
-- payload at send time from live rows. An org can rename itself after a
-- send, so the historical from-identity is unreconstructible unless it is
-- captured at birth with the rest of the payload. Two nullable columns on
-- `draft_send_attempts`, written by the birth insert, pinned by the
-- terminal-once trigger like every other birth fact.
--
-- ADDITIVE IN EFFECT despite the `create or replace function`: the trigger
-- functions from 0069 are already applied in the live database, so the
-- extended pinning cannot arrive as a new function -- it must replace
-- `draft_send_attempts_enforce_terminal_once` in place. The replacement
-- only WIDENS a guard (two more columns join the pinned birth-facts list),
-- changes no data, drops nothing, and removes no check the 0069 version
-- performed -- every update the old function refused, this one refuses too.
-- Migration 0069 itself is untouched (never rewrite an applied migration).
--
-- SAFE TO APPLY AHEAD OF ITS CODE. The new columns are nullable and
-- written by nothing that exists before item 59's code: item 57's birth
-- insert simply leaves them null, which is legal (a row born before this
-- capture existed records that absence, honestly), and the widened pinning
-- is a no-op for every update that does not touch the two columns -- which
-- is every update the pre-item-59 code performs (finalization writes only
-- outcome, completed_at, error_note, resend_message_id). The reverse order
-- is ALSO safe, and fail-closed: with this migration absent, the birth
-- insert names columns that do not exist, so it fails (undefined column)
-- and the handler refuses without sending anything -- 0069's
-- birth-before-provider construction makes the code the gated side here
-- exactly as it did for the table itself.

alter table draft_send_attempts
  add column from_identity text,
  add column reply_to text;

comment on column draft_send_attempts.from_identity is
  'The exact from header handed to the provider: "{org display name}" <platform address>, captured at birth with the rest of the payload (ruling 0029 clause 4, STATE item 59). The org can rename itself later; this row keeps what the funder actually saw. Null on rows born before this column existed -- that absence is the honest record, never backfilled by guesswork.';

comment on column draft_send_attempts.reply_to is
  'The reply-to handed to the provider: the email of the human who clicked send, captured at birth. Null on rows born before this column existed.';

-- The terminal-once trigger, with the two new columns joining the pinned
-- birth-facts list. Byte-for-byte the 0069 function otherwise: a
-- finalization may add what the provider answered, never rewrite what was
-- handed to it, by whom, when -- or, now, as whom.
create or replace function draft_send_attempts_enforce_terminal_once() returns trigger as $$
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
     or new.from_identity is distinct from old.from_identity
     or new.reply_to is distinct from old.reply_to
     or new.attempted_by is distinct from old.attempted_by
     or new.attempted_at is distinct from old.attempted_at
     or new.organization_id is distinct from old.organization_id then
    raise exception 'draft_send_attempts: birth facts (id, draft, payload, identity, who, when, organization) cannot be rewritten';
  end if;
  return new;
end;
$$ language plpgsql;
