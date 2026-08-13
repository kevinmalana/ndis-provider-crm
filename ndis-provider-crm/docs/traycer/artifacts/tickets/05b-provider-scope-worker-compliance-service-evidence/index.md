---
title: "Provider scope, worker readiness and service-evidence integration"
kind: ticket
status: 1
---

## Goal

Close the completed Ticket 05 shift-readiness bypass and let Kevin prepare one representative synthetic service record entirely through the admin UI before Ticket 06: one worker, one participant and one individual time-based support item, with current provider scope, screening and competence evidence, active reviewed service context, immutable snapshot and accurately sourced acknowledgement.

## Planning readiness

The two remaining decisions from the cold P0 closure review were settled on 2026-08-10: screening now has a deterministic registered/provider/participant strictest-rule predicate with explicit unregistered policy, and acknowledgement now has a strict authority allowlist plus one immutable conclusive supersession chain. All six original P0 findings are closed at contract level. Migration `0009`, UI integration and runtime proof remain this ticket's implementation work.

## Product boundary

All provider types may create an organisation account. That is an onboarding choice, not a claim that all provider/support obligations are implemented. The Ticket 06 path supports only one-worker/one-participant individual time-based services. Group/ratio evidence, multiple item segments, transport or activity quantities, billing/claim rounding, SIL, SDA, high-intensity, early-childhood, specialist support-coordination, behaviour support, restrictive practices and other dedicated modules remain `specialist_phased` or `not_supported`.

## Migration and Ticket 05 correction

- Add transactional forward-only migration `0009` after Ticket 05's `0008`; preserve all current identities, participants, shifts, assignments, summaries, receipts and audit history.
- Drop the exact old `cmd_admin_create_shift(text, uuid, uuid, uuid, timestamptz, timestamptz, text, jsonb)` signature. Do not leave an overload, compatibility warning or inferred default context.
- Add `cmd_admin_create_service_ready_shift`; update Ticket 05's admin UI, typed wrappers/database types, reassignment integration and synthetic seed to use only the new command.
- Mark pre-0009 context-free shifts `legacy_incomplete`: admin-readable history only, never copyable, worker-actionable or finalisable.
- Update Start enforcement so readiness is rechecked at action time. Revocation after accepted Start preserves evidence and routes the shift to urgent provider review.

## Provider scope and catalogue

- Immutable/versioned provider-scope records capture registered/unregistered declaration, registration-group/class-of-support references, jurisdictions, effective window, author/reviewer and supersession.
- Each organisation support capability is `individual_time_supported`, `specialist_phased` or `not_supported`, linked to the scope version/category/service kind/effective window.
- Provider-managed catalogue versions/items capture source label/version, item code/name/category, time unit, service kind, effective window and supersession. No live NDIA catalogue or legal-applicability claim.
- Only current `individual_time_supported` rows with a time/hour unit can become ready. Provider configuration cannot promote a product-unsupported service kind.

## Worker readiness

- Versioned risk-assessed role definition: title, definition basis, description, assessment date, assessor name/title.
- Versioned screening policy per relevant role: registered/unregistered state, explicit `required`/`not_required`, decision owner/reason/effective window and supersession. Registered risk-assessed roles are always required; registered non-risk roles use the registration baseline unless provider policy requires more; every unregistered role requires an explicit effective provider decision.
- A participant/service-context requirement records issuer/authority, evidence reference and effective window and may make screening stricter but never relax a registered/provider rule. The strictest applicable layer wins; missing unregistered policy is unready.
- Provider-recorded screening verification: source, verifier/time, application/check references, clearance status/expiry and bar/suspension/exclusion/revocation history.
- Only named official pathways are available. Secondary-school work experience and jurisdiction-permitted working on application are no-clearance exceptions with their specific supervision/risk conditions; higher-education placement and contractor arrangements require evidence of external screening/contract administration. Enforce the pathway-specific jurisdiction, date, supervisor-clearance, risk-plan, application/placement/contract and administering-organisation fields. No generic override.
- Versioned provider role/support requirements for qualifications, induction, training and competence; evidence captures type, issuer/reference, verifier, assessed state, limitation and expiry. Every required item must be current and `met`; a one-shift override is impossible.
- Any known interim bar, suspension, exclusion or revocation always blocks assignment, including where screening would otherwise be `not_required`. Competence is evaluated independently and remains a hard gate.
- Create/reassign validates the complete scheduled interval. Start rechecks live readiness. Provider admins may version future policy; schedulers may only use its server-derived result.
- Preserve office-only worker screening/competence history after membership withdrawal or unlinking.

## Service context and evidence

- Dedicated participant NDIS-identifier relation, separate from ordinary participant data. Admins and schedulers receive masked display. Only an active admin may perform an audited full reveal with a non-empty reason. No worker/portal/cache/analytics projection.
- Versioned participant service context links one participant, one current capability and one catalogue item to an external agreement/plan reference, source type, owner/reviewer, effective dates, goal source/reference/display and lifecycle state.
- Only `active`, current and reviewed contexts schedule work. `draft`, `review_required`, `superseded`, `withdrawn`, `expired`, mismatched, phased and unsupported contexts block new create/reassign/Start but remain historical.
- One immutable shift-service snapshot copies the chosen context/item/category/catalogue version/time unit and goal reference/display. Accepted Start/End derive exact elapsed duration; workers cannot enter billable duration and the CRM applies no pricing/claim rounding.
- Signed agreements/plans/clearances/certificates remain external evidence references in the provider-approved document system; metadata is not presented as document verification.

