---
title: "Ticket 04 fixup repeat security review"
kind: review
---

## Final cold pass — `b738835`

| Result | Recommendation |
| --- | --- |
| **The four blockers from the prior pass are closed in code and in the new regression/contract tests. No actionable code blocker found in this cold pass.** | **MERGE after the required production-shaped Postgres/PostgREST gate.** That gate was intentionally not run per instruction. |

### Prior blocker closure

- Receipt lookup impersonation: closed for active callers; the new ownership predicate and regression test reject worker-B lookup of worker-A's receipt.
- Conflict subject FK/accepted evidence: closed for the covered stale-end path; the new test resolves the review and transitions the shift.
- Legacy invitation/audit RLS: closed for forged legacy profile authority; the new membership-based policies and test pass.
- Portal request actor attribution: closed for covered participant/representative/access-request retries via profile-scoped receipts.
- Summary portal RLS: closed for participant/representative/external current-version reads; `1db50f5` also includes cancelled headers.
- Post-capture withdrawal preservation: covered withdrawal path writes a conflict receipt and passes.
- Finalisation authority: worker compatibility calls are rejected; admin/scheduler path is receipt-backed.

### Final blocker verification

- **Historical accepted retry after withdrawal — closed.** `lookup_command_receipt` now authorises historical ownership without requiring current membership, and `cmd_on_my_way` checks idempotency before live assignment validation. The regression creates an accepted `cmd_end_shift`, withdraws the membership, and confirms the retry returns the same accepted receipt and outcome (`supabase/migrations/0005_sensitive_command_rpcs.sql:96-116,329-350`; `tests/db/rpc-contracts.test.ts:402-438`).
- **0004 upgrade/rerun DDL — closed for the implemented path.** Explicit rerunnable `ALTER`/backfill/constraint blocks cover pre-existing command receipts and tenant identity FKs (`supabase/migrations/0004_v1_domain_tables.sql:579-651`). A direct current-schema rerun passed; the static contract test asserts the backfill and constraints (`tests/db/postgrest-contract.test.ts:52-74`).
- **Legal/version-guarded `resolve_conflict` — closed.** Accepted exceptions map only supported command types, require the original expected version, restrict each command to legal source states, and use a guarded update. Regression coverage includes accepted end evidence and a newer `cancelled_needs_review` state (`supabase/migrations/0005_sensitive_command_rpcs.sql:1532-1578`; `tests/db/rpc-contracts.test.ts:155-226`).
- **Exact invitation/PostgREST contract — closed for the local contract.** The test invokes `cmd_accept_invitation` with an exact token and checks replay/wrong-token failures; a separate contract test verifies SQL `p_token`, authenticated-only ACL, and the client wrapper's `p_token` named argument (`tests/db/forward-identity.test.ts:188-225`; `tests/db/postgrest-contract.test.ts:10-31`). Real PostgREST remains part of the intentionally unrun gate.

### Findings

No actionable code findings remain in this pass. The PGlite harness still cannot prove live PostgREST routing/catalog ACL behavior; this is an explicitly outstanding environment gate, not a source blocker.

### Verification at `b738835`

| Gate | Result |
| --- | --- |
| `pnpm db:parse` | Pass — all 7 migrations parse |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | Pass |
| `pnpm db:test` | Pass — 5 files, 47 tests |
| `git diff --check main...HEAD` | Pass |
| Current-schema `0004` rerun probe | Pass |
| Real Postgres/PostgREST/Docker | **Not run** (explicit review constraint) |

## Historical previous pass (superseded by the final cold pass above)

| Review range | Result | Recommendation |
| --- | --- | --- |
| `main...HEAD` including fixups `21dbac8`, `d26431e` | **Blocked — Major Drift remains** | **Do not merge yet.** The fixups are directionally correct, and the local PGlite/quality gates pass, but the production-shaped Postgres/PostgREST gate is not green and several concrete authorization/data-integrity blockers remain. |

The branch is safe to test locally (no source, remote database, Docker, secrets, real participant data, or hard-purge implementation was touched). It is not merge-ready even before the required real Postgres/PostgREST gate because the exposed receipt lookup leaks another actor's receipt, conflict resolution still fails at runtime, and secondary-membership invitation/audit authorization still trusts legacy profile columns.

## Well Implemented

- 0003 now backfills `global_profiles` and memberships before adding the replacement audit FK (`NOT VALID`), and the trigger path performs token-bound acceptance for existing as well as new accounts.
- Sensitive public RPCs consistently use `SECURITY DEFINER`, fixed `search_path`, explicit revoke/grant, scoped receipt uniqueness, expected-version checks on the main worker transitions, and append-only summary version rows.
- Synthetic seeding is now a service-role-only, dedicated-`.synthetic` identity RPC with deterministic IDs and one transaction; rerun and rollback tests pass.
- No raw authenticated insert/update/delete policy was found for the v1 sensitive tables; no hard purge, committed secret, or real data was found.

## Historical findings (superseded; retained for traceability)

### 1. Major Drift — `lookup_command_receipt` still permits caller impersonation

`supabase/migrations/0005_sensitive_command_rpcs.sql:70-105` grants the `SECURITY DEFINER` lookup directly to every authenticated caller but only filters on the caller-supplied organisation and membership UUID. It never proves that `p_actor_membership` belongs to `auth.uid()` (or that the caller is an authorised supervisor). A worker-B probe supplied worker-A's membership and received A's accepted status, outcome, receipt ID, and subject shift. Make this helper internal/revoke the public grant, or enforce `organisation_memberships.profile_id = auth.uid()` plus live membership/org checks before returning any row.

