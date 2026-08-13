---
title: "NDIS Provider CRM — Human-in-the-Loop Runbook"
kind: spec
---

A reference of decision gates that require a human to act before the system proceeds. Each gate describes *who decides, what they need to see, what the choices are, what happens by default if nobody responds, and what is recorded.* This runbook deliberately does **not** invent policies — it describes the gate so a future operator fills the policy with qualified advice (privacy, security, NDIS compliance) before the system enters production.

Use this when:

- Designing or reviewing any flow that touches a sensitive action.
- Onboarding a new provider or operator.
- Responding to incidents, outages, or unusual access patterns.
- Preparing for a production deployment or schema promotion.

## Gate 1 — Invite acceptance

| Field | Value |
| --- | --- |
| **Trigger** | A recipient clicks the single-use invitation link sent by an authorised user. |
| **Human role** | The invitee (the human accepting the invitation). |
| **Required info** | Who invited them, the organisation they are joining, the role being granted, and what the role can see and do. |
| **Decision** | Accept the role as offered, or decline. |
| **Default if no response** | Standard invitations expire after 14 days; the one-time founding bootstrap invitation may use its documented 30-day window. Until expired, an invitation is single-use and stops working after acceptance, decline, revocation, or expiry. |
| **Audit trail** | One append-only event per outcome — "invitation accepted", "invitation declined", or "invitation expired" — with actor, timestamp, organisation, and role. |

**Notes for the operator.** Decide whether a declined invitation can be re-issued by the same inviter without further approval. If the email already belongs to a global account, acceptance adds a separate organisation membership after explicit confirmation; it must not replace another provider context.

## Gate 2 — Role changes

| Field | Value |
| --- | --- |
| **Trigger** | An admin attempts to change an existing user's role within an organisation (for example, scheduler → admin), or grant an additional role. |
| **Human role** | An authorised administrator from the same organisation, with permission to manage membership. |
| **Required info** | Current role, proposed role, the user's recent activity (last sign-in, last action), and an explicit reason the admin enters in free text. |
| **Decision** | Approve, approve with conditions (e.g., scheduled effective date), or reject. |
| **Default if no response** | No change. Role changes do not auto-apply. |
| **Audit trail** | Append-only event capturing the requester, the user affected, before and after roles, the reason, the timestamp, and the outcome. |

**Notes for the operator.** The current bounded administrator-MFA deferral is recorded in the decision log. Until MFA is enforced, an admin promotion must explicitly show the magic-link/shared-inbox risk and the scheduled MFA deadline rather than claiming an MFA check occurred. Workforce offboarding and representative-authority changes are distinct gates; a nominee/representative is not a provider workforce role.

## Gate 3 — Organisation creation

| Field | Value |
| --- | --- |
| **Trigger** | A new provider organisation is being created in the platform. |
| **Human role** | The platform operator (for the pilot, this is the small founding team) acting on a written onboarding request from the provider. |
| **Required info** | Provider legal name, primary contact, Australian Business Number or equivalent identifier, primary region, signed data-processing terms, and the admin user who will own the organisation. |
| **Decision** | Provision the organisation, provision with conditions (e.g., stagger access), or reject. |
| **Default if no response** | No organisation is created. The platform never auto-creates organisations. |
| **Audit trail** | Append-only event capturing the operator, the requester, the data processed, the decision, and the timestamp. |

**Notes for the operator.** Before any production onboarding, qualified Australian privacy, security, and NDIS advice must have reviewed the data-processing terms. Do not bypass this gate for "favours" or informal requests.

## Gate 4 — Authentication recovery and future MFA reset

| Field | Value |
| --- | --- |
| **Trigger** | A user cannot access the invited email account/session/device, or—once MFA is enabled—is locked out of a factor or reports it lost/stolen. |
| **Human role** | The user's organisation administrator, with a secondary confirmation path back to the platform operator if the organisation admin is the locked-out user. |
| **Required info** | Global user identity, affected organisation membership(s), last successful sign-in, reported email/device/factor loss, active sessions/devices, reason, and a separately verified recovery channel. |
| **Decision** | Revoke sessions/device enrolment and approve a verified recovery or factor reset; or reject and require stronger verification. |
| **Default if no response** | No recovery/reset. Revoke a reported lost session/device where safe; the user remains unable to enter protected functions until verified. |
| **Audit trail** | Append-only events for request, verification method, revoked sessions/devices, factor/reset action, decision-maker, timestamp, and outcome—without storing recovery secrets. |

**Notes for the operator.** Magic links remain vulnerable to compromised or shared inboxes, phishing, and forwarding. Recovery must not rely solely on the same compromised email channel. Once MFA lands, offer an accessible recovery path and a phishing-resistant option where supported.

