---
title: "Design-system foundation — tokens, Tailwind v4, shadcn/ui"
kind: ticket
status: 2
---

## Supersession note — 2026-08-06

This ticket remains complete for the work it delivered, but its verification record does not establish WCAG conformance. Independent review found semantic contrast failures, incomplete reference-page/token/component coverage, an addressable blank production route, and no axe/Pa11y test rail. Draft ticket 04a corrects these gaps and raises the worker-control standard from 44 to 48 CSS pixels. No historical Result claim below has been rewritten.

## Context

We are building a multi-provider SaaS CRM for small-to-medium Australian NDIS providers. The UI/UX foundation has been settled in three artifacts (`ui-ux-research`, `ui-personas-and-stories`, `reference-flow-shift-and-service-note`) and a decision log entry. The bootstrap ticket installed the project with `--no-tailwind` deliberately so that a token layer could anchor the design system before Tailwind is added. This ticket realises that layer and installs the agreed UI primitives.

Read these artifacts first:

- `/Users/kevinmalana/.traycer/epics/d2224b09-58de-43fc-b758-76653d2a5742/artifacts/ndis-provider-crm-brief/index.md`
- `/Users/kevinmalana/.traycer/epics/d2224b09-58de-43fc-b758-76653d2a5742/artifacts/ndis-provider-crm-technical-plan/index.md`
- `/Users/kevinmalana/.traycer/epics/d2224b09-58de-43fc-b758-76653d2a5742/artifacts/ui-ux-research/index.md`
- `/Users/kevinmalana/.traycer/epics/d2224b09-58de-43fc-b758-76653d2a5742/artifacts/decision-log/index.md`

**Security reminder:** no secrets in code, chat, or artifacts. `.env.local` only.

## Result

- **Commits:** `f92aeb0` (scaffold: tokens, Tailwind v4, shadcn init + first batch, layout rewire) and `d75ef73` (dev-only `/design-system` page + README documentation section). Both pushed to `main`.
- **Routes built:** `/` (static), `/_not-found`, `/api/health` (dynamic), `/design-system` (static; returns `null` in production via `NODE_ENV` gate).
- **Quality gates:** `pnpm lint` clean, `pnpm typecheck` clean, `pnpm build` succeeds.
- **Self-review check:** `pnpm install --frozen-lockfile` on a clean `node_modules` succeeds and the rebuilt route list matches.
- **Deps all recorded in `package.json`** — verified via `git diff origin/main -- package.json`; no deps were installed without being recorded (lesson carried over from bootstrap commit `01c431d`).
- **Security posture:** `.env.example` only is committed; no secrets in any artifact, commit, or chat reply.
- **Multi-tenant hook:** `[data-org="…"]` selector pattern documented in `src/styles/tokens.css` and demonstrated on the dev page. Real per-organisation overrides land in a later ticket.

## Tasks

1. **Token layer** — create `src/styles/tokens.css` defining semantic CSS custom properties:
  - Colour: `--color-bg`, `--color-fg`, `--color-muted`, `--color-muted-fg`, `--color-border`, `--color-primary`, `--color-primary-fg`, `--color-accent`, `--color-accent-fg`, `--color-success`, `--color-warning`, `--color-danger`, `--color-info`.
  - Typography: `--font-sans`, `--font-mono`, scale `--text-xs` through `--text-3xl`, line-height tokens, weight tokens.
  - Spacing on a 4 px grid: `--space-1` … `--space-12`.
  - Radii: `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-full`.
  - Motion: `--duration-fast` (120 ms), `--duration-base` (200 ms), `--duration-slow` (320 ms), `--easing-standard`.
  - Touch: `--touch-min: 44px` (above WCAG 24 px minimum, matches worker-app requirement).
  - Multi-tenant hook: leave a single comment block showing how `[data-org="<slug>"]` will override `--color-primary` later; do not implement per-org overrides yet — that's a later ticket.
