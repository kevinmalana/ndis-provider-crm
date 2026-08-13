---
title: "Ticket 05 admin workspace pre-merge review"
kind: review
---

## Final superseding review — `0590a00`

| Result | Recommendation |
| --- | --- |
| **All reproducible database/security and UI/integration blockers from the review and repeat-review cycles are closed.** | **MERGE.** Both independent reviewers approved current HEAD `0590a00`. |

Final verification:

- Database/security reviewer: MERGE — actor-private invite recovery, basis-blind single consent lineage, mixed-history upgrade, receipt-helper ACLs, supplementary roles, representative liveness and the final self-link projection passed direct adversarial checks.
- UI/integration reviewer: MERGE — exact dynamic-payload retry, warning acknowledgement rotation, invitation fallback, per-form pending state, participant-scoped authorisers, representative consent/grant, labels, errors and privacy-safe recipient display passed mounted checks.
- Full local suite: 12 files / 143 tests pass; lint, typecheck, production build, migrations `0001`–`0008c`, diff check and clean worktree pass.
- Remote Supabase/PostgREST was not run. Manual browser/assistive-technology testing at keyboard, screen reader, 320 CSS px and 200% zoom remains an unrun release gate.
- No Docker, remote data, secrets, merge or push occurred during implementation or review.

The original pre-merge findings below are retained as historical traceability and are superseded by this final approval.

## Review result

| Reviewed | Result | Recommendation |
| --- | --- | --- |
| Ticket 05 commit `1b66d6e` against the settled admin-workspace requirements and current identity/security model | **Major Drift** | **DO NOT MERGE.** The branch builds and its existing tests pass, but retry safety, tenant/role checks, consent-backed disclosure, scheduler rostering, and core admin usability are not yet correct. |

The Ticket 05b forward-correction boundary was respected: this review does **not** treat the context-free shift signature or missing provider/service-readiness fields as Ticket 05 defects. Ticket 05b still owns those changes.

## Merge blockers

### 1. Major Drift — retries mutate data before checking the command receipt

`record_admin_command` writes or reuses the receipt only after each RPC has already created or changed domain rows (`supabase/migrations/0008_admin_workspace_rpcs.sql:45,79,125,171,195,238,258`). A repeated command therefore is not idempotent. A focused probe called `cmd_admin_create_participant` twice with the same command ID but different names: two participants and two critical cards were created; the second response said `duplicate_returned` while exposing the newly created IDs alongside the first receipt's outcome. An identical participant replay instead fails on the natural-key constraint rather than returning the original result.

Reserve or look up the actor/org/type-scoped receipt before any mutation, return the original outcome unchanged on retry, and keep first execution, receipt, domain mutation and audit in one transaction. Add duplicate/retry tests for every new admin command, including same and altered payloads.

### 2. Major Drift — schedulers cannot see workers to roster

The page admits schedulers and fetches `organisation_memberships` (`src/app/app/admin/page.tsx:10,19`), but membership RLS exposes other members only to admins (`supabase/migrations/0003_forward_identity.sql:699-710`). A scheduler probe returned only the scheduler's own row, so `workers` is empty (`src/app/app/admin/workspace-client.tsx:31`) and the create/reassign selectors cannot be used.

Expose a minimal, live worker-roster projection or a narrow read RPC to authorised schedulers; do not broaden access to unrelated profile data. Add a scheduler page/query regression proving active workers are selectable and inactive/cross-tenant workers are hidden.

### 3. Major Drift — shared admin and worker checks do not implement the settled live-role model

`admin_context` trusts the legacy `organisation_memberships.role` column and never checks that the organisation is not soft-deleted (`supabase/migrations/0008_admin_workspace_rpcs.sql:20-40`). A valid supplementary admin role in `organisation_membership_roles` was rejected in a focused probe, while a separate probe confirmed a soft-deleted organisation still accepts participant creation. Target-worker checks likewise use only base `role='worker'` and `status='active'`, omitting effective dates (`:248,270`).

Use the canonical membership/role helpers with organisation liveness, active/effective membership and role windows. Apply the same predicate to invite authority and target workers. Add deleted-org, supplementary-role, withdrawn-role, future-worker, expired-worker and cross-org negative tests.

### 4. Major Drift — participant self-linking can cross tenant boundaries

`cmd_admin_link_participant` verifies only that the supplied profile exists globally before creating the link (`supabase/migrations/0008_admin_workspace_rpcs.sql:103-120`). `participant_self_links` has no composite organisation/profile constraint. A focused probe linked an Org B profile to an Org A participant; the participant-self RLS path then treats that foreign identity as authorised for the Org A participant.

Require the linked identity to have the intended live participant membership in the same organisation, enforce tenant consistency in schema or an immutable constraint trigger, and add cross-org/inactive/wrong-role rejection tests.

### 5. Major Drift — external grants are not actually backed by current consent authority

`cmd_admin_create_grant` accepts arbitrary non-empty consent/evidence strings and `consent_basis='authorised_representative'` without identifying or validating a current representative authority, its participant, scope, status or effective window (`supabase/migrations/0008_admin_workspace_rpcs.sql:195-218`). After revoking every representative authority for the participant, a focused probe still created an accepted representative-backed grant. A withdrawn/expired recipient membership can also retain usable grant access because grant reads do not recheck recipient membership liveness.

