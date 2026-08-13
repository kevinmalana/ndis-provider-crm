---
title: "NDIS Provider CRM — Personas & Revised v1 User Stories"
kind: spec
---

## Revision note

This revision incorporates the independent UI/UX critique and Kevin's product decisions on 2026-08-06. It replaces the earlier story set. Consent, representative authority, internal work access, participant portal visibility, and external disclosure are distinct concepts. The stories define product behaviour, not legal conclusions; qualified Australian advice remains a production gate.

## Personas and relationships

### Sarah — Provider administrator / scheduler

- Coordinates rosters, invitations, participant records, worker access, and corrections for one provider.
- Works mainly on a laptop while handling interruptions and time-sensitive changes.
- Needs keyboard-efficient views, non-destructive actions, reasons for sensitive changes, and clear organisation context.
- Is not automatically authorised to consent on a participant's behalf; the product must show whose authority supports a disclosure.

### Jordan — Support worker

- Works across participants and potentially multiple providers on an older Android phone.
- Often has poor signal, glare, gloves, one free hand, and limited time for writing.
- Needs minimum current safety information, accurate Start and End timestamps, short participant-readable summaries, and persistent sync/conflict status.
- Must always know which provider and participant context is active.

### Maya — Participant

- Wants to know who is coming, read a plain-English summary of delivered support, see optional external access, and request access or correction.
- May use screen readers, magnification, switch/voice access, Easy Read, or support from another person.
- Her account and choices remain distinct from any nominee, guardian, attorney, or other representative.

### Linda — Nominee or other representative

- Uses a separate account and may help Maya according to a documented authority type, scope, evidence, and effective period.
- Plan nominee, correspondence nominee, guardian, attorney, and informal supporter are not interchangeable labels.
- Needs the product to explain what relationship is recorded, what it permits, and how to request review when it changes.

### Casey — External coordinator or referrer

- Works across many providers and participants using one account with separate grants.
- Needs plain visibility of the active provider, participant, purpose, permitted record categories, expiry, and view-only boundary.
- May also have disability or accessibility needs; the external portal receives the same WCAG 2.2 AA baseline and manual validation as other surfaces.

## v1 user stories

### Provider administrator / scheduler

#### S1.1 — Invite a person into an organisation

<user_quoted_section>As an administrator, I want to invite a person into a defined organisation membership, so that their role is explicit without creating a second global identity.</user_quoted_section>

- **Given** I am authorised to manage memberships in the active organisation
- **When** I invite an email and choose a role
- **Then** the invitation names the organisation, role, issuer, expiry, and material access
- **And** an existing account can accept a separate membership after explicit confirmation
- **And** acceptance never changes another organisation's memberships or grants
- **And** acceptance, decline, expiry, and revocation are audited

#### S1.2 — Create a participant record and record authority separately

<user_quoted_section>As an administrator, I want to create a participant record and record consent or representative authority as separate evidence, so that access is not inferred from a role label.</user_quoted_section>

- **Given** I am authorised in the active organisation
- **When** I create a participant
- **Then** the participant identity is stored separately from consent, supported-decision-making preferences, representative authority, internal work access, portal visibility, and external disclosure
- **And** each authority/consent record captures issuer, authority type, purpose, scope, recipient where relevant, evidence reference, effective date, expiry, and amendment/withdrawal history
- **And** the product does not claim the provider administrator supplied participant consent unless their recorded authority permits it

#### S1.3 — Schedule and reassign a shift

<user_quoted_section>As a scheduler, I want to assign and reassign a worker with a reason, so that everyone sees the current roster without erasing previous assignments.</user_quoted_section>

- **Given** a participant, a worker membership, one active/current/reviewed service context, one individual time-based support item, and an active provider context
- **When** I create or reassign a shift
- **Then** overlap and availability warnings appear
- **And** expired, mismatched, specialist-phased or unsupported provider-scope rows block the assignment
- **And** a registered-provider risk-assessed assignment is blocked unless current provider-recorded clearance or a complete current named screening pathway permits the worker to perform that role
- **And** every provider-required role/support competence item must be current and assessed as met; there is no one-shift override
- **And** affected workers see the change on next sync
- **And** the participant's upcoming visit reflects only the current assignment
- **And** previous/new assignments, actor, reason, and timestamps remain auditable

#### S1.4 — Maintain critical support and safety information

<user_quoted_section>As an authorised provider user, I want to maintain the minimum critical information a worker needs before starting, so that missing or stale information is visible rather than silently trusted.</user_quoted_section>

