---
title: "Ticket 05b final database and security review"
kind: review
---

## Verdict

**DO NOT MERGE** frozen commit `84f07f3c58deb21169f583c3df174bc879024580`.

The migration, legacy isolation, tenant links, immutable snapshot, acknowledgement-chain structure and catalog hardening are materially improved. Five locally reproduced correctness/security defects remain, including two readiness/authorisation bypasses that can admit a worker or service-ready shift after the controlling evidence says they are not authorised or not ready.

## Findings

### P0 — Withdrawn effective roles still authorise admin writes and worker Start

`0009_provider_readiness_service_evidence.sql:640-642`, `:656-657` and `:714-720` read the legacy `organisation_memberships.role` column instead of the effective `organisation_membership_roles` authority resolved by `membership_has_role`. The inherited Start guard also relies on the legacy column at `0005_sensitive_command_rpcs.sql:253-263`.

Isolated PGlite reproductions from `seedStandardFixture`:

- Give the base-admin membership only an active `worker` role row. `current_user_membership_role()` returns `worker` and `membership_has_role(...,'admin')` returns false, but `cmd_admin_create_provider_scope_version` returns `accepted`.
- Give the assigned worker a withdrawn `worker` role row. `membership_has_role(...,'worker')` returns false, but `provider_readiness` returns `ready: true` and `cmd_start_shift` returns `accepted`.

This is a live authorisation bypass and contradicts Ticket 04/05's supplementary-role model. Resolve role authority through effective role rows everywhere, lock role-row changes with the 05b protocol, and add demotion/withdrawal Start and admin-RPC tests.

### P0 — Partial-interval required screening and competence are ignored

The readiness predicate only considers a screening policy or competence requirement if one row spans the entire shift (`0009_provider_readiness_service_evidence.sql:661-663`, `:671`). A required rule that covers any proper sub-interval is excluded rather than applied as the strictest rule for that interval.

Reproduction: make the registered role non-risk-assessed, end its required screening policy at `10:30`, and set direct clearance to `pending`; readiness for `10:00-11:00` returns `ready: true` with `screening_source: not_required`. Separately, end a required competence row at `10:30` and set its only evidence to `not_met`; `cmd_admin_create_service_ready_shift` accepts the `10:00-11:00` shift and snapshot.

Evaluate continuous interval coverage and the strictest applicable rule at every point in the scheduled window. A shift that crosses policy/requirement versions must either satisfy each segment or fail closed.

### P1 — Acknowledgement authority is not resolved at event time or to the required scope

`cmd_admin_record_acknowledgement` (`0009_provider_readiness_service_evidence.sql:691-694`) checks participant self-link current status without comparing `occurred_at` to `linked_at`/`withdrawn_at`, requires representative status to be active now rather than valid at event time, and accepts either `service_acknowledgement` **or `service_summary`** scope.

Direct probes show:

- a participant-self acknowledgement occurring on `2026-08-07` is accepted although the self-link was created on `2026-08-10`;
- a plan nominee whose only relevant scope is `service_summary` is accepted for a conclusive acknowledgement;
- an authority valid across `2026-08-07` but subsequently marked revoked is rejected when the provider records that historical event.

Resolve the immutable authority version at `p_occurred_at`; require the exact service-acknowledgement scope; snapshot the accepted authority lineage; cover pre-link, post-withdrawal, later-revoked and summary-only cases.

### P1 — Risk-role and membership-role revocations do not propagate urgent review

The urgent-review trigger list at `0009_provider_readiness_service_evidence.sql:623-630` excludes both `risk_assessed_role_versions` and `organisation_membership_roles`.

Reproduction: Start a ready shift, then withdraw the service context's risk-role version. `provider_readiness` immediately returns `role_not_current`, but the shift remains `started` at the same version instead of becoming `urgent_provider_review`. Effective membership-role changes also bypass both the shared lock and propagation path.

Attach the shared lock and post-write urgent-review evaluator to every readiness authority source, including both role tables, and prove post-Start role withdrawal plus concurrent role withdrawal versus Start.

### P1 — New 05b admin commands can reject a valid duplicate instead of returning its receipt

Mutable-state validation occurs before receipt lookup in the typed admin commands; for example `cmd_admin_create_support_capability` validates its scope at `0009_provider_readiness_service_evidence.sql:740-746` and only reserves/looks up the command at `:746`.

Reproduction: create a capability successfully, withdraw the referenced scope, then resend the exact same command ID and arguments. The retry raises `support_capability_invalid` rather than returning the original accepted receipt/outcome. The same ordering pattern appears across the new scope/catalogue/role/policy/evidence/context commands.

Restore Ticket 05's receipt-first duplicate behavior after caller authentication and immutable input-shape checks; validate mutable domain state only for a genuinely new reservation. Add changed-state exact-retry tests for every 05b admin command family.

## Contract closure

| Area | Result | Evidence |
| --- | --- | --- |
| Caller, tenant and live-role authorisation | **Fail** | Tenant IDs are bound, but effective role withdrawal is bypassed (P0). |
| Participant/context/capability/catalogue/jurisdiction binding | Pass | Explicit participant/context and catalogue hierarchy checks; nullable/mismatched jurisdiction fails readiness. |
| Complete interval and strictest screening/competence | **Fail** | Partial policy/requirement intervals are ignored (P0). |
| Named pathways and supervisor clearance | Pass | Required reference, dates, jurisdiction, administrator, risk plan and live distinct cleared supervisor are enforced. |
| Shared locking and post-Start urgent review | **Fail** | Main evidence writers share the organisation lock; role sources are omitted (P1). |
| Legacy isolation and old API retirement | Pass | Old eight-argument function absent; legacy rows hidden from workers and blocked from reassign/Start/state transition. |
| Fresh/populated/failure/rerun migration safety | Pass locally | Fresh boot, populated 0008c upgrade, forced late rollback and second application succeed; prior rows remain. |
| Immutable snapshot and acknowledgement chain | Partial | Snapshot and acknowledgement UPDATE/DELETE blocked; unique root/successor/current leaf and stale quarantine pass, but authority acceptance is wrong (P1). |
| Admin RPC validation and idempotency | **Fail** | Shape/tenant/interval validation is present; duplicate outcome is not stable after mutable state changes (P1). |
| RLS, ACL, empty `search_path`, qualified relations, named args | Pass locally | New tables have RLS; no authenticated raw writes; public/anon revoked; intended RPC grants and local named calls pass. |
| Tickets 04/05 regressions | Partial | Existing 100 DB tests and 19 mounted tests pass, but P0 role handling contradicts the established supplementary-role contract and P1 regresses receipt-first retry semantics. |

## Gates run

- `pnpm db:parse` — pass, migrations `0001` through `0009`.
- Focused readiness/remediation/final-closure/PostgREST suite — 22/22 pass.
- Full `tests/db` suite — 100/100 pass.
- `tests/admin-workspace-mounted.test.tsx` — 19/19 pass.
- `pnpm lint`, `pnpm typecheck`, `pnpm build` — pass.
- `git diff --check 0590a00..84f07f3` — pass.
- Six independent PGlite adversarial probes — reproduced all five findings above.
- Remote Supabase, Docker, secrets and real data were not used. No remote-only result could overturn the local merge blockers.

## Merge gate

Do not merge until all five findings are fixed and covered by direct negative/concurrency/idempotency tests. Re-run the full local gates and obtain a fresh independent DB/security review against a newly frozen commit.
