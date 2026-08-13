---
title: "External grant lifecycle and view-only portal"
kind: ticket
status: 0
---

## Goal

Implement the bounded external coordinator/referrer experience with an explicit disclosure grant lifecycle.

## Scope

- Invite and role-aware external portal for authorised, view-only access.
- One global external account may hold grants across providers; require explicit provider and participant context selection and display that context on sensitive pages.
- Clear display of purpose, permitted record classes, effective/expiry dates, and no-edit status.
- Admin-side evidence-aware lifecycle for creating, modifying, revoking, and expiring grants; notify the participant/nominee according to sharing settings.
- Empty, denied, revoked, expired, inaccessible, and session-expired states that disclose no participant information and explain the next safe contact/re-authentication action.

## Out of scope

- Cross-provider participant search, self-service external invitations, messaging, export, billing, and delegated sub-grants.

## Dependencies

`04-v1-data-security-foundation`, `04a-design-system-accessibility-rails`, and `05-admin-roster-and-consent-workspace`.

## Verification

- External accounts see only named participants and permitted classes while the grant is active.
- A revoked/expired grant is denied immediately online and the response is privacy-preserving.
- Grant lifecycle actions and external views respect RLS and leave an audit trace.