- **Given** I am authorised to maintain critical information
- **When** I publish or review it
- **Then** it records owner, reviewed time, review-due time, and the minimum worker-visible content
- **And** missing or stale information produces a persistent warning and provider contact action
- **And** the warning does not automatically block essential support
- **And** worker acknowledgement is audited without implying clinical approval

#### S1.5 — Grant or revoke external disclosure access

<user_quoted_section>As an authorised provider user, I want to issue a time-bounded external grant backed by recorded participant or authorised-representative consent, so that the recipient sees only the approved purpose and record categories.</user_quoted_section>

- **Given** recipient identity and current authority evidence are verified
- **When** I create a grant with purpose, scope, participant, recipient, start, and expiry
- **Then** the external user sees only those record categories in that provider context
- **And** the participant can see the optional external grant and request withdrawal/review
- **And** revocation ends future sessions and cached access at the next server contact
- **And** the UI explains that previously exported or disclosed copies cannot be remotely recalled

#### S1.6 — Resolve rejected offline evidence

<user_quoted_section>As an authorised supervisor, I want to review evidence that conflicts with a reassignment, cancellation, or server rule, so that genuine service evidence is never silently discarded.</user_quoted_section>

- **Given** a worker action or summary reached the server in a conflict state
- **When** I review the original payload, claimed local time, server arrival time, current roster state, and worker explanation
- **Then** I can accept it as a late/exception record, request more information, or reject it with a reason
- **And** the worker sees the outcome
- **And** every decision preserves the submitted evidence and audit history under the approved retention policy

#### S1.7 — Correct a finalised service summary

<user_quoted_section>As an authorised supervisor, I want to approve a reasoned correction without overwriting the original, so that the current record is clear and the history remains trustworthy.</user_quoted_section>

- **Given** a worker or participant has requested correction
- **When** I approve a corrected version with a reason
- **Then** the original and every version remain immutable
- **And** the corrected version becomes the current display
- **And** the worker is notified
- **And** the participant sees that a correction occurred and can view the current summary
- **And** the read-only audit view links to, but does not perform, the correction action

#### S1.8 — Declare provider scope without overclaiming specialist capability

<user_quoted_section>As an administrator, I want to record our provider and support scope, so that the CRM shows which common workflows are available and which specialist modules are not yet supported.</user_quoted_section>

- **Given** I am onboarding or updating an organisation
- **When** I record registered/unregistered status, registration groups or support categories, operating jurisdictions, effective dates and provider-owned capability
- **Then** the workspace shows the active scope and whether each row is individual-time-supported, specialist-phased or not supported
- **And** only one-worker/one-participant time-based rows inside the product boundary can be made ready for Ticket 06
- **And** SIL, SDA, high-intensity, early-childhood, specialist support-coordination, behaviour-support and restrictive-practice workflows are clearly labelled phased where no dedicated module exists
- **And** generic shift and summary records are never described as satisfying an unsupported specialist obligation

#### S1.9 — Verify worker eligibility before rostering

<user_quoted_section>As an administrator, I want to verify worker screening and competence for a risk-assessed role, so that an ineligible worker cannot be scheduled.</user_quoted_section>

- **Given** a registered-provider role is classified as risk-assessed and the provider has versioned its required competence evidence for that role/support
- **When** I record the official source checked, verifier, check time, clearance/reference, status, expiry, qualifications/training and any named screening pathway
- **Then** current clearance permits rostering
- **And** only the configured work-experience or working-on-application exception, or an externally administered higher-education-placement/contractor screening arrangement, may substitute for provider-held current-clearance evidence when every pathway-specific condition is current
- **And** required supervisor clearance, jurisdiction, dates, application/placement/contract reference and risk-plan evidence are enforced where the selected pathway calls for them
- **And** missing, expired, suspended or excluded status blocks assignment
- **And** missing, expired or failed provider-required competence evidence also blocks assignment; changing the future role policy never overrides one shift
- **And** screening readiness uses the strictest of registered-provider/risk-role rules, provider policy and any participant/service-context requirement
- **And** an unregistered-provider role must have an explicit effective required/not-required decision; missing policy is not ready, and any known bar, suspension, exclusion or revocation blocks assignment
- **And** the workspace calls this provider-recorded verification evidence, not live Commission verification or a legal determination
- **And** history remains accessible after a worker is withdrawn or unlinked

#### S1.10 — Establish structured service context before a shift

<user_quoted_section>As an administrator, I want each shift linked to the participant's current service context, so that the worker's final record identifies what support was delivered and why.</user_quoted_section>

