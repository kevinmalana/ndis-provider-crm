---
title: "Ticket 04 security review — data, consent and authorisation foundation"
kind: review
---

## Verdict

| Review range | Result | Recommendation |
| --- | --- | --- |
| `main...HEAD` (`9bc66c3`, `dee9af9`, `e77d3c9`) | **Blocked — Major Drift findings remain** | **Do not merge.** Correct the migration, identity acceptance, legacy escalation, RPC, RLS and test-validity blockers, then repeat the review against real Postgres/PostgREST as well as PGlite. |

The automated gates pass, but focused probes reproduced migration failure, privilege escalation, cross-actor receipt disclosure, unusable summary RLS, broken conflict/correction RPCs, and unaudited cross-organisation request creation. The passing suite does not exercise those production-shaped paths.

## Well Implemented

- The new authority concepts are separated into memberships, self-links, representative authority and external grants rather than collapsed into one role/grant.
- The public sensitive RPCs consistently use `SECURITY DEFINER`, a fixed `search_path`, and explicit revoke/grant statements. No hard-purge worker, attachment/GPS model, real participant data, or committed secret was found.
- Accepted Start/End paths update state, append audit/event rows and write receipts in one transaction; ordinary raw writes to shifts and summary versions remain denied by RLS.
- Lint, typecheck, build, frozen-lockfile install, migration parsing and all 30 PGlite tests pass independently.

## Findings

### 1. Major Drift — the populated forward migration aborts before it can preserve audit history

`supabase/migrations/0003_forward_identity.sql:78-101` replaces `audit_log.actor -> profiles` with `audit_log.actor -> global_profiles` while `global_profiles` is still empty; the backfill does not run until `:170-228`. Applying 0003 after an accepted invitation therefore fails FK validation. A focused 0001/0002 populated-database probe reproduced `audit_log_actor_fkey` failure. Backfill first, or add the new FK `NOT VALID` and validate after the copy. Also make the claimed rerun path real: unconditional trigger/policy creation begins at `0003:61-63` and `0004_v1_domain_tables.sql:90-92`, so both files fail on a second application.

### 2. Major Drift — the retained legacy profile is writable and permits role escalation

0003 calls the legacy row a read-only shadow (`0003_forward_identity.sql:20-23`) but deliberately leaves legacy helpers/policies in place (`:330-332`). The existing self-update policy at `0002_auth_and_invitations.sql:356-363` lets a worker change their own `profiles.role` or `organisation_id`; legacy organisation, invitation and audit policies still trust those values (`0002:334-393`). A focused authenticated probe changed a worker to `admin` successfully. Drop the legacy mutation policy/revoke column writes and replace every surviving legacy-authorised policy before treating the shadow as safe.

### 3. Major Drift — invitation acceptance does not implement exact, multi-membership acceptance

Acceptance still happens only in the `auth.users AFTER INSERT` trigger (`0003_forward_identity.sql:256-325`). `src/app/invite/[token]/confirm/route.ts:59-65` merely sends an OTP, so an existing account never fires the trigger and never gains the second membership. For a new account, the trigger ignores the clicked token and chooses the newest pending invitation by email (`0003:265-277`), which can consume the wrong organisation/role invite. The test at `tests/db/forward-identity.test.ts:75-143` manually copies the desired SQL instead of invoking the real flow. Add a token-bound, authenticated acceptance RPC that locks and consumes that exact invitation atomically, with collision/reactivation/escalation rules.

The new-account shell is also broken: the trigger creates no legacy profile (`0003:283-302`), while the organisation policy still uses legacy `current_user_organisation_id()` (`0002:334-343`). The inner organisation join in `src/lib/membership.ts:72-80` therefore removes new and secondary memberships and redirects the user as uninvited (`src/app/app/layout.tsx:26-28`). Migrate organisation/invitation/audit RLS and test the real authenticated shell query.

### 4. Major Drift — tenant, role and effective-period integrity is not database-enforced

