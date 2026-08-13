---
title: "Worker online shift and service-summary flow"
kind: ticket
status: 0
---

## Goal

Deliver the primary mobile workflow against service-ready synthetic records: a worker sees today's assigned individual time-based work, checks essential support information, records Start/End, and submits a short text service summary.

## Scope

- Complete the nested urgent-contact/handoff prerequisite before exposing worker delivery actions.
- Phone-first `/worker` flow for today, shift detail, optional “On my way,” Start, separate End, service-summary-required state, submission, and accepted/conflict status.
- Display only the minimum information required on the glanceable list; show full address/support handoff only after selecting the assigned shift.
- Call the ticket-04 transactional Supabase RPC functions and clearly distinguish client-reported time, server receipt, acceptance, and summary finalisation.
- Include an always-visible urgent-help route with separate `000`, current provider emergency and incident channels, fallback contact, and provider-owned guidance. Record truthful initiated/worker-confirmed/failed handoff evidence; never claim a call connected or the provider acknowledged it. A service summary is explicitly not an incident report.
- Text-only summaries with respectful, participant-centred writing guidance. No attachments.
- Read-only display of the shift's single immutable support-item/catalogue-version/goal snapshot and exact elapsed duration derived from accepted Start/End; workers cannot replace it with free text, enter billable time or apply claim rounding.
- Separate acknowledgement source/status after finalisation. Provider-recorded external evidence/attempts are never labelled participant-authenticated; attempts never replace the conclusive current leaf; a conflict shows Needs review; missing acknowledgement never changes an accepted summary back to pending.
- Consume only 05b service-ready shifts. `legacy_incomplete`, draft/review-required/superseded/withdrawn/expired context, non-individual-time, phased/not-supported, and failed Start-readiness states are excluded or shown as blocked with provider contact.

## Out of scope

- Offline persistence/sync (next ticket), real-time participant tracking, GPS verification, audio/photos, and in-app incident case management.

## Dependencies

`04-v1-data-security-foundation`, `04a-design-system-accessibility-rails`, `05-admin-roster-and-consent-workspace`, and `05b-provider-scope-worker-compliance-service-evidence`.

## Verification

- An assigned worker can complete the online happy path on phone and desktop responsive views.
- End records actual delivered-support time before summary authoring; the shift remains Summary required until the server finalises the summary.
- The app never calls a shift or note finalised before server acknowledgement.
- New shifts without one active/current/reviewed individual-time context, a current supported scope/item, a ready assigned worker and complete full-window evidence cannot enter the worker flow.
- Start rechecks live scope/context/screening/pathway/competence readiness; revocation before Start blocks with provider contact, while revocation after accepted Start preserves evidence and shows urgent provider review.
- The final record shows the immutable item/catalogue/goal snapshot and exact server-derived elapsed duration without a billing claim; acknowledgement source/status progresses separately.
- Wrong assignment, cancelled/reassigned shift, validation error, and urgent-help states have clear recovery paths.
- Missing/expired provider emergency or incident configuration blocks delivery actions with a clear admin-configuration recovery path while `000` remains visible for immediate danger.
- Handoff receipts are append-only, assignment/tenant/route-version bound and idempotent; no incident narrative or inferred call/provider acknowledgement is stored.
- All worker actions have 48 CSS-px targets, visible labels, live status announcements, and a focus-safe sticky action area.
