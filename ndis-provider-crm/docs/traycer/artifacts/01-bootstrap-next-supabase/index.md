---
title: "Bootstrap Next.js + Supabase scaffold for NDIS Provider CRM"
kind: ticket
status: 2
---

## Supersession note — 2026-08-06

This ticket remains complete as a historical record of the verified bootstrap. Its one-profile/one-organisation schema and `current_user_organisation_id()` helper are superseded by the revised multi-provider identity model. Draft ticket 04 adds a forward migration to global profiles plus separate organisation memberships/roles while preserving existing auth identities and audit history. No Result claim below has been rewritten.

## Progress

- **Region confirmed:** Sydney (`ap-southeast-2`) — data-residency constraint satisfied.
- **Repo:** `git init -b main` at `/Users/kevinmalana/Documents/traycer`. Project scaffolded into `ndis-provider-crm/` subdirectory.
- **Scaffold:** Next.js 16.3.0 (App Router, TypeScript, ESLint, src dir, `@/*` alias), React 19.2.8. No Tailwind (deferred per ticket).
- **Dependencies added:** `@supabase/supabase-js@2.112`, `@supabase/ssr@0.12.4`, `server-only@0.0.1` (runtime); `supabase@2.111.0` (dev).
- **Env:** `.env.local` populated (Supabase URL, anon key, service-role key — all gitignored). `.env.example` committed with empty values. `.gitignore` whitelists `.env.example`.
- **Supabase clients:** `src/lib/supabase/{server,client,admin,env}.ts`. Server uses `cookies()` + `getAll`/`setAll`. Admin is `server-only`. All clients share a single `getSupabaseEnv()` that throws fast on missing values.
- **Migration:** `supabase/migrations/0001_init_organisations_and_profiles.sql` written — `organisations` + `profiles` with RLS, `current_user_organisation_id()` helper, `set_updated_at` triggers, and a no-op `handle_new_user` placeholder trigger.
- **Healthcheck:** `src/app/api/health/route.ts` queries `organisations` with `.limit(1)`; returns `{ ok, supabase: bool }`.
- **Landing:** `src/app/page.tsx` shows app name, link to `/api/health`, and links to the brief + technical plan artifacts.
- **Scripts added:** `lint` (eslint), `typecheck` (`tsc --noEmit`), `db:types` (`supabase gen types typescript --linked`).
- **README:** setup, env vars, scripts, db migration + type-gen workflow, security notes.
- **Quality gates run so far (without DB applied):** `pnpm lint`, `pnpm typecheck`, `pnpm build` all clean.
- **Outstanding:** migration not yet applied to the Sydney project. Waiting on Kevin to paste it into the Supabase SQL Editor. After that: re-run `pnpm dev`, hit `/api/health`, commit, report to PM.

## Result

- **Region confirmed:** Sydney (`ap-southeast-2`).
- **Commit:** `8b24959300f4b2168c6f2b6138ab9de6ea3d3f37`.
- **Migration applied** by Kevin via the Supabase SQL Editor.
- **`GET /api/health` output:** `{"ok":true,"supabase":true}`.
- **Quality gates:** `pnpm lint`, `pnpm typecheck`, `pnpm build` all clean.
- **Deviations:** None. Ticket executed as written; next.js/AGENTS.md and CLAUDE.md were kept in the scaffold and committed (Next.js auto-regenerates them).
- **Security:** anon + service_role keys live in `.env.local` only; `.env.example` is committed empty; no secrets in repo or in this artifact.

## Context

We are building a multi-provider SaaS CRM for small-to-medium Australian NDIS providers. The agreed stack is **Next.js (App Router) + TypeScript on Vercel, with Supabase (Auth, Postgres, RLS, Storage, Realtime) hosted in Sydney**. This ticket sets up the project skeleton, environment wiring, and the first organisation-scoped DB migration that every later ticket depends on.

Read these artifacts first:

- `/Users/kevinmalana/.traycer/epics/d2224b09-58de-43fc-b758-76653d2a5742/artifacts/ndis-provider-crm-brief/index.md`
- `/Users/kevinmalana/.traycer/epics/d2224b09-58de-43fc-b758-76653d2a5742/artifacts/ndis-provider-crm-technical-plan/index.md`

**Do not** paste any real API keys, secrets, or project URLs into chat, code, or commit history. Use `.env.local` and `.env.example` only.

## Tasks