- **Given** a participant has a service agreement or support plan held in the provider's approved document system
- **When** I record its external reference, owner/reviewer, lifecycle state, effective dates, one support item and participant-goal source/display
- **Then** a shift selects exactly one active, current and reviewed individual time-based context
- **And** the participant's NDIS identifier is restricted to authorised office users and is not exposed on the worker Today list
- **And** a draft, review-required/disputed, superseded, withdrawn, expired, missing or unsupported context blocks the ordinary workflow from being treated as ready
- **And** accepted Start/End produces exact elapsed delivery time without claiming a rounded or billable quantity

### Support worker

#### S2.1 — See current-day assigned work safely

<user_quoted_section>As a worker, I want to see today's assigned shifts and their freshness, so that I know what is safe to act on.</user_quoted_section>

- **Given** I opened the app online within the last 24 hours
- **When** I view Today
- **Then** I see only current-day shifts for the active organisation, ordered by time
- **And** the list shows participant first name, time, a minimal location hint, status, connectivity, and last permission verification time
- **And** full address and safety information appear only inside the assigned shift
- **And** after 24 hours without verification, sensitive actions are blocked with a provider contact path

#### S2.2 — Review critical information before Start

<user_quoted_section>As a worker, I want the minimum current support and safety information before I start, so that I can deliver support safely.</user_quoted_section>

- **Given** I am assigned to the shift
- **When** I open its detail
- **Then** I see full location, access instructions, current critical support/safety information, its last-reviewed time, and provider emergency/incident contact actions
- **And** missing or stale information creates a persistent warning requiring acknowledgement and contact guidance
- **And** I may still Start so the software does not automatically cancel essential support

#### S2.3 — Optionally mark On my way

<user_quoted_section>As a worker, I want to optionally mark On my way, so that the provider can see my intent without making it a prerequisite for support.</user_quoted_section>

- **Given** a current assigned shift
- **When** I use On my way online or offline
- **Then** the event records claimed local time and later server receipt time
- **And** Start remains independently available
- **And** the participant does not receive real-time travel tracking in v1

#### S2.4 — Start and End with distinct timestamps

<user_quoted_section>As a worker, I want separate Start and End actions, so that delivered-support time is not distorted by note writing.</user_quoted_section>

- **Given** I am assigned and the shift is actionable
- **When** I tap Start or End
- **Then** the app records the action, claimed local time, device time-zone/offset, and a unique command identifier
- **And** it shows Pending until the server accepts the action
- **And** End changes the shift to Ended—summary required rather than Completed
- **And** a retry cannot create a duplicate event

#### S2.5 — Submit a participant-readable service summary

<user_quoted_section>As a worker, I want to submit a short structured summary after End, so that the participant has a clear account of delivered support.</user_quoted_section>

- **Given** the shift has ended
- **When** I select provided activities, enter a plain-English summary, review its audience, and submit
- **Then** no photo or audio attachment is offered in v1
- **And** the summary is Submitted locally, then Pending/Syncing until accepted
- **And** successful finalisation makes it visible to the participant
- **And** the final record carries the selected support category/item, participant goal context and actual duration derived from accepted Start and End
- **And** acknowledgement never blocks server finalisation and clearly distinguishes provider-recorded external signed/declined evidence or attempts from a future participant-authenticated portal action
- **And** a provider-recorded signed or declined outcome names the reported actor/authority, method, time and external evidence reference; unavailable/not obtained remain attempt records
- **And** attempts never replace a conclusive outcome, corrections explicitly supersede the expected current event, and competing changes are preserved for review
- **And** only the participant, child representative, plan nominee or legal guardian may be reported as signer/decliner when evidence shows their authority was effective and appropriately scoped at that time
- **And** external users see it only when their active consent-backed grant includes service summaries
- **And** failure/conflict remains persistently visible and routes to worker/supervisor resolution

#### S2.6 — Continue through intermittent connectivity

<user_quoted_section>As a worker, I want current-day assigned work to continue during short outages, so that bad signal does not erase evidence.</user_quoted_section>

- **Given** permissions were verified within 24 hours and the current-day shift was cached
- **When** connectivity is lost
- **Then** only the minimum necessary current-day location/safety data and drafts remain available
- **And** Start, End, optional On my way, and summary commands queue with persistent per-item states
- **And** commands may sync independently so one conflict does not block unrelated shifts
- **And** rejected evidence is quarantined for review, not dropped
- **And** an offline-only draft remains on that device; cross-device resume is promised only after a server draft sync

#### S2.7 — Raise an urgent concern

<user_quoted_section>As a worker, I want an urgent-concern action that is always easy to find, so that a safety issue is not buried in an ordinary service summary.</user_quoted_section>

