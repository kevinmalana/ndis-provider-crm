# Traycer migration source manifest

This manifest records the read-only Traycer source state captured on 14 August
2026 (Australia/Sydney) before the Buzz snapshot commit was created.

## Provenance

| Item | Value |
| --- | --- |
| Traycer Task | `d2224b09-58de-43fc-b758-76653d2a5742` |
| Source checkout | `/Users/kevinmalana/Documents/traycer` |
| Source branch | `main` |
| Base commit | `763e8a7de2d6b9f727ab478509c98cf3c0ed1ead` |
| GitHub `main` | `763e8a7de2d6b9f727ab478509c98cf3c0ed1ead`, verified with `git ls-remote` on 14 August 2026 |
| Source-origin tracked-diff SHA-256 | `c748419583da4d02b15d38a1106312943dabd850f27d35f566791e9d979b357b` |
| Untracked implementation aggregate SHA-256 | `153fb292fc50b39cca7be4ad82405639aea312043702ec7a31c099822e63d40e` |

The source-origin tracked hash excludes the Buzz-only README rewrite. The
untracked aggregate was calculated from the same sorted path list in source and
destination and matched in both places.

## Modified tracked files (10)

- `ndis-provider-crm/src/app/app/admin/page.tsx`
- `ndis-provider-crm/src/app/app/admin/workspace-client.tsx`
- `ndis-provider-crm/src/app/app/layout.tsx`
- `ndis-provider-crm/src/lib/supabase/commands.ts`
- `ndis-provider-crm/src/lib/supabase/types.domain.ts`
- `ndis-provider-crm/tests/admin-workspace-state.test.ts`
- `ndis-provider-crm/tests/db/fixtures.ts`
- `ndis-provider-crm/tests/db/harness.ts`
- `ndis-provider-crm/tests/db/migrations-list.ts`
- `ndis-provider-crm/tests/db/postgrest-contract.test.ts`

## Untracked implementation files (10)

- `ndis-provider-crm/src/app/worker/[shiftId]/page.tsx`
- `ndis-provider-crm/src/app/worker/layout.tsx`
- `ndis-provider-crm/src/app/worker/page.tsx`
- `ndis-provider-crm/src/app/worker/shift-detail-client.tsx`
- `ndis-provider-crm/src/lib/handoff-routes.ts`
- `ndis-provider-crm/src/lib/worker.ts`
- `ndis-provider-crm/supabase/migrations/20260813000002_worker_urgent_handoff_and_worker_flow.sql`
- `ndis-provider-crm/supabase/migrations/20260813000003_ticket06_first_pass_review_fixup.sql`
- `ndis-provider-crm/tests/db/worker-handoff-and-worker-flow.test.ts`
- `ndis-provider-crm/tests/worker-flow-mounted.test.tsx`

## Traycer artifacts

All 51 artifact `index.md` files were copied with their hierarchy and
frontmatter intact. Forty-eight files are byte-identical to the source. Three
directory-only index files had redundant final blank lines normalized during
repository whitespace review; their frontmatter and semantic content are
unchanged.

## Deliberate exclusions

- `.env` and local secret values;
- dependency caches and build output;
- `.git` internals from the source checkout;
- local Supabase link/cache state;
- operating-system metadata;
- raw Traycer transcripts, pending the retention decision recorded in
  [SESSION_INVENTORY.md](SESSION_INVENTORY.md).
