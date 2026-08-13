---
title: "Ticket 05 repeat-review database and security fixup"
kind: ticket
status: 2
---

## Goal

Close the repeat cold-review database/security blockers found at HEAD `b30bbfa` before merge approval. Preserve the Ticket 05b boundary.

## Required corrections

- Make command-receipt reservation/finalisation internal-only or fully actor-bound; prevent authenticated callers from forging membership linkage, pre-reserving another actor's key, or changing a completed outcome.
- Grant only the intended authenticated read privilege on `participant_consent_evidence`; retain no direct client writes and add catalog/PostgREST-shaped ACL tests that the PGlite blanket test role cannot mask.
- Implement immutable consent renewal/correction history with deterministic version increments and supersession; cover concurrent/stale renewal behavior.
- Add an explicit rerunnable upgrade path from the pre-version Ticket 05 consent schema: add/backfill the version column and create idempotent uniqueness/constraints outside `CREATE TABLE IF NOT EXISTS`.
- Require a live, effective same-tenant representative/nominee membership and role when recording representative consent and issuing a grant; withdrawal must invalidate new issuance.
- Make supplementary active admin/scheduler roles consistent across membership context, `/app/admin` routing and all Ticket 05 read policies, not only command RPCs.

## Verification

- Direct helper ACL, forged-membership, completed-receipt tamper and idempotency tests pass.
- Real-role catalog privileges prove consent reads are allowed and direct writes denied.
- Consent create, renewal, immutable history, stale/concurrent renewal and pre-version upgrade/rerun tests pass.
- Withdrawn/future/expired/wrong-role representative tests pass for consent and grant issuance.
- A base worker with a current supplementary admin/scheduler role can access the intended page/read/command path; withdrawn supplementary roles cannot.
- Full test, lint, typecheck, build, migration parse/rerun and diff checks pass with no remote Supabase, Docker, secrets, merge or push.

## Second repeat-review findings

- Enforce exactly one current consent leaf per organisation/participant/recipient lineage. Initial recording must reject or explicitly route an existing current lineage through renewal; grants may reference only the unique unsuperseded current leaf.
- Resolve the current leaf across the complete successor chain under lock. Renewal must require the caller's expected current ID to equal that leaf and may update only a predecessor whose `superseded_by` is still null; stale or concurrent attempts must preserve conflict evidence and never rewrite an existing successor edge.
- Upgrade populated pre-version consent data deterministically: assign unique versions with `row_number()` ordered by stable creation/id fields, preserve every row, chain multiple legacy active rows in that order, and leave only the newest active/current. Add a realistic pre-b30 duplicate-history upgrade/rerun test.
- Remove the test-harness privilege mask for internal receipt helpers or add true-role direct-call denial probes so production ACL closure is executable rather than catalog-only.

## Final decisive-review findings

- Keep invitation-token recovery actor-private: general same-organisation admin/scheduler receipt reads must never expose an `admin_invite` token or email belonging to another issuer. Preserve same-actor duplicate recovery and add cross-admin/cross-tenant probes.
- Make the populated pre-version backfill partition exactly match the consent version uniqueness key. Mixed participant/representative basis rows for the same organisation/participant/recipient must receive deterministic unique versions, form one preserved chain and upgrade/rerun successfully.
- Treat participant and authorised-representative evidence as versions in the same organisation/participant/recipient lineage. The current-leaf guard, renewal chain, grant predicate, version key and upgrade backfill must use the same basis-blind lineage, leaving exactly one grantable leaf across basis changes.
