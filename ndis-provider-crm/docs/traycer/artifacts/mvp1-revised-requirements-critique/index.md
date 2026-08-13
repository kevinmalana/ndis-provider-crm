---
title: "Cold critique — revised MVP 1 requirements and Ticket 05b"
kind: review
---

## Review boundary

Cold review of the requested planning artifacts, their comments (none found), the current application, and completed Ticket 05 commit `1b66d6e`. Official claims were checked against current primary NDIS Commission, NDIA and OAIC material. This is a product/engineering critique, not legal advice.

## Overall recommendation

**Not ready for Ticket 05b implementation.** The direction is materially better, but the ticket is not yet executable against the completed Ticket 05 surface: the old shift RPC and UI can still create records without service context or eligibility, while the new scope, competence, identifier, catalogue, and acknowledgement rules are not specified tightly enough to implement or test safely. Resolve the P0 findings below, then do a short contract pass before Ticket 06.

## P0 — blockers

### P0.1 — Ticket 05 leaves a bypass around every new 05b gate

**Claim/location.** Ticket 05b “Roster enforcement in shift create/reassign RPCs” and “New shifts must select a current common-supported context”; Technical Plan “every newly scheduled ordinary shift selects a current service context”. In commit `1b66d6e`, `supabase/migrations/0008_admin_workspace_rpcs.sql::cmd_admin_create_shift` accepts only participant, worker and times, and `src/app/app/admin/workspace-client.tsx` calls that old signature.

**What breaks.** PostgreSQL overloads functions by signature. Adding a new context-aware function does not remove the existing eight-argument function. The current admin UI therefore remains able to create context-free shifts, and any old client can call the old RPC. Ticket 06 could consume a shift that never passed 05b’s scope, screening or service-context rules.

**Concrete correction.** Make the migration contract explicit: drop/revoke the old signature (or replace it with an intentional hard failure), update the Ticket 05 page, typed wrappers and generated types to the new command, and add a test that an old-signature call and a missing-context call fail. Re-run the end-to-end admin → worker seed against the merged branch, not only isolated 05b SQL.

### P0.2 — Provider scope is a display label, not an applicability decision

**Claim/location.** Decision log 2026-08-10 “all providers may onboard”; Technical Plan “scope is display and workflow configuration”; Ticket 05b “registered/unregistered status … registration groups/support categories … capability state”.

**What breaks.** “Common-supported” is undefined, and no rule maps a registered/unregistered provider, registration group, support category, jurisdiction or effective date to an allowed shift. A provider can select an unsupported or specialist context and still appear ready. This risks an unsafe “NDIS CRM” implication and makes the UI unable to explain why a context is blocked.

