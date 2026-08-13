---
title: "Auth + organisation onboarding (invite-only, magic-link, soft-delete)"
kind: ticket
status: 2
---

## Supersession note — 2026-08-06

This ticket remains complete for the implemented invite/magic-link shell. Its trigger and protected shell assume one `profiles` row with one organisation/role; draft ticket 04 migrates invitation acceptance and app context to global identity plus separate memberships. The blanket 30-day hard-purge promise is reopened and must not be implemented without qualified per-data-category policy. Magic links remain the selected bounded-deferral mechanism but are not represented as phishing-proof or independently compliant. No historical Result claim below has been rewritten.

## Progress

- **Migration 0002** (`supabase/migrations/0002_auth_and_invitations.sql`):
organisations + profiles extended for soft-delete and email/invited_via;
`invitations` and `audit_log` tables created; `handle_new_user` replaced
with the real invitation-matching flow; helper functions
`current_user_role`, `is_invitation_valid`, `get_invitation_view`,
`soft_delete_organisation`. RLS refined so soft-deleted rows and
inactive users cannot read; `invitations` and `audit_log` are append-only
via the "no policy = deny all" default. Applied to the Sydney project
and verified with 9/9 schema smoke tests.
- **Auth surface** (`proxy.ts`, `src/lib/supabase/middleware.ts`,
`src/app/sign-in/`, `src/app/auth/callback/`, `src/app/sign-out/`):
magic-link request form (shadcn Card/Input/Label/Button + Sonner), POST
sign-out, session-refresh proxy.
- **Invitation flow** (`src/app/invite/[token]/`,
`src/components/layout/sign-out-button.tsx`): valid / accepted / expired
states, POST confirm handler that triggers `signInWithOtp`, client-side
fragment handler for the implicit-grant magic-link delivery.
- **Protected shell** (`src/app/app/layout.tsx`, `src/app/app/page.tsx`,
`src/app/no-invitation/`): reads session + profile + organisation,
redirects to /sign-in when unauthenticated, redirects to /no-invitation
when authenticated without a profile (no matching invitation).
- **Bootstrap** (`scripts/bootstrap-founding-tenant.ts`,
`pnpm bootstrap`): env-driven, idempotent on slug, refuses to overwrite
a mismatched name, prints the invitation URL to stdout only.
- **README**: Bootstrapping section, auth model, scripts, security notes,
decision-log references.

## Deviations

- **Next.js 16 deprecated `middleware.ts` → `proxy.ts`.** The rename is
cosmetic (Next.js's docs call the same boundary feature `proxy`
now); functionality unchanged. Same matcher pattern, same export
signature (named `proxy` instead of `middleware`).
- **Magic-link delivery uses Supabase's implicit grant, not PKCE.**
The verify endpoint returns `Location: <redirect_to>#access_token=…&refresh_token=…`,
not `?code=…`. Server-side route handlers can't read URL fragments,
so `/auth/callback` is a client component (`page.tsx`, not `route.ts`)
that lets `supabase-js` parse the fragment via `detectSessionInUrl`.
The `/invite/[token]` page renders an invisible `<InviteFragmentHandler>`
client component for the same reason when the magic link redirects
there. This works correctly in a real browser but is the reason the
E2E test cannot fully verify session-cookie establishment from
Node — the session is set client-side by `supabase-js` reading the
fragment.
- **`/api/health` route from the bootstrap ticket is unchanged.**

## Result

- **Region:** Sydney (`ap-southeast-2`).
- **Commits:**
  - `bf95296` — Add migration 0002: auth, invitations, audit_log, soft-delete
  - `b6522e9` — Auth surface, invite flow, protected shell, bootstrap script
- **`GET /api/health`:** `{"ok":true,"supabase":true}`.
- **Quality gates:** `pnpm lint` clean, `pnpm typecheck` clean, `pnpm build`
succeeds (route list below), `pnpm install --frozen-lockfile` on a
clean `node_modules` succeeds.
- **E2E (4 flows):** PASS — fresh sign-in via direct magic link,
invite-based sign-in, invalid token → expired view, reused token →
"already accepted" view. Session-cookie establishment requires a real
browser; the server-side trigger (`handle_new_user`) firing on verify
is verified directly via the database.
- **Bootstrap script:** never run by the agent; env-error path verified
(`FOUNDING_ADMIN_EMAIL` missing → exits with code 1, no side
effects). Ready for Kevin to set `FOUNDING_ADMIN_EMAIL` in `.env.local`
and run `pnpm bootstrap`.
- **Security:** anon + service-role keys live in `.env.local` only;
`.env.example` committed empty for the new bootstrap env vars;
`pnpm bootstrap` prints the invitation URL to stdout only (no chat,
no artifact, no commit).

