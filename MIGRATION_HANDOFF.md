# NDIS Provider CRM — Traycer to Buzz handoff

This repository is the non-destructive Buzz continuation of the NDIS Provider
CRM project previously coordinated in Traycer. The source Traycer checkout has
not been modified by the migration.

## Migration snapshot

| Item | Value |
| --- | --- |
| Snapshot date | 14 August 2026 (Australia/Sydney) |
| Traycer Task | `d2224b09-58de-43fc-b758-76653d2a5742` |
| Read-only source checkout | `/Users/kevinmalana/Documents/traycer` |
| Original Git remote | `https://github.com/kevinmalana/ndis-provider-crm.git` |
| Source branch and commit | `main` at `763e8a7de2d6b9f727ab478509c98cf3c0ed1ead` |
| Buzz migration branch | `buzz/migration-20260814` |
| Application directory | `ndis-provider-crm/` |
| Imported Traycer artifacts | 51 Markdown files under `ndis-provider-crm/docs/traycer/artifacts/` |

The source and Buzz copies have the same base commit. Excluding the Buzz-only
README rewrite that replaces machine-local Traycer links, their source-origin
tracked working-tree diffs have the same SHA-256,
`c748419583da4d02b15d38a1106312943dabd850f27d35f566791e9d979b357b`.
The 10 source-side untracked code, migration, and test files were also verified
byte-for-byte in the Buzz copy before this handoff was added.

Secret environment files, `.git` implementation data, dependency caches,
Next.js/TypeScript build output, operating-system metadata, and local Supabase
link/cache metadata were deliberately not copied. No real participant data is
part of this migration.

## Product boundary

The project is a multi-tenant, mobile-first service-delivery CRM for Australian
NDIS providers. The current release target is a synthetic-data MVP. It is not
approved for real participant data or a production pilot.

The settled first-release boundary includes invite-only organisations,
role-aware access, provider and worker readiness, the online worker shift and
service-summary journey, bounded offline recovery, participant/representative
and consent-backed external portals, accessibility verification, and a full
synthetic pilot rehearsal. Billing, claims, budgets, public signup, native apps,
chat, GPS/live tracking, media service notes, and full incident management are
out of scope.

Start with these imported sources:

- [Current product state and roadmap](ndis-provider-crm/docs/traycer/artifacts/changeset-walkthroughs/current-product-state-and-roadmap/index.md)
- [Business and product overview](ndis-provider-crm/docs/traycer/artifacts/business-product-overview/index.md)
- [Epic brief](ndis-provider-crm/docs/traycer/artifacts/ndis-provider-crm-brief/index.md)
- [Technical plan](ndis-provider-crm/docs/traycer/artifacts/ndis-provider-crm-technical-plan/index.md)
- [Decision log](ndis-provider-crm/docs/traycer/artifacts/decision-log/index.md)
- [Human-in-the-loop runbook](ndis-provider-crm/docs/traycer/artifacts/human-in-the-loop-runbook/index.md)

## Current implementation state

Commit `763e8a7` is the published baseline and is in sync with the original
GitHub `main` branch. The preserved working tree contains the Ticket 06 online
worker flow and its urgent-contact handoff prerequisite:

- 10 modified tracked files;
- 10 untracked application, SQL migration, and test files;
- migrations `20260813000002_worker_urgent_handoff_and_worker_flow.sql` and
  `20260813000003_ticket06_first_pass_review_fixup.sql`;
- `/worker` list, shift detail, delivery-action, summary, urgent-help, admin
  route-configuration, and supporting server/domain changes;
- database and mounted UI coverage for the new flow.

The Buzz migration additionally changes `ndis-provider-crm/README.md` so its
project-document links resolve inside this repository instead of pointing to
Kevin's machine-local Traycer artifact directory.

The [Ticket 06 first-pass code review](ndis-provider-crm/docs/traycer/artifacts/ticket-06-first-pass-code-review/index.md)
records six initial findings, one remediation finding, and their closure. Its
remaining explicit residual is manual browser/device inspection. The ticket
metadata itself is still open and should not be marked complete until the Buzz
copy passes the full validation below and the intended manual evidence is
recorded.

The approved release dependency is Ticket 06 → Ticket 08 (participant and
representative portal) → Ticket 09 (external consent-backed view). Ticket 07
(bounded offline outbox and device safety) follows Ticket 06 and may run in
parallel with Ticket 08 once its high-risk device, encryption, session,
recovery, and conflict behaviours meet Ready. Ticket 10 remains the pilot,
accessibility, privacy, security, and production-readiness evidence gate.

## Local setup

Run commands from `ndis-provider-crm/`:

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Create `.env.local` from `.env.example` only when runtime or remote Supabase
checks are required. The expected variable names are:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_SYNTHETIC_SEED`
- `SUPABASE_PROJECT_ENV`
- `NEXT_PUBLIC_APP_URL`
- `FOUNDING_ORG_NAME`
- `FOUNDING_ORG_SLUG`
- `FOUNDING_ADMIN_EMAIL`

Never place their secret values in Buzz messages, repository documents, or Git.

## Validation gates

The migration is ready to publish only after these pass against the same Git
state:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm db:parse
pnpm db:test
pnpm build
git diff --check
```

Browser accessibility runners and the synthetic remote Supabase journey require
their documented local services, browser, and guarded development credentials.
They remain separately recorded gates rather than being inferred from static or
in-memory tests.

### Validation result — 14 August 2026

All checks below were run from the Buzz copy at base commit `763e8a7`, with the
preserved Ticket 06 working tree and imported documentation present:

- dependency installation with the pinned `pnpm` 11.20.0: passed;
- lint: passed;
- TypeScript typecheck: passed;
- all 14 SQL migration files parsed: passed;
- database and mounted UI suite: 18 files and 198 tests passed;
- `git diff --check`: passed;
- Next.js 16.3.0 production build using its supported webpack builder: passed,
  including static generation and route collection.

The default Turbopack build could not be completed inside the managed migration
runner. Its first attempt was denied external access to Google Fonts; after
external access was permitted, Turbopack's PostCSS worker failed when the runner
denied a local port bind. This is an execution-environment limitation, not a
reported application test failure. The default `pnpm build` gate therefore
remains to be repeated in the target developer or CI environment; the successful
webpack production build is recorded as equivalent build evidence, not as a
claim that the default Turbopack command passed.

## Traycer conversation scope

Traycer reported 25 readable project agent sessions during inventory. Raw
conversations were not copied automatically: they contain conversational churn
and may include machine-specific context, while the authored artifacts, Git
history, review record, and this handoff carry the project state required to
continue safely. The [session inventory](ndis-provider-crm/docs/traycer/SESSION_INVENTORY.md)
records all 25 sessions and the rule for any later selective archive. The
[source manifest](ndis-provider-crm/docs/traycer/MIGRATION_SOURCE_MANIFEST.md)
and [privacy/secrets review](ndis-provider-crm/docs/traycer/PRIVACY_AND_SECRETS_REVIEW.md)
record the remaining publication controls.
