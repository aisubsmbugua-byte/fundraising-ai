-- Attest what was SAID about a candidate, not just where it was found.
--
-- 0055 captured provenance: the URL the search actually visited, its domain,
-- and whether that URL is the funder's own site or a third party's page about
-- them. That closed the question "did this candidate come from anywhere real?"
--
-- It left the larger half open. Every remaining structured field on a
-- candidate -- name, funder_name, opportunity_name, organization, contact_name,
-- contact_email, location -- is still a string the model TYPED, with nothing
-- testing it against the source it cited. The first confirmed instance:
-- "Mariners Church (Sister Campuses)" was stored with opportunity_name
-- "Sister Campus Sibling Outreach Strategy" -- not a program Mariners Church
-- publishes, but our own suggested approach to them, written into a field that
-- reads as fact and flows into the display name and on into Research.
--
-- That is not a bug in one field. It is the same defect the Research Agent was
-- rebuilt to remove, one layer upstream: a model typing what it concluded
-- instead of selecting from what was captured.

-- The title the search returned for the cited URL, kept verbatim.
--
-- Real captured text, and the only ground truth this pipeline has about a
-- source's content -- Donor Finder has no evidence ledger (that is Research's
-- research_evidence). Stored for two reasons: it makes attestation auditable
-- after the fact rather than a decision made once and thrown away, and it is
-- worth showing a reviewer ("found on: ...") in its own right.
alter table candidates add column source_title text;

-- Which model-typed fields could NOT be supported by the captured source text.
--
-- A list of column names rather than one boolean per field: the set of fields
-- worth attesting will grow (contact_email and location are both obvious
-- next candidates), and each one should not cost a migration. Same reasoning
-- as keeping status vocabularies in text rather than a Postgres enum.
--
-- Null means not evaluated -- every row written before this migration, and any
-- row whose source could not be captured at all. An empty array means
-- evaluated and everything held. Those are different facts and must not
-- collapse into one.
alter table candidates add column asserted_fields text[];

comment on column candidates.source_title is
  'Verbatim title the search returned for source_url. Ground truth for attestation.';
comment on column candidates.asserted_fields is
  'Model-typed fields unsupported by the captured source. Null = not evaluated; empty = evaluated and clean.';