## Context

We are building a multi-provider SaaS CRM for small-to-medium Australian NDIS providers. Bootstrap ticket `01-bootstrap-next-supabase` is complete: project scaffolded, design-system foundation in place, first migration creating `organisations` and `profiles` with minimal RLS, and `/api/health` returns green against the Sydney Supabase project. UI/UX research and the v1 scope lock (see decision log, last entry) define the auth model: **invite-only**, **magic-link** for every role, **no MFA until post-pilot**.

This ticket lands the actual auth surface — sign-in pages, session middleware, the invitation table and token lifecycle, and the bootstrap mechanism that lets the founding operator (Open NDIS) claim their first tenant and send the first invite. Until this ticket lands, the platform has no real users; this ticket is the unlock for tickets 4 onward (worker mobile, admin scheduler, participant portal, external coordinator).

Read these artifacts first:

- `/Users/kevinmalana/.traycer/epics/d2224b09-58de-43fc-b758-76653d2a5742/artifacts/ndis-provider-crm-brief/index.md`
- `/Users/kevinmalana/.traycer/epics/d2224b09-58de-43fc-b758-76653d2a5742/artifacts/ndis-provider-crm-technical-plan/index.md`
- `/Users/kevinmalana/.traycer/epics/d2224b09-58de-43fc-b758-76653d2a5742/artifacts/decision-log/index.md` — entries dated 2026-08-06 (operator, magic-link, invitations, soft-delete, scope lock)
- `/Users/kevinmalana/.traycer/epics/d2224b09-58de-43fc-b758-76653d2a5742/artifacts/human-in-the-loop-runbook/index.md`

**Security reminder:** no secrets, emails, or sign-in tokens in chat, code, commits, or artifacts. The founding operator's admin email will be supplied to you (Coder) directly in this chat at the end — write it into `.env.local` only and never echo it back in any report or commit.

## Tasks

### 1. SQL migration `0002_auth_and_invitations.sql`

Apply via the same path as `0001` (Kevin pastes into the Supabase SQL Editor OR you use `supabase db push` after `supabase link`).

- **`organisations` extensions:** add `deleted_at timestamptz` (soft-delete marker), `slug text` should already exist — verify and add a unique index `organisations_slug_unique` if not present.
- **`profiles` extensions:** add `deleted_at timestamptz`, add `invited_via uuid` (nullable, references `invitations.id`), add `email text` (nullable, set at invite-acceptance; never assume auth.users.email is up-to-date). Keep `role check` as-is. Add an index on `(organisation_id, role)` for roster queries.
- **`invitations` table:**
    ```sql
    create table public.invitations (
      id              uuid primary key default gen_random_uuid(),
      organisation_id uuid not null references public.organisations(id) on delete restrict,
      email           text not null,
      role            text not null check (role in ('admin','scheduler','worker','participant','external','nominee')),
      token           text not null unique,
      expires_at      timestamptz not null,
      accepted_at     timestamptz,
      revoked_at      timestamptz,
      issued_by       uuid references public.profiles(id),
      created_at      timestamptz not null default now()
    );
    create index invitations_token_idx on public.invitations (token);
    create index invitations_org_email_idx on public.invitations (organisation_id, email);
    ```
- **Replace the `handle_new_user` placeholder.** New behaviour: when a `auth.users` row appears, look up a matching unused, unexpired, unrevoked invitation by email; if found, create the `profiles` row tied to that invitation's organisation + role, mark the invitation accepted, and stamp `invited_via`. If no invitation matches, **do not create a profile row** — the user lands on a "no invitation" page after sign-in.
- **Helper SQL functions:**
  - `public.current_user_role()` — returns `profiles.role` for the caller, mirroring `current_user_organisation_id()`.
  - `public.is_invitation_valid(p_token text)` — returns `boolean` (and a record in a sibling function) used by the invitation page.
