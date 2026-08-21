-- Expand the pipeline stage model per the finalized nav/stage design
-- (Contact, Discovery, Proposal, Decision, Awarding, Stewardship).
-- Postgres enums can't drop values without recreating the type, and
-- migrations here are additive-only -- screening/qualification/
-- cultivation/ask stay defined on the type but unused going forward.
-- Verified before writing this: 0 prospects currently occupy any of
-- those four, so nothing needs backfilling.
alter type stage add value 'contact' before 'discovery';
alter type stage add value 'proposal' after 'discovery';
alter type stage add value 'awarding' after 'decision';

-- Needed for an accurate "recently reviewed" activity feed on the new
-- Dashboard -- created_at only reflects when a candidate was found,
-- not when it was accepted/dismissed.
alter table candidates add column updated_at timestamptz not null default now();
