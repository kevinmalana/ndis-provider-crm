---
title: "Vercel deployment runbook — NDIS Provider CRM"
kind: spec
---

## Scope

Single source of truth for Vercel-side setup of the NDIS Provider CRM. Anyone (human or agent) reading this should be able to wire up a new project, redeploy, add env vars, or diagnose a region/config mistake without tribal knowledge.

This artifact complements but does not duplicate:

- `ndis-provider-crm-brief/index.md` — product scope
- `ndis-provider-crm-technical-plan/index.md` — architecture and hosting/data-residency commitments
- `human-in-the-loop-runbook/index.md` — gates that involve deployment decisions
- `decision-log/index.md` — settled decisions (Sydney region, etc.)

## Project setup (first time)

1. **Vercel account** under `kevinmalana`. Hobby tier is sufficient until a customer pilot.
2. **Import** `kevinmalana/ndis-provider-crm` from GitHub. Vercel's GitHub integration must have private-repo scope; if the repo does not appear, re-authorize the integration with `All repositories` or the specific repo.
3. **Framework Preset:** Next.js (auto-detected). **Root Directory:** `ndis-provider-crm` (the project lives in a subdirectory of the repo). **Build/Output/Install commands:** leave at Next.js defaults.
4. **Region:** `syd1` (Sydney). Do **not** accept the default — US East has been the historical default and is wrong for NDIS participant data.
5. **Node version:** 22.x or current LTS. Match whatever `ndis-provider-crm/package.json` engines field declares.

## Environment variables

Set in **Project Settings → Environment Variables**, with values copied directly from `ndis-provider-crm/.env.local` (never from chat).

| Variable | Scope | Sensitive | Source |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Production, Preview, Development | No | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Production, Preview, Development | No | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Production, Preview, Development | **Yes** | Supabase → Project Settings → API |
| `NEXT_PUBLIC_APP_URL` | Production, Preview (auto), Development | No | Per-environment: prod = `https://<prod-domain>`, preview = Vercel-assigned URL, dev = `http://localhost:3000` |

Mark `SUPABASE_SERVICE_ROLE_KEY` as sensitive if Vercel offers the toggle. The `NEXT_PUBLIC_*` prefix is safe to ship to the browser — only `SUPABASE_SERVICE_ROLE_KEY` must remain server-side, and Vercel guarantees that for non-`NEXT_PUBLIC_` vars.

For Preview deploys, Vercel supplies the deployment URL automatically — set `NEXT_PUBLIC_APP_URL` per environment with a wildcard if the team needs stable callback URLs.

## Branch → deployment mapping

| Branch | Behaviour | Use |
| --- | --- | --- |
| `main` | Production domain (`https://ndis-provider-crm.vercel.app` or custom) | Always deployable, every push auto-deploys |
| `<feature>` branches | Preview URLs (`https://ndis-provider-crm-git-<branch>-<org>.vercel.app`) | PR previews, share with reviewers |
| Tags | No automatic use yet | Future: preview a tag, then promote |

Production deployments from `main` are automatic after initial setup. The release go/no-go gate occurs before merge: required CI and review evidence must be complete before approving a merge to `main`. To change branch behaviour, configure **Project Settings → Git → Production Branch** and **Ignoring Build Steps** as needed.

## First-deploy verification

Run, in this order:

1. **Build succeeds** — Vercel dashboard shows a green Build log; check there are no build warnings about deprecated APIs or missing env vars.
2. **`/api/health` is green from Vercel's network**:
     ```bash
      curl https://<your-project>.vercel.app/api/health
     ```
    Expected body: `{"ok":true,"supabase":true}`. If `supabase:false`, an env var is missing or the Supabase project isn't reachable from Vercel's Sydney region (Supabase project must be Sydney `ap-southeast-2` for `syd1` to talk to it without crossing regions).
3. **Landing renders** — open the root URL and confirm the placeholder content + link to `/api/health` shows up.
4. **No secrets in build output** — scan the build log for any token-like strings (starts with `eyJ`, `sbp_`, etc.). If any appear, treat it as an incident and rotate the relevant key.

## Common pitfalls

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `supabase:false` on health | Region mismatch (Supabase non-Sydney) **or** anon key wrong/rotated | Confirm project region; re-pull anon key from Supabase dashboard |
| Build error: "supabase env var undefined" | Env var not set on the relevant environment (Production/Preview/Development) | Add to all three environments |
| Preview deploy misbehaves while prod is fine | Preview env vars not configured | Mirror env vars into Preview scope |
| `NEXT_PUBLIC_APP_URL` mismatch | Forgot to update after first deploy | Update per environment |
| Build warns about Next.js version | Next.js major bump | Read `node_modules/next/dist/docs/` per `AGENTS.md` rule and update code; do not blindly upgrade |
| 404 on `/api/health` after a move | Route handler moved or renamed | Verify `src/app/api/health/route.ts` exists and exports `GET` |

## Rollback

Vercel keeps the previous successful deployment live until a new one replaces it. Two safe options:

1. **Instant rollback to previous deployment**: Deployments tab → previous deployment row → **⋯** → **Promote to Production**. Safe and reversible.
2. **Roll back via git**: revert the offending commit on `main`, push, wait for redeploy. Slower but produces an audit trail.

For an RLS / auth / database-affecting bug, also consider whether **downstream Supabase state** (e.g. a bad migration) needs rolling back — those don't auto-revert with a Vercel rollback.

## Production due-diligence reminder

The Sydney compute region is **necessary but not sufficient** for Australian data-residency compliance. Before onboarding real NDIS providers:

- Confirm Vercel's Data Processing Addendum covers Australian privacy obligations and Subprocessor list, per `ndis-provider-crm-technical-plan/index.md`.
- Confirm Supabase's region + backup region (Sydney, cross-region replication off) matches customer expectations.
- Confirm `decision-log/index.md` records who provided this legal/compliance advice and when.

These checks sit in `human-in-the-loop-runbook/index.md` as gates.