Membership helpers and switching check only `status='active'` (`0003_forward_identity.sql:334-389`, `:466-489`), ignoring organisation deletion and `effective_from/effective_until`; the old soft-delete function updates only legacy profiles/invitations (`0002_auth_and_invitations.sql:223-245`). Multiple active role rows are allowed by `unique (organisation_id, profile_id, role)` (`0003:124-127`), while `current_user_membership_role()` chooses an unordered `limit 1` (`:341-347`). Worker RPC/RLS checks similarly ignore assignment effective windows and worker role (`0005_sensitive_command_rpcs.sql:365-370`; `0006_access_matrix_rls.sql:266-279`). Focused probes confirmed future assignments, expired memberships and an assigned admin could act as a worker.

Separately, independent foreign keys allow cross-tenant relationship rows: self-links (`0004_v1_domain_tables.sql:102-118`), authorities (`:150-171`), grants (`:197-222`), shifts (`:301-329`) and assignments (`:352-366`) do not require their linked participant/membership/shift to share `organisation_id`. Add composite tenant FKs or immutable consistency triggers and central current-membership/current-assignment helpers.

### 5. Major Drift — the real Supabase RPC clients cannot resolve the SQL functions

The SQL parameters are named `p_command_id`, `p_shift_id`, `p_organisation_id`, etc. (`0003_forward_identity.sql:466`; `0005_sensitive_command_rpcs.sql:184-190`), but every wrapper and the active-organisation route send unprefixed keys (`src/lib/supabase/commands.ts:24-103`; `src/app/app/active-organisation/route.ts:26-29`). PostgREST matches named arguments exactly; a focused named-call probe returned `function ... does not exist`. `tests/db/harness.ts:150-163` masks this by translating the friendly keys into positional SQL calls. Align SQL/generated types/callers and add a real PostgREST contract test.

### 6. Major Drift — idempotency is global, cross-actor and not receipt-faithful

`command_receipts` has `unique(command_id)` only (`0004_v1_domain_tables.sql:477-504`), and `lookup_command_receipt(text)` is granted to every authenticated user and filters only that text (`0005_sensitive_command_rpcs.sql:102-127`). RPCs run the lookup before subject/organisation/actor checks. A focused worker-B probe read worker A's accepted outcome and receipt; reusing that ID in another command also returns A's status. Duplicate responses omit the stored outcome, and concurrent lookup-then-insert calls can race into the unique constraint. Scope the key and lookup to actor, organisation and command type, authorize first, and atomically return the original stored outcome.

### 7. Major Drift — reassignment and stale-summary conflicts discard evidence

Start/End/submit raise `not_assigned` before creating any receipt, review item or audit (`0005_sensitive_command_rpcs.sql:365-373`, `:559-567`, `:750-758`), so an offline command captured before reassignment is dropped when delivered afterward. `cmd_submit_summary` also lacks the stale-version preservation branch; its conditional update at `:824-830` throws and rolls the whole attempt back. Invalid On-my-way and summary branches create review rows but omit audit/event append (`:242-269`, `:763-788`). Route every post-capture authority/version/state failure into an attributed receipt and review record atomically.

### 8. Major Drift — conflict resolution and correction workflows fail at runtime

`cmd_resolve_conflict` writes the original receipt UUID into `subject_shift_id` (`0005_sensitive_command_rpcs.sql:1095-1111`), which references `shifts(id)` (`0004_v1_domain_tables.sql:492`); a focused probe reproduced the FK failure. Even corrected, `accept_exception` only relabels the queue and never applies the evidence or updates the original receipt (`0005:1073-1093`), and decided reviews can be overwritten.

Participant/representative correction requests are admitted without membership (`0005:1171-1196`) but then insert null into non-null `command_receipts.actor_membership_id` (`0004:491`, `0005:1223-1234`). Applying a real pending request writes a membership UUID into profile-FK `correction_requests.decided_by` (`0004:564`, `0005:1350-1358`). Focused probes reproduced both failures. The apply RPC also accepts no request ID, can correct an unfinalised summary, and approves every pending request on the shift. Model non-membership actors explicitly and enforce one legal request/review transition per command.

### 9. Product Misalignment — summary finalisation adds the rejected office bottleneck and omits the command contract

