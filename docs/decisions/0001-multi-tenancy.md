# 0001 — Multi-tenancy retrofit

**Date:** 2026-08-22/23
**Status:** Implemented (migrations 0032–0034 applied). One item still open — see "Not yet done" below.

## Why this exists

This doc is a copy of the reasoning that originally lived only in a Claude Code
plan-mode file (`.claude/plans/`), which is not part of this repo and is not
durable — it gets overwritten the next time any session enters plan mode. If
you're reading this because you're about to touch `organizations`, `profiles`,
RLS policies, or the invite flow, read this whole file first.

## The problem

The app was single-tenant: no `profiles` table, no `organization_id` on any
table, and every one of 15 CRM tables had an RLS policy of `using (true)` — any
signed-in user saw every row in the database. Beta testing required a second
real nonprofit to use the app without seeing the first tenant's (Village
Worship Initiative's) prospects, evidence, drafts, etc. Separately, Supabase's
default mailer (used for magic-link login) is rate-limited and not meant for
production, which was already breaking login for more than a couple of users.

## Decisions made, and why

- **Shared instance, not one deployment per org.** Considered fully isolating
  each org (separate Supabase project + Vercel deployment) — rejected because
  it doesn't scale past a handful of orgs and each instance needs maintenance
  forever. Instead: one Supabase project, an `organizations` table, a
  `profiles` table linking each user to their org, and a `SECURITY DEFINER`
  helper function (`my_organization_id()`) that every RLS policy calls instead
  of `true`. Adapted from the same pattern used on a prior project (Timiza).
- **Uniform per-org access, no admin/member roles.** Every invited member of
  an org gets full access to that org's CRM — matches the app's existing
  behavior and avoids building permission scaffolding nobody asked for. The
  only separate privilege is a narrow `is_superadmin` flag that gates
  *creating organizations* and a read-only housekeeping list, and grants
  **zero** visibility into any org's actual CRM content. That boundary is
  structural, not a convention: `organizations` has RLS enabled with **zero**
  policies for `authenticated` — no role, including superadmin, can read or
  write it directly. Only the service-role admin client touches it, and only
  from `app/admin/organizations/actions.ts` and
  `app/(dashboard)/settings/team/actions.ts`, both of which re-verify the
  caller's own permissions server-side before ever reaching for that client.
- **Minimal admin tool, not public signup.** A superadmin-only page
  (`/admin/organizations`) creates an org and invites its first user. That
  user can then invite teammates into their own org from
  `/settings/team`. `/login`'s `signInWithOtp` now passes
  `shouldCreateUser: false` — self-serve signup is closed. **This is
  load-bearing for a second decision below, not just a UX choice — see the
  self-healing invite section.**
- **Invite org membership travels in `app_metadata`, never `user_metadata`.**
  `inviteUserByEmail`'s own `data` option writes to `user_metadata`, which a
  signed-in user can overwrite themselves via `supabase.auth.updateUser()`.
  `app_metadata` is not client-writable. Both invite actions call
  `inviteUserByEmail` and then a separate `updateUserById(id, { app_metadata:
  { organization_id } })` — two calls, not one. The `profiles` insert policy
  (in `app/auth/callback/route.ts`, first-login path) checks the new row's
  `organization_id` against `auth.jwt() -> 'app_metadata' ->> 'organization_id'`,
  so a client can't self-assign into an arbitrary org even if they tried.
- **`nonprofit_data_cache` is deliberately excluded from org-scoping.** It's a
  global cache of public IRS/ProPublica filing data keyed by EIN, not tenant
  data. It still has its original `using (true) with check (true))` policy —
  **known accepted gap, not yet hardened:** this means any authenticated user
  in any org can currently write to it, and a bad write could poison cached
  data another org's screening trusts as real. Nobody has done this; it just
  hasn't been closed off yet.
