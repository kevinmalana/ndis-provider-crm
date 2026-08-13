---
title: "NDIS Provider CRM — Decision Log"
kind: spec
---

Append-only record of settled decisions for the NDIS Provider CRM pilot. New entries are added by PM sessions as resolved questions land. Entries are not edited in place; superseded decisions get a new entry that references the old one. Do not put open questions, proposed approaches, or speculative reasoning here — those belong in chat or in the relevant planning artifact.

Each entry follows the same shape: **Date · Decision · Why · Rejected alternatives · Source.**

## 2026-08-06 · Multi-tenant SaaS with Sydney data residency from day one

**Decision.** The product ships as a multi-tenant software service from the first pilot. All data, identity, and file storage live in the Sydney region (`ap-southeast-2`). There are no separate single-tenant instances for the pilot; isolation between providers is enforced inside the database, not at deployment time.

**Why.** Pilot providers expect a service they can sign into, not a deployment they operate. NDIS participant data carries Australian privacy obligations, and a Sydney compute region is the simplest, most defensible default for meeting the NDIS Commission information-management guidance and the Australian Privacy Principles.

**Rejected alternatives.**

- **Single-tenant deployment per provider** — operationally heavy for a pilot and slower to onboard. Rejected because it adds per-tenant infrastructure before product–market fit.
- **US or EU region hosting** — wrong data-residency posture for Australian participant data. Rejected outright.
- **Residency posture deferred to post-pilot** — would require migration before the platform proves itself. Rejected because moving real participant data twice is a privacy incident waiting to happen.

**Source.** Resolved in PM session ahead of the bootstrap ticket. Recorded here as the foundational tenancy decision. See the epic brief and technical plan for context.

## 2026-08-06 · Invite-only authentication; MFA required for administrators

**Decision.** The product has no public sign-up. Every account — office staff, workers, participants, nominees, and external coordinators — is created via a single-use invitation link issued by an authorised user. Multi-factor authentication is required for provider administrators before they can use the production system. Workers, participants, nominees, and external users may use single-factor sign-in until a future release hardens MFA policy further.

**Why.** The product holds sensitive participant information. A public sign-up surface combined with weak authentication is the single most common way this kind of platform leaks data. Invite-only also lets us model who has access at any point in time and produce a clean audit trail. MFA on administrators closes the highest-risk account class while leaving lighter friction for participants and external users.

**Rejected alternatives.**

- **Public sign-up with email confirmation** — incompatible with the "no public access to participant records" boundary. Rejected.
- **SSO-only (Google / Microsoft)** — better security but creates a dependency on third-party identity providers for a pilot. Rejected for v1; keep on the roadmap.
- **MFA for every user from day one** — improves security but raises accessibility friction for participants and external coordinators with limited digital fluency. Deferred rather than rejected; revisit after the pilot.

**Source.** Resolved in PM session; aligned with the auth posture in the technical plan and the human-in-the-loop runbook (invite acceptance, MFA reset).

## 2026-08-06 · Build stack: Next.js + TypeScript PWA on Vercel; Supabase (Auth, Postgres, RLS, Storage, Realtime) in Sydney

**Decision.** The application is a Next.js (App Router) TypeScript progressive web app hosted on Vercel. The data and identity backend is Supabase running in Sydney. Supabase provides authentication, the Postgres database, row-level security, file storage, realtime updates, and server-side functions. The same stack is used in development and production against separate Supabase projects; the existing experimental Supabase project is not used for real participant data.

**Why.** Next.js gives us a single codebase for the office dashboard and the phone-friendly worker experience without paying for native builds yet. Supabase gives us an authenticated Postgres database with a security model that lives in the database itself — the most defensible place for multi-tenant and per-participant access control. Keeping the same vendor for auth, data, files, realtime, and server-side workflows reduces the number of moving parts in a regulated environment.

**Rejected alternatives.**

- **A custom backend (Express / Fastify) in front of Postgres** — duplicates what Supabase already gives us, slows the pilot, and adds a second security perimeter to audit. Rejected.
- **A headless CMS or low-code platform** — insufficient for the records model and auditability this product needs. Rejected.
- **Multiple cloud providers, one per concern** — operationally heavy and crosses borders that participant data should not cross. Rejected.

**Source.** Resolved in PM session. Aligned with the technical plan and the bootstrap ticket (`01-bootstrap-next-supabase`).

## 2026-08-06 · UI stack: Tailwind v4 + shadcn/ui + Radix, React Hook Form + Zod, Lucide, Inter, date-fns + date-fns-tz, TanStack Table v8, Sonner; Serwist + Dexie for offline; WCAG 2.2 AA floor

**Decision.** The pilot is built with the following UI and form tooling, applied consistently to all surfaces (admin, worker, participant, external):

