# NDIS Provider CRM

Multi-tenant SaaS CRM for small-to-medium Australian NDIS providers.
Roster support workers, capture mobile service records, and share
appropriate information with participants, nominees, and authorised
external parties.

## Stack

- **Next.js 16** (App Router) + **TypeScript** — Vercel-hosted
- **Supabase** (Postgres, Auth, RLS, Storage, Realtime, Edge Functions) —
  Sydney region (`ap-southeast-2`)
- **pnpm** package manager

See the project artifacts for full context:

- [Epic brief](file:///Users/kevinmalana/.traycer/epics/d2224b09-58de-43fc-b758-76653d2a5742/artifacts/ndis-provider-crm-brief/index.md)
- [Technical plan](file:///Users/kevinmalana/.traycer/epics/d2224b09-58de-43fc-b758-76653d2a5742/artifacts/ndis-provider-crm-technical-plan/index.md)

## Prerequisites

- Node.js 20+ and pnpm 11+
- A Supabase project created in the **Sydney** region
- (Optional) Supabase CLI for migrations and type generation:
  `brew install supabase/tap/supabase`

## Setup

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Copy the example env file and fill in your Supabase project values:

   ```bash
   cp .env.example .env.local
   ```

   `.env.local` is git-ignored. The four keys:

   | Variable | Where to find it |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase Dashboard → Project Settings → API → Project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase Dashboard → Project Settings → API → `anon` `public` key |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → Project Settings → API → `service_role` key — server-only, never expose to the browser |
   | `NEXT_PUBLIC_APP_URL` | Public URL of this app (default `http://localhost:3000` for dev) |

3. Run the dev server:

   ```bash
   pnpm dev
   ```

   The app is served at `http://localhost:3000`. The healthcheck at
   `/api/health` should return `{ "ok": true, "supabase": true }`.

## Database

SQL migrations live in `supabase/migrations/` and are applied with the
Supabase CLI:

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
```

The first migration (`0001_init_organisations_and_profiles.sql`) creates
the `organisations` and `profiles` tables with RLS enabled and the
minimum policies needed for organisation isolation.

## Type generation

After schema changes, regenerate the typed Supabase client:

```bash
pnpm db:types
```

This writes `src/lib/supabase/types.gen.ts`, which the server, browser,
and admin clients consume for fully typed queries.

## Scripts

| Script | Purpose |
| --- | --- |
| `pnpm dev` | Next.js dev server |
| `pnpm build` | Production build |
| `pnpm start` | Run the production build |
| `pnpm lint` | ESLint (`eslint-config-next`) |
| `pnpm typecheck` | TypeScript check (no emit) |
| `pnpm db:types` | Regenerate `src/lib/supabase/types.gen.ts` from the linked Supabase project |

## Quality gates (must pass)

- `pnpm lint` — clean
- `pnpm typecheck` — clean
- `pnpm build` — succeeds
- `pnpm dev` → `GET /api/health` returns `{ ok: true, supabase: true }`

## Out of scope (this ticket)

- Full invite-only auth + MFA enforcement
- Full RLS policy suite beyond organisation scope
- Tailwind / UI library decision
- Vercel deployment
- NDIS-domain features (participants, rosters, service notes)

## Security

- `.env*` files except `.env.example` are git-ignored.
- `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS and must never reach the
  browser. It is only imported in `src/lib/supabase/admin.ts`, which is
  marked `server-only`.
- The browser client uses `NEXT_PUBLIC_SUPABASE_ANON_KEY` and respects
  RLS.
- Validate Australian privacy, security, and NDIS compliance with
  qualified advice before importing real participant data.