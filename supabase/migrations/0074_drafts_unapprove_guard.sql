-- STATE item 72(d), closing item 55: the database half of the un-approve
-- wall. unapproveDraft (item 68) refuses approved -> draft while a send
-- attempt exists that is live (outcome null: attempted-unconfirmed) or
-- confirmed ('sent'), but that check is application-level: it reads the
-- ledger, then writes the draft, and a send confirmation landing between
-- the two would leave an approved-then-reverted draft carrying a live
-- attempt -- a message that may have reached a funder attached to a draft
-- that says it is not approved. This trigger makes the same refusal a
-- property of the drafts table itself, for every role including the
-- service role, so the app-level check is no longer the only wall.
--
-- One legal-transition table (only approved -> draft is guarded):
--   draft    -> approved  allowed (approveDraft; never reaches the guard).
--   approved -> approved  allowed -- includes the send handler's write:
--                         status stays 'approved' throughout a send while
--                         sent_at / sent_by / resend_message_id are written.
--   approved -> draft     allowed when NO attempt exists, or when every
--                         attempt is 'failed' (a refusal is terminal for
--                         its attempt, not for the draft -- 0069 clause 5).
--   approved -> draft     REFUSED while any attempt is live (outcome null)
--                         or confirmed (outcome 'sent').
-- A SENT draft is already pinned by drafts_sent_once (0069), which refuses
-- every change to a sent draft; this trigger covers the case that trigger
-- cannot see: an attempt exists but sent_at is not yet written.
--
-- SECURITY DEFINER with search_path = public, like the sibling drafts
-- triggers in 0069: the guard must read draft_send_attempts, whose select
-- policy is org-scoped. Run as the invoker, a caller whose org context did
-- not resolve would see zero attempts and the guard would fail OPEN;
-- definer makes the ledger read independent of the caller's RLS view, so
-- the refusal is uniform across roles. It reads only, writes nothing, and
-- returns new unchanged.
--
-- Additive under ruling 0020: one new function, one new trigger. No
-- existing column, policy, function or trigger is dropped or altered, and
-- migrations 0001-0073 are untouched. It coexists with drafts_sent_once
-- (0069): both are BEFORE UPDATE row triggers on drafts, neither writes
-- new, they only raise, so firing order does not change any outcome.
--
-- SAFE TO APPLY AHEAD OF ITS CODE. No code path that exists today performs
-- a forbidden transition: unapproveDraft already refuses one whenever the
-- ledger shows a live or confirmed attempt, so the trigger fires only in
-- the race the app-level check cannot close -- where it turns a silently
-- wrong state into a refused write (unapproveDraft surfaces the database
-- error). The reverse order is ALSO safe: code deployed before this
-- migration behaves exactly as it does today, with the app-level check as
-- the only wall.
--
-- SQL-editor caveat: the Supabase SQL editor runs a pasted script as one
-- transaction, so create function + create trigger apply together or not at
-- all; nothing here needs to run outside a transaction (no concurrent
-- index, no enum value added). Re-running after success fails on the
-- existing trigger name (create trigger has no IF NOT EXISTS here) -- that
-- is a no-op refusal, not damage. `create or replace function` makes the
-- function half re-runnable.
--
-- Known limit, stated so it is not mistaken for a guarantee: a trigger sees
-- only COMMITTED attempt rows (READ COMMITTED). An attempt insert that has
-- not yet committed when the un-approve update runs is invisible here, and
-- 0069's birth trigger likewise reads drafts.status without locking the
-- draft row. Closing that fully needs a row lock in the birth path, which
-- is send machinery and outside this migration's authorization.

create or replace function drafts_refuse_unapprove_with_attempt() returns trigger as $$
begin
  if old.status = 'approved' and new.status = 'draft' then
    if exists (
      select 1 from draft_send_attempts
      where draft_id = old.id and (outcome is null or outcome = 'sent')
    ) then
      raise exception 'drafts: an approved draft with a live or confirmed send attempt cannot return to draft -- the message may have reached the funder, so it stays exactly as attempted';
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger drafts_unapprove_guard
  before update on drafts
  for each row execute function drafts_refuse_unapprove_with_attempt();
