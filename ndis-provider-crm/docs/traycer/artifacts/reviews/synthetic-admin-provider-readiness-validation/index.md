---
title: "Development Supabase — Synthetic Admin and Provider-Readiness Validation"
kind: review
---

## Verdict

**Pass.** The complete synthetic admin and provider-readiness journey succeeds against the linked development Supabase project. The blocking migration-order regression was repaired in the repository and applied to development. The Ticket 06 environment prerequisite is clear.

This is development-only synthetic evidence. It is not approval for production or real participant data.

## Safety boundary

- The configured Supabase URL was required to match the repository's linked project before any remote write.
- The run required both explicit `development` and remote-validation process guards.
- Validation used one reserved synthetic organisation, one marked synthetic admin, and two marked synthetic workers. Every identity uses the reserved `.synthetic` namespace.
- Journey records used unique synthetic references and a synthetic identifier. No existing organisation was selected or modified.
- The harness does not print keys, tokens, magic-link hashes, emails, UUIDs, or RPC detail payloads. Screenshots and the redacted machine report are stored outside the repository in the operating-system temporary directory.
- During the first auth diagnostic, the Next.js development access log displayed one single-use magic-link hash before output redaction was added. It had already been consumed, was not copied into an artifact/report, and no key or real participant data was exposed.

## Journey evidence

| Step | Browser-observed result |
| --- | --- |
| 1 | Real magic-link callback established the synthetic admin session and loaded the protected workspace. |
| 2 | Participant record and separate critical support/safety handoff created. |
| 3 | Synthetic worker availability window published. |
| 4 | Reviewed provider scope and supported individual-time capability created. |
| 5 | Provider-owned, time-based catalogue item created. |
| 6 | Risk-assessed role and strict screening policy created. |
| 7 | Two current screening verifications and a named supervised pathway recorded. |
| 8 | Required competence rule and current met evidence recorded. |
| 9 | Identifier stored masked and revealed only through a reason-required audited action. |
| 10 | Service context created as draft and explicitly reviewed active with role and jurisdiction. |
| 11 | Server readiness returned `Ready`; the service-ready shift and immutable snapshot were created. |
| 12 | Snapshot inspected and a truthful provider-recorded acknowledgement attempt added without claiming participant authentication. |

After the browser flow, a separate service-role verification found every run-specific synthetic record across participant, provider scope/capability/catalogue, role, screening, pathway, competence, active context, snapshot, and acknowledgement relations. A reload also confirmed persistence.

## Blocker found and fixed

Supabase applies migration filenames lexicographically. `0009_provider_readiness_service_evidence.sql` therefore ran before the timestamped Ticket 05 fixups, although the isolated test harness had listed it after them. The later fixup then:

1. narrowed `command_receipts_command_type_check`, rejecting `admin_provider_scope` and the other provider-readiness command families; and
2. reintroduced the context-free `cmd_admin_create_shift` callable that Ticket 05b had retired.

The forward migration `20260813000001_provider_readiness_ordering_fix.sql` now restores the complete command allow-list, preserves the legacy receipt type for historical rows, retires the unsafe callable again, and classifies any snapshot-free shifts from the affected window as `legacy_incomplete`. It was the only migration in the CLI dry run and was applied successfully to development.

A final dry run reports the development database up to date. PostgREST discovery confirms the context-free shift RPC is absent and the required provider-readiness RPCs are present.

The database test manifest now follows the real Supabase filename order and fails if its explicit list diverges from the migration directory. A successful provider-scope command test guards the exact regression.

## Supporting tooling fixes

- The reusable journey harness now scopes multi-status and repeated-text assertions correctly and refuses a local app origin that differs from `NEXT_PUBLIC_APP_URL`.
- The axe runner now uses an isolated Playwright browser context.
- Pa11y now reuses the pinned Playwright Chromium executable instead of depending on an unmanaged Chrome cache.

## Final gates

| Gate | Result |
| --- | --- |
| Frozen dependency install | Pass |
| Migration parser | 12/12 files pass in deployed lexical order |
| Database/component/contracts | 16 files, **177/177 tests pass** |
| Lint | Pass |
| Typecheck | Pass |
| Production build | Pass |
| axe | 14 pass groups, 0 violation groups |
| Pa11y | 0 issues |
| Remote browser journey | 12/12 steps pass |
| Independent remote record verification | Pass |

## Remaining release boundaries

- Keep all use synthetic; real participant data remains prohibited.
- Production deployment, production authentication/recovery review, privacy/legal review, manual keyboard/zoom/screen-reader/forced-colour checks, and disability-inclusive user validation remain later release gates.
- The reserved synthetic development tenant and its synthetic audit trail remain in development as repeatable test evidence.

## Ticket 06 handoff

Ticket 06 can now consume the proven service-ready boundary: a ready assigned worker, active reviewed service context, immutable provider item/catalogue/goal snapshot, Start-time readiness recheck, and separately truthful acknowledgement status.
