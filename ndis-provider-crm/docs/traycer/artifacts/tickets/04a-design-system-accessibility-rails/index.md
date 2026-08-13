---
title: "Design-system accessibility correction and test rails"
kind: ticket
status: 2
---

## Goal

Correct the verified design-system acceptance gaps before new production UI inherits them, and establish the reusable accessibility test rails for every v1 screen.

## Scope

- Repair semantic foreground/background and focus-state contrast failures, including validated tenant primary/accent overrides.
- Bring the dev reference page into line with its stated contract: resolved token values, all defined tokens, and samples for all installed components; prevent an addressable blank production route.
- Add reusable accessible status, form-error, focus-safe sticky action, and 48 CSS-px worker-control patterns; ordinary controls retain the WCAG 24 CSS-pixel baseline.
- Treat audio, haptics, vibration, and Background Sync as optional enhancements, never the only status or safety signal.
- Add representative axe/Pa11y checks and a WCAG 2.2 AA screen acceptance-matrix template.

## Out of scope

- Application role flows, participant data, and a claim of complete end-to-end accessibility conformance.

## Dependencies

Existing `02-design-system-foundation` ticket.

## Verification

- Normal text and essential UI states meet their declared contrast targets, including forced-colour mode and tenant override fallbacks.
- Every promised component and token is visibly verified on the development reference page.
- CI runs the agreed automated accessibility checks against representative fixtures.
