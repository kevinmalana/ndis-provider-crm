---
title: "Ticket 05 repeat-review UI fixup"
kind: ticket
status: 2
---

## Goal

Close the remaining Ticket 05 UI/integration findings at HEAD `b30bbfa` before merge approval. This fixup does not change the Ticket 05b provider/service-readiness boundary.

## Required corrections

- Refresh or reconcile the server-backed workspace after a successful command so newly created consent, grants, participants, shifts and audit entries are immediately available without losing warnings or result context.
- Keep a stable command ID across an uncertain post-commit transport failure and user retry; generate a new ID only after the prior command has a known terminal result or the form payload intentionally starts a new submission.
- Require explicit user acknowledgement of overlap/availability warnings and keep the warning tied to the affected shift/result.
- Split participant-create and critical-information review dates; expose and validate the update review-due field independently.
- Display recipient identity labels in disclosure summaries rather than raw profile UUIDs, with a privacy-safe fallback.

## Verification

- UI/static integration tests cover refresh/reconciliation, retry command-ID reuse, warning acknowledgement, independent date state and recipient labels.
- Existing Ticket 05 database/security tests remain green.
- Lint, typecheck, build, migration parse, full test suite and diff check pass.
- No merge, push, remote Supabase, Docker, secrets or real participant data.
