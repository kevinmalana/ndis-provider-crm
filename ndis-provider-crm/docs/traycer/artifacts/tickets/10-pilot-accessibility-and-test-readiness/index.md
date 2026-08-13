---
title: "Pilot accessibility, test harness and readiness"
kind: ticket
status: 0
---

## Goal

Make the full v1 scope safe and practical for Kevin to test with synthetic data before any real participant use.

## Scope

- Run the automated accessibility checks and manual WCAG 2.2 AA acceptance matrices across every completed role flow.
- Test focus with sticky action UI, visible-label/name agreement, programmatic sync/conflict status, reflow/zoom, forced colours, keyboard, VoiceOver, and TalkBack.
- Add a synthetic-data reset/seed workflow and an end-to-end test guide covering scheduler → worker → participant/nominee → external lifecycle.
- Verify that completed tickets 01–03 retain historical status/results while their superseded identity, retention, authentication-rationale, and design-verification assumptions are covered by 04/04a and the release guide.
- Assemble the Gate-12 real-data review pack but keep it unapproved/synthetic-only until named human/advisor sign-off.
- Verify the one-worker/one-participant/one-item individual-time boundary; provider scope/capability versions; named screening pathways and hard-blocking competence requirements; service-context lifecycle/snapshots; restricted NDIS-identifier access; and explicitly sourced acknowledgement outcomes across the full synthetic journey.
- Document known test-only limits and block any real participant-data test until qualified privacy/security/NDIS review.

## Out of scope

- Production deployment, production monitoring, real-person usability research recruitment, or importing real participant data.

## Dependencies

All tickets `04`, `04a`, `05`, `05b`, and `06` through `09`.

## Verification

- Kevin can run the seeded full-role journey locally without editing the database by hand.
- The expected quality gates, end-to-end flows, and manual accessibility checks are documented and reproducible.
- No unchecked P0 issue from `ui-ux-documentation-critique` remains in the synthetic MVP test path.
- The release guide states that broad provider onboarding is not broad workflow coverage, names every phased/not-supported service kind, and demonstrates that group, multi-item, transport/activity-quantity, billing and specialist contexts cannot be treated as ready shifts.
- Evidence distinguishes mandatory registered-risk screening from explicit unregistered/provider/participant policy, provider-recorded screening/competence evidence from live Commission verification or a legal determination, exact elapsed delivery time from billable quantity, and office-recorded external acknowledgement from participant-authenticated action.
- Acknowledgement release evidence proves attempts cannot replace conclusive outcomes, corrections require the expected current event, competing successors enter review, and only evidence-backed participant/child-representative/plan-nominee/legal-guardian authority can support a signed/declined record.
