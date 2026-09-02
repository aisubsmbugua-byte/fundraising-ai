-- A human's confirmation of WHICH ORGANIZATION a prospect is, recorded as
-- itself rather than inferred from a side effect.
--
-- confirmProspectOperatingIdentity wrote prospects.website and nothing else,
-- on the reasoning that the website is what the next run needs. That is true
-- and it is not sufficient: on Mission to the World the website was ALREADY
-- https://mtw.org (Donor Finder captured it), so confirming wrote the value
-- that was already there, the page re-rendered identically, and the button
-- read as broken. The same failure has appeared once before in this build --
-- see "Make confirming an entity visibly do something" -- and it recurs
-- because the confirmation is not stored anywhere, only implied by a field
-- that may already hold the value.
--
-- So: store the decision. Who confirmed it, when, and what they confirmed.
-- Deliberately parallel to ein/predecessor_eins (the LEGAL layer's
-- confirmation) and deliberately separate from it: confirming an organization
-- is not evidence about a filing, and the two must never collapse into one
-- field.
alter table prospects add column operating_identity_domain text;
alter table prospects add column operating_identity_name text;
alter table prospects add column operating_identity_confirmed_at timestamptz;
alter table prospects add column operating_identity_confirmed_by uuid references profiles (id);

comment on column prospects.operating_identity_domain is
  'The organization''s own domain, confirmed by a person. Feeds the official-domain path so the next run can resolve the EIN deterministically.';
comment on column prospects.operating_identity_name is
  'The organization as confirmed, for display. Not a legal name -- see prospects.legal_name.';
comment on column prospects.operating_identity_confirmed_at is
  'When a human settled WHICH ORGANIZATION this is. Null means nobody has. Independent of prospects.ein, which settles which FILING.';