## Acknowledgement

- Append-only idempotent events are classified as `attempt` or `conclusive`. Attempts (`unavailable`, `not_obtained`) remain history and never replace a conclusive current outcome.
- Before Ticket 08, admin/scheduler may record provider-sourced conclusive externally signed evidence or externally documented decline. Reported signer authority is restricted to participant self, child representative, plan nominee or legal guardian, effective at the event time and scoped to service acknowledgement; method/time and external reference are mandatory. The UI labels these provider-recorded, never participant-authenticated.
- Conclusive events form one immutable chain per service record: exactly one root and at most one accepted successor for each current leaf. A correction supplies the expected current/superseded event plus reason/evidence. The current view is the unique leaf, never simply the latest timestamp.
- Duplicate commands return the original receipt. A stale or concurrent competing successor is preserved in the protected evidence-review path and does not change the current leaf.
- Ticket 08 later adds direct participant/self-link and authorised-representative events. Acknowledgement never gates service-summary finalisation and is not presented as proof of consent or payment.

## Security contract

- Narrow idempotent RPCs only; no browser service key, raw client multi-table write or caller-supplied authority shortcut.
- Every new `SECURITY DEFINER` function has `search_path = ''`, fully qualified relations, no `public`/`anon` execution, explicit authenticated grant, internal active membership/role/tenant/effective-window validation and same-transaction command receipt/audit.
- RLS is enabled on every relation. Admin/scheduler, assigned-worker and future portal projections are explicit; active organisation is navigation context, never sufficient authority.
- Full NDIS reveal is admin-only and audited. Workers/participants/representatives/external recipients cannot read worker compliance records or the identifier.
- Synthetic identities and identifiers only; real data remains blocked by the production privacy/security gate.

## Admin integration

Extend `/app/admin` with role-gated, typed forms and read views for provider scope/capability, catalogue, risk roles/requirements, worker verification/pathways/evidence, masked participant identifier/full-reveal action, service-context lifecycle and provider-recorded acknowledgement. Replace free-text profile identifiers with selectable authorised records where the current data permits. Show persistent readiness reasons and precise recovery actions.

Kevin's acceptance journey must work without SQL editing: configure scope → add time-based item → define role requirements → verify synthetic worker → activate reviewed participant context → create service-ready shift → inspect immutable snapshot and readiness → record an acknowledgement attempt/attestation.

## Out of scope

- Document uploads, live Commission screening, live NDIA catalogue, legal determination, billing/claims/invoices, group/ratio records, multiple-item segments, transport/activity quantities, payroll, full LMS, incident/complaint case management, emergency-plan management and every specialist module.
- Direct participant/representative portal acknowledgement, delivered in Ticket 08.

## Dependencies and ownership

Tickets `04`, `04a`, and completed Ticket `05`. Ticket 05 remains a historical result; this ticket owns its forward API/UI correction. Ticket `06` depends on this ticket and must not consume `legacy_incomplete` rows.

## Required verification

### Migration and API retirement

- Apply 0001→0009 fresh and 0001→0008 with populated synthetic participant/shift/audit/receipt data→0009; preserve rows and constraints.
- A failed transactional migration leaves the 0008 schema/data intact; current-schema migration parsing/catalog checks pass.
- Assert the old eight-argument function is absent/unexecutable and the old UI/wrapper call no longer exists.
- `legacy_incomplete` rows are admin-readable but cannot be copied, started, reassigned as ready, summarised or projected to the worker route.

### Readiness and concurrency

- Accept a shift only when scope/capability/catalogue/context cover the complete scheduled interval, the service kind is individual-time, clearance or a complete named pathway is current, and every required competence item is met/current.
- Negative tests cover every context lifecycle, phased/not-supported/mismatched/cross-tenant scope, unsupported unit/kind, registered-risk/provider/participant screening combinations, missing unregistered policy, missing/expired/barred/suspended/excluded/revoked screening, every incomplete pathway field, missing/expired/failed competence and an uncleared required supervisor.
- Concurrent revocation/expiry versus create, reassign and Start cannot produce a ready action from stale evidence. Revocation after accepted Start preserves events/receipts and creates urgent review state.
- Duplicate command IDs return the original receipt and never duplicate a shift, snapshot, evidence version, reveal or acknowledgement.

### Identifier, acknowledgement and security

- Admin/scheduler masked identifier views never contain the full value; only admin full-reveal with non-empty reason succeeds and produces an audit event. All worker/portal/cross-tenant paths fail.
- Provider-recorded signed/declined events reject missing evidence/actor, a non-allowlisted authority, authority outside its event-time/scope window, and stale expected-current IDs. Attempt events reject missing recorder/reason and never change the conclusive leaf. Tests prove one root, one successor per leaf, duplicate idempotency, competing-correction quarantine, full ledger preservation, and unauthorised/cross-tenant denial.
- Static/catalog assertions cover RLS enabled, fixed empty `search_path`, qualified relations, revoked `public`/`anon`, explicit authenticated grants and no unintended raw write grants.

### User journey and quality gates

- Kevin completes the full synthetic admin readiness journey through the browser with clear errors/recovery, then the resulting shift snapshot is available to Ticket 06's contract.
- Frozen install, lint, typecheck, build, migration parse, isolated database suites, Ticket 05 regression suite, PostgREST named-argument/privilege contract and diff check pass. Browser accessibility checks run when the required browser is available; manual keyboard/zoom/status checks are recorded.
