-- Discovery search + ProPublica integration.
-- Apply after 0018_add_church_channel.sql.
--
-- Every org looked up via ProPublica gets cached here, keyed by EIN.
-- This is the seed of "our own database" -- built organically from
-- real usage rather than a big upfront bulk-ingestion project.
-- Repeat lookups hit this cache first, getting faster over time.

create table nonprofit_data_cache (
  ein bigint primary key,
  name text not null,
  city text,
  state text,
  ntee_code text,
  raw jsonb not null,
  fetched_at timestamptz not null default now()
);

alter table nonprofit_data_cache enable row level security;

create policy "team members manage nonprofit data cache"
  on nonprofit_data_cache for all
  to authenticated
  using (true)
  with check (true);

create index nonprofit_data_cache_name_idx on nonprofit_data_cache (name);
