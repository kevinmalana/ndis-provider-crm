---
title: "NDIS Provider CRM — UI/UX Research & Design Direction"
kind: spec
---

## Evidence status of the landscape scan

The comparison below is a **design hypothesis**, not validated market research. It was assembled from publicly visible product positioning and prior product impressions; it does not yet include a dated test protocol, versioned screen captures, customer interviews, or accessibility audits. Claims such as “best-in-class,” “widely used,” performance quality, and accessibility quality must not be treated as verified facts until the research record names the date, surface, method, and source. The highest-risk assumptions must be validated with workers, participants, representatives, and external users before pilot release.

## Reference landscape scan

We surveyed five products that touch the same problem space: coordinating support workers and participant services in Australia. Each illustrates a different strength to learn from and a different weakness to avoid.

| Product | What it does well | What it does poorly | What we should borrow | What we should avoid |
| --- | --- | --- | --- | --- |
| **SupportAbility** (AU NDIS practice management, widely used) | Deep NDIS awareness (plan numbers, line items, restrictive practices, goals framework); comprehensive participant records; audit-ready | Dated 2010s visual design; dense forms; weak mobile portal; uneven accessibility | Information architecture for the participant profile and consent/authorisation records; the goal and progress-notes taxonomy as a starting vocabulary | Visual density; non-mobile-friendly form patterns; reliance on training to use the product |
| **ShiftCare** (AU NDIS/aged care, mobile-first) | Best-in-class mobile worker app; offline shift start/stop; clean shift UI; NDIS-aware | Weak on deep NDIS practice management (more aged-care-shaped); minimal participant self-service; billing-centric | Mobile-first shift card design; offline-first worker experience patterns | Skewing toward billing as the primary screen; assuming workers have continuous signal |
| **Lumary** (AU NDIS provider platform) | Modern UI; strong participant journey; clear information architecture; billing-ready | Feature breadth overwhelms smaller providers; mobile experience secondary; pricing skews larger | Information architecture for participant home screen; clear role-based navigation | Long navigation paths; feature-rich dashboards that hide the most common task |
| **Tanda** (AU workforce management) | Exceptional worker app (GPS clock-in, photo verification, fatigue rules); shift swapping; multi-site rostering | Not disability-specific; no service notes or progress notes; no participant records | Worker app pattern: today's shifts, one-tap actions, GPS verification, photo verification, fatigue rules | Treating workers as interchangeable time units; ignoring what they actually deliver |
| **CareMaster / MYP** (AU NDIS CRM) | Deep NDIS compliance and reporting | Oldest-school UX; weak mobile; performance complaints; training-heavy | Audit-event vocabulary; the idea that compliance can be a first-class screen | Visual staleness; per-screen complexity that only power users can navigate |

Key takeaways from the landscape:

- The mobile worker experience is the most differentiated surface. Workers have been failed by clunky web apps in this category; getting it right is a competitive feature, not a nice-to-have.
- Participant-facing portals in the category are uniformly thin. There is room to be meaningfully better.
- Audit/compliance is treated as a separate screen in most incumbents. We can do better by baking audit events into normal actions and surfacing them contextually.
- Accessibility in this category is uneven. Meeting WCAG 2.2 AA is a baseline, not a target.

## Recommended UI stack

The technical plan has settled Tailwind CSS, shadcn/ui, React Hook Form, and Zod. This section confirms those choices and adds the remaining UI picks with rationale.