The worker's `cmd_submit_summary` stops at `submitted_local` (`0005_sensitive_command_rpcs.sql:824-870`), while only an admin/scheduler may call finalisation (`:883-929`). The settled flow says successful server acceptance makes the participant-readable summary visible automatically and explicitly rejects mandatory provider review. Finalisation also has no expected version, client-reported time or timezone and updates the shift without a version predicate (`:883-887`, `:965-998`); On my way and the supervisor/request commands have similar missing timing/version fields (`:184-190`, `:1019-1025`, `:1133-1139`, `:1253-1262`). Restore the agreed worker acceptance path or revise the product contract explicitly, and make every command carry the required concurrency/timing evidence.

### 10. Major Drift — summary RLS is recursive, premature and incomplete

The participant version policy queries `service_summary_versions` from its own policy (`0006_access_matrix_rls.sql:506-519`), producing `infinite recursion detected in policy` for authenticated reads; a focused participant probe reproduced it. The summary header is visible before finalisation (`:450-472`). The version block has no assigned-worker or representative policy (`:488-534`), while the external policy exposes every historical correction version rather than only the current finalised version. Use a non-recursive current-version relation/helper, require finalised/corrected state, add the missing scoped audiences and expose only the current version where the story requires it.

### 11. Product Misalignment — portal RLS collapses scopes and exposes internal/live state

Representative and external shift policies union `upcoming_visits` with `service_summary` before applying one state rule (`0006_access_matrix_rls.sql:292-317`), so summary-only representative authority can read scheduled/in-progress visits. Participant shift RLS exposes `in_transit`, `started` and `ended_summary_required` (`:281-290`) despite the no-real-time-travel decision, and participant event RLS exposes whole event rows including actor membership, command IDs and version mechanics (`:370-379`). Split category/state policies and serve participant-safe projections rather than raw operational rows.

### 12. Major Drift — raw request inserts bypass authority, tenant and atomic audit invariants

`correction_requests_insert_requester` (`0006_access_matrix_rls.sql:606-621`) accepts active-context equality without proving assignment, representative scope or organisation/shift consistency. `access_requests_insert_requester` requires only `requester=auth.uid()` (`:641-644`). A focused external-user probe inserted an unaudited access request for a participant from another organisation. Remove the raw client paths in favour of scoped RPCs, or enforce equivalent authority/tenant checks and mandatory atomic audit at the database layer.

### 13. Technical Drift — PGlite tests mask rather than test several production invariants

The harness grants its test role execute on every public function (`tests/db/harness.ts:99-108`), represents service role by resetting to the Postgres superuser (`:124-129`), and converts friendly RPC names to positional calls (`:150-163`). It cannot validate actual grants/revokes, service-role-only boundaries or PostgREST resolution. Several assertions are false positives: expiry/withdrawal queries add the forbidden predicates themselves (`tests/db/access-matrix.test.ts:157-205`), the worker-summary test creates no summary (`:219-227`), and the reassignment test neither withdraws/cancels nor submits post-reassignment evidence (`tests/db/rpc-contracts.test.ts:276-327`). Add real Postgres/PostgREST integration, catalog ACL assertions, populated migration tests, and negative tests for every authority/state boundary above.

### 14. Technical Drift — the synthetic seed is neither synthetic-account-safe nor idempotent/atomic

The script accepts any URL/service-role key (`scripts/seed-synthetic.ts:70-76`), chooses the first existing worker (`:94-114`), then makes that real profile an active representative and external recipient despite saying it will not attach a real profile (`:207-242`). There is no dev/synthetic project allow-list. Reruns also collide with the participant natural key (`0004_v1_domain_tables.sql:86-88`, `seed-synthetic.ts:116-129`), and partial failures cannot be rolled back. Require dedicated `.synthetic` identities and a hard non-production guard, then use deterministic IDs/upserts inside one service-only transaction.

## Verification

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile --offline` | Pass |
| `pnpm lint` | Pass |
| `pnpm typecheck` | Pass |
| `pnpm build` | Pass |
| `pnpm db:parse` | Pass — all six migrations parsed |
| `pnpm db:test` | Pass — 3 files, 30 tests, 179.70 s |
| `git diff --check main...HEAD` | Pass |
| Focused populated/RLS/RPC probes | **Fail as described above** |

No real data, credentials, hard-purge implementation, or raw shift/summary table mutation path was found. These positives do not offset the merge blockers.