## Gate 5 — Incident acknowledgment

| Field | Value |
| --- | --- |
| **Trigger** | A platform incident is detected — Supabase service outage impacting production, suspicious key activity, an unusual volume of privileged actions, or an alert from monitoring. |
| **Human role** | On-call platform operator (and, when the incident impacts participant data, the provider's primary contact). |
| **Required info** | Incident summary, impacted scope (which providers, which users, which records), start time, current status, and links to live dashboards or status pages. |
| **Decision** | Acknowledge and triage, escalate to incident response, or close as a non-incident. Trigger a notifiable data-breach assessment under the OAIC scheme if participant data is implicated. |
| **Default if no response** | Auto-page after a defined idle window (policy field — not yet set). Automatic mitigations stay conservative; the system never auto-promotes schema or credentials during an unresolved incident. |
| **Audit trail** | Append-only event capturing every status change with operator, decision, and timestamp; the incident itself is logged in the operator's incident system of record. |

**Sub-gates specific to this category:**

- **Supabase outage:** enrolled workers may capture only the bounded current-day offline commands/summaries permitted by the revised offline contract; these remain visibly pending and non-authoritative. Pause fresh consent, invitations, access changes, finalisation, and all operations requiring a current server decision. Resume normal processing only after Supabase is green and integrity/queue checks pass.
- **Key rotation:** before rotating any production secret, two operators must independently confirm and one must trigger the rotation; the audit event names both.

## Gate 6 — Data export

| Field | Value |
| --- | --- |
| **Trigger** | An organisation administrator requests a bulk export of participant, worker, or roster records — for example, for an audit, a regulator request, or a participant access request under the Australian Privacy Principles. |
| **Human role** | Authorised organisation administrator, with a second administrator's sign-off when the export covers participant records. |
| **Required info** | Scope (which records, which participants, which date range), purpose (named — internal review, regulator request, participant access request, etc.), destination, and the requester. |
| **Decision** | Approve, narrow the scope, postpone, or reject. |
| **Default if no response** | No export. Exports never run without an explicit decision. |
| **Audit trail** | Append-only event capturing the requester, approver, scope, purpose, timestamp, and a hash of the produced file. The export file itself carries a watermark identifying the producing organisation. |

**Notes for the operator.** APP 12 (access) and APP 13 (correction) requests by participants are time-bound. The runbook should describe the operator's expected response time. Never include more records than the scope approved — exports that bundle extras are policy violations even when technically possible.

## Gate 7 — Account deletion

| Field | Value |
| --- | --- |
| **Trigger** | A user requests deletion of their account, or an organisation admin requests offboarding of a worker / participant / nominee / external user. |
| **Human role** | The user themselves for self-requested deletion; an authorised organisation administrator for offboarding. Participant or nominee deletions may require platform-operator co-sign-off. |
| **Required info** | Identity of the account, scope of deletion (account only vs. account and linked records where legally permissible), reason, and (for self-request) verification that the requester is the account holder. |
| **Decision** | Approve, approve after a defined cooling-off period, or reject. Participants and nominees get the longest cooling-off window and the most conservative scope defaults. |
| **Default if no response** | No deletion. The system never auto-deletes user accounts. |
| **Audit trail** | Append-only event capturing requester, decision-maker, scope of deletion, timestamp, and (after deletion) a tombstone reference that points to the retention record retained for legal purposes. |

**Notes for the operator.** The blanket 30-day hard-purge promise has been reopened. Soft-delete is allowed, but no automatic hard purge proceeds until qualified per-data-category rules define retention, legal hold, backups, exports/already-disclosed copies, destruction versus de-identification, and which audit fields remain personal information.

## Gate 8 — Merge to the production branch

| Field | Value |
| --- | --- |
| **Trigger** | The platform team is about to merge a build, schema migration, or server-side function into `main`, which Vercel automatically deploys to production. |
| **Human role** | The platform operator approving the merge, with a second operator for releases that include schema changes, security-sensitive configuration, participant-visible data, or new external integrations. |
| **Required info** | Release notes, schema and policy diffs, the access matrix that was re-validated for the change, the recovery rehearsal status, and any open incident or rollback considerations. |
| **Decision** | Approve merge (which triggers production deployment), postpone/request changes, or revert/roll back a deployed commit. |
| **Default if no response** | No merge to `main`; therefore no production deployment. Preview builds may continue automatically. |
| **Audit trail** | Append-only event capturing approver(s), CI/review evidence, change set, merge commit, deployment identifier, timestamp, and any rollback/revert. Combined with migration hashes for traceability. |

**Sub-gates specific to this category:**

- **Schema changes touching multi-tenant or per-participant access** require additional review by a second operator and a written note in the change record referencing the equivalent RLS test cases that were re-run.
- **First deployment of a feature that touches participant-visible data** also requires confirmation that the participant-portal copy and consent flows match the change.

## Gate 9 — RLS policy change review

| Field | Value |
| --- | --- |
| **Trigger** | A database migration adds, modifies, or removes a row-level security policy, a permission helper function, or a storage-bucket access policy. |
| **Human role** | At least two platform operators (the author and a reviewer), with the platform's privacy/security advisor looped in when the change affects who can read participant data. |
| **Required info** | The migration diff, the affected tables or buckets, the access matrix before and after, the new test cases (positive and negative), and a backward-compatibility note for any flows affected. |
| **Decision** | Approve, request changes, or block (e.g., pending legal review). |
| **Default if no response** | No merge. Authorisations change hands only with two recorded approvals. |
| **Audit trail** | Append-only event capturing the author, the reviewer, the migration identifier, the timestamp, the access matrix delta, and the test cases that were exercised. |

**Notes for the operator.** This gate exists because authorisation is the single most consequential layer of the platform. Treat it with the same rigour as a financial-system permission change.

## Gate 10 — Offline-device enrolment and lost-device response

| Field | Value |
| --- | --- |
| **Trigger** | A worker requests offline access on a provider-owned or BYOD phone, or reports an enrolled device lost, stolen, shared, replaced, or compromised. |
| **Human role** | Authorised provider administrator plus the worker; platform operator joins for suspected compromise or failed revocation. |
| **Required info** | Worker/global account, organisation membership, device identifier, supported OS/browser, screen-lock and individual-use confirmation, offline responsibilities, last permission check/sync, cached-data categories, and incident/lost-device details. |
| **Decision** | Approve/enrol, reject, revoke, or suspend offline access; initiate the provider's incident process when participant data may be exposed. |
| **Default if no response** | No offline cache for an unenrolled/unsupported device. A reported lost device is marked revoked immediately server-side; affected cache is purged at next contact, with no claim of remote wipe while offline. |
| **Audit trail** | Enrolment, policy acknowledgement, last verification, revocation/suspension, reported loss, next-contact purge confirmation, decision-makers, and timestamps. |

## Gate 11 — Offline evidence conflict review

| Field | Value |
| --- | --- |
| **Trigger** | A Start, End, summary, or other command reaches the server after reassignment/cancellation or fails an assignment, version, time, or transition rule. |
| **Human role** | Authorised provider supervisor who did not author the original evidence where practical. |
| **Required info** | Preserved original payload, command ID, worker, device, participant/shift, client-reported time and offset, server receipt time, current roster/version, conflict reason, and worker explanation. |
| **Decision** | Accept as late/exception evidence, request more information, or reject with a reason under the approved retention policy. |
| **Default if no response** | Keep the evidence quarantined and non-final; do not discard it, expose it as a participant-final record, or block unrelated commands. |
| **Audit trail** | Original command/receipt, conflict, reviewer, evidence viewed, decision/reason, resulting version/status, notifications, and timestamps. |

## Gate 12 — Synthetic MVP to real-participant-data pilot

| Field | Value |
| --- | --- |
| **Trigger** | The team proposes moving from synthetic test data to any real participant information or real provider operation. |
| **Human role** | Kevin/platform operator, pilot provider accountable owner, and qualified Australian privacy/security/NDIS advisors. |
| **Required info** | Access matrix/RLS evidence; identity and recovery threat model; explicit administrator-MFA deferral risk; device/offline test results; retention/legal-hold schedule; Vercel/Supabase DPA, subprocessors, logs/backups/cross-border flows; incident/breach process; accessibility and disabled-user evidence; restore/rollback rehearsal; open critique findings. |
| **Decision** | Approve real-data pilot, approve with documented conditions and owners/dates, or block. A qualified review may require MFA or other controls earlier than the current product deferral. |
| **Default if no response** | Synthetic data only. No real participant record, address, note, consent, safety information, or attachment enters development, preview, or production. |
| **Audit trail** | Review pack version, each approver/advisor and capacity, conditions, risk acceptances, blockers, decision date, expiry/re-review date, and first authorised data-import event. |

## Operating notes

- Every gate above produces an append-only event. The audit log is the source of truth for after-the-fact review; gates that are not auditable must be reworked.
- Where a policy field is not yet set, treat the most conservative option as the default until the policy is filled in.
- When a gate is the wrong fit for a future change, add a new gate to this document rather than overloading an existing one. New entries are appended at the bottom and existing entries are not edited.
