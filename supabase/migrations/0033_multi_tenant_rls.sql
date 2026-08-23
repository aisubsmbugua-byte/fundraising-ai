-- Multi-tenancy, stage 2: the actual isolation cutover. Apply after
-- 0032_multi_tenant_foundation.sql, and only once everyone who might
-- touch the app during the cutover window is prepared for it -- this
-- is what turns "using (true)" into real per-organization isolation
-- across every CRM table.
--
-- Every table below gets the same four-step treatment: add
-- organization_id defaulting to the inserting user's own org (so no
-- existing server action needs to start passing it explicitly --
-- Postgres fills it in the same way created_by/changed_by already
-- work), backfill existing rows onto the one bootstrap org, make it
-- required, then drop and recreate that table's policy scoped by it.
--
-- nonprofit_data_cache is deliberately excluded -- it's a global cache
-- of public ProPublica/IRS data keyed by EIN, not tenant data.

-- prospects
alter table prospects add column organization_id uuid references organizations (id) default my_organization_id();
update prospects set organization_id = (select id from organizations where name = 'Village Worship Initiative') where organization_id is null;
alter table prospects alter column organization_id set not null;
create index prospects_organization_id_idx on prospects (organization_id);
drop policy "team members manage all prospects" on prospects;
create policy "team members manage all prospects"
  on prospects for all
  to authenticated
  using (organization_id = my_organization_id())
  with check (organization_id = my_organization_id());

-- stage_changes (append-only: insert + select only, no update/delete)
alter table stage_changes add column organization_id uuid references organizations (id) default my_organization_id();
update stage_changes set organization_id = (select id from organizations where name = 'Village Worship Initiative') where organization_id is null;
alter table stage_changes alter column organization_id set not null;
create index stage_changes_organization_id_idx on stage_changes (organization_id);
drop policy "team members can log stage changes" on stage_changes;
drop policy "team members can read stage changes" on stage_changes;
create policy "team members can log stage changes"
  on stage_changes for insert
  to authenticated
  with check (changed_by = auth.uid() and organization_id = my_organization_id());
create policy "team members can read stage changes"
  on stage_changes for select
  to authenticated
  using (organization_id = my_organization_id());

-- screening_rules
alter table screening_rules add column organization_id uuid references organizations (id) default my_organization_id();
update screening_rules set organization_id = (select id from organizations where name = 'Village Worship Initiative') where organization_id is null;
alter table screening_rules alter column organization_id set not null;
create index screening_rules_organization_id_idx on screening_rules (organization_id);
drop policy "team members manage screening rules" on screening_rules;
create policy "team members manage screening rules"
  on screening_rules for all
  to authenticated
  using (organization_id = my_organization_id())
  with check (organization_id = my_organization_id());

-- screening_results (log/read only, no update/delete)
alter table screening_results add column organization_id uuid references organizations (id) default my_organization_id();
update screening_results set organization_id = (select id from organizations where name = 'Village Worship Initiative') where organization_id is null;
alter table screening_results alter column organization_id set not null;
create index screening_results_organization_id_idx on screening_results (organization_id);
drop policy "team members can log screening results" on screening_results;
drop policy "team members can read screening results" on screening_results;
create policy "team members can log screening results"
  on screening_results for insert
  to authenticated
  with check (screened_by = auth.uid() and organization_id = my_organization_id());
create policy "team members can read screening results"
  on screening_results for select
  to authenticated
  using (organization_id = my_organization_id());

-- org_profile (each org's own nonprofit content -- not to be confused
-- with the organizations/profiles tenancy tables from 0032)
alter table org_profile add column organization_id uuid references organizations (id) default my_organization_id();
update org_profile set organization_id = (select id from organizations where name = 'Village Worship Initiative') where organization_id is null;
alter table org_profile alter column organization_id set not null;
create index org_profile_organization_id_idx on org_profile (organization_id);
drop policy "team members manage org profile" on org_profile;
create policy "team members manage org profile"
  on org_profile for all
  to authenticated
  using (organization_id = my_organization_id())
  with check (organization_id = my_organization_id());

