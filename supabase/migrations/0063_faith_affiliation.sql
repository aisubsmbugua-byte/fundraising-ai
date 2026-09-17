-- Build 1, Step 1: user-confirmed faith affiliations on the nonprofit's own profile.
--
-- Needed by the denominational disqualification rule, which may only fire when
-- the funder STATES a restriction, the profile SUPPLIES a confirmed
-- affiliation, and the two are deterministically incompatible. Without a
-- confirmed affiliation on our side, the rule can never fire -- which is the
-- correct behaviour, and requires being able to tell "nobody has told us" from
-- "confirmed: none".
--
-- Three columns rather than one array, because an empty array cannot carry
-- that distinction, and this codebase already has a rule about exactly that:
-- "not evaluated" and "evaluated and clean" are different facts and must not
-- collapse into one value. A nonprofit that has confirmed it has no
-- denominational affiliation IS disqualified by a named-body requirement; one
-- we have never asked is not.
--
-- Additive. org_profile already carries organization_id and its RLS policy
-- from 0033, so new columns inherit tenant isolation with no policy change.

alter table org_profile
  add column faith_affiliation_state text not null default 'unknown',
  add column faith_affiliations text[] not null default '{}',
  add column faith_affiliation_confirmed_at timestamptz,
  add column faith_affiliation_confirmed_by uuid references profiles (id);

-- text + check rather than a Postgres enum, matching entity_validation_status
-- and citation_consistency: this vocabulary may still grow, and a check
-- constraint can be altered where an enum value cannot be removed.
alter table org_profile
  add constraint org_profile_faith_affiliation_state_check
  check (faith_affiliation_state in ('unknown', 'none', 'declared'));

-- The invariant the reader enforces in code, enforced here too. A row claiming
-- 'declared' with nothing declared is a contradiction, and a contradiction
-- must not be storable -- lib/qualification.ts reads it as 'unknown' rather
-- than as anything that could disqualify someone, but the safest version of
-- that defence is for the row never to exist.
alter table org_profile
  add constraint org_profile_faith_affiliation_declared_check
  check (
    (faith_affiliation_state = 'declared' and array_length(faith_affiliations, 1) >= 1)
    or (faith_affiliation_state <> 'declared' and coalesce(array_length(faith_affiliations, 1), 0) = 0)
  );

comment on column org_profile.faith_affiliation_state is
  'unknown | none | declared. "unknown" (the default for every existing row) means nobody has been asked, and can never disqualify. "none" is a human-confirmed absence and CAN be incompatible with a funder that requires a named affiliation. See lib/qualification.ts.';

comment on column org_profile.faith_affiliations is
  'Vocabulary identifiers, not free text, and only non-empty when state = declared. Multiple affiliations are permitted and any one of them matching a funder''s accepted bodies satisfies the rule.';

comment on column org_profile.faith_affiliation_confirmed_by is
  'Who confirmed it. Affiliation is a human-confirmed fact about the nonprofit, never inferred from its name or its funders -- same pattern as prospects.operating_identity_confirmed_by in 0059.';
