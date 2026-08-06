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
- [Decision log](file:///Users/kevinmalana/.traycer/epics/d2224b09-58de-43fc-b758-76653d2a5742/artifacts/decision-log/index.md)
- [Human-in-the-loop runbook](file:///Users/kevinmalana/.traycer/epics/d2224b09-58de-43fc-b758-76653d2a5742/artifacts/human-in-the-loop-runbook/index.md)

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

   `.env.local` is git-ignored. Required keys:

   | Variable | Where to find it |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase Dashboard → Project Settings → API → Project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase Dashboard → Project Settings → API → `anon` `public` key |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → Project Settings → API → `service_role` key — server-only, never expose to the browser |
   | `NEXT_PUBLIC_APP_URL` | Public URL of this app (default `http://localhost:3000` for dev) |
   | `FOUNDING_ADMIN_EMAIL` | Email of the platform operator's first admin. **Set this directly in `.env.local`; never type it into chat.** |
   | `FOUNDING_ORG_NAME` | Optional. Defaults to `Open NDIS`. |
   | `FOUNDING_ORG_SLUG` | Optional. Defaults to `opendis`. |

3. Apply the database migrations to your Sydney Supabase project. The
   two migrations in `supabase/migrations/` are idempotent-friendly:

   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```

   Or open `supabase/migrations/0001_init_organisations_and_profiles.sql`
   and `supabase/migrations/0002_auth_and_invitations.sql` in the
   Supabase Dashboard → SQL Editor and run each in order.

4. Run the dev server:

   ```bash
   pnpm dev
   ```

   The app is served at `http://localhost:3000`. The healthcheck at
   `/api/health` should return `{ "ok": true, "supabase": true }`.

## Bootstrapping

On a fresh database, before anyone can sign in, the platform operator's
first tenant must exist. `pnpm bootstrap` is a one-shot script that:

1. Creates the founding organisation (`Open NDIS` / slug `opendis`) if
   it does not already exist. Idempotent — refuses to overwrite if the
   slug exists with a different name.
2. Issues an admin invitation for `FOUNDING_ADMIN_EMAIL`, valid for 30
   days.
3. Prints the single-use invitation URL to **stdout**.

```bash
pnpm bootstrap
```

The URL goes only to the operator's terminal. It is never typed into
chat, committed to source, or stored in any artifact. The operator
opens the URL in a browser, requests a magic link, and lands in `/app`
as the first admin.

## Auth model

- **Invite-only.** No public sign-up. Every account is created through a
  single-use invitation link.
- **Magic-link only.** No password, no SSO. All roles use the same flow.
- **MFA deferred** (decision-log/2026-08-06: bounded until first
  paying customer or 90 days after pilot go-live).
- **Soft-delete** with 30-day recovery; hard-delete is a later worker.

The auth surface lives at:

- `/sign-in` — magic-link request form (anonymous)
- `/auth/callback` — Supabase code-exchange
- `/sign-out` — POST-only sign-out
- `/invite/[token]` — invitation landing page (valid / accepted / expired)
- `/invite/[token]/confirm` — POST handler that emails the magic link
- `/app` — protected shell (requires session + profile)

The Next.js 16 `proxy.ts` at the project root refreshes Supabase
session cookies on every non-static request. Authorisation decisions
live in each protected layout, not the proxy.

## Database

SQL migrations live in `supabase/migrations/`:

- `0001_init_organisations_and_profiles.sql` — `organisations`,
  `profiles`, minimal RLS, `current_user_organisation_id()` helper,
  no-op `handle_new_user` trigger placeholder.
- `0002_auth_and_invitations.sql` — `invitations`, `audit_log`,
  `current_user_role()`, `is_invitation_valid()`,
  `get_invitation_view()`, `soft_delete_organisation()`, and the real
  invitation-matching `handle_new_user` flow.

Apply with the Supabase CLI as above.

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
| `pnpm bootstrap` | One-shot: create founding tenant + first admin invitation (prints URL to stdout) |

## Quality gates (must pass)

- `pnpm lint` — clean
- `pnpm typecheck` — clean
- `pnpm build` — succeeds
- `pnpm install --frozen-lockfile` on a clean `node_modules` — succeeds
- `pnpm dev` → `GET /api/health` returns `{ ok: true, supabase: true }`

## Design system

- **Token layer**: `src/styles/tokens.css` is the single source of truth for colour, typography, spacing, radii, motion, and touch targets. Read by Tailwind v4 via `@theme` in `src/app/globals.css`.
- **Components**: [shadcn/ui](https://ui.shadcn.com) — `radix-vega` preset, configured with the CLI (`pnpm dlx shadcn@latest add …`). Source lives in `src/components/ui/`. The shadcn alias variables (`--background`, `--primary`, …) are mapped onto our tokens in `globals.css`, so re-targeting a token re-skins every component.
- **Icons**: `lucide-react`. Don't ship inline SVGs for first-class icons.
- **Font**: Inter via `next/font` (variable, weights 400–700). No runtime Google Fonts requests.
- **Dev reference**: `pnpm dev` → `http://localhost:3000/design-system` (dev-only — returns null in production). Shows every token visualised plus a sample of each installed shadcn component.

### Adding a new shadcn component

```bash
pnpm dlx shadcn@latest add <name>
```

The component lands in `src/components/ui/<name>.tsx` consuming our token alias layer automatically. Update the `/design-system` dev page if you want it represented in the reference sample set.

## Out of scope (later tickets)

- Admin dashboard UI (roster, participant CRUD, exports)
- Worker mobile experience (real `/worker/today`, shift detail, service notes, offline)
- Participant portal
- External coordinator view
- Per-organisation theming enforced at signup
- Hard-delete worker (the 30-day purge)
- MFA
- Vercel deployment debugging

## Security

- `.env*` files except `.env.example` are git-ignored.
- `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS and must never reach the
  browser. It is only imported in `src/lib/supabase/admin.ts`, which is
  marked `server-only`. The bootstrap script (`scripts/bootstrap-founding-tenant.ts`)
  also uses it and runs only on Kevin's terminal.
- The browser client uses `NEXT_PUBLIC_SUPABASE_ANON_KEY` and respects
  RLS.
- Magic-link emails contain a one-time code; the `handle_new_user`
  trigger matches the inbound `auth.users.email` against an unused
  invitation, creates the profile, marks the invitation accepted, and
  writes an `audit_log` entry — all in one transaction.
- The invitation URL printed by `pnpm bootstrap` goes to stdout only
  and is never persisted in chat, code, or any artifact.
- Validate Australian privacy, security, and NDIS compliance with
  qualified advice before importing real participant data.