- **Layout and styling:** Tailwind CSS v4 with design-token CSS variables.
- **Components:** shadcn/ui on Radix primitives — accessible by default and source-owned.
- **Forms:** React Hook Form with Zod validation, the same Zod schemas shared with the server where possible.
- **Icons:** Lucide, consistent across surfaces.
- **Typography:** Inter as the primary face, with a system font fallback.
- **Dates and times:** date-fns with date-fns-tz for worker devices and participant-local time rendering.
- **Tables:** TanStack Table v8 (headless) for admin roster, participant lists, and audit log.
- **Toasts:** Sonner, via shadcn/ui.
- **Offline support:** Serwist (service worker) plus Dexie.js (IndexedDB) so the worker experience keeps working on bad signal.
- **Accessibility floor:** WCAG 2.2 Level AA, validated through axe-core in continuous integration and Pa11y sweeps.

**Why.** Each pick is chosen for a specific reason captured in the design research artifact: accessibility by default (Radix), low-friction styling that pairs with a token layer (Tailwind), responsive forms on cheap phones (RHF), tree-shakable date handling that supports Australian timezones, headless tables we can style and screen-reader-test, and an offline story that survives the dropped-connection reality of mobile work.

**Rejected alternatives.**

- **Material UI** — heavier, more opinionated, and harder to align with our accessible aesthetic. Rejected.
- **Formik or TanStack Form** — slower, less production-tested at the pilot's required scale. Rejected for v1.
- **Luxon or Moment** — heavier runtime and legacy surface area. Rejected.
- **Workbox directly instead of Serwist** — more boilerplate for the same benefit. Rejected.
- **Charts and dashboards in v1** — not needed; deferred to a future release.

**Source.** Resolved in PM session; aligned with `ui-ux-research` and the technical plan.

## 2026-08-06 · Multi-tenant design posture: shared neutral system + constrained theming

**Decision.** All providers share a single base design system — typography, spacing, motion, focus styles, neutral palette, semantic colours, and component structure. Each provider may override a small, validated set of tokens:

- Organisation logo.
- Organisation display name.
- Brand primary colour (validated against accessibility before saving; rejected colours fall back to the base).
- Brand accent colour (same validation).

Locked tokens (typography, sizing, spacing, motion, semantic colours, focus ring, radii) cannot be overridden per tenant. Contrast and other accessibility checks happen at the platform layer, not in the tenant's hands.

**Why.** Free per-tenant theming produces inconsistent accessibility (low-contrast brand colours are common in the disability sector) and inconsistent interaction language, which makes life harder for workers covering shifts across providers and for support staff dealing with incident screenshots. Constrained theming keeps the trust signal — the participant sees their provider's name and colour — without paying the maintenance and accessibility cost of full customisation.

**Rejected alternatives.**

- **No per-tenant theming at all** — fails the trust signal participants need to know they are looking at *their* provider's portal. Rejected.
- **Free per-tenant theming** — fails accessibility and increases maintenance, support, and incident-response surface area. Rejected.
- **CSS-variable theme per tenant with no validation** — same failure mode as free theming, just delayed. Rejected.

**Source.** Resolved in PM session; recorded in `ui-ux-research` and reflected in the bootstrap token-layer plan.

## 2026-08-06 · Platform operator: Open NDIS

**Decision.** The platform operator (the entity accountable for the system, the data, and the runbook gates) is **Open NDIS**, a company. Operator identity, contact details, and any relevant legal-entity identifiers (ABN/ACN) belong on file before the first pilot tenant is onboarded. The platform records the operator as a distinct subject in the audit trail so incident-response and statutory-notification obligations have an accountable party on record.