- **Given** I am viewing Today, shift detail, an active shift, or the summary
- **When** I activate Urgent concern
- **Then** the app shows provider-defined emergency and incident-process contacts and what to do now
- **And** it clearly states that the service summary is not the incident report
- **And** the handoff/acknowledgement is recorded when possible
- **And** full incident investigation and closure remain outside v1

### Participant

#### S3.1 — See upcoming support

<user_quoted_section>As a participant, I want to see upcoming visits, so that I can prepare.</user_quoted_section>

- **Given** my participant account is linked to my record
- **When** I open the portal
- **Then** I see upcoming time windows and current assigned worker identity allowed by provider policy
- **And** I do not need an optional external-disclosure grant to access my own portal
- **And** changed/cancelled/empty states explain what happened without leaking another person's data

#### S3.2 — Read a finalised service summary

<user_quoted_section>As a participant, I want the finalised plain-English summary to appear after successful server acceptance, so that I can understand what was recorded.</user_quoted_section>

- **Given** a summary has finalised
- **When** I open the visit
- **Then** I see actual Start/End times, worker name, activities, current summary version, and correction indicator where relevant
- **And** internal identifiers and audit mechanics are hidden
- **And** pending worker drafts or quarantined conflicts are not presented as final records

#### S3.3 — Request access or correction

<user_quoted_section>As a participant, I want clear access and correction paths, so that my rights are not reduced to discretionary sharing.</user_quoted_section>

- **Given** I am signed in or using an approved identity-verification path
- **When** I request access, flag a summary, or ask for correction
- **Then** the request names the record, reason, submitted time, status, and provider contact
- **And** the portal does not promise an unqualified deletion or disclosure outcome
- **And** the provider handles the request under its qualified policy and records the decision

#### S3.4 — See and review optional access

<user_quoted_section>As a participant, I want to see current representatives and external disclosures separately, so that I understand who can see what and why.</user_quoted_section>

- **Given** current authority and external-grant records
- **When** I open Who can see my information
- **Then** each entry shows relationship/authority type, purpose, record scope, recipient, issuer, effective dates, and review/withdrawal path
- **And** internal provider work access is not misrepresented as optional participant-granted access

### Nominee or other representative

#### S4.1 — Use only documented representative authority

<user_quoted_section>As a representative, I want my separate account to explain my recorded authority, so that I do not accidentally act beyond it.</user_quoted_section>

- **Given** verified authority evidence exists
- **When** I enter the participant context
- **Then** I see the relationship label, permitted actions/records, effective dates, and provider contact
- **And** my access does not automatically mirror the participant
- **And** expired, revoked, disputed, or missing authority produces a non-leaking explanation and review path

### External coordinator or referrer

#### S5.1 — Use a purpose-specific external grant

<user_quoted_section>As an external user, I want one account with separate provider/participant grants, so that I can work across organisations without mixing contexts.</user_quoted_section>

- **Given** at least one active external grant
- **When** I sign in
- **Then** I explicitly select the provider and participant context
- **And** the UI shows purpose, record categories, view-only status, and expiry
- **And** I see only finalised records inside that grant
- **And** no active, expired, revoked, empty, session-expired, or inaccessible-attachment state explains the next safe action without revealing other records

## Cross-cutting acceptance baseline

- WCAG 2.2 AA is evaluated across every role, route, modal, offline/conflict/error/correction state, and supported browser/assistive-technology pair using automated and manual evidence.
- Status is never toast-only: connectivity, pending evidence, conflict, stale critical information, and correction state remain discoverable after the transient announcement disappears.
- Worker interactive controls use a 48×48 CSS-pixel minimum; ordinary controls retain the WCAG 2.2 AA 24 CSS-pixel target-size baseline.
- The active organisation and participant context are visible on sensitive screens.
- Accessibility and disability-inclusive usability assumptions are tested with people who use screen readers, magnification, switch/voice access, alternative input, Easy Read/plain language, and supported decision-making.
- Product copy distinguishes participant, plan nominee, correspondence nominee, guardian, attorney, informal supporter, support coordinator, LAC, and referrer rather than collapsing them into one authority.

## Explicit v1 non-goals

- Billing, claims, plan budgets, or payment reconciliation.
- Public signup, native apps, in-app messaging, real-time participant tracking, worker shift swaps, or goal/outcome modules.
- Photos, audio notes, Auslan video capture, or other service-summary attachments.
- Full incident investigation/case management; v1 provides a critical-information surface and urgent handoff only.
- Unqualified deletion, retention, consent, or regulatory response promises before qualified policy review.