- **Email provider: Postmark, not Resend.** The `resend` npm package was
  already installed and unused; the product owner already has a paid Postmark
  plan and wanted tooling/cost consolidated there. Postmark is now Supabase
  Auth's custom SMTP provider (fixes the magic-link rate limit) and is the
  intended provider for the still-unbuilt Slice 8 app-level send too. The
  `resend` dependency has **not** been removed from `package.json` yet — it's
  dead weight, not a live risk, but worth cleaning up.
- **Cross-table FK integrity is an accepted gap, not closed.** Seven columns
  reference other org-scoped tables with no same-org check constraint:
  `stage_changes.prospect_id`, `screening_results.prospect_id`,
  `deep_dive_runs.prospect_id`, `drafts.prospect_id`, `drafts.deep_dive_run_id`,
  `contacts.source_prospect_id`, `contacts.source_candidate_id`,
  `evidence_items.source_document_id`. Each gets its own row's
  `organization_id` from the inserting user's own org via
  `DEFAULT my_organization_id()` — there's no DB-level check that a referenced
  ID actually belongs to that same org. In practice this requires an attacker
  to already know another org's row UUID (RLS blocks ever discovering one
  through the UI, and blocks reading the referenced row even via a join), so
  it's a low-probability targeted vector, not a passive leak — but it's real
  and unclosed.

## The RLS pattern, mechanically

Every org-scoped table follows this shape (see `0033_multi_tenant_rls.sql`):

```sql
alter table <table> add column organization_id uuid references organizations (id)
  default my_organization_id();
-- backfill existing rows onto the bootstrap org, then:
alter table <table> alter column organization_id set not null;
-- drop the old using(true) policy, recreate scoped by organization_id = my_organization_id()
```

Because `organization_id` defaults to `my_organization_id()`, **no existing
server action needed to start passing it explicitly** for anything using the
normal session client — Postgres fills it in the same way `created_by`
already does. The **one exception**: `app/api/cron/discovery-auto-search/route.ts`
uses the service-role admin client (no `auth.uid()`, so the default can't
resolve) — it now loops per-organization and threads `organizationId`
explicitly into `runAutoDiscoverySearchForChannel` and
`countStrategiesReadyForReview`.

**If you add a new org-scoped table, it needs this exact treatment —
`organization_id` column with this default, the policy rewrite, an index.**
Nothing in the codebase enforces this automatically. There is no test that
catches a new table shipping without it.

## What changed from the original plan during actual rollout

The plan above was written before implementation; these are things discovered
while executing it that the plan didn't anticipate — real bugs, not
hypotheticals:

- **Postgres error bodies get stripped on HEAD requests.** The original
  `deleteOrganization` safety check used `.select("id", { count: "exact", head:
  true })` to check whether an org had any data — a HEAD request has no HTTP
  response body by spec, and PostgREST's JSON error body was getting lost
  somewhere in that chain, leaving an empty, undiagnosable error object.
  Fixed by switching to a plain `.select("id").limit(1)`, which always returns
  a real body whether it errors or not. Worth remembering for any future code
  that checks table state via a HEAD/count-only query.
- **Server Actions redact thrown errors in production.** Next.js replaces a
  thrown `Error`'s message with a generic "Server Components render" string
  on the client in production builds — meaning any server action using
  `throw new Error(...)` for expected-failure cases (bad input, a real
  Postmark failure, etc.) shows the user nothing useful, and worse, a plain
  `<form action={serverAction}>` with no client-side handler turns that thrown
  error into a full page crash. Every action added or touched during this
  work (`createOrgAndInviteFirstUser`, `inviteTeammate`, `deleteOrganization`)
  now returns `{ error: string } | { success: true }` instead of throwing,
  paired with a client component that submits via `startTransition` and
  displays the returned error. **This is a pattern worth applying to any new
  action with a form that has real failure modes a user should see.**
