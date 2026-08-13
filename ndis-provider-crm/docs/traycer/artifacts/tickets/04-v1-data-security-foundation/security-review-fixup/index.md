---
title: "Ticket 04 fixup — security review blockers"
kind: ticket
status: 1
---

## Goal

Correct every validated blocker in the Ticket 04 cold security review without weakening the revised product or technical plan. Ticket 04 remains blocked and unmergeable until this fixup passes a repeat cold review.

Authoritative review:

- `../review/index.md`

## Required fixes

1. **Populated forward migration:** backfill global identities before validating the repointed audit actor FK; preserve existing profiles, accepted invitations and audit rows. Make rerun claims truthful or explicitly once-only under migration bookkeeping.
2. **Remove legacy escalation:** legacy `profiles` becomes a non-authoritative shadow. Remove authenticated mutation/escalation paths and replace all remaining organisation/invitation/audit authorisation that trusts legacy role/org values.
3. **Exact invitation acceptance:** add an authenticated, exact-token RPC that locks, validates and consumes the clicked invitation atomically for both new and existing auth users. It must create/reactivate the correct membership/role without selecting another pending invite by email.
4. **Membership-aware shell/RLS:** organisations, memberships, invitations and audit reads must work for new and secondary memberships. Active context is not authority.
5. **Membership/tenant integrity:** enforce live organisation, effective membership and assignment windows, worker role, and deterministic role semantics. Implement one membership per user/org plus separately modelled roles, as the revised technical plan requires.
6. **Cross-tenant foreign-key integrity:** enforce matching `organisation_id` across participant links, representative authority, grants, shifts, assignments, critical information, summaries and requests using composite keys/FKs or equally strong immutable constraints.
7. **PostgREST RPC contract:** SQL parameter names, TypeScript wrappers, routes and database types must match exactly. Add a production-shaped PostgREST contract test.
8. **Receipt/idempotency isolation:** scope receipts and lookup to actor, organisation and command type; authorise before lookup; handle concurrent retries atomically; return the original complete outcome without cross-actor leakage.
9. **Evidence preservation:** reassignment, cancellation, stale version/state and post-capture authority failures must create an attributed receipt, audit/event and protected review item instead of throwing away evidence.
10. **Conflict/correction correctness:** make review decisions immutable/one-way; apply accepted exception evidence or explicitly model its authoritative result; fix subject FKs; support participant/representative request actors; require exact request IDs and legal summary/request states.
11. **Automatic summary finalisation:** successful worker submission finalises the participant-readable summary without a mandatory admin step. Carry expected version, client time/timezone and server receipt through every command required by the plan.
12. **Summary and portal RLS:** remove recursion; hide headers/versions until finalised; expose only the current safe version to participant/representative/external readers; add assigned-worker scope; separate upcoming-visit and summary scopes; do not expose live travel/operational events or internal command/audit mechanics.
13. **Request mutations:** replace raw access/correction request inserts with scoped transactional RPCs, or enforce equivalent tenant/authority checks and mandatory audit atomically.
14. **Synthetic seed safety:** refuse non-development/non-synthetic projects, use dedicated synthetic auth identities, never select an arbitrary existing worker, and make seeding deterministic, idempotent and transactional/recoverable.
15. **Test realism:** retain PGlite unit coverage but add populated-migration, catalog privilege, exact invitation, shell join, effective-window, cross-tenant, PostgREST named-RPC, cross-actor idempotency, summary RLS, conflict/correction and synthetic-seed tests against real local Postgres/PostgREST/Supabase where feasible. Tests must exercise real functions/policies instead of reimplementing them or adding filtering predicates that hide failures.

## Scope constraints

- No product requirement changes.
- No design-system/accessibility work (Ticket 04a owns it).
- No remote Sydney migration, real participant data, credentials, automatic hard purge or raw sensitive-table mutation path.
- The branch is not merged or pushed to `main` until repeat review recommends merge.

## Verification required

- Reproduce each review failure before the fix where practical, then add a regression test that fails without the correction.
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm db:parse`, PGlite tests, and production-shaped local Postgres/PostgREST tests all pass.
- Populated 0001/0002 → revised 0003+ migration succeeds with existing actor/audit data intact.
- Exact-token invitation acceptance works for new and existing accounts with multiple simultaneous invitations.
- Negative access matrix covers deleted/expired organisations/memberships, future/expired assignments, wrong roles, cross-tenant relationships and request creation.
- No secrets or non-synthetic data in branch history.

## Completion

Report fix commits, root cause and correction for each review finding, exact gates/results, deviations and residual risks. Do not mark the parent ticket complete; PM does that after repeat review.