-- channel_match_runs
alter table channel_match_runs add column organization_id uuid references organizations (id) default my_organization_id();
update channel_match_runs set organization_id = (select id from organizations where name = 'Village Worship Initiative') where organization_id is null;
alter table channel_match_runs alter column organization_id set not null;
create index channel_match_runs_organization_id_idx on channel_match_runs (organization_id);
drop policy "team members can log channel match runs" on channel_match_runs;
drop policy "team members can read channel match runs" on channel_match_runs;
drop policy "team members can review channel match runs" on channel_match_runs;
create policy "team members can log channel match runs"
  on channel_match_runs for insert
  to authenticated
  with check (created_by = auth.uid() and organization_id = my_organization_id());
create policy "team members can read channel match runs"
  on channel_match_runs for select
  to authenticated
  using (organization_id = my_organization_id());
create policy "team members can review channel match runs"
  on channel_match_runs for update
  to authenticated
  using (organization_id = my_organization_id())
  with check (organization_id = my_organization_id());

-- candidates
alter table candidates add column organization_id uuid references organizations (id) default my_organization_id();
update candidates set organization_id = (select id from organizations where name = 'Village Worship Initiative') where organization_id is null;
alter table candidates alter column organization_id set not null;
create index candidates_organization_id_idx on candidates (organization_id);
drop policy "team members manage candidates" on candidates;
create policy "team members manage candidates"
  on candidates for all
  to authenticated
  using (organization_id = my_organization_id())
  with check (organization_id = my_organization_id());

-- deep_dive_runs
alter table deep_dive_runs add column organization_id uuid references organizations (id) default my_organization_id();
update deep_dive_runs set organization_id = (select id from organizations where name = 'Village Worship Initiative') where organization_id is null;
alter table deep_dive_runs alter column organization_id set not null;
create index deep_dive_runs_organization_id_idx on deep_dive_runs (organization_id);
drop policy "team members can log deep dive runs" on deep_dive_runs;
drop policy "team members can read deep dive runs" on deep_dive_runs;
drop policy "team members can update deep dive runs" on deep_dive_runs;
create policy "team members can log deep dive runs"
  on deep_dive_runs for insert
  to authenticated
  with check (created_by = auth.uid() and organization_id = my_organization_id());
create policy "team members can read deep dive runs"
  on deep_dive_runs for select
  to authenticated
  using (organization_id = my_organization_id());
create policy "team members can update deep dive runs"
  on deep_dive_runs for update
  to authenticated
  using (organization_id = my_organization_id())
  with check (organization_id = my_organization_id());