**Why.** A regulated SaaS handling NDIS participant data needs a named, real-world accountable party from day one — not a placeholder, not a future entity. The choice affects how invitations are issued (the first admin is the operator's admin), how incidents are notified, and how data-breach obligations flow under the Privacy Act 1988.

**Rejected alternatives.**

- **Kevin personally as the operator** — workable for development but wrong for production. Rejected to avoid retrofitting a corporate wrapper onto a live data flow.
- **An external admin (e.g., a third-party MSP) as operator** — viable but doesn't match the founder-controlled pilot model. Deferred rather than rejected.
- **Operator identity deferred until a customer is signed** — would leave the pilot running with no accountable party. Rejected.

**Source.** Resolved in PM session against the human-in-the-loop runbook's "operator required" gate. The exact legal-entity name and ABN are recorded separately and are not echoed into artifacts or chat.

## 2026-08-06 · Admin sign-in: magic link only; MFA deferred to post-pilot

**Decision.** Administrators sign in using a Supabase-issued magic link sent to their email — no password, no SSO. Workers, participants, nominees, and external users follow the same passwordless flow. **Multi-factor authentication is deferred** until the first paying customer or 90 days after the first pilot go-live, whichever comes first.

**Why.** Magic-link sign-in removes the entire password-handling surface from the platform for the pilot (no hashing, no resets, no shared credentials, no phishing surface) while still satisfying the "know your customer" requirements of NDIS information management. Deferring MFA is a deliberate trade-off: it preserves the lightweight onboarding experience for the founding team and pilot tenants, and the deferral is bounded so MFA is reintroduced before any production-shaped commercial exposure.

**Rejected alternatives.**

- **Email + password with magic-link fallback** — adds password handling we don't need yet. Rejected.
- **Google / Microsoft SSO from day one** — creates a third-party identity dependency at a stage where we want to keep the security perimeter simple. Rejected for v1; kept on the roadmap.
- **MFA for every user from day one** — improves security but raises accessibility friction for Deferred (already noted in the prior entry).
- **Passwordless for non-administrators but password + MFA for administrators** — adds MFA back, against the resolved decision. Rejected.

**Source.** Resolves and supersedes the "MFA required" portion of the 2026-08-06 auth entry. The bounded deferral window and the operator-accepted risk of a notifiable data breach in the interim are recorded alongside this entry.

## 2026-08-06 · Invitation rules: role-scoped invite authority

**Decision.** The platform is fully invite-only. Invitations are issued according to role:

- **Administrators** may invite any other role, including other administrators.
- **Schedulers** may invite workers and participants / nominees, but may not invite other administrators, schedulers, or external coordinators.
- **Workers, participants, nominees, and external coordinators** may not issue invitations.

Each invitation is single-use, time-bounded (default expiry 14 days), audit-logged at issue and at acceptance, and revocable by any administrator.

**Why.** Limiting invite authority to the roles that genuinely need it reduces the blast radius of a compromised account: a worker account cannot silently grant itself the ability to bring in arbitrary external coordinators, and a compromised scheduler cannot escalate to administrator status. Single-use, expiring, revocable invitations with an audit trail are the minimum acceptable posture for a regulated environment.

**Rejected alternatives.**

- **Anyone signed in can invite** — far too permissive. Rejected.
- **Admin can invite only via a separate approval workflow** — unnecessary friction at the pilot's scale. Rejected for v1.
- **Invitation never expires** — incompatible with the audit-and-revoke posture. Rejected.

**Source.** Resolved in PM session; the human-in-the-loop runbook's "invite acceptance" gate is designed against this rule.

## 2026-08-06 · Account deletion: soft-delete with 30-day recovery

**Decision.** When a platform tenant or an individual user account is deleted, the operation is a soft-delete. The record is retained (and unrecoverable to the user) for **30 days**, after which a hard-delete worker purges PII while preserving an audit-trail skeleton (subject names, actor names, timestamps, action types) for compliance retention.

**Why.** Pilot tenants occasionally delete an account in haste and need to recover; workers rotate off rosters and rejoin later. Hard-delete on request would lose the operator's ability to investigate post-hoc complaints or regulator inquiries. Thirty days balances the platform operator's recovery obligation against the participant's right to have their data removed at the earliest reasonable point.

**Rejected alternatives.**

- **Hard-delete immediately on request** — incompatible with the platform's audit obligations and the operator's incident-response duty. Rejected.
- **Soft-delete indefinitely** — defeats the participant's interest in timely deletion. Rejected.
- **Anonymous-keep (anonymise PII, retain structurally for analytics)** — acceptable for aggregate metrics but harder to defend for individual-record audits. Rejected for v1; revisit when analytics requirements mature.

**Source.** Resolved in PM session; aligned with the human-in-the-loop runbook's "account deletion" and "data export" gates.

## 2026-08-06 · v1 scope lock — UI/UX, integrations, and platforms

**Decision.** The v1 pilot release explicitly does not include the following. They are recorded here so a later ticket that proposes them must justify adding them against this baseline.

- **"On my way" step** on a shift is **optional** in v1. A worker can start a shift without tapping "on my way."
- **Audio notes** for service notes are **out** in v1; notes are text only.
- **Real-time participant in-transit view** is **out** in v1. The participant portal shows shift time, worker name, and a post-shift service-note summary — nothing real-time.
- **Auslan / BSL video** in the participant portal is **out** in v1. Accessibility commitments remain at WCAG 2.2 AA; Auslan support is a known follow-up.
- **Billing and NDIS claims** are out in v1. Service records are captured accurately and exported; no invoice generation, no claim submission.
- **In-app messaging** between workers, participants, and offices is out in v1.
- **Shift-swap marketplace** (workers picking up / trading shifts through the platform) is out in v1.
- **Native iOS and Android apps** are out in v1. The product is the Next.js PWA only.
- **Public sign-up** of any kind (workers, participants, anyone) is out in v1. Every account is invite-only.

**Why.** This product must be valuable before it is broad. Each excluded item is a meaningful feature that, if added now, would either expand the compliance surface (e.g., in-app messaging brings confidentiality obligations into the application), duplicate effort that better fits a v2 release (shift-swap marketplace), or push us off the PWA path (native apps). Locking the boundary prevents scope drift.

**Rejected alternatives.** Each excluded item above was considered and explicitly removed from v1. None are rejected forever; all are accepted candidates for v2 evaluation.

**Source.** Resolved in PM session against the brief, the UI/UX research artifact, and the reference worker flow. The "On my way" optionality is reflected in `reference-flow-shift-and-service-note`. Audio notes and Auslan video are deferred accessibility features tracked separately.

## 2026-08-06 · Separate participant, representative, internal, and external access authority

**Decision.** Participant self-access, supported-decision-making preferences, nominee/representative authority, provider internal work access, participant portal visibility, and optional external disclosure are separate product concepts. Participants use their own accounts. Nominees and other representatives use separate accounts limited by the recorded type, scope, evidence, and effective period of their authority. External grants require recorded participant or authorised-representative consent naming the purpose, recipient, record categories, and expiry. One blanket “nominee” or “provider role” grant must not stand in for these relationships.

**Why.** The earlier artifacts conflated consent, legal/representative authority, internal operational access, and optional external sharing. That could allow disclosure without evidence of who authorised it and could incorrectly make participant access/correction discretionary.

**Rejected alternatives.**

- **Provider-managed sharing alone** — too weak because it lets an administrator grant external access without recording the participant-side authority supporting the disclosure.
- **A nominee automatically mirrors the participant** — rejected because different representative relationships carry different authority.
- **Deferring nominee and external portals** — would reduce risk, but Kevin chose to retain these roles with a stricter model.

**Source.** Resolved with Kevin during `traycer-revise-requirements`, responding to critique finding C1. Supersedes conflicting access-grant language in the earlier brief, stories, and business overview.

## 2026-08-06 · Participant-readable summaries, no attachments, and a separate urgent handoff in v1

**Decision.** After a worker records a separate actual End time, they submit a short structured, plain-English service summary. It becomes visible to the participant automatically after successful server finalisation. External users see it only when their current consent-backed grant includes service summaries. V1 offers no service-note photos or audio. Current minimum critical support/safety information is shown before Start; missing or stale information creates a persistent warning, acknowledgement, and provider-contact action but does not automatically block essential support. An always-visible urgent-concern action hands off to the provider's emergency/incident process; full incident investigation and case management remain outside v1.

**Why.** A known audience reduces worker uncertainty and discretionary sharing. Removing attachments avoids purpose, consent, bystander, metadata, retention, and offline-device risks that the pilot has not designed. Separating urgent concerns prevents safety issues being buried in an ordinary service summary.

**Rejected alternatives.**

- **Internal note plus mandatory provider review before participant visibility** — adds an office bottleneck and delays the participant's record.
- **Provider chooses sharing record by record** — preserves the ambiguity criticised in the original artifacts.
- **Full incident management in v1** — expands the pilot beyond its service-delivery focus.
- **Blocking Start when critical information is stale** — risks automatically cancelling essential support; warning, acknowledgement, and contact are the safer product behaviour for v1.

**Source.** Resolved with Kevin during `traycer-revise-requirements`, responding to critique findings C4 and C5.

## 2026-08-06 · Evidence-preserving worker lifecycle, bounded offline access, corrections, and multi-provider identity

**Decision.** On my way remains optional. Start and End are distinct actions; End captures actual delivered-support time and moves the shift to “summary required.” Offline commands and summaries show persistent per-item states and are never silently dropped; a rejection or conflict preserves the original evidence for authorised supervisor review. Offline participant data is limited to minimum necessary current-day assigned work for no more than 24 hours since the last permission verification. A finalised summary can be corrected only through an authorised supervisor workflow that preserves immutable versions, reason, worker notification, and a participant-visible correction indicator. One global account may hold separate organisation memberships and participant grants, with an explicit active-organisation context.

**Why.** The earlier flow could distort end time, lose evidence after cancellation/reassignment, block an entire FIFO queue, expose seven days of participant data after authority changed, and could not support people working across multiple providers. Immutable corrections keep the current record usable without rewriting history.

**Rejected alternatives.**

- **Submitting the summary ends the shift** — note-writing time would distort actual support time.
- **Seven days of offline participant data** — unnecessary exposure after reassignment, revocation, or device loss.
- **Draft-only offline mode** — too fragile for field work with intermittent connectivity.
- **Separate account per provider or single-provider pilot identities** — creates avoidable user friction and contradicts the multi-provider product direction.
- **Worker self-edit window** — adds version and offline-conflict complexity; workers and participants request correction instead.

**Source.** Resolved with Kevin during `traycer-revise-requirements`, responding to critique findings C2, C3, M2, and M4.

## 2026-08-06 · MVP test target is the full v1 pilot scope, built in staged slices

**Decision.** Kevin chose the **full v1 pilot scope** as the MVP target for testing: scheduler/admin operations, worker shift and text service-summary flow, bounded offline support, participant/nominee portal, and externally granted view-only access. Implementation is staged so each working slice can be tested with synthetic data before the complete role journey is ready. No real participant data is used during MVP testing.

**Why.** A clickable demo of only the worker flow would not validate the product's central promise: one trustworthy, permissioned record shared across office staff, workers, participants, nominees, and authorised external people. Staged delivery preserves fast feedback without replacing that outcome with a narrower product.

**Rejected alternatives.**

- **Core operations loop only** — faster first screen-level validation, but insufficient to test consent/authority and cross-role sharing. Rejected as the MVP target; it remains the first staged slice.
- **Core loop plus participant portal, with external/offline later** — validates more of the experience but leaves two material v1 promises untested. Rejected as the target scope.

**Source.** Kevin's 2026-08-06 MVP test-boundary decision. Execution tickets `04`–`10` implement this decision without importing real participant information.

## 2026-08-06 · Forward identity migration, enrolled offline devices, and retention-policy reset

**Decision.** Correct the current single-organisation profile design through a forward migration before domain data exists, preserving existing identities, invitations, and audit history. Offline participant data is permitted only on approved, individually enrolled provider-owned or BYOD devices that meet the supported OS/browser, screen-lock, no-shared-use, encrypted-cache, and lost-device process. The previous blanket 30-day hard-purge promise is reopened: soft-delete remains, but no automatic purge worker is built until qualified per-data-category retention, legal-hold, destruction/de-identification, backup, export, and audit rules are approved.

**Why.** Rebuilding would repeat setup unnecessarily, deferring the identity correction would make multi-provider users expensive to unwind, unrestricted BYOD would expose cached participant information, and a universal 30-day purge can destroy records that must be retained while still leaving personal information in audit data.

**Rejected alternatives.**

- **Rebuild Supabase from scratch** — unnecessary while the existing foundation can be migrated safely.
- **Any signed-in phone may cache data** — insufficient control for participant addresses and critical information.
- **Keep 30 days for every category or retain indefinitely** — neither is defensible without the missing data-category policy.

**Source.** Resolved with Kevin during `traycer-revise-requirements`; supersedes the hard-purge portion of the earlier account-deletion entry and the single-organisation assumption in tickets 01/03.

## 2026-08-06 · Direct Supabase RPC for sensitive state transitions

**Decision.** The PWA talks directly to Supabase. Start, End, optional On my way, summary finalisation, conflict review, and correction use narrow transactional Postgres RPC functions—not raw multi-table writes and not a separate custom API service. Each command validates current authority/assignment/version, is idempotent, records client and server times, applies one transition, preserves conflicts, and appends audit data in the same transaction.

**Why.** This keeps the MVP architecture simple while meeting the evidence-preservation and retry guarantees required by the revised worker flow.

**Rejected alternatives.**

- **Raw table writes** — transition, idempotency, audit, and conflict handling would become scattered and weaker.
- **Separate Next.js/Edge command API** — workable but unnecessary infrastructure for the MVP.
- **Manual supervisor import** — too error-prone and operationally expensive.

**Source.** Kevin selected the direct-Supabase RPC compromise during `traycer-revise-requirements` after reviewing the consequences of raw writes.

## 2026-08-06 · Magic-link MFA deferral reaffirmed with explicit residual risk

**Decision.** Keep the earlier bounded administrator-MFA deferral: magic-link-only for the synthetic MVP and until the first paying customer or 90 days after pilot go-live, whichever comes first. This does **not** mean magic links eliminate phishing or independently satisfy regulatory identity requirements. Before real participant data, the release record must name the risk owner and document phishing/shared-inbox exposure, accessible recovery, session/device revocation, and qualified review; that review may impose a stricter go-live condition.

**Why.** Kevin chose the lower-friction pilot path while accepting that security evidence and recovery controls must be honest and explicit.

**Rejected alternatives.**

- **Administrator MFA before any real participant data** — security-recommended, but not selected by Kevin at this revision point.
- **MFA for every user before pilot** — adds larger accessibility and onboarding work.
- **Claims that magic links remove phishing** — factually unsafe and superseded.

**Source.** Reaffirms the earlier bounded deferral while superseding its overclaimed phishing/compliance rationale, responding to critique finding C6.

## 2026-08-06 · 48-pixel worker controls and historical ticket preservation

**Decision.** Worker interactive controls use a 48 CSS-pixel minimum; ordinary controls retain the WCAG 2.2 AA 24 CSS-pixel baseline. Audio, haptics, vibration, and Background Sync are optional enhancements only. Completed tickets 01–03 remain status 2 as historical records of what was built and verified; concise supersession notes identify changed assumptions, and corrective work lives in new tickets.

**Why.** A 48-pixel field standard better accommodates Android conventions, gloves, glare, and motor variance. Preserving ticket history keeps the audit trail truthful instead of rewriting old acceptance criteria after requirements changed.

**Rejected alternatives.**

- **44 pixels for worker controls** — viable on some platforms but less conservative for the field-work context.
- **Reopen or rewrite completed tickets** — confuses implementation history with future corrective scope.

**Source.** Research reconciliation plus Kevin's ticket-history choice during `traycer-revise-requirements`.

## 2026-08-06 · Vercel automatically deploys every merge to main

**Decision.** `main` remains the Vercel production branch and every merge to it deploys live automatically. Preview builds may run automatically on other branches. The human go/no-go decision moves before merge: required CI and reviews must pass, and schema/authorisation/security-sensitive changes require the recorded second review defined in the runbook.

**Why.** Kevin prioritised a fast, simple release path while retaining an explicit control point at merge approval.

**Rejected alternatives.**

- **Manual promotion after merge/build** — stronger separation between merge and release, but not selected.
- **Automatic only for app-only changes** — classification complexity and mistakes outweigh the flexibility for the pilot.

**Source.** Resolved with Kevin during the final consistency pass of `traycer-revise-requirements`; supersedes the explicit-promotion wording in the revised technical plan and human runbook, while confirming the existing Vercel runbook behaviour.

## 2026-08-06 · Compliance, security, accessibility, and research claims require evidence

**Decision.** Sydney hosting, magic-link authentication, Radix/shadcn components, automated axe/Pa11y output, and chosen open-source libraries are useful inputs but do not by themselves prove Australian privacy/NDIS compliance, phishing resistance, WCAG conformance, or licence clearance. Each release uses the evidence and human-review gates in the revised technical plan. Competitor/persona observations remain labelled hypotheses until dated sources and user research validate them.

**Why.** The original artifacts converted reasonable design choices into claims stronger than the available evidence. That would encourage downstream tickets and customers to treat assumptions as verified facts.

**Rejected alternatives.**

- **Keep “accessible by default” and compliance shorthand** — concise but misleading.
- **Remove every unvalidated choice** — unnecessary; retain choices while naming their evidence boundary and verification work.

**Source.** Factual correction from both independent critiques, adopted during `traycer-revise-requirements`; supersedes contrary rationales in earlier decision entries without changing the underlying stack choices.

## 2026-08-10 · Existing local credentials authorised for synthetic development testing

**Decision.** Kevin considers the credentials currently stored in the main checkout's uncommitted `.env.local` suitable for the present development context and authorises their use for synthetic build and test work. Credential rotation is deferred until later at Kevin's request. Secret values must never be copied into artifacts, source control, agent worktrees, logs, screenshots, or chat responses; the service-role credential remains server-only and no real participant data may be used.

**Why.** The immediate objective is synthetic MVP development and testing. Recording the boundary avoids repeatedly asking Kevin to restate it while keeping credential values out of durable project records.

**Rejected alternatives.**

- **Require immediate rotation before any synthetic testing** — deferred by Kevin for the current development stage.
- **Copy credentials into ticket worktrees or shared artifacts** — rejected because it expands access and creates avoidable leakage risk.
- **Use the credentials with real participant data** — outside the synthetic MVP boundary and not authorised.

**Source.** Kevin's explicit 2026-08-10 instruction to remember that the existing `.env.local` credentials are authorised for current build/test work and will be changed later.

## 2026-08-10 · Broad provider onboarding with phased specialist modules and evidence-ready common records

**Decision.** MVP 1 permits any NDIS provider to onboard and records its registered/unregistered status, registration groups or support categories, and operating jurisdictions. The common CRM supports ordinary shift-based records; SIL, SDA, high-intensity supports, early childhood, specialist support coordination, behaviour support and restrictive-practice workflows remain explicitly phased until dedicated modules exist. The product must not imply that a generic shift or summary satisfies those specialist obligations.

For risk-assessed roles, rostering is blocked unless the provider has recorded either a current clearance or a lawful, time-bounded exception with supervisor and risk-plan reference. Missing, expired, suspended or excluded status blocks assignment. Screening is provider-verified in MVP 1 using source, verifier, verification time, status, expiry and evidence reference; there is no claimed live Commission integration and no clearance-document upload.

Service evidence uses structured metadata and external document references: restricted NDIS identifier, service-agreement/support-plan reference and effective dates, support category/item, participant goal context, accepted Start/End duration, and separate participant or authorised-representative acknowledgement status. Acknowledgement does not block finalisation; signed, declined, unavailable and not-obtained-with-reason are distinct outcomes. Signed source documents remain in the provider's approved document system during MVP 1.

**Why.** Official-gap research found that broad onboarding without capability boundaries would overclaim specialist support, while invitations and free-text summaries alone do not establish worker eligibility or common NDIS delivery evidence. Structured records preserve a usable cross-provider core without introducing specialist modules or a document-storage lifecycle before those are designed.

**Rejected alternatives.**

- **Full specialist-module support in MVP 1** — rejected because it would replace the narrow pre-worker correction with a large behaviour-support, restrictive-practice, SIL, SDA, high-intensity and other module program.
- **Warning-only worker screening** — rejected because it permits known missing, expired, suspended or excluded eligibility to be rostered without a documented lawful exception.
- **Participant acknowledgement required before summary finalisation** — rejected because it can leave delivered-support evidence permanently unfinished when acknowledgement is unavailable; acknowledgement remains separately visible and auditable.
- **Upload agreements and clearance documents now** — rejected because it introduces file scanning, access, retention, download and disclosure controls before the approved document lifecycle exists.

**Source.** Kevin's choices during `traycer-revise-requirements`, following the 2026-08-10 official MVP 1 gap audit.

## 2026-08-10 · Restricted participant identifiers and versioned provider support catalogue

**Decision.** Store the participant NDIS number in a dedicated office-only relation, separate from the ordinary participant record, protected by RLS and exposed only through a narrow audited server command that returns a masked value unless an explicitly authorised office action requires the full identifier. Synthetic values only are permitted until the real-data privacy/security review approves the handling. Workers, representatives and external users never receive the identifier through the Today, shift, summary or portal projections.

Support categories/items use a provider-managed structured catalogue with code, name, source/catalogue version and effective dates. Each scheduled shift snapshots the selected code/name/version and participant goal context so later catalogue edits do not rewrite historical service evidence. MVP 1 makes no claim of a live NDIS catalogue integration.

**Why.** A free-text support item is too weak for dependable evidence, while a live integration is not available in the current architecture. Separating the government-related identifier minimises its exposure and creates a clear place for audited access and future encryption/key-management review.

**Rejected alternatives.**

- **Application-level encryption in 05b** — deferred because it introduces key creation, rotation, recovery and incident procedures before the synthetic worker loop; real data remains gated.
- **External-system reference without the NDIS number** — rejected because it leaves common service evidence structurally incomplete.
- **Free-text or claimed live support catalogue** — rejected respectively for inconsistent evidence and an unsupported integration claim.

**Source.** Kevin's technical choices during `traycer-revise-requirements`, following the 2026-08-10 official MVP 1 gap audit.

## 2026-08-10 · Narrow the representative worker loop and remove generic compliance overrides

**Decision.** The first representative worker loop supports one worker delivering one individual, time-based support item to one participant per shift. The accepted Start and End determine exact elapsed delivery time; MVP 1 does not calculate billable quantities, catalogue rounding, group ratios, transport units, activity-based quantities or multiple support-item segments. Providers of other support types may onboard, but those workflows remain `specialist_phased` or `not_supported` and cannot be made ready for Ticket 06.

The provider selects its organisation-scoped supported rows within that product boundary. The CRM enforces current registration/scope configuration, jurisdiction, support item, effective dates and capability state; expired, mismatched, phased and unsupported rows block new shift creation and reassignment. This is provider-recorded policy configuration and product workflow gating, not a legal determination by the CRM.

For registered-provider risk-assessed roles, only named official pathways may substitute for provider-held current-clearance evidence: formal secondary-school work experience or jurisdiction-permitted working on application as no-clearance exceptions, and higher-education placement or contractor arrangements where screening/contract administration is verified through the external organisation. Every pathway-specific condition must be complete and current; there is no free-text generic exception. Separately, every provider-required qualification, induction, training or competence item for the assigned role/support must be current and provider-assessed as met; missing, expired or failed required evidence blocks assignment. An authorised admin may version future role requirements but cannot override one shift.

Each shift selects exactly one active, current and reviewed service context and one support item. Draft, review-required/disputed, superseded, withdrawn and expired contexts remain historical but cannot schedule new work. The shift snapshots the item and participant-goal source/display. Acknowledgement remains separate from summary finalisation: before Ticket 08, office staff may attest receipt of externally signed evidence or a documented decline, naming the reported signer/authority, method, time and external evidence reference; `unavailable` and `not_obtained` are provider attempt records. The UI never describes those office records as participant-authenticated. Ticket 08 later adds direct participant or currently authorised-representative confirmation.

**Why.** The cold critique showed that “ordinary shift”, “lawful exception”, “competence evidence” and “signed acknowledgement” still allowed materially different and unsafe interpretations. The narrower boundary makes readiness testable without pretending the CRM covers every support type, determines legal eligibility, performs billing, or authenticates a participant action that happened outside the app.

**Rejected alternatives.**

- **Several support items or group supports in one MVP shift** — rejected because they require segmented quantities, attendance and ratios that Ticket 06 does not model.
- **CRM-maintained legal applicability engine or warning-only provider scope** — rejected respectively for regulatory maintenance/overclaim risk and bypassable readiness.
- **Generic provider-defined screening or competence override** — rejected because an unstructured assertion must not become a green assignment result.
- **Provider-entered billable duration or catalogue rounding** — rejected because evidence time and claiming policy are different concerns.
- **Office-entered acknowledgement shown as participant-authenticated** — rejected because it misstates the actor and authority behind the record.

**Source.** Kevin's explicit choices during the 2026-08-10 critique-fix `traycer-revise-requirements` discussion, informed by current NDIS Commission worker-screening/training guidance and NDIA record-keeping guidance.

## 2026-08-10 · Retire the context-free shift API through a forward Ticket 05b migration

**Decision.** Keep completed Ticket 05 as a truthful historical record. Ticket 05b owns transactional migration `0009`, retires the old eight-argument `cmd_admin_create_shift` signature, replaces it with a distinctly named service-ready command, updates the Ticket 05 admin UI/types/wrappers, and tests that stale clients and missing-context calls fail. Existing context-free shifts become admin-readable `legacy_incomplete` history; they cannot be copied, started, finalised or exposed to Ticket 06 as ready.

The new create/reassign transaction locks and checks the organisation scope/capability, active reviewed service-context version, immutable catalogue item, worker membership, screening clearance/named pathway and all provider-required competence evidence for the full scheduled window. Start rechecks current readiness. Revocation after an accepted Start preserves evidence and raises an urgent provider-review state rather than deleting or silently completing it.

Participant NDIS identifiers remain in a separate relation with no worker/portal projection. Admins and schedulers receive masked display; only an active admin may perform an audited full-value reveal with a non-empty reason. Acknowledgement is an append-only idempotent event ledger with a derived current view; correction/supersession never overwrites the earlier event.

Every new `SECURITY DEFINER` RPC uses an empty fixed `search_path` and fully qualified relations, revokes execution from `public` and `anon`, grants only the intended authenticated surface, and rechecks role/tenant/effective state inside the transaction. Migration and command tests cover populated upgrade, old-signature retirement, cross-tenant access, expired/revoked evidence, phased scope, concurrent revocation/reassignment/Start, identifier masking/reveal and unauthorised acknowledgement.

**Why.** PostgreSQL treats a changed function argument list as a separate overload, so merely adding service-context parameters would leave the Ticket 05 bypass callable. A forward corrective migration preserves completed-ticket history while making the runtime boundary unambiguous and testable.

**Rejected alternatives.**

- **Rewrite completed Ticket 05** — rejected because it obscures what was built and reviewed; 05b is explicit corrective integration work.
- **Leave the old command with a warning or automatic context backfill** — rejected because either preserves the bypass or fabricates evidence.
- **Check eligibility only when rostered** — rejected because expiry or revocation before Start would be ignored.
- **Mutable acknowledgement row** — rejected because actor, attempts and corrections could diverge from the audit trail.

**Source.** Kevin's explicit technical choices during the 2026-08-10 critique-fix `traycer-revise-requirements` discussion.

## 2026-08-10 · Layer screening policy and make acknowledgement precedence explicit

**Decision.** Worker-screening readiness uses the strictest applicable rule. For a registered provider, key personnel and roles the provider classifies as risk-assessed follow the registered-provider requirement. A provider may voluntarily require screening for additional roles. For an unregistered provider, each relevant role has an explicit versioned `required` or `not_required` provider decision with owner, reason and effective period; a missing decision is not ready. A participant/service context may also require a screened worker. If any applicable layer requires screening, current clearance or the already-approved named pathway contract is mandatory. Provider-required competence evidence remains mandatory regardless of whether screening is required. Any known interim bar, suspension, exclusion or revocation blocks assignment even when another policy layer says screening is not required.

Acknowledgement attempts and conclusive outcomes are distinct. `unavailable` and `not_obtained` are attempt history and never replace a signed or declined outcome. The first conclusive provider-recorded event establishes the current sourced outcome. A correction must name the current event it supersedes and give a reason; competing changes against a stale expected current event are preserved for authorised review rather than resolved by timestamp or actor ranking. Before Ticket 08, a provider-recorded signed/declined event may identify only the participant, child representative, plan nominee or legal guardian, with evidence-backed authority effective at the reported event time and scope that permits service acknowledgement. The UI continues to label the event provider-recorded, not participant-authenticated.

**Why.** Current Commission guidance distinguishes mandatory registered-provider screening from optional unregistered-provider screening, while allowing providers and participants to require it. A layered strictest-rule model represents that distinction without weakening a recorded safety choice. Explicit acknowledgement supersession prevents a later attempt, staff edit or concurrent request from silently rewriting stronger evidence.

**Rejected alternatives.**

- **Require screening for every worker as if legally mandatory** — rejected because it misstates the unregistered-provider position, even though providers may adopt that product policy.
- **Default unregistered-provider screening to not required** — rejected because it ignores provider/participant choice and makes missing policy look approved.
- **Newest acknowledgement wins or fixed actor ranking** — rejected because timing or a simplistic hierarchy can silently overwrite evidence and mishandle authority disputes.
- **Any current representative may sign/decline** — rejected because informal supporters and different nominee/guardian relationships are not interchangeable.

**Source.** Kevin's explicit choices during the 2026-08-10 P0-closure `traycer-revise-requirements` discussion, informed by current NDIS Commission registered/unregistered worker-screening guidance and NDIA support-log guidance.

## 2026-08-10 · Compute screening readiness and chain conclusive acknowledgements immutably

**Decision.** Persist a versioned screening-policy decision per relevant provider role. Readiness is computed using the strictest rule: registered-and-risk-assessed, provider-required, or participant/service-context-required. An unregistered-provider role with no explicit effective provider decision is unready. When screening is required, current clearance or a complete permitted named pathway is required. A recorded interim bar, suspension, exclusion or revocation always blocks, including when another layer says screening is not required. Competence requirements are evaluated independently and always remain mandatory when the provider marked them required.

Store acknowledgement attempts and conclusive outcomes as immutable event classes. Each service record may have one conclusive root; each accepted correction names the expected current event and may create only one successor. The current outcome is the unique conclusive leaf. Attempt events never join or replace the conclusive chain. Duplicate commands return the original receipt; a stale or competing successor is preserved in the evidence-review path without changing the current leaf. Provider-recorded signer authority is checked against the strict allowlist and authority effective at the reported event time.

**Why.** A computed predicate prevents UI/admin discretion from weakening the strictest applicable screening choice. The single-chain invariant produces one deterministic current acknowledgement under retries and concurrency without mutating or timestamp-ranking historical evidence.

**Rejected alternatives.**

- **Let a not-required policy override a known adverse status** — rejected because recorded exclusion/suspension cannot safely become assignable.
- **Mutable current acknowledgement row or latest-timestamp view** — rejected because either can drift from history or silently select a race winner.

**Source.** Kevin's final technical choices during the 2026-08-10 P0-closure `traycer-revise-requirements` discussion.

## How to add a new entry

1. Use today's date in `YYYY-MM-DD` format.
2. Title the entry with the decision in one sentence.
3. Cover: **Decision · Why · Rejected alternatives (with one-line rationale each) · Source.**
4. Append at the bottom of the file. Do not edit or reorder existing entries.
5. If a decision changes, add a new entry that references the date of the old one; do not overwrite the original.
