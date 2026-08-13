---
title: "Participant and nominee portal"
kind: ticket
status: 0
---

## Goal

Give participants and authorised nominees an accessible, narrowly scoped view of upcoming visits, finalised plain-English service summaries, their current authority/access, and a way to request correction or withdrawal.

## Scope

- Separate role-aware participant and nominee portal routes backed by recorded authority, never a blanket nominee mirror.
- Upcoming visits and every successfully finalised participant-readable service summary for the participant's self-linked account; participant visibility is automatic after finalisation, not a provider-by-provider share toggle.
- Representatives see only what their separately recorded authority type/scope permits; no blanket nominee mirror.
- Plain-English information about what is shared, who else may have optional access, and what a request changes now versus what must be retained.
- Access/correction/withdrawal request workflow with confirmation, status, and audit—not unreviewed direct mutation of provider workforce permissions.
- Accessible authentication fallback, reduced-motion/forced-colour compatibility, text resize/reflow, and non-digital contact/support route.

## Out of scope

- Public access, chat, billing, real-time “on my way” tracking, Auslan media, and a complete complaints/incident system.

## Dependencies

`04-v1-data-security-foundation` and `04a-design-system-accessibility-rails`.

## Verification

- Participant, nominee, expired nominee, and unauthorised account read the correct and only the correct records.
- The portal never exposes internal planner notes, audit IDs, quarantined/pending worker evidence, or other participants.
- Correction/withdrawal requests are comprehensible, traceable, and do not over-promise deletion or instant offline revocation.