-- org_documents (the table -- storage.objects policies for the
-- org-documents bucket are handled separately in 0034, since object
-- paths need relocating first, see that migration's header)
alter table org_documents add column organization_id uuid references organizations (id) default my_organization_id();
update org_documents set organization_id = (select id from organizations where name = 'Village Worship Initiative') where organization_id is null;
alter table org_documents alter column organization_id set not null;
create index org_documents_organization_id_idx on org_documents (organization_id);
drop policy "team members manage org documents" on org_documents;
create policy "team members manage org documents"
  on org_documents for all
  to authenticated
  using (organization_id = my_organization_id())
  with check (organization_id = my_organization_id());

-- drafts
alter table drafts add column organization_id uuid references organizations (id) default my_organization_id();
update drafts set organization_id = (select id from organizations where name = 'Village Worship Initiative') where organization_id is null;
alter table drafts alter column organization_id set not null;
create index drafts_organization_id_idx on drafts (organization_id);
drop policy "team members manage drafts" on drafts;
create policy "team members manage drafts"
  on drafts for all
  to authenticated
  using (organization_id = my_organization_id())
  with check (organization_id = my_organization_id());

-- discovery_search_runs
alter table discovery_search_runs add column organization_id uuid references organizations (id) default my_organization_id();
update discovery_search_runs set organization_id = (select id from organizations where name = 'Village Worship Initiative') where organization_id is null;
alter table discovery_search_runs alter column organization_id set not null;
create index discovery_search_runs_organization_id_idx on discovery_search_runs (organization_id);
drop policy "team members can log discovery search runs" on discovery_search_runs;
drop policy "team members can read discovery search runs" on discovery_search_runs;
drop policy "team members can update discovery search runs" on discovery_search_runs;
create policy "team members can log discovery search runs"
  on discovery_search_runs for insert
  to authenticated
  with check (created_by = auth.uid() and organization_id = my_organization_id());
create policy "team members can read discovery search runs"
  on discovery_search_runs for select
  to authenticated
  using (organization_id = my_organization_id());
create policy "team members can update discovery search runs"
  on discovery_search_runs for update
  to authenticated
  using (organization_id = my_organization_id())
  with check (organization_id = my_organization_id());

-- auto_search_settings (was enforced as a global singleton via
-- .limit(1).maybeSingle() in app code -- becomes "one row per org" for
-- free once select is filtered by RLS, no app code change needed;
-- the cron route is the one exception -- it uses the service-role
-- admin client with no auth.uid(), so it needs its own per-org loop,
-- see app/api/cron/discovery-auto-search/route.ts)
alter table auto_search_settings add column organization_id uuid references organizations (id) default my_organization_id();
update auto_search_settings set organization_id = (select id from organizations where name = 'Village Worship Initiative') where organization_id is null;
alter table auto_search_settings alter column organization_id set not null;
create index auto_search_settings_organization_id_idx on auto_search_settings (organization_id);
drop policy "team members manage auto search settings" on auto_search_settings;
create policy "team members manage auto search settings"
  on auto_search_settings for all
  to authenticated
  using (organization_id = my_organization_id())
  with check (organization_id = my_organization_id());

-- contacts -- plus the cross-tenant collision fix: the same funder
-- contact's email can legitimately recur across two different
-- nonprofits' pipelines, so the uniqueness has to be scoped per org,
-- not global. contacts_email_key is Postgres's default name for the
-- inline "email text unique" constraint from 0023_contacts.sql.
alter table contacts add column organization_id uuid references organizations (id) default my_organization_id();
update contacts set organization_id = (select id from organizations where name = 'Village Worship Initiative') where organization_id is null;
alter table contacts alter column organization_id set not null;
create index contacts_organization_id_idx on contacts (organization_id);
alter table contacts drop constraint contacts_email_key;
alter table contacts add constraint contacts_org_email_key unique (organization_id, email);
drop policy "team members manage contacts" on contacts;
create policy "team members manage contacts"
  on contacts for all
  to authenticated
  using (organization_id = my_organization_id())
  with check (organization_id = my_organization_id());

-- evidence_items
alter table evidence_items add column organization_id uuid references organizations (id) default my_organization_id();
update evidence_items set organization_id = (select id from organizations where name = 'Village Worship Initiative') where organization_id is null;
alter table evidence_items alter column organization_id set not null;
create index evidence_items_organization_id_idx on evidence_items (organization_id);
drop policy "team members manage evidence items" on evidence_items;
create policy "team members manage evidence items"
  on evidence_items for all
  to authenticated
  using (organization_id = my_organization_id())
  with check (organization_id = my_organization_id());

-- interactions
alter table interactions add column organization_id uuid references organizations (id) default my_organization_id();
update interactions set organization_id = (select id from organizations where name = 'Village Worship Initiative') where organization_id is null;
alter table interactions alter column organization_id set not null;
create index interactions_organization_id_idx on interactions (organization_id);
drop policy "team members manage interactions" on interactions;
create policy "team members manage interactions"
  on interactions for all
  to authenticated
  using (organization_id = my_organization_id())
  with check (organization_id = my_organization_id());
