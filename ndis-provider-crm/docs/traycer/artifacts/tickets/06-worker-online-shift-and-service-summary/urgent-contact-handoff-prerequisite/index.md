---
title: "Provider urgent-contact and worker handoff prerequisite"
kind: ticket
status: 1
---

## Goal

Give Ticket 06 a real, provider-configured safety destination and truthful append-only handoff evidence without turning the CRM into an incident or complaint case-management system.

## Scope

- Versioned, tenant-scoped emergency, incident and complaint route configuration with provider guidance, owner-role label, primary phone/HTTPS URL, fallback phone, effective window, review and lifecycle state.
- Admin-only idempotent create/supersede command and a clear admin workspace configuration surface.
- Narrow assigned-worker projection of only current emergency and incident routing fields for a selected service-ready shift.
- Always distinguish Australian emergency services (`000`) from provider-configured channels.
- Append-only worker handoff receipts for `initiated`, `worker_confirmed`, and `failed`, bound to the exact route version, worker assignment and shift. No participant or incident narrative.
- Truthful semantics: a phone/URL launch is not proof of connection; worker confirmation is not provider acknowledgement.
- Full RLS, tenant isolation, RPC ACL/search-path/idempotency/audit coverage and negative tests.

## Out of scope

- Incident/complaint intake forms, investigation, reportability decisions, statutory deadline calculation, regulator submission, provider response, closure or document uploads.
- Participant/representative complaint UI, which remains a later portal/release concern.

## Verification

- An admin can configure and supersede current provider routes without direct table writes.
- Cross-tenant, future, expired, withdrawn and superseded routes are never returned to a worker.
- A currently assigned worker can read the minimum route for their selected service-ready shift; another worker cannot.
- Duplicate handoff commands return the original receipt and do not create a second event.
- `initiated`, `worker_confirmed`, and `failed` remain distinct and never overclaim connection/provider acknowledgement.
- Ticket 06 delivery actions remain disabled until current emergency and incident routes exist; `000` remains available for immediate danger.