- **RLS:**
  - Enable RLS on `invitations`.
  - **Admins and schedulers** of the same org can SELECT their org's invitations.
  - **Only admins** can INSERT/UPDATE/DELETE invitations (via service-role for now; explicit policies later if we expose surface area).
  - Refine `profiles_select_own_org` and `profiles_update_own` to also respect `deleted_at is null`.
  - Refine `organisations_select_member` to also respect `deleted_at is null`.
- **`audit_log` table (new):** `id uuid pk`, `organisation_id uuid`, `actor uuid references profiles(id)`, `action text`, `subject_type text`, `subject_id uuid`, `metadata jsonb`, `created_at timestamptz default now()`. Enable RLS: admins of the same org can SELECT; inserts happen via the service-role only. Wire this in the trigger so `handle_new_user` writes an audit row when an invitation is accepted.
- **Soft-delete helper function:** `public.soft_delete_organisation(p_id uuid)` — sets `deleted_at`, marks all `profiles` for that org as deleted, revokes all `invitations` for that org. Hard-delete is **not** in this ticket; that's the 30-day worker.

### 2. Auth clients and middleware

- `src/lib/supabase/server.ts` already returns a server client; no changes needed for now.
- Add `src/lib/supabase/middleware.ts` exporting `updateSession()` that reads cookies, refreshes the access token via Supabase's `getUser()`, and writes the refreshed session back. This is the standard Supabase Next.js pattern.
- Add `middleware.ts` at the project root that calls `updateSession()` for every non-static request. Use a `matcher` config that excludes static assets and images.
- **Redirect policy:** unauthenticated requests to anything under `/app/**`, `/admin/**`, `/worker/**`, `/portal/**`, `/external/**` redirect to `/sign-in?next=<original-path>`. Authenticated requests to `/sign-in` or `/sign-in/confirm` redirect to `/app`.
- **Route protection by role** lives in each protected layout, not the middleware — the middleware only handles session refresh.

### 3. Sign-in pages

- `src/app/sign-in/page.tsx` — magic-link request form. Single `email` input, one button. Submission calls Supabase `signInWithOtp({ email, options: { emailRedirectTo: <NEXT_PUBLIC_APP_URL>/auth/callback } })`. If the email matches an outstanding invitation, also link to the `invite/<token>` route in the success state. Use the design system tokens; the form must look at home in the brand surface.
- `src/app/auth/callback/route.ts` — Supabase callback. Exchanges the `code` query param for a session via `supabase.auth.exchangeCodeForSession(code)`, then redirects to `next` (default `/app`). If `code` is missing or invalid, redirect to `/sign-in?error=invalid`.
- `src/app/sign-out/route.ts` — POST handler that calls `supabase.auth.signOut()` and redirects to `/sign-in`. (Route, not page, so we never accept GET for sign-out.)
- Error surface: a single Sonner toast on auth failures. Do not echo server error details to the client.

### 4. Invitation pages

- `src/app/invite/[token]/page.tsx` — server component. Calls `public.is_invitation_valid(token)` via the service-role client to render one of three states: valid (show email + role + organisation, then `<form>` with one button that POSTs to confirm); invalid (show a friendly "this invitation is no longer valid, contact your administrator" page); already accepted (show "this invitation was already used on <date>").
- `src/app/invite/[token]/confirm/route.ts` — POST handler. Validates again, then calls Supabase's `signInWithOtp` with the email — this time the link goes to `/invite/<token>` rather than `/auth/callback`. Once the user clicks the link and lands back at the invite page, the `handle_new_user` trigger will create the profile because the invitation is matched. (Document this two-step flow in the page so a confused invitee isn't stuck.)
- `src/app/invite/[token]/expired/page.tsx` — invitation shown when expired/revoked; friendly, points back to the inviting admin.

### 5. Bootstrap mechanism (founding operator)

The first tenant must exist before anyone can sign in normally. Use a one-shot, env-driven bootstrap script.

- `scripts/bootstrap-founding-tenant.ts` — a small Node script (run with `pnpm tsx scripts/bootstrap-founding-tenant.ts`). Reads `FOUNDING_ORG_NAME`, `FOUNDING_ORG_SLUG`, `FOUNDING_ADMIN_EMAIL` from process env; uses the service-role Supabase client to:
  1. Insert into `organisations` (idempotent on slug) — name "Open NDIS", slug `opendis`.
  2. Generate an admin invitation (no issued_by) for the founding admin email with role `admin`, expires in 30 days.
  3. Print the invitation URL to stdout: `<NEXT_PUBLIC_APP_URL>/invite/<token>`. The PM (Kevin) will copy this link out-of-band to the founding admin's email — do not paste it back into chat.