### 2. Major Drift — conflict resolution is still nonfunctional and does not apply accepted evidence

In `supabase/migrations/0005_sensitive_command_rpcs.sql:1398-1412`, `cmd_resolve_conflict` calls `record_shift_audit` with `v_review.receipt_id` as `p_shift_id` (a receipt UUID, not a shift UUID), then passes `v_review.subject_shift_id`, a field that does not exist on `evidence_review_queue`. The focused probe fails with `shift_events_shift_id_fkey`, so every decision rolls back. Even after fixing the subject lookup, the `accept_exception` branch only changes queue state (`:1374-1396`) and records a decision; it never applies an authoritative shift transition or updates the original receipt as required by the fixup contract. Resolve the receipt's real subject shift and explicitly model/apply the accepted exception atomically.

### 3. Major Drift — invitation and audit RLS still authorise through legacy single-org profiles

0003 says it replaces legacy organisation/invitation/audit authorisation, but it only drops/recreates the organisation and profile policies (`supabase/migrations/0003_forward_identity.sql:596-620`). The invitation and audit policies from 0002 remain unchanged at `supabase/migrations/0002_auth_and_invitations.sql:365-393`, using `current_user_organisation_id()` and `current_user_role()` over the mutable legacy row. A user who gains a second membership has no membership-aware invitation/audit read path, and legacy role/org values remain an authority source. Replace both policies with live membership/effective-window checks and add a secondary-membership regression test.

### 4. Major Drift — non-membership request actors are collapsed onto an arbitrary membership

`cmd_request_correction` and `cmd_request_access` use `select id ... limit 1` as a synthetic `actor_membership_id` for participant, representative, and external callers (`supabase/migrations/0005_sensitive_command_rpcs.sql:1505-1521,1567-1570,1664-1671,1712-1715`). This misattributes the receipt and makes idempotency collide across unrelated profiles. A participant and representative issuing the same command ID returned the participant's original receipt to the representative. Store a real actor-profile key (or a nullable/non-membership actor dimension) in the receipt uniqueness/lookup contract; never select another person's membership.

### 5. Major Drift — participant/representative/external summary reads are empty, not safely scoped

`service_summary_current_versions` is `security_invoker` and is granted to authenticated users (`supabase/migrations/0006_access_matrix_rls.sql:550-562`), but `service_summary_versions` has only admin/scheduler and assigned-worker policies (`:516-547`). There are no participant, representative, or external policies for the underlying relation, so the view returns no rows for those audiences even after a summary is finalised. A participant probe after the worker auto-finalised a summary returned an empty result. Add non-recursive audience policies/projection that enforce finalised/current-version/category scope, then test each portal audience.

### 6. Major Drift — post-capture authority loss still drops evidence before the preservation path

The worker commands resolve `current_membership` and immediately raise `not_a_member` when it is null (`supabase/migrations/0005_sensitive_command_rpcs.sql:433-435`, with the same pattern in `cmd_on_my_way`, `cmd_end_shift`, and `cmd_submit_summary`). A worker whose membership expires/withdraws after capturing an offline command therefore gets no receipt, audit/event, or review item; `assert_worker_assignment` is never reached. Preserve the historical actor membership (including withdrawn status) and route this post-capture failure through the same atomic evidence path.

### 7. Minor Issue — compatibility finalisation RPC bypasses authority and receipt contracts

`cmd_finalise_summary` is `SECURITY DEFINER`, granted to all authenticated callers, and performs no authentication/membership/role check, expected-version check, receipt, audit, or command idempotency (`supabase/migrations/0005_sensitive_command_rpcs.sql:975-1002`). Any signed-in user who guesses a shift UUID can receive an “accepted” result for a finalised/corrected/cancelled shift. Remove the client-facing endpoint, or make it an internal/admin-scoped compatibility wrapper with the same command contract.

### 8. Technical Drift — current tests cannot validate the required PostgREST/privilege contract

The PGlite harness translates friendly unprefixed names to positional SQL (`tests/db/harness.ts:150-163`), grants execute on every public function and uses a superuser reset for service-role calls (`:99-108,124-129`). Thus the 34 passing tests do not exercise the `p_` named-argument PostgREST contract, catalog ACLs, or real service-role boundaries. No real local Postgres/PostgREST gate was run per instruction. Additionally, `git diff --check e77d3c9..HEAD` fails on a blank line at `tests/db/synthetic-seed.test.ts:88`. Add the production-shaped gate and clear the diff-check failure before merge.

## Historical verification (superseded by the final gate results above)

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile --offline` | Pass — already up to date |
| `pnpm db:parse` | Pass — all 7 migrations parse |
| `pnpm lint` | Pass |
| `pnpm typecheck` | Pass |
| `pnpm build` | Pass |
| `pnpm db:test` | Pass — 5 files, 47 tests |
| `git diff --check main...HEAD` | Pass |
| Current-schema `0004` rerun probe | Pass — explicit upgrade blocks rerun cleanly |
| Focused receipt-lookup, conflict-resolution, withdrawal-retry, invitation, summary-view probes | Pass |
| Real Postgres/PostgREST/Docker | **Not run** (explicit review constraint) |

## Current merge recommendation

**MERGE after the production-shaped Postgres/PostgREST gate passes.** All local quality gates and 47 database tests pass at `b738835`; no source changes were made during review. No Docker, remote Supabase, real participant data, or secrets were accessed.

## Historical merge recommendation (superseded)

See the historical sections below for prior findings and their remediation history.
