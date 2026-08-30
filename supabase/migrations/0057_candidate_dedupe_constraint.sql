-- Make "no duplicate funders" a guarantee instead of a check.
--
-- Five identical "Graceway Church" candidates were written through the manual
-- form on 18 August. Two causes, not one, and the timestamps separate them:
--
--   22:17:45, 22:27:02, 22:36:39   minutes apart -- a person adding the same
--                                  church repeatedly, with nothing telling
--                                  them it already existed. Manual entry and
--                                  CSV import never checked; only Donor
--                                  Finder's search did.
--
--   22:48:00.440, 22:48:01.884     1.4 seconds apart -- one click landing
--                                  twice.
--
-- The first cause is fixed in code (lib/candidate-intake.ts, now shared by all
-- three write paths). The second cannot be. Between reading the existing rows
-- and writing the new one there is a window in which a second identical
-- request passes the same check, and no amount of application-level care
-- closes it. Only a constraint does.
--
-- So the check stops being the guarantee and becomes what it should always
-- have been: the thing that produces a helpful message before the guarantee
-- ever has to fire.

-- Scoped to candidates still in the queue.
--
-- An accepted candidate is not a queue entry -- it is the immutable record of
-- a decision that already happened, and a prospect exists downstream of it.
-- Rewriting that history to satisfy a constraint would destroy an audit trail
-- to tidy a list. The live invariant is "at most one OPEN candidate per
-- funder", and that is what this enforces.
--
-- Re-adding a funder that was already accepted is caught by the application
-- check instead, which reads prospects as well as candidates -- that path has
-- a person waiting on an answer, so a warning serves better than a violation.
delete from candidates c
using candidates keep
where c.status <> 'accepted'
  and keep.status <> 'accepted'
  and c.dedupe_key is not null
  and keep.dedupe_key is not null
  and c.dedupe_key = keep.dedupe_key
  and c.organization_id is not distinct from keep.organization_id
  and (keep.created_at < c.created_at or (keep.created_at = c.created_at and keep.id < c.id));

-- Nulls compare as distinct in a unique index, so rows predating 0055 -- which
-- have no key and cannot be given one honestly -- are unconstrained rather
-- than colliding with each other. That is the correct reading: an absent key
-- is "unknown", never "same as the other unknowns".
create unique index candidates_open_dedupe_key_idx
  on candidates (organization_id, dedupe_key)
  where status <> 'accepted' and dedupe_key is not null;

comment on index candidates_open_dedupe_key_idx is
  'At most one open candidate per funder. Backstop for the race the application check cannot close.';