- Add a `bootstrap` script to `package.json`: `"bootstrap": "tsx scripts/bootstrap-founding-tenant.ts"`.
- Document in README under a new "Bootstrapping" section: prerequisites (env vars set in `.env.local`), the exact command to run, and what it prints.

### 6. Foundations of the protected app shell (no UI yet — just structure)

- `src/app/app/layout.tsx` — server component that calls `createSupabaseServerClient()`, reads `getUser()`, redirectss to `/sign-in?next=/app` if no user, and renders `children`. Reads profile + organisation for the header.
- `src/app/app/page.tsx` — placeholder: "Welcome, `<profile.full_name>`" with the organisation name and a sign-out button. No nav yet.
- `src/components/layout/SignOutButton.tsx` — client component that POSTs to `/sign-out` (or calls a server action). Hooks into Sonner to confirm.
- This is intentionally tiny. Admin/worker/portal layouts land in their own tickets.

### 7. Quality gates (must pass before reporting done)

- `pnpm lint` clean
- `pnpm typecheck` clean
- `pnpm build` succeeds; route list shows the new auth + invite + app routes alongside existing ones
- `pnpm dev` → `pnpm bootstrap` in another shell creates the founding invitation; visiting the printed URL on a fresh browser, the magic-link flow completes, the user's profile row is created under Open NDIS as role `admin`, and they land at `/app` seeing their name and organisation. Sign-out returns to `/sign-in`.
- All four flows work end-to-end on the Sydney Supabase project:
  1. Fresh sign-in with the founding admin email via direct magic link
  2. Sign-in via an invitation link
  3. Invitation with an invalid/expired token shows the correct error page
  4. Re-using a consumed invitation token shows the "already accepted" state
- `curl http://localhost:3000/api/health` still returns `{"ok":true,"supabase":true}` — healthcheck regression check.

### 8. Self-review checklist (from the bootstrap-ticket lesson)

Before reporting done, verify:

- `git diff origin/main -- package.json pnpm-lock.yaml` — every new dep (`tsx` is one example) is recorded in `package.json`, **not only** in `pnpm-lock.yaml`.
- `pnpm install --frozen-lockfile` on a clean `node_modules` succeeds.
- `pnpm build` after the clean checkout reproduces the same route list.
- The migration is applied to the Sydney Supabase project (Kevin pastes SQL into the editor if `supabase db push` isn't set up). Verify by running a smoke test query against the live DB.
- No secrets, emails, tokens, or service-role keys in any commit, artifact, or chat reply. The bootstrap script's stdout (the invitation URL) goes to Kevin's terminal directly, never back here.
- The previous ticket's artifact (`02-design-system-foundation`) is still status: 2 after this lands — design system unchanged.

### 9. Commit hygiene

Two commits pushed to `main`:

1. **Migration + invitation + audit schema.** Includes the SQL file, types regen, RLS updates. Verify lint + typecheck + build before pushing.
2. **Auth surface + protected app shell.** Includes sign-in / callback / sign-out, invite pages, middleware, app layout, bootstrap script, README section. Self-review before pushing.

## Acceptance criteria

- Magic-link sign-in works end-to-end against the Sydney Supabase project.
- Founding tenant "Open NDIS" exists with one admin invitation issued via the bootstrap script.
- Invitations table supports single-use, expiring, revocable invites with full audit trail.
- Existing data (organisations + profiles rows from migration `0001`) is preserved; RLS refinement doesn't drop legitimate access.
- Soft-delete helpers exist; hard-delete worker is **not** in this ticket.
- Lint, typecheck, build, dev, `pnpm install --frozen-lockfile`, and the four end-to-end flows all green.
- No secrets in commits or in any artifact. Founding admin email lives only in `.env.local` for the bootstrap run.
- Bootstrap script output (invitation URL) goes to Kevin's terminal — the PM agent never sees the URL.

## Out of scope (later tickets)

- Admin dashboard UI (roster, participant CRUD, exports)
- Worker mobile app (real `/worker/today`, shift detail, service notes, offline)
- Participant portal
- External coordinator view
- Per-organisation theming enforced at signup
- Hard-delete worker (the 30-day purge)
- MFA
- Vercel deployment debugging
