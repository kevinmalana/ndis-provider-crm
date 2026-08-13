---
title: "Ticket 05b cold-review remediation"
kind: ticket
status: 1
---

## Result being corrected

Cold database/security and product/UI reviews of `1a1319d` independently recommend **DO NOT MERGE**. The branch proves basic migration/API retirement and a service-ready happy path, but materially under-implements the settled Ticket 05b contract. This remediation changes no product decision and remains inside Ticket 05b.

## Batch A — data, authority and concurrency invariants

- Rebuild acknowledgement semantics as an append-only ledger with one conclusive root, at most one accepted successor per current leaf, full-chain current-leaf resolution, expected-current enforcement and stale/concurrent evidence preservation that never creates a competing root. Attempts remain separate history. Add an authenticated, role-scoped ledger/current projection and provider-recorded admin/scheduler commands/UI contract.
- Make migration `0009` transactional and rerunnable. Guard triggers/constraints/policies/functions; prove fresh apply, populated `0008c` upgrade, second apply, and failed-migration rollback preserving the old schema/data.
- Add composite tenant integrity or equivalent immutable checks for identifiers, contexts, scope/capability/catalogue/item, worker-role evidence, snapshots and acknowledgement shift/authority links. Every SECURITY DEFINER command must reject cross-tenant subjects before write.
- Make `provider_readiness` internal or explicitly caller-authorised. Bind readiness to the assigned worker's relevant risk-role version and context/support item—not the newest organisation role or unrelated evidence.
- Validate the complete scheduled interval across provider scope, capability, catalogue version/item, service context, jurisdiction, screening policy/verification/pathway and competence. Enforce verification/pathway/competence effective windows and current statuses.
- Enforce each named pathway's exact fields and semantics: jurisdiction, dates, application/placement/contract reference, external administering organisation where applicable, active cleared supervisor membership/clearance, and risk plan. Empty strings do not satisfy evidence.
- Lock or version every readiness input during create/reassign/Start so concurrent revocation/expiry cannot commit a stale-ready action. Revocation after accepted Start preserves evidence and enters urgent provider review.
- Fully isolate `legacy_incomplete` shifts: admin-readable history only; reject worker projection, copy, create-from, reassign, Start, summary/finalise and other actionable paths.
- Add immutable UPDATE/DELETE guards for shift service snapshots and acknowledgement events, including privileged/raw mutation probes.
- Remove the retired `cmdAdminCreateShift` wrapper/export and every old UI/static call; the exact old database signature remains absent.

## Batch B — complete secure administration surface

Add narrow typed idempotent RPCs, RLS read projections and role-gated `/app/admin` forms/read views for the entire no-SQL journey:

1. Provider scope version, registration declaration, jurisdictions and review.
2. Support capability with explicit `individual_time_supported`, `specialist_phased` or `not_supported` state.
3. Provider catalogue version and time-based supported item.
4. Risk-assessed role and registered/unregistered screening policy.
5. Worker screening verification and named pathway evidence.
6. Role/support competence requirements and worker competence evidence.
7. Masked participant NDIS identifier plus admin-only, reason-required, audited full reveal.
8. Participant service context create/review/activate/supersede/withdraw lifecycle using tenant-scoped selectable capability/item/owner/reviewer records.
9. Service-ready shift creation/reassignment with persistent readiness reasons and recovery actions, plus immutable snapshot/readiness display.
10. Provider-recorded acknowledgement attempt, signed/declined root and expected-current correction, with truthful source labels and readable immutable ledger/current outcome.

No raw profile/tenant IDs where authorised selectable records exist. Show SQL detail/reason safely enough for actionable recovery. Preserve Ticket 05 per-form pending, exact retry arguments, warnings, labels, privacy fallbacks and read-error behavior. Do not imply live Commission/catalogue verification, legal determination, participant authentication, billing, or specialist workflow support.

## Batch C — required proof

