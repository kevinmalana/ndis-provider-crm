---
title: "Ticket 04a accessibility review fixup"
kind: ticket
status: 1
---

## Goal

Close every actionable finding from the cold review of commit `645e895` without weakening the Ticket 04a accessibility contract.

## Required fixes

1. **Tenant theme safety:** do not activate tenant primary/accent overrides unless values and semantic foreground/background contrast have been validated by a trusted boundary. Client code must not self-assert validation. Missing, malformed, and low-contrast values must retain safe defaults, with regression coverage.
2. **Focus-safe sticky actions:** define a real scroll-container/layout contract that reserves the sticky action height and prevents keyboard-focused content from being obscured. Add representative regression coverage and document the remaining manual keyboard/zoom check.
3. **Strict automated gates:** axe and Pa11y must fail on every unbaselined WCAG finding. Any allowlist must be narrow, documented, evidence-backed, and time-bounded; do not silently ignore moderate or warning results.
4. **Sticky boundary contrast:** make the sticky action region distinguishable at the required 3:1 non-text contrast ratio or provide an equivalent non-colour boundary.
5. **Definite sticky scroll contract:** the configured scroll region must have an explicit viewport/container height contract so it actually owns scrolling in shipped usage. Do not leave an unsafe standalone `StickyActionBar` export that can be used without reserved focus space. Add a realistic fixture/regression showing content overflow is handled by the configured scroller and focus cannot be obscured by the action area.

## Verification

- Frozen install, lint, typecheck, build, database parse/tests, accessibility static tests, and diff-check pass.
- Dev `/design-system` remains HTTP 200; production remains a real HTTP 404.
- Tenant fallback tests cover absent, invalid, and low-contrast values.
- Sticky action fixture demonstrates reserved scroll space/focus contract.
- Axe/Pa11y execution is attempted if a browser is available; if the browser runtime remains unavailable, report the exact blocker without claiming those gates passed.
- No Supabase credentials, remote services, Docker, real data, main merge, or push.

## Source

Cold review: `../review/index.md`.