2. **Tailwind v4** — install via the project-recommended path (`pnpm add -D tailwindcss@latest @tailwindcss/postcss postcss`). Wire it through `postcss.config.mjs` and have `globals.css` `@import` the tokens file before the Tailwind layers. Do not introduce a `tailwind.config.*` file unless Tailwind v4 actually requires it; v4 prefers CSS-first config.
3. **shadcn/ui** — initialise with the CLI (`pnpm dlx shadcn@latest init`). Use the **New York** style, **Neutral** base colour, CSS variables = yes. The generated config must consume the token layer in `src/styles/tokens.css` rather than introducing a parallel set of variables. If shadcn's `cn()` helper and component aliases land in `src/lib/utils.ts` and `components/ui/`, keep those paths.
4. **First shadcn component batch** — add via `pnpm dlx shadcn@latest add` only: `button`, `input`, `label`, `card`, `dialog`, `dropdown-menu`, `sheet`, `sonner`. Defer table, form, combobox, calendar — those land with their consuming tickets.
5. **Font + icons**:
  - Add `next/font` for **Inter** (variable weight 400–700) in `src/app/layout.tsx`, removing any default Google Fonts.
  - Install **lucide-react**; ensure icons import from `lucide-react` only (no inline SVGs for first-class icons).
6. **Toast host** — render `<Toaster />` from `sonner` once in the root layout, with `richColors` and `position="top-right"` defaults.
7. **Dev reference page** — create `src/app/design-system/page.tsx` that:
  - Lists every token from `src/styles/tokens.css` in a swatch / sample row (read via `getComputedStyle`, no hard-coded copy).
  - Renders a representative sample of each shadcn component from step 4.
  - Sets `data-org="demo"` on the page root to demonstrate the tenant-override hook compiles.
  - This page is internal-only; gate it behind a `NODE_ENV !== "production"` check so it doesn't ship to real customers.
8. **Theming baseline** — wire a minimal light theme in `globals.css`. Dark mode is a later ticket; do not implement it here, but name variables so a `:root.dark` block can be added without renaming.
9. **README** — add a "Design system" section: one paragraph on tokens, one on shadcn usage, and the `/design-system` dev-only route.
10. **Quality gates** (must pass before reporting done):
  - `pnpm lint` clean
  - `pnpm typecheck` clean
  - `pnpm build` succeeds; route list shows `/`, `/_not-found`, `/api/health`, and `/design-system` (the dev gate means it's compiled out for production, that's fine)
  - `pnpm dev` → `curl http://localhost:3000/api/health` returns `{"ok":true,"supabase":true}` — healthcheck must not regress
  - `pnpm dev` → `/design-system` renders with visible tokens and components
11. **Commit hygiene** — commit logically: first the tokens + Tailwind + shadcn scaffold (one commit), then the dev page (second commit). Each commit message references this ticket. Do **not** squash into one commit (reviewers need to see the layer construction).
12. **Push + report** — push to `origin/main`. Report back to the PM: commit hashes, list of files added, exact `/api/health` output, and any deviations or discoveries. **Do not** paste secrets. Do not echo `service_role` anywhere.

## Acceptance criteria

- Tokens render correctly in `/design-system` (visual confirmation + `getComputedStyle` reading).
- shadcn components installed via the official CLI; no hand-rolled shadcn-style components shadowing the CLI's output.
- Multi-tenant override hook documented in `tokens.css` even if not yet used by an org.
- `/api/health` still green locally after the changes.
- No new top-level files outside `src/styles`, `src/components/ui`, `src/lib`, and `src/app/design-system` unless the ticket is updated.
- Lint, typecheck, build, dev all green.
- Two commits pushed, both clean.

## Out of scope (later tickets)

- Auth flows, RLS expansion, invite-only enforcement.
- TanStack Table v8, RHF + Zod form patterns, date-fns / date-fns-tz integration.
- Serwist + Dexie / offline / PWA.
- Dark theme.
- Application UI (admin dashboard, worker app, participant portal, external coordinator view).
- Per-organisation theme enforcement at signup.
- Vercel deployment debugging.

## Self-review checklist (PM-direct execution note)

Given the bootstrap ticket missed recording `@supabase/ssr` and `@supabase/supabase-js` in `package.json` (fixed at commit `01c431d`), execute these checks before reporting done:

- `git diff origin/main -- package.json pnpm-lock.yaml` — confirm every new dep is recorded in `package.json`, **not only** present in `pnpm-lock.yaml`.
- `pnpm install --frozen-lockfile` on a clean checkout (delete `node_modules`, re-install) — must succeed without errors.
- `pnpm build` after the clean checkout — must produce the route list above.