For representative consent, require an exact authority/version effective at authorisation time with appropriate disclosure scope. For every grant, require a live same-tenant recipient relationship and define revocation/withdrawal propagation. Preserve the consent/authority snapshot used, then test revoked, expired, wrong-participant, wrong-scope and withdrawn-recipient cases.

### 6. Major Drift — invitation and access workflows are not usable end to end

The invite RPC creates a random token but returns no usable invitation URL and sends no email (`supabase/migrations/0008_admin_workspace_rpcs.sql:79-99`); the browser ignores all successful RPC data and reloads (`src/app/app/admin/workspace-client.tsx:33-39`). The existing `/invite/[token]` flow therefore has no path from the admin action to the invitee. The self-link, representative and grant forms also require a raw profile UUID, with no searchable/selectable invited identity (`workspace-client.tsx:101-104`). This fails the settled goal of preparing the synthetic pilot without direct database work.

Add a safe delivery/copy-link handoff that does not leak cross-organisation account existence, and replace raw UUID entry with role/tenant-scoped identity selection. Keep participant, representative and external recipient form state separate so editing one form cannot silently retarget another.

### 7. Major Drift — material warnings and read failures are rendered as success or empty data

The shift RPC returns overlap and availability warnings, but `call()` discards response data and immediately reloads (`src/app/app/admin/workspace-client.tsx:33-39`), so the promised warnings never reach the scheduler. The server page also ignores every Supabase query error and converts failures to empty arrays (`src/app/app/admin/page.tsx:16-40`), making an RLS/network/schema failure look like “no participants”, “no grants” or “no workers”.

Handle query failures as an explicit error/retry state. Consume command outcomes before refresh and require the user to see/acknowledge roster warnings. Add integration tests for warning display, partial read failure and retry.

## Other required corrections

### 8. Technical Drift — key forms do not have programmatically associated labels or safe submit state

`Field` renders `<Label>` without `htmlFor`, while its controls have no matching IDs (`src/app/app/admin/workspace-client.tsx:74-110`). This fails the Ticket 05 screen-reader-label gate. The shared command helper also has no `try/catch` or pending/disabled state; a rejected promise can leave “Saving securely…” forever, and rapid double-submit issues different command IDs, amplifying the broken retry contract.

Give every control a stable accessible name, add field-level IDs/descriptions/errors, catch transport failures, and disable or deduplicate submission while a command is pending. Run the settled keyboard, screen-reader, 200% zoom and 320 CSS-px reflow checks.

### 9. Technical Drift — new `SECURITY DEFINER` functions miss the current hardening contract

Every new definer uses `set search_path = public` instead of the settled empty search path with fully qualified objects (`supabase/migrations/0008_admin_workspace_rpcs.sql:20-280`); `gen_random_bytes` is also unqualified (`:93`). This is contract drift even if current schema privileges happen to prevent exploitation.

Set `search_path = ''`, fully qualify relations, functions, operators/types as needed, explicitly revoke `public`/`anon`, grant only intended callers, and add catalog assertions for `proconfig` and ACLs.

### 10. Minor Issue — the event stream labels initial creation as reassignment

Shift creation records audit action `shift.created` but emits `shift_events.event_type='reassigned'` (`supabase/migrations/0008_admin_workspace_rpcs.sql:275`). Use a creation event type or otherwise align the event/audit vocabulary, with a regression assertion.

## What is sound

- Sensitive writes are routed through narrow transactional RPCs rather than direct client multi-table writes.
- Tenant IDs are included throughout the new admin domain writes, and existing RLS continues to separate workforce, participant, representative and external read paths.
- Reassignment uses the existing versioned command and preserves assignment history.
- The implementation is synthetic-labelled and does not add real participant data, secrets, Docker or remote-database changes.
- Migration `0008` parses and reruns on the current local PGlite schema.

## Verification

| Gate | Result |
| --- | --- |
| `pnpm lint` | Pass |
| `pnpm typecheck` | Pass |
| `pnpm build` | Pass |
| `pnpm db:parse` | Pass — migrations `0001`–`0008` |
| `pnpm db:test` | Pass — 8 files / 60 tests |
| `git diff --check 0b1d1bb..1b66d6e` | Pass |
| Focused duplicate-command probe | **Fail reproduced** — second mutation occurred before duplicate receipt return |
| Focused scheduler membership read | **Fail reproduced** — scheduler sees no worker memberships |
| Focused supplementary admin-role probe | **Fail reproduced** — active added admin role rejected |
| Focused revoked-authority grant probe | **Fail reproduced** — representative-backed grant accepted with zero active authorities |
| Real remote Supabase/PostgREST | Not run; no secrets or remote project were accessed during review |

The green suite is not evidence that the blockers are absent: Ticket 05 adds only two database happy-path tests (`tests/db/admin-workspace.test.ts:11-33`) and no UI integration tests for the admin workflows.
