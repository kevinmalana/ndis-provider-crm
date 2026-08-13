---
title: "Admin roster, consent and access workspace"
kind: ticket
status: 2
---

## Goal

Give an authorised administrator/scheduler a usable desktop workflow to create and maintain the data that powers the pilot.

## Forward correction after completion

This ticket remains a truthful record of the admin workspace completed at commit `1b66d6e`. The context-free shift command/UI it delivered is not sufficient for the revised representative worker test. Ticket `05b-provider-scope-worker-compliance-service-evidence` owns migration `0009`, removal of that old RPC signature, service-ready shift creation, admin UI integration and the new readiness gates. No Ticket 05 shift may enter Ticket 06 merely because this historical ticket is complete.

## Scope

- Protected role-aware admin navigation and empty/error states.
- Participant profile creation, minimum safety/support handoff information, consent evidence, and participant/nominee authority records.
- Worker availability, shift creation/reassignment, overlap warnings, and an audit timeline.
- Management of external view-only grants, including scope, purpose, evidence reference, effective/expiry dates, revocation, and participant-visible disclosure summary.
- Respect data minimisation: do not reveal whether an email already belongs to another organisation; do not expose participant details in notifications unnecessarily.

## Out of scope

- Invoicing, staff shift swaps, messaging, full incident management, photos/audio, and broad data export.

## Dependencies

`04-v1-data-security-foundation` and `04a-design-system-accessibility-rails`.

## Verification

- A scheduler can prepare a synthetic participant, worker, and shift without direct database use.
- Invalid/expired authority or a conflicting roster assignment is clearly blocked or warned according to the agreed policy.
- Reassignment and grant changes are immediately audit-visible and correctly reflected in role-scoped reads.
- Keyboard, screen-reader labels, focus order, 200% text zoom, and 320 CSS-px reflow work on the key forms.
