---
title: "Ticket 06 first-pass code review"
kind: review
---

## Findings

### P0 — Delivery commands do not enforce urgent-route readiness on the server

The worker UI hides Start/End/summary actions when either current route is missing, but the underlying `cmd_on_my_way`, `cmd_start_shift`, `cmd_end_shift`, and `cmd_submit_summary` RPCs remain callable directly and do not check the new emergency/incident configuration. The migration only reports route readiness through `list_worker_today_shifts` and `list_worker_shift_handoff_routes` (`20260813000002_worker_urgent_handoff_and_worker_flow.sql:306-423`), while the actual gate lives in client state (`shift-detail-client.tsx:151-196`). A stale client or direct PostgREST caller can therefore begin or progress delivery after routes expire or are withdrawn. Enforce the settled prerequisite inside the transactional command path and add negative DB tests for missing/expired/withdrawn routes.

### P0 — A mid-shift readiness revocation strands the worker before End

The existing readiness trigger changes an in-progress shift from `started` to `urgent_provider_review` (`0009_provider_readiness_service_evidence.sql:607-625`). `cmd_end_shift` accepts only `started` (`0005_sensitive_command_rpcs.sql:722-750`), and the Ticket 06 client also renders End only for `started`. The worker therefore cannot preserve the actual End time or continue to the required summary after the exact post-Start revocation scenario named in the ticket. Add an evidence-preserving urgent-review End/recovery path and test the complete revocation-after-Start journey.

### P1 — Handoff receipts are described as append-only but are mutable

`worker_handoff_receipts` has RLS and no authenticated write grants, but it has no immutable `BEFORE UPDATE OR DELETE` trigger. Privileged maintenance/service-role code can silently rewrite or delete the safety evidence, unlike the existing immutable snapshot and acknowledgement ledgers. Add an immutability trigger and a regression proving update/delete fail while inserts through the command RPC still work.

### P1 — The displayed “exact elapsed” duration is rounded

`formatDuration` rounds milliseconds to whole minutes (`shift-detail-client.tsx:72-80`). A 59m31s interval is displayed as 1h, so the final screen does not show the exact accepted Start/End duration promised by Ticket 06. Preserve seconds (or another lossless representation) and add boundary coverage.

### P1 — Admin “Current” route badges ignore effective windows

The admin workspace treats the latest `status = active` version as current without checking `effective_from <= now < effective_until` (`workspace-client.tsx:908-912`). Future-scheduled or expired-but-active versions can be labelled Current even while worker delivery remains correctly blocked by the RPC projection. Apply the same current-window predicate in the admin read model/UI and cover future and expired versions.

### P2 — New security-definer command uses a writable search path

`cmd_worker_record_handoff` declares `set search_path = public` while the other new security-definer functions use an empty search path and the prerequisite explicitly calls for search-path hardening. All referenced objects are already schema-qualified, so use `set search_path = ''` and retain explicit qualification.

## Remediation review

The six findings above are closed in `20260813000003_ticket06_first_pass_review_fixup.sql` and its application/UI tests.

### P1 — Internal route-state helper is callable across tenants

`current_worker_route_state(uuid)` is a `SECURITY DEFINER` helper that accepts any organisation ID and returns emergency/incident configuration booleans. The fixup revokes `public` and `anon` but then grants it directly to all `authenticated` users (`20260813000003_ticket06_first_pass_review_fixup.sql:34-36`) without checking membership or tenant. A signed-in user can therefore probe route readiness for another organisation. This helper is only needed by the definer command functions, so remove the authenticated grant (or add an explicit active tenant-role check if a direct client contract is genuinely needed) and add a negative cross-tenant/direct-execute test.

## Final verification

Closed. The internal helper is no longer executable by `authenticated` or `anon`, the ACL regression verifies both roles, and the delivery commands retain their internal definer access. Ticket 06's parser, focused database/security tests, mounted UI tests, lint, typecheck, production build and diff checks pass. No secret value, real participant data, remote write, commit or push was introduced. Manual browser/device inspection remains an explicit post-checkpoint residual because no browser session was available in the Traycer window.
