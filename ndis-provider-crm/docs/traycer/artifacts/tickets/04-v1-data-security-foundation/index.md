---
title: "V1 data, consent and authorisation foundation"
kind: ticket
status: 1
---

## Goal

Create the database-enforced foundation for a testable pilot, including the forward identity migration, distinct authority relationships, transactional shift/summary RPCs, and synthetic domain data.

## Scope

- Add a forward migration from the implemented `profiles.organisation_id + role` model to global profiles, organisation memberships/roles, and explicit active-organisation context; preserve auth identities, accepted invitations, and audit history.
- Update invitation acceptance so an existing global account gains a separate membership rather than colliding with a single profile row.
- Add participants, participant self-portal links, representative-authority records, external disclosure grants, workforce assignments, availability, shifts, critical-information cards, participant-readable summaries/versions, correction/access requests, evidence-review queue, command receipts, and audit events.
- Distinguish provider workforce permissions, participant self-access, representative authority, and external disclosure grants; enforce organisation, participant, role, assignment, scope, effective-date, and expiry boundaries through RLS and database constraints.
- Make participant correction/access and consent-withdrawal requests explicit pending requests; do not silently alter a grant or historical record.
- Record start, actual finish, client-reported time, server receipt, finalisation, correction, and access changes as distinct audited events.
- Add direct-Supabase transactional Postgres RPC functions for On my way, Start, End, summary finalisation, conflict review, and correction. Each validates authority/assignment/version, deduplicates by command ID, preserves client/server times, applies one transition, and appends audit in one transaction.
- Add idempotency/version fields needed by the worker sync outbox and create synthetic-only development seed data.
- Add automated positive and negative RLS/authorisation tests.

## Out of scope

- Photos, audio, GPS, biometrics, real participant data, billing, claims, messaging, and any automatic hard-purge worker.
- Browser UI beyond development/test helpers.

## Dependencies

Existing bootstrap/auth/design tickets remain complete historical foundations. Their single-organisation and design-verification assumptions are superseded by this ticket and 04a.

## Verification

- A worker cannot read an unassigned shift or another worker's record.
- A participant reads their own portal through the participant self-link; a representative reads only current recorded authority; an external user reads only a current consent-backed grant.
- Expiry, withdrawal, and reassignment deny new reads/writes immediately online.
- Every sensitive mutation creates an append-only audit event in the same transaction.
- Duplicate RPC retries return the original receipt; cancellation/reassignment conflicts preserve evidence for review.
- Existing test identities/invitations/audit history survive the migration and the app can select an active organisation membership.
- Migration, generated types, lint, typecheck, and build succeed.
