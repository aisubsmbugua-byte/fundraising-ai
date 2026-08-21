-- One-time backfill: 0023_contacts.sql's upsertContact hook only
-- fires on new candidate/prospect writes going forward, so every
-- contact captured before this feature existed needs populating once
-- here. Prospects go first so an accepted candidate's contact links
-- to its (now-existing) prospect page rather than nowhere; the
-- candidates insert then skips anything already claimed by email.
insert into contacts (name, email, organization, source_prospect_id, created_by)
select
  coalesce(nullif(trim(contact_name), ''), lower(trim(contact_email))),
  nullif(lower(trim(contact_email)), ''),
  organization,
  id,
  owner_id
from prospects
where coalesce(nullif(trim(contact_name), ''), nullif(trim(contact_email), '')) is not null
on conflict (email) do nothing;

insert into contacts (name, email, organization, source_candidate_id, created_by)
select
  coalesce(nullif(trim(contact_name), ''), lower(trim(contact_email))),
  nullif(lower(trim(contact_email)), ''),
  organization,
  id,
  reviewed_by
from candidates
where coalesce(nullif(trim(contact_name), ''), nullif(trim(contact_email), '')) is not null
on conflict (email) do nothing;
