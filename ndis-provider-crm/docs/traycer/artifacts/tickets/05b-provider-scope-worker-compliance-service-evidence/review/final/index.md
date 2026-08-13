---
title: "Ticket 05b final independent review"
kind: review
---

## Decision

**DO NOT MERGE** frozen commit `84f07f3c58deb21169f583c3df174bc879024580`.

Two fresh independent reviews reached the same conclusion. The implementation is substantially improved and all standard automated gates pass, but two P0 database bypasses and several P1 security and workflow defects remain. Green tests do not outweigh the direct adversarial reproductions.

## Blocking findings

| Priority | Area | Required correction |
| --- | --- | --- |
| P0 | Effective roles | Use current effective membership roles for every admin command, readiness check and Start guard; withdrawn admin/worker authority must fail closed. |
| P0 | Partial-interval rules | Apply the strictest screening policy and competence requirement across every segment of the full shift interval. |
| P1 | Acknowledgement authority | Resolve participant/representative authority at the event time and require the exact acknowledgement scope. |
| P1 | Urgent review | Propagate risk-role and membership-role withdrawal to already-started shifts. |
| P1 | Idempotency | Return the original receipt before revalidating mutable state on exact retries of every 05b admin command. |
| P1 | Controlled evidence | Replace hard-coded scope, role, screening and competence evidence values with truthful controlled inputs, including adverse and limited outcomes. |
| P1 | Context lifecycle | Hydrate and bind lifecycle changes to the selected context rather than reusing state from the create form. |
| P1 | Audit presentation | Show the worker, role, requirement, supervisor, dates, adverse flags, acknowledgement authority, method, evidence and supersession lineage. |
| P1 | Readiness display | Invalidate readiness when worker, context or interval inputs change; enable creation only for a successful result matching current inputs. |
| P1 | Scheduler UX | Hide or disable admin-only actions while preserving scheduler-authorised workflows. |
| P2 | Legacy history | Remove `legacy_incomplete` shifts from actionable reassignment controls. |

## Verification result

Migration parsing, database suites, mounted UI tests, lint, type checking, production build and diff checks passed. Reviewers additionally ran direct PGlite adversarial probes that reproduced the two P0 and three database P1 defects. Authenticated mobile, keyboard, zoom and assistive-technology testing remains unrun.

## Detailed reviews

- [Final database and security review](../final-db-security/index.md)
- [Final product, UI and integration review](../final-product-ui/index.md)

## Merge gate

Fix every P0/P1 finding, add the direct and mounted regressions specified in the detailed reviews, run the full local gates, then freeze a new commit for another independent review. Do not apply remote migrations before approval.