| Concern | Recommendation | Rationale | Alternatives considered |
| --- | --- | --- | --- |
| Component primitives | **Radix UI** (via **shadcn/ui**) — already in tech plan | Radix supplies useful accessibility primitives, but conformance depends on our composition, labels, focus behaviour, content, and testing. shadcn/ui owns its source in the repo so gaps can be fixed locally. | Material UI (heavier and more opinionated); Headless UI (smaller surface); Chakra (different ecosystem fit). |
| Styling system | **Tailwind CSS** — already in tech plan | Utility-first pairs cleanly with the shadcn/ui copy-paste model; CSS-variable theme aligns with multi-tenant tokens. | CSS Modules (more bespoke, slower to iterate); styled-components (runtime cost, no RSC fit); Emotion (same). |
| Icon set | **Lucide** | Comes with shadcn/ui; tree-shakable; broad coverage; consistent stroke that reads at small sizes. Open license. | Heroicons (smaller set); Phosphor (excellent but heavier); Tabler (slightly busier). |
| Font (UI and body) | **Inter** as primary; system stack as fallback | Designed for screen readability; broad language coverage (matters for Australia's multilingual participants); variable font for weight control; free; widely used by accessible products; tabular numerals for shift times. | Geist (less battle-tested in accessibility audits); Söhne (paid); IBM Plex Sans (heavier at small sizes); system stack only (inconsistent across Android/iOS/desktop). |
| Body font for participant portal | **Inter** default; consider **Atkinson Hyperlegible** as a future option for low-vision participants | Atkinson Hyperlegible is specifically designed for low-vision readability. Defer; ship Inter for v1 and gate behind a setting if requested later. | Lexend (designed for reading proficiency, not low vision); Comic Sans (stigma, accessibility tooling handles it fine but tests will look strange). |
| Form layer | **React Hook Form + Zod** — already in tech plan | RHF's uncontrolled model keeps worker forms responsive on low-end phones; Zod schemas double as server validation source of truth. | Formik (slower, more re-renders); TanStack Form (newer, less production-tested); native forms only (poor validation ergonomics). |
| Date/time handling | **date-fns** with **date-fns-tz** | Functional, tree-shakable, plays well with RSC; tz needed for participant locality vs server clock. | Luxon (heavier, OO model fights functional patterns); Moment (legacy); Temporal polyfill (still maturing). |
| Data tables (admin roster, audit log, participant list) | **TanStack Table v8** (headless) | Headless; accessible if we wire up proper ARIA; pairs with shadcn/ui styles; pagination/sorting/filtering built in. | AG Grid Community (over-featured for v1, slower to style); plain HTML tables (fine for first screens, will not scale). |
| PWA / offline | **Serwist** (service worker) + **Dexie.js** (IndexedDB wrapper) | Serwist is the maintained successor to next-pwa; Dexie gives a sane IndexedDB surface for cached shifts and queued service-note submissions. | Workbox directly (more boilerplate); idb (lower-level); PWA with no offline (rejected — mobile workers drop signal). |
| Toasts / ephemeral feedback | **Sonner** (via shadcn/ui) | Accessible, lightweight, queues well, integrates with the toast provider. | react-hot-toast (older, less accessible out of the box). |
| Charts / analytics | Defer to post-v1 | The pilot does not need dashboards; RLS test output and audit log are tabular. If added, **Recharts** for accessibility and simplicity. | n/a |

Notes:

- Record exact dependency versions and verify their licences before each production release; this artifact does not waive a dependency/licensing check.
- Icon and font choices stay consistent across admin and worker surfaces so workers recognise the visual language across devices.
- shadcn/ui's CSS-variable theme system means our token layer is portable; Tailwind reads from the same variables in `tailwind.config.ts`.

## Accessibility baseline

NDIS participants include people with disability; the worker app is used in conditions that make accessibility a safety issue (gloves, sun, one hand free). WCAG 2.2 AA is the floor, not the ceiling.

### Universal baseline (all surfaces)

- **WCAG 2.2 Level AA conformance**, validated against the [WCAG 2.2 understanding documents](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/).
- All interactive elements keyboard-operable; visible focus indicator (we do not disable outlines).
- Colour is never the only signal (icons + text accompany state).
- Text resizes to 200% without loss of content; reflow at 320 CSS px width works.
- `prefers-reduced-motion` respected; non-essential animation removed when set.
- `prefers-color-scheme` respected; high-contrast mode for outdoor work.
- All form fields have associated labels and accessible error messages; errors are announced.
- No essential interaction requires dragging (per WCAG 2.2).
- Touch targets ≥ 24×24 CSS px (WCAG 2.2 AA minimum).

### Worker app specific (more demanding than baseline)

- **Target size: 48×48 CSS px minimum** for worker interactive controls (Start, End, On my way, Submit, urgent actions). This exceeds the WCAG 2.2 AA 24 CSS-pixel floor and is the safer cross-platform field-work standard; ordinary non-worker controls retain the WCAG baseline.
- **Contrast: 7:1 (AAA) for primary action surfaces** so they remain visible in bright sun. AAA applies to the worker app's primary CTA surface only; secondary text can stay at AA.
- **One-thumb operation:** primary actions reachable in the bottom 40% of the viewport. Use a bottom-anchored action bar or FAB for the main call to action on each step.
- **Glove tolerance:** avoid relying on hover; reveal-on-tap; spacing between targets ≥ 8 CSS px.
- **Audio + haptic feedback** **may enhance** state changes where supported, but availability is inconsistent and it is never required or the sole confirmation. Persistent visual text and programmatic status announcements are authoritative.
- **Voice control friendly:** visible labels on every control; no icon-only buttons.

### Participant portal specific

- **Plain English** with Australian health-literacy conventions; avoid NDIS jargon in the participant surface, explain when unavoidable.
- **Read-aloud support:** semantic HTML, proper landmark regions, alt text on every image.
- **Choice of views:** some participants may prefer large-print or high-contrast; respect system preferences and provide in-app toggles where possible.

### External portal specific

- The external coordinator/referrer surface is low-frequency; standard WCAG 2.2 AA suffices. No additional requirements beyond baseline.

### Validation approach

- Maintain a WCAG 2.2 AA acceptance matrix for every role, route, modal, authentication state, timeout, offline state, conflict, error, and correction flow.
- Automated: **axe-core** in CI on representative states and **Pa11y** sweeps. Automated success is necessary but never treated as conformance proof.
- Manual on every material flow change and before release: keyboard; zoom/reflow with the mobile keyboard open; visible and unobscured focus; status/error announcements; label-in-name; forced colours; reduced motion; and timeout/re-authentication recovery.
- Supported assistive-technology checks before pilot: VoiceOver/Safari, TalkBack/Chrome, desktop keyboard and screen reader, switch/voice access, and magnification on agreed devices.
- Disability-inclusive usability testing must include people with motor, vision, hearing, cognitive/intellectual disability, low literacy, and supported-decision-making needs. Plain English, Easy Read, and alternative formats are validated with users rather than assumed from a font or component library.
- No material flow ships with a known WCAG 2.2 AA failure; test evidence is attached to its release record.

## Multi-tenant design posture

### Recommendation

**Shared neutral system with constrained per-organisation theming.** Concretely:

- A single set of base design tokens (typography, spacing, radii, neutral palette, focus ring, semantic colours for success / warning / danger).
- Each organisation may override a small, **constrained** set of tokens: brand primary colour (validated against accessibility), brand accent, organisation logo, organisation display name.
- All other tokens are locked. Typography, sizing, spacing, motion, and component structure stay identical across tenants.

### Why not free theming?

- Per-tenant brand colours frequently fail accessibility (low-contrast brand colours are common in the disability sector).
- A consistent shape and interaction language reduces worker cognitive load when staff move between providers or cover shifts.
- A consistent visual identity makes audit log screenshots, incident reports, and training materials unambiguous.
- Unconstrained theming increases maintenance and test surface; for a pilot we should not pay that cost.

### Why not no theming at all?

- NDIS providers expect to put their own logo and name on the participant surface. It is a trust signal.
- For the participant portal especially, the participant must be confident this is *their* provider, not a generic tool.

### Interaction with the bootstrap ticket

The bootstrap ticket (`01-bootstrap-next-supabase`, currently no Tailwind) should still establish the **token layer** as plain CSS custom properties under `app/styles/tokens.css`:

- A `:root` block with base tokens (`--color-bg`, `--color-fg`, `--space-1`, `--font-sans`, etc.).
- An `[data-org="…"]` override mechanism that the server applies per request to scope organisation-specific primary / accent / logo.
- Component styles in bootstrap are minimal; the structure is in place.

When the follow-up Tailwind + shadcn/ui ticket lands, it consumes these CSS variables directly (Tailwind's `bg-[var(--color-fg)]` or via `tailwind.config.ts` `theme.extend.colors`). shadcn/ui's CSS-variable theme system is already aligned with this pattern, so the transition is mechanical.

For per-tenant overrides, the organisation's primary colour is validated at signup against a contrast check before saving; rejected colours fall back to the base. This keeps accessibility owned by the platform, not the tenant. The validation itself is a small server-side check (e.g., WCAG contrast formula against the chosen neutral surface) — not a UI feature, just a guard.

## Settled product implications from the critique

- The worker's Start and End actions are distinct from summary authoring. Pending, rejected, or conflicting offline evidence receives a persistent state and is never silently dropped.
- Offline access is limited to assigned current-day work and the minimum necessary participant/safety information for at most 24 hours since the last server verification.
- “On my way” is optional and must never gate Start. Real-time participant tracking is not in v1.
- The worker submits a participant-readable summary; photos and audio attachments are not in v1. Urgent concerns use a separate, always-visible handoff.
- Participants, nominees/representatives, and external users are separate relationships with different authority and error states.
- Dark mode, Auslan video, and install-prompt optimisation remain post-pilot research items, not v1 acceptance requirements.
