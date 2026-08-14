# Slice 0 — Live skeleton

## Goal
Stand up a deployed Next.js app on Vercel, wired to Supabase auth, with a protected dashboard shell.

## Why now
Everything else is built against a live app. Get the deploy pipeline and auth working before any features exist, so every later slice ships live within a minute.

## Scope
- Next.js App Router project (TypeScript).
- Supabase client set up for both server and browser.
- Email/password (or magic link) auth via Supabase.
- Protected `(dashboard)` route group with a left-nav shell: Pipeline · Prospects · Settings (links can be dead for now).
- A public `/login` page.
- Health-check route `GET /api/health` returning `{ ok: true }`.
- Deployed to Vercel with all env vars set.

## Out of scope
- Any real data models. No prospects yet.
- Any AI. No Anthropic calls yet.

## Data
- No app tables. Rely on Supabase's built-in `auth.users`.

## UI
- `/login` — auth form.
- `/(dashboard)` — shell with nav; redirects to `/login` if unauthenticated.

## Guardrails
- Service role key and Anthropic key are **server-only**. Confirm they are not imported in any client component.
- Middleware protects the dashboard group.

## Definition of done
- [ ] `npm run dev` runs; `/login` works; authed users reach the dashboard shell.
- [ ] Repo is on GitHub and deploys on Vercel on push to `main`.
- [ ] `/api/health` returns `{ ok: true }` on the live URL.
- [ ] Unauthed access to the dashboard redirects to `/login`.