**Concrete correction.** Define an organisation-scoped versioned scope matrix: registration status, registration-group/class-of-support code, operating jurisdiction, support category/item, effective window, and provider-owned capability (`common_supported`/`specialist_phased`/`not_supported`). Bind each service context and shift snapshot to one current allowed row; reject expired, mismatched or phased rows in the same transaction. Copy must say which controls are product boundaries versus provider policy. Officially, Practice Standards modules vary by registered provider and supports; the Code of Conduct applies more broadly. See [NDIS Practice Standards](https://www.ndiscommission.gov.au/rules-and-standards/ndis-practice-standards) and [NDIS Commission provider pack](https://www.ndiscommission.gov.au/provider-and-participant-packs/provider-pack).

### P0.3 — “Lawful exception” and competence evidence are not an executable eligibility model

**Claim/location.** Ticket 05b Worker compliance; Technical Plan “a lawful exception is a separate time-bounded record”; UI story S1.9; Verification says current exception is accepted with a warning.

**What breaks.** The ticket has no fixed exception basis/status, approver, jurisdiction rule, risk-plan reference semantics, required supervisor clearance, role/support scope, or expiry/revocation behaviour. It also stores qualification/induction/training as untyped external references but the assignment rule checks only clearance or exception. A worker can therefore be rostered with no role-specific competence evidence, while the product copy suggests eligibility was verified. The application cannot decide legality, but it must not turn an unreviewed free-text assertion into a green-light.

**Concrete correction.** Define a provider-owned role-requirement matrix and evidence lifecycle (required evidence type, issuer/reference, verifier, assessed status, effective/expiry date, limitation and review owner). Define exception fields and states, including approved basis, jurisdiction, supervisor membership whose own clearance is current, risk-plan reference, supported role/scope, start/end and revocation. Choose and document whether missing competence is a hard block or a provider-owned warning; do not imply that recording metadata proves competence. Add race/expiry/revocation tests to create and reassign RPCs. The Commission requires written risk-assessed-role records and clearance/exception details, and expects worker qualifications, training and competence evidence: [worker screening records](https://www.ndiscommission.gov.au/workforce/worker-screening/worker-screening-registered-providers), [training your workers](https://www.ndiscommission.gov.au/workforce/training-workers/guide-for-ndis-providers/training-your-workers).

### P0.4 — Service evidence is named, but the data contract cannot produce a dependable record

**Claim/location.** Ticket 05b “dedicated participant NDIS-identifier relation”, “provider-managed structured support catalogue”, “versioned participant service context”, and “actual quantity/duration derives from accepted Start and End”. Decision log 2026-08-10 restricted identifier/catalogue decision.

**What breaks.** No table/column/RPC contract defines the office role, masking rule, catalogue identity, item-version relationship, service-context status, or shift snapshot foreign key. “Duration” covers time but not quantity/unit for ordinary supports that are not purely time-based. External agreement references and goal text are not evidence that the agreement is current or that the selected item is permitted. The official minimum record includes participant name, NDIS number, delivery date, amount/quantity or hours, and support type; support logs are signed by the participant or authorised person. See [NDIS record-keeping requirements](https://ndis.gov.au/providers/working-provider/reporting-and-recording-keeping/what-are-record-keeping-requirements).

**Concrete correction.** Specify exact relations and RPCs for: office-only NDIS identifier (masked-by-default projection and audited full-value action), provider catalogue row (code/name/source/version/effective window), service context (agreement/plan external reference, status, date window, category/item, goal source and capability), and immutable shift snapshot (including quantity and unit or an explicit time-only support boundary). Validate context/shift dates, scope compatibility and catalogue version atomically. State that external document references are provider evidence pointers, not document verification or live catalogue integration.

### P0.5 — Acknowledgement authority and status can be fabricated or become unresolvable

**Claim/location.** Ticket 05b “separate append-only acknowledgement record”; Technical Plan and Reference Flow statuses `signed`, `declined`, `unavailable`, `not_obtained`; Ticket 06 “missing acknowledgement never changes an accepted summary”.

**What breaks.** There is no actor/authority transition contract: who may record a participant signature, nominee/legal-guardian acknowledgement, decline, unavailability or reason; how representative authority is checked at the event time; what “method” means; or how an external signed source reference is linked. The system could display “signed” from an unauthorised admin, or leave a final record with no safe explanation of who declined and why.

**Concrete correction.** Define an append-only acknowledgement RPC and state machine with actor identity, authority snapshot, method, evidence/reference, timestamp, reason taxonomy, and permitted transitions. Validate current participant self-link or representative authority for participant-side actions; separate provider-entered “unavailable/not obtained” from participant-entered outcomes. Keep finalisation independent, but make the audience copy say acknowledgement is a separate provider record and not proof of consent or payment.

### P0.6 — Migration, RLS and RPC testability is asserted rather than specified

**Claim/location.** Ticket 05b “Forward-only migration”, “SECURITY DEFINER RPCs”, “RLS negatives”, “full isolated database tests”; Technical Plan “migration, rollback and negative RLS/RPC tests cover …”.

**What breaks.** There is no migration number/order, old-function retirement rule, ownership/search-path rule for new `SECURITY DEFINER` functions, or complete negative matrix. The current codebase has table-level RLS and `current_active_organisation_id()`-based projections, while 05b introduces new relations and audited narrow RPCs. A migration can pass parser tests while a worker/participant/second-tenant still reads or calls the new data incorrectly.

**Concrete correction.** Add a written migration contract and test matrix before implementation: apply 0001→current→05b in a fresh database; verify rollback/forward compatibility; reject cross-tenant IDs, stale scope/context, expired/revoked worker evidence, phased support, old shift RPC calls and unauthorised acknowledgement; verify masked/full identifier paths; run concurrent reassignment/expiry tests; assert `SECURITY DEFINER` functions have fixed `search_path`, revoked public execute, explicit authenticated grants, and audit/idempotency receipts. Keep all new table reads behind RLS and all writes behind the intended RPC.

## P1 — material drift and missing handoffs

### P1.1 — Urgent/incident/complaint handoff has no configured destination or receipt

**Claim/location.** Gap audit incident/complaint finding; Technical Plan “provider-defined Urgent concern”; Ticket 06 urgent-help route; Reference Flow “handoff/acknowledgement is recorded when possible”.

**What breaks.** Ticket 05 creates only a free-text critical-information card. Nothing configures the provider’s emergency number, incident owner, complaint route, external Commission/advocacy information, fallback channel, handoff timestamp or acknowledgement. “When possible” is not testable, and a worker can be shown a button that goes nowhere.

**Concrete correction.** Add a small provider contact/handoff contract before 06: configured emergency/incident/complaint contacts and URLs, owner role, fallback phone, active window, and append-only initiated/acknowledged/failed handoff receipt. Keep investigation/case management out of scope. Do not hard-code legal deadlines, but show provider-owned escalation guidance. Officially, all providers are expected to manage complaints; registered providers must notify reportable incidents on applicable 24-hour/five-business-day paths: [complaints guidance](https://www.ndiscommission.gov.au/complaints/complaints-about-supports-and-services-you-provide), [reportable incidents](https://www.ndiscommission.gov.au/rules-and-standards/reportable-incidents-and-incident-management/reportable-incidents).

### P1.2 — “Current service context” has no lifecycle or goal provenance

**Claim/location.** Technical Plan Service context; Reference Flow governing rule; Ticket 05b service evidence.

**What breaks.** Effective dates alone do not say whether an agreement/plan is active, superseded, disputed, withdrawn or provider-reviewed. Goal context is free text with no source or participant-directed review. A shift can select a date-overlapping but superseded context, and later readers cannot distinguish provider commentary from participant goals.

**Concrete correction.** Define context states and supersession rules, require provider review/owner and source type, and snapshot a goal reference plus plain-language display text. The create/reassign transaction must check the shift delivery window against the active context and preserve the selected context even after supersession.

### P1.3 — Completed Ticket 05 UI is not a usable 05b entry point

**Claim/location.** Ticket 05b admin settings/scope; commit `1b66d6e` `src/app/app/admin/page.tsx` and `workspace-client.tsx`.

**What breaks.** The page loads only participants/cards/memberships/shifts/assignments/authorities/grants/availability/audit; it has no provider-scope, screening, competence, NDIS-identifier, catalogue, service-context or acknowledgement views. Forms call untyped RPC names, use free-text profile UUIDs, and reload the entire page after saving. Even if SQL is correct, an admin cannot prepare the synthetic journey without direct database edits—the exact verification boundary Ticket 05b promises.

**Concrete correction.** Treat 05b as an integration ticket: add role-gated forms and read projections for each new record, typed command wrappers, explicit validation/error states, and a seeded end-to-end flow. Acceptance must prove Kevin can configure scope → verify worker → create context → create shift through the UI and then hand the resulting snapshot to 06.

### P1.4 — Privacy/access/correction and participant communication rails remain downstream while 05b adds sensitive records

**Claim/location.** Gap audit privacy/communication findings; Personas S1.2/S3.3; Technical Plan consent/authority sections.

**What breaks.** New worker evidence, NDIS identifiers and service-context references increase sensitive data without a versioned collection/use notice, preferred accessible communication fields, or a defined access/correction request owner/status/refusal path. This does not block synthetic data, but it makes a “full v1 pilot” claim drift from the current product surface.

**Concrete correction.** Keep real-data use gated, but add release evidence that these 05b fields are covered by the provider’s approved collection notice and access/correction runbook. Model request owner, due date, status, outcome/refusal reason and external complaint path before real-data readiness. OAIC guidance says organisations should generally respond to access/correction within a reasonable period usually not exceeding 30 days and requires refusal reasons/complaint mechanisms for correction: [APP 12](https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines/chapter-12-app-12-access-to-personal-information), [APP 13](https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines/chapter-13-app-13-correction-of-personal-information).

## Drift / overclaim to correct in copy

- “NDIS provider CRM” and “all providers may onboard” should be labelled as a product onboarding choice, not a conclusion that every provider/support type is covered. Registered-provider Practice Standards and supplementary modules are support-dependent; unregistered-provider and worker obligations differ.
- “Worker eligibility verified” should mean “provider-recorded verification evidence and policy state”; it is not a live Commission screening integration or an independent legal determination.
- “Evidence-ready” and “representative synthetic journey” should not imply payment-claim sufficiency, incident/complaint compliance, or WCAG conformance until Ticket 10’s human/policy gates are actually complete.

## What is sound

The direction is strong on separating authority models, retaining rejected evidence, deriving actual time from accepted Start/End, snapshotting historical service context, restricting participant identifiers, and keeping specialist modules visibly phased. Those decisions are worth preserving; the blockers are contract and integration gaps, not a reason to expand MVP 1 into full compliance case management.
