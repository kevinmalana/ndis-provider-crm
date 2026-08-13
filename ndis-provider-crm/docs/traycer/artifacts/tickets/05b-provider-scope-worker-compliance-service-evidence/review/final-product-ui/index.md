---
title: "Ticket 05b final product, UI and integration review"
kind: review
---

## Decision

**DO NOT MERGE** frozen commit `84f07f3c58deb21169f583c3df174bc879024580`.

The database contract is substantially stronger and the admin happy path is mounted and green, but the product surface still does not deliver the settled role-gated, fully controlled and auditable no-SQL journey. The blockers below are component behavior, not missing static strings.

## Prioritized findings

### P1 — Provider and compliance records cannot be entered with their settled controlled values

The forms submit hard-coded evidence instead of controls for material fields:

- provider scope fixes registration group/class to `synthetic`/`individual` and auto-picks a reviewer (`src/app/app/admin/workspace-client.tsx:901`);
- worker verification fixes source/verifier and forces every adverse flag false, so an admin cannot record an interim bar, suspension, exclusion or revocation (`workspace-client.tsx:918-922`);
- competence evidence always submits provider `Synthetic Provider`, state `met`, no limitation and a fixed expiry (`workspace-client.tsx:924-926`);
- role definition, screening-policy owner/reason and competence requirement state/method/owner are fixed rather than controlled (`workspace-client.tsx:929-940`).

This is not the required administration surface for versioned scope, risk-role definition, adverse screening history, or met/not-met/pending competence evidence. The mounted closure test controls only catalogue fields (`tests/admin-workspace-mounted.test.tsx:156-175`).

### P1 — Context lifecycle updates are not bound to the selected context

Selecting a context changes only `context`; the lifecycle command reuses reviewer, role and jurisdiction state from the separate create form (`workspace-client.tsx:824-834,948-951`). On a loaded draft those values are not hydrated from the selected record. An admin therefore either receives `reviewed_context_required` or can apply a previously selected role/reviewer/default `NSW` jurisdiction to a different context. The server validates tenant/current values, but it cannot know that the UI showed values belonging to another record.

Bind lifecycle inputs to the chosen context, display the existing owner/reviewer/role/jurisdiction, and require explicit changed values before activation.

### P1 — Readiness evidence and acknowledgement history are not auditable to the correct actor/record

The page loads worker/role/requirement/authority fields (`src/app/app/admin/page.tsx:36-43`) but the UI collapses all organisation evidence into unscoped strings such as reference + status or pathway + jurisdiction (`workspace-client.tsx:941`). Screening policies are loaded but never rendered. An office user cannot tell which worker, role, requirement, supervisor, effective window or adverse flags a displayed record belongs to.

Likewise, the acknowledgement ledger omits reported signer, authority type, method, external evidence reference and supersession link even though the projection returns them; it shows only event type/source/time/reason (`workspace-client.tsx:965`; projection at `supabase/migrations/0009_provider_readiness_service_evidence.sql:883-889`). That is insufficient to review the immutable attempt/root/correction chain or verify the provider-recorded source.

### P1 — The visible readiness result can become stale while Create uses changed inputs

Worker, context and interval changes do not clear or re-run `readinessResult` (`workspace-client.tsx:843-847,953-954`). After a `Ready` response, the user can change any input and the screen continues to say Ready. The create button is gated only by non-empty worker/context and pending state, not by a readiness result for the current input fingerprint (`workspace-client.tsx:955`). The server recheck prevents an unsafe write, but the persistent status is materially false and recovery happens only after a failed create.

Tie the result to an input fingerprint, clear it on change, and enable create only for a current successful result.

### P1 — Scheduler presentation is not role-gated to match server authority

Schedulers are admitted to the route (`src/app/app/admin/page.tsx:10-13`) and see enabled controls for provider scope, capability, catalogue, risk role, screening policy, competence requirement and context lifecycle (`workspace-client.tsx:900-940,948-951`). Those RPCs are admin-only (`supabase/migrations/0009_provider_readiness_service_evidence.sql:729,744,758,801,815,829,857`). Only identifier buttons use `actorRole` to gate mutation (`workspace-client.tsx:944,946`). A scheduler can therefore fill and submit controls the product promises are role-gated, then receives an avoidable permission error.

Hide or disable admin-only controls with an explanatory label; retain scheduler-authorised verification/pathway/evidence/readiness/acknowledgement actions.

### P2 — Legacy history is still offered as an actionable reassignment target

The reassignment selector includes every shift without filtering or disabling `legacy_incomplete` (`workspace-client.tsx:698-723`). The database correctly rejects the write, and acknowledgement correctly filters legacy records (`workspace-client.tsx:957`), but the Ticket 05 integration still presents legacy history as actionable rather than read-only.

## Ten-step closure

| Journey area | Result |
| --- | --- |
| Scope/capability and time catalogue | Partial — happy path exists; scope values and scheduler role gate fail |
| Risk role/screening policy | Partial — material definition/policy values fixed; policy read view absent |
| Verification and named pathways | Partial — happy path exists; adverse history cannot be entered; read rows lack worker/role/supervisor/window |
| Competence requirement/evidence | Partial — requirement and outcome metadata fixed; displayed evidence is not actor/requirement scoped |
| Masked identifier/admin reveal | Pass — mounted reveal, masked read, admin disable and DB audit/denial covered |
| Context create/review lifecycle | Fail — creation works, selected-record lifecycle binding does not |
| Service-ready shift | Partial — server gate works; visible readiness can be stale |
| Readiness reasons/recovery | Partial — known reasons are actionable, but not bound to current inputs |
| Immutable snapshot | Pass — item/category/kind/catalogue/unit/goal and billing non-claim render |
| Acknowledgement attempt/root/decline/correction/ledger | Partial — actions exist and current leaf renders; ledger omits the evidence/authority/supersession needed to audit it |

## Gates

| Gate | Result |
| --- | --- |
| Mounted/admin state/contracts | Pass — 54 tests (`19` mounted) |
| Focused Ticket 05b + Ticket 05 + PostgREST/RPC DB suites | Pass — 69 tests |
| Typecheck / lint / production build / migration parse | Pass |
| Old `cmd_admin_create_shift` UI/wrapper/static call | Pass — absent; service-ready command only |
| Per-form pending/retry/error behavior | Pass for exercised forms; new-role/legacy/stale-result states are untested |
| Authenticated browser, mobile viewport, keyboard, zoom and assistive technology | Not run — no connected in-app or external browser was available; mounted DOM tests do not close this gate |

## Merge gate

Merge only after the five P1 findings have mounted coverage for both admin and scheduler, adverse/failed evidence values, selected-context lifecycle hydration, current-input readiness invalidation and a fully labelled acknowledgement/evidence read view. Remove legacy rows from actionable selectors and record a real authenticated mobile/keyboard/zoom/AT pass.