1. **Repo**
  - Create a local project folder (Kevin will provide the GitHub repo URL after this ticket is done; init a local git repo for now).
  - `git init`, set default branch `main`, add a sensible `.gitignore` (Node, Next.js, env files, OS junk).
2. **Next.js scaffold**
  - `pnpm create next-app@latest ndis-provider-crm --typescript --eslint --app --src-dir --import-alias "@/*" --no-tailwind` (Tailwind comes later as a deliberate choice, not here).
  - Pin Next.js to the current LTS-stable major; commit `pnpm-lock.yaml`.
  - Add `package.json` scripts: `dev`, `build`, `start`, `lint`, `typecheck`, `db:types` (see step 5).
3. **Env wiring**
  - Create `.env.local` with these **placeholder** values (Kevin fills real ones from his Supabase project):
  - Create `.env.example` mirroring the above with empty values; commit `.env.example`.
  - Ensure `.env*.local` is in `.gitignore`.
4. **Supabase clients**
  - `pnpm add @supabase/supabase-js @supabase/ssr`
  - Create `src/lib/supabase/server.ts` (cookies-based server client, used in RSC + route handlers).
  - Create `src/lib/supabase/client.ts` (browser client).
  - Create `src/lib/supabase/admin.ts` (service-role client, server-only, never imported into client components).
5. **Types regen**
  - `pnpm add -D supabase`
  - Add script `"db:types": "supabase gen types typescript --linked > src/lib/supabase/types.gen.ts"` (run after Supabase login; document in README).
6. **First SQL migration**
  - Create `supabase/` folder and `supabase/migrations/0001_init_organisations_and_profiles.sql`.
  - Define:
    - `organisations(id uuid pk, name text, slug text unique, created_at timestamptz default now(), updated_at timestamptz default now())`
    - `profiles(id uuid pk references auth.users(id), organisation_id uuid not null references organisations(id), full_name text, role text check (role in ('admin','scheduler','worker','participant','external','nominee')), created_at timestamptz default now(), updated_at timestamptz default now())`
  - Enable RLS on both tables.
  - Add policies:
    - `profiles_select_own_org`: a profile can read other profiles in the same `organisation_id`.
    - `profiles_update_own`: a profile updates only their own row.
    - `organisations_select_member`: a profile can read its own organisation.
    - Helper SQL function `public.current_user_organisation_id()` that returns the caller's `organisation_id` from `profiles`.
  - Add a trigger so a new `auth.users` insert auto-creates a `profiles` row only when an explicit invite is accepted (placeholder for now; full invite flow is a later ticket).
7. **Healthcheck route**
  - `src/app/api/health/route.ts` returns `{ ok: true, supabase: bool }` — calls `supabase.from('organisations').select('id').limit(1)` and reports whether the DB is reachable. Uses server client.
8. **Root layout + minimal landing**
  - `src/app/layout.tsx` with Supabase session listener bootstrap placeholder (no UI yet).
  - `src/app/page.tsx` shows app name, a link to `/api/health`, and a note linking to the Traycer brief + tech plan artifacts.
9. **README.md**
  - One-page setup: prerequisites, env vars, `pnpm dev`, Supabase login + `pnpm db:types`, deploy notes for Vercel, plus links to the two Traycer artifacts.
10. **Quality gates (must pass before reporting done)**
  - `pnpm lint` clean
  - `pnpm typecheck` clean
  - `pnpm build` succeeds
  - `pnpm dev` → `/api/health` returns `{ ok: true, supabase: true }` against the user's Sydney Supabase project (Kevin provides keys; agent runs locally with `.env.local`).

## Acceptance criteria

- Local project exists, runs with `pnpm dev`, and the healthcheck confirms Supabase connectivity.
- Migration applied to the user's Sydney Supabase project; `organisations` and `profiles` tables exist with RLS enabled.
- No real secrets in the repo; `.env.example` is the only env file committed.
- README, scripts, and types regen pipeline are usable by a second agent or Kevin with no tribal knowledge.
- Report back: commit hash, list of files created, the exact output of `/api/health`, and any deviations from the ticket.

## Out of scope (later tickets)

- Full invite-only auth flow + MFA enforcement
- Full RLS policy suite beyond the organisation scope
- Tailwind / UI library decision
- Vercel deployment (do not push or connect a Vercel project in this ticket)
- Anything NDIS-domain (participants, roster, service notes)