- Fresh/populated/failure/rerun migration tests and exact old-signature/UI/wrapper retirement.
- Full readiness negative matrix: scope/capability/kind/unit/jurisdiction/catalogue/context lifecycle and interval mismatches; registered-risk/provider/participant strictest screening; missing unregistered policy; every adverse screening state; every incomplete pathway field/supervisor state; role-bound missing/expired/failed competence.
- Direct create/reassign/Start concurrency probes for revocation/expiry, post-Start urgent review, duplicate idempotency and evidence preservation.
- Identifier masking/reveal/audit/cross-role/cross-tenant tests.
- Acknowledgement allowlist/event-time authority, attempt separation, one-root/one-successor/current-leaf, 3+ corrections, duplicate/stale/concurrent quarantine and append-only tests.
- Mounted admin journey tests covering all ten Batch B steps, role restrictions, error/recovery messages, retry behavior and immutable snapshot/ack views.
- Catalog assertions for RLS, fixed empty search path, qualified relations, public/anon revocation, intended authenticated grants and no raw write privileges.
- Frozen install, lint, typecheck, build, migration parse, full isolated DB/Ticket 05/PostgREST/static/mounted suites and diff check pass. Browser/manual accessibility remains explicit if browser tooling is unavailable.

## Boundaries

Modify the unmerged/unapplied `0009` migration rather than consuming a later ticket number. Synthetic data only. No remote Supabase, Docker, secrets, real participant data, merge or push. Keep parent Ticket 05b status 1 until a fresh cold review approves the complete branch.

## User execution decision after repeat review

Kevin chose to continue one large Ticket 05b fixup rather than split the work into separately approved sub-tickets. The full scope remains mandatory. A fresh builder owns the following repeat-review blockers on frozen HEAD `63d4bff`.

### Remaining database/security blockers

- Authorise `provider_readiness` and every readiness/ledger projection against the caller's live membership, tenant and intended role. An authenticated no-role or other-tenant caller must learn nothing.
- Bind the service context and requested participant explicitly before readiness. Bind one declared worker risk-role version to the service context/support requirement; unrelated screening or competence evidence must never satisfy readiness.
- Validate catalogue-version status/window and item containment, capability complete-interval logic, scope/context jurisdiction and all verification/pathway/competence effective windows for the full scheduled interval. Context jurisdiction is required on new/current ready contexts and existing nullable rows remain unready until reviewed/backfilled through an explicit admin action.
- Enforce named pathway application/placement/contract references, jurisdiction, dates, external administrator where applicable, and a live cleared supervisor membership/clearance. Empty strings fail.
- Use a shared lock/version protocol across create, reassign, Start and every policy/evidence writer so concurrent expiry/revocation cannot produce stale readiness. Worker screening/pathway/competence revocation after accepted Start must route the affected shift to urgent provider review.
- Reject every actionable operation on `legacy_incomplete`, including reassignment, worker projection, copy, Start, summary and finalisation.
- Tenant-authorise acknowledgement ledger reads; preserve one-root/one-successor/current-leaf and append-only guarantees.
- Validate all new admin RPC inputs: nonempty/normalised jurisdictions, interval ordering and containment, tenant/role/effective authority, catalogue hierarchy, service-context reviewed activation and deterministic idempotency.

### Remaining product/UI blockers

- Complete the no-SQL journey with actual create/read forms for participant service context, competence requirements, masked NDIS identifier/admin-only audited reveal, and acknowledgement declined/correction/ledger/current outcome.
- Load and render screening verifications, pathways, competence requirements/evidence, identifier masking, snapshot fields and acknowledgement ledger; include their errors in the page read-error boundary.
- Call ledger projections per selected shift or support a safely authorised nullable listing contract; never pass null to a strict equality filter and silently show empty history.
- Show persistent readiness results and safe actionable SQL detail/recovery reasons by invoking the authorised readiness projection. Render immutable snapshot item/category/catalogue/unit/goal fields, not only shift IDs.
- Give scope, capability, catalogue, role, screening policy, verification, pathway, competence requirement/evidence, context, identifier and acknowledgement forms independent pending/retry keys and exact argument snapshots.
- Make every visible catalogue/policy/pathway field control the submitted value; remove hard-coded values and raw requirement/profile/membership/shift IDs where tenant-scoped selectable labels exist.
- Require an active reviewer before context activation. Scope participant/representative acknowledgement signer choices to the selected shift's participant and current allowlisted authority.
- Retain truthful provider-recorded/non-participant-authenticated labels, specialist/billing/legal non-claims and all Ticket 05 accessibility/error/retry protections.

### Repeat-review proof

Add mounted and direct DB tests for every item above, including no-role/cross-tenant readiness and ledger calls, already-expired capability/catalogue/evidence, role-mismatched evidence, nullable/mismatched jurisdiction, every pathway field/supervisor state, two-session revocation races, post-Start worker-evidence revocation, legacy reassignment/finalisation denial, reviewed context activation, full identifier flow, 3+ acknowledgement corrections and the complete browser-level ten-step synthetic journey. No item may be treated as covered only because lint/build or a happy-path test is green.
