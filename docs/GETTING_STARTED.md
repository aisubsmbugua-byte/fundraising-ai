# Getting started

This project is designed to run **live on Vercel from day one**. You deploy the skeleton first (Slice 0), then build each slice against the live app.

## Prerequisites

- Node.js 20+
- A [Supabase](https://supabase.com) project (free tier is fine)
- A [Vercel](https://vercel.com) account
- An [Anthropic API key](https://console.anthropic.com)
- A [Resend](https://resend.com) API key (needed at Slice 8)

## 1. Install

```bash
npm install
```

## 2. Environment variables

Copy `.env.example` to `.env.local` and fill in:

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
RESEND_API_KEY=          # Slice 8+
```

Never commit `.env.local`. The service role key and Anthropic key are server-only — never expose them to the client.

## 3. Database

Migrations live in `supabase/migrations/`. Apply them with the Supabase CLI:

```bash
npx supabase link --project-ref <your-ref>
npx supabase db push
```

Each slice adds its own migration. Apply them as you build.

## 4. Run locally

```bash
npm run dev
```

## 5. Deploy live to Vercel

**Do this at Slice 0 and keep it live.**

1. Push this repo to GitHub.
2. Import the repo in Vercel.
3. Add all env vars from `.env.example` in Vercel → Project → Settings → Environment Variables (mark server-only keys as such).
4. Deploy. Every push to `main` redeploys automatically.

From here on, each merged slice is live within a minute. Treat the Vercel URL as the working app you demo and dogfood as you go.

## Working with Claude Code

Open this repo in Claude Code and point it at `docs/slices/`. Build one slice at a time, in order. Each slice doc has an explicit **Definition of done** and **Guardrails** section. Do not let the agent skip the guardrails — the no-auto-send / no-auto-advance rules are load-bearing.