- **A failed invite still creates the underlying `auth.users` row.** Before
  Postmark was correctly configured, invite attempts partially succeeded:
  Supabase creates the auth account, then delivery fails. `inviteUserByEmail`
  then permanently refuses to re-invite that same email as "already
  registered" — even though the person never completed onboarding, since no
  `profiles` row exists. `lib/invite.ts`'s `sendOrgInvite` now detects this
  specific case (email has an auth account but no `profiles` row anywhere)
  and self-heals: deletes the stale account and retries automatically. This
  is only safe because self-serve signup is closed (`shouldCreateUser:
  false`) — the only way a profile-less account can exist in this app is
  exactly this stale-invite case. **If self-serve signup is ever reopened,
  this logic needs to be revisited first** — otherwise it becomes an
  account-takeover vector: register with someone else's email, get
  auto-deleted as "stale," get re-invited into an attacker-controlled org.
- **`createOrgAndInviteFirstUser` now rolls back the org row on invite
  failure.** Early testing left three orphaned, memberless organizations
  behind (visible as "Test", "Test", "Tunde Medical" with 0 members) because
  the org insert succeeded but the invite crashed the page before any cleanup
  could run. Fixed at the root (return-value pattern above) and the action
  now explicitly deletes the org row it just created if the invite step
  fails.
- **Time-of-day/timestamp displays computed server-side read Vercel's UTC
  clock, not the visitor's.** Unrelated to RLS, but discovered and fixed in
  the same window: the Home page's "Good morning/afternoon/evening" greeting
  and its "As of"/"Last updated" timestamps were computed in Server
  Components, so they reflected the server's default UTC timezone rather than
  wherever the person actually is. Both moved into small Client Components
  (`components/Greeting.tsx`, `components/LocalTime.tsx`) that compute from
  `new Date()` after mount, reading the browser's own clock.

## Not yet done

- **`DISABLE_AUTH` in Vercel's production environment.** `middleware.ts`
  mints a real session for one hardcoded account (`kanjii@kijijiagency.com`)
  via the admin API whenever no session exists on a dashboard route and this
  env var is `"true"`. It was deliberately left on through the entire
  rollout so testing didn't depend on real email delivery for every check.
  **Turning it off was always meant to be the final step and has not been
  confirmed done.** Check Vercel's current value before treating this as
  resolved — if it's still `true`, production currently has a working,
  single-account auth bypass.
- `nonprofit_data_cache`'s write-poisoning gap (above) — not closed.
- The 7-column cross-table FK integrity gap (above) — not closed.
- `resend` dependency in `package.json` — not removed.
- `lib/scoring/engine.ts` — a pre-this-work dead scaffold (Slice 3's
  `screen()` throws `"Not implemented"`, imported by nothing; the real
  implementation is `lib/screening.ts`) — unrelated to multi-tenancy but
  found during the audit that produced this doc, noted here since nothing
  else tracks it.
- No automated test exists for tenant isolation. Every verification pass
  this work went through (regression on the existing tenant, cross-org
  isolation in both directions, storage path scoping, cron route per-org
  behavior) was done by hand in a browser. None of it is repeatable by
  someone else or re-run automatically the next time an org-scoped table
  changes.

## Critical files

- `supabase/migrations/0032_multi_tenant_foundation.sql`,
  `0033_multi_tenant_rls.sql`, `0034_storage_multi_tenant.sql`
- `app/auth/callback/route.ts`, `middleware.ts`, `app/login/page.tsx`
- `lib/invite.ts` (shared invite logic), `lib/supabase/admin.ts`
  (service-role client — every legitimate caller is listed in that file's
  own header comment)
- `app/admin/organizations/` (superadmin tool), `app/(dashboard)/settings/team/`
  (member-facing teammate invite)
- `app/(dashboard)/organization/documents/actions.ts` (storage path
  prefixing), `scripts/migrate-storage-paths.mjs` (one-time relocation,
  already run against production — safe to re-run, it skips already-prefixed
  paths)
- `app/api/cron/discovery-auto-search/route.ts`,
  `app/(dashboard)/discovery/search/actions.ts`, `lib/deep-dive.ts` (the
  per-org cron rewrite)
- `lib/contacts.ts` (the `organization_id, email` unique-constraint fix)
