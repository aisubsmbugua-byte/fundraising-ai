-- Evidence-first redesign (Research Agent v10). Root cause of Stage 4's
-- weak results (v9: 4/33 consistent) and a confirmed entity-contamination
-- finding (a real, unrelated organization sitting unflagged in a source
-- list): the extraction step both decided what a source said AND wrote a
-- quote of it, with nothing forcing the two to correspond. This migration
-- adds the schema for capturing evidence deterministically, before
-- extraction ever runs, and classifying which entity each source actually
-- describes. See docs/decisions/0002-research-agent.md.

-- One row per distinct captured text FRAGMENT, not per source -- a source
-- cited three times plus its title yields four evidence records, each
-- independently referenceable. "Captured evidence," deliberately not
-- implying a full webpage: this is a fragment (a citation span or a
-- title), assembled entirely from the search API's own response, never
-- model-typed.
create table research_evidence (
  id uuid primary key default gen_random_uuid(),
  research_run_id uuid not null references research_runs (id) on delete cascade,
  source_id uuid not null references research_sources (id) on delete cascade,
  url text not null,
  kind text not null,                                     -- 'citation_fragment' | 'page_title' -- see lib/research.ts
  exact_text text not null,
  provider text not null default 'anthropic_web_search',  -- which pipeline captured this; kept separable per the Research Department's own governing principle (Claude-only for now, not architecturally locked to it)
  content_hash text not null,                              -- sha256(exact_text)
  retrieved_at timestamptz not null default now(),
  organization_id uuid references organizations (id) default my_organization_id(),
  created_at timestamptz not null default now()
);

alter table research_evidence enable row level security;

create policy "team members can log research evidence"
  on research_evidence for insert
  to authenticated
  with check (organization_id = my_organization_id());

create policy "team members can read research evidence"
  on research_evidence for select
  to authenticated
  using (organization_id = my_organization_id());

create trigger research_evidence_org_match
  before insert on research_evidence
  for each row execute function enforce_research_run_org_match();

-- Same reasoning as enforce_claim_source_run_match (0037): confirms
-- source_id actually belongs to research_run_id, one level down from the
-- org-match check above, so a session can't wire a real evidence row to
-- another organization's source by referencing its id directly.
create function enforce_evidence_source_run_match() returns trigger as $$
begin
  if new.research_run_id is distinct from (select research_run_id from research_sources where id = new.source_id) then
    raise exception 'source_id must belong to the same research_run_id';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger research_evidence_source_run_match
  before insert on research_evidence
  for each row execute function enforce_evidence_source_run_match();

create index research_evidence_run_idx on research_evidence (research_run_id);
create index research_evidence_source_idx on research_evidence (source_id);
create index research_evidence_organization_id_idx on research_evidence (organization_id);

-- Trust CLASSIFICATION per source, not a pass/fail filter -- most
-- legitimate corroborating sources never state an EIN, and a different
-- EIN doesn't automatically mean "wrong entity" (an affiliated sibling
-- foundation, a fiscal sponsor, a grantee are all real, differently-EIN'd,
-- relevant entities). Text, not an enum -- see
-- RESEARCH_ENTITY_VALIDATION_STATUSES in lib/research.ts. Null on all
-- pre-existing rows: "not evaluated by this stage," not "passed."
alter table research_sources add column entity_validation_status text;

-- The real link is to a specific evidence fragment, not just "a source" --
-- null on pre-existing rows (predates the evidence ledger).
alter table research_claim_sources add column evidence_id uuid references research_evidence (id);
