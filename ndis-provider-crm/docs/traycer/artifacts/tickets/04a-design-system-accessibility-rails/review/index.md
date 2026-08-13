---
title: "Ticket 04a accessibility rails cold review"
kind: review
---

## Final cold review of `26f510b` (on top of `645e895` + `faaaba8`)

**Recommendation: MERGE after the required browser/manual accessibility gate.** The remaining sticky Major Drift is closed: the layout requires a definite height, owns the actual overflow region, reserves measured action space, includes a realistic overflow/focus fixture, and no unsafe standalone bar is exported. Tenant validation/fallback, strict axe/Pa11y semantics, and the >=3:1 sticky boundary remain intact. No actionable source blocker remains in this pass.

### Sticky finding closure

- `StickyActionLayout` now requires `height` and applies it directly to the element with `overflow: auto` (`src/components/ui/accessibility.tsx:48-82`).
- The action bar height is measured with `ResizeObserver` and written to the same scroller's `scroll-padding-block-end`/reserved padding (`src/components/ui/accessibility.tsx:64-73`; `src/app/globals.css:95-105`).
- The reference route exercises a definite `18rem` scroller with `min-h-[32rem]` content and a focusable input near the action region (`src/app/design-system/design-system-client.tsx:82`).
- `StickyActionBarInternal` is private; the public export is now only `StickyActionLayout` (`src/components/ui/accessibility.tsx:44-46,92`).

### Prior fix verification

- **Tenant validation/fallback — pass.** Strict six-digit hex parsing, complete-pair 4.5:1 checks, and all-or-default fallback remain in `src/lib/tenant-theme.ts:22-90`; the client does not self-assert the validated attribute. Contract tests pass.
- **Axe/Pa11y semantics — pass.** Axe fails on every violation and Pa11y on every issue, with no allowlist (`scripts/a11y/axe-check.mjs:8-16`; `scripts/a11y/pa11y-check.mjs:4-14`).
- **Sticky boundary contrast — pass.** `#71717a` is approximately 4.83:1 on white (`src/styles/tokens.css:22-24`).

### Residual release gate

Chromium/Chrome binaries are unavailable in this environment, so automated axe/Pa11y page execution and manual keyboard, screen-reader, zoom/reflow, forced-colour, reduced-motion, touch, and AT checks remain unrun. This is the required release validation gate, not a source finding.

### Verification and gates at `26f510b`

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile --offline` | Pass |
| `pnpm lint` | Pass |
| `pnpm typecheck` | Pass |
| `pnpm build` | Pass; route compiles |
| `pnpm db:parse` | Pass; all 7 migrations |
| `pnpm db:test` | Pass; 6 files / 52 tests |
| `git diff --check main...HEAD` | Pass |
| Dev `GET /design-system` | Pass; HTTP 200 and fixture content present |
| Production `GET /design-system` | Pass; HTTP 404 after `next build`/`next start` |
| `pnpm a11y:axe` | **Unavailable**: Playwright Chromium executable absent |
| `pnpm a11y:pa11y` | **Unavailable**: Puppeteer Chrome executable absent |

No source, Docker, remote Supabase, or `.env.local` was accessed or modified during review.

## Historical review of `faaaba8`

**Recommendation: DO NOT MERGE.** The tenant validator/fail-closed fallback, strict automated failure semantics, and >=3:1 boundary fix are present and pass local contract tests. One material sticky-focus gap remains, and Chromium/manual AT checks are unavailable.

### Prior finding verification

- **Tenant override validation/fallback — closed for the implemented utility.** `resolveValidatedTenantTheme` accepts strict six-digit hex pairs, requires both primary and accent pairs to reach 4.5:1, and returns the complete default theme on absent/malformed/low-contrast input (`src/lib/tenant-theme.ts:22-76`). The reference client no longer self-asserts `data-theme-validated`; the validated attribute and custom properties are emitted only by `getValidatedTenantThemeProps` (`src/lib/tenant-theme.ts:78-90`; `src/app/design-system/design-system-client.tsx:66-70`). Five contract tests cover fallback and a valid pair.
- **Strict axe/Pa11y semantics — closed in scripts.** Axe now fails on every violation and Pa11y fails on every issue; no allowlist is present (`scripts/a11y/axe-check.mjs:8-16`; `scripts/a11y/pa11y-check.mjs:4-14`). Browser execution remains unavailable in this environment.
- **Sticky boundary contrast — closed.** `--color-border-strong` is now `#71717a` (about 4.83:1 on white), above the 3:1 non-text target (`src/styles/tokens.css:22-24`).

### Residual finding

#### Major Drift — the sticky scroll contract still depends on an unstated definite-height parent

`StickyActionLayout` adds `overflow: auto`, `scroll-padding-block-end`, and measured padding (`src/components/ui/accessibility.tsx:57-80`; `src/app/globals.css:95-105`), but `.focus-safe-scroll-region` only has `max-height: 100%` and no definite height or viewport/container contract (`src/app/globals.css:97-102`). In the shipped reference usage it sits inside a normal `Card` with auto height (`src/app/design-system/design-system-client.tsx:82`), so the region expands to its content instead of becoming a scrolling container; the body then scrolls outside the element whose `scroll-padding` was configured. The standalone `StickyActionBar` is still exported and can be used without any scroll-space contract (`src/components/ui/accessibility.tsx:44-46`). In either case a focused control can still be hidden by the sticky bar, so the claimed WCAG 2.4.11 guarantee is not enforced by the reusable API. Require a definite scroll-region height (or make the component take/establish the scrolling container), apply scroll padding to that actual scroller, and remove or make the unsafe raw bar internal.

The previous review's token/component coverage, 24/48 CSS-pixel rails, reduced-motion/forced-colour CSS, production 404, and base text-pair contrast checks remain verified.

### Verification and gates at `faaaba8`

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile --offline` | Pass |
| `pnpm lint` | Pass |
| `pnpm typecheck` | Pass |
| `pnpm build` | Pass; route compiles |
| `pnpm db:parse` | Pass; all 7 migrations |
| `pnpm db:test` | Pass; 6 files / 52 tests |
| `git diff --check main...HEAD` | Pass |
| Dev `GET /design-system` | Pass; HTTP 200 and reference content present |
| Production `GET /design-system` | Pass; HTTP 404 after `next build`/`next start` |
| `pnpm a11y:axe` | **Not executed**: Playwright Chromium executable is absent |
| `pnpm a11y:pa11y` | **Not executed**: Puppeteer Chrome executable is absent |
| Keyboard, screen reader, zoom/reflow, forced-colour, reduced-motion, touch and manual AT checks | **Not run** |

The missing browser/manual checks are an additional release gate, not the only blocker: the sticky layout contract remains a concrete source issue. No source, Docker, remote Supabase, or `.env.local` was accessed or modified during review.

## Historical review of `645e895`

**Recommendation: DO NOT MERGE.** The base semantic text pairs, token/component reference coverage, 24/48 CSS-pixel rails, reduced-motion/forced-colour CSS, and production 404 boundary are directionally good. Two implementation gaps still invalidate the promised reusable accessibility rails; the browser/manual checks are also outstanding.

### Findings

#### Major Drift — tenant override “fallback” does not reject invalid or low-contrast values

`src/styles/tokens.css:113-133` uses `var(--tenant-primary, #18181b)` and equivalent accent variables. The `var()` fallback applies only when the custom property is absent; an invalid colour or a low-contrast colour still replaces the semantic token. There is no server validator or contrast test in this change, and the reference client sets `data-theme-validated="true"` itself (`src/app/design-system/design-system-client.tsx:66-70`). A future tenant value can therefore erase a usable token or produce an unreadable primary/accent pair while the code claims validation-safe fallback. Emit only server-validated values (or keep the override selector disabled until validation exists), and add a browser/static contract covering missing, invalid, and low-contrast override cases.

#### Major Drift — `StickyActionBar` is not actually focus-safe

The primitive only adds `position: sticky` and `scroll-margin-bottom` to the bar (`src/app/globals.css:84-93`; `src/components/ui/accessibility.tsx:44-46`). `scroll-margin-bottom` on the sticky container does not add scroll padding to the scroll container or to focused descendants, so a focused field behind/under the bottom bar can remain obscured. This fails the promised WCAG 2.4.11 protection in the matrix (`tests/a11y/wcag-2.2-aa-acceptance-matrix.md:18`). Use a layout/scroll-container contract that reserves the bar height (for example `scroll-padding-block-end` on the scrolling region plus a measured bar offset), and manually verify keyboard focus with the bar present.

#### Technical Drift — automated gates silently allow WCAG issues

The axe script reports all violations but fails only `serious`/`critical` impacts (`scripts/a11y/axe-check.mjs:10-14`), and Pa11y fails only `Error` issues while explicitly collecting warnings (`scripts/a11y/pa11y-check.mjs:8-13`). Moderate axe violations and Pa11y warnings can therefore leave CI green despite the WCAG AA matrix requiring a complete result. Fail on all un-baselined WCAG violations, or check in a narrowly documented allowlist with expiry and evidence.

#### Minor Issue — strong border token is below the non-text contrast target when used as a boundary

`--color-border-strong: #a1a1aa` against the white/base sticky background is approximately 2.56:1, below the 3:1 non-text contrast target. It is used for the sticky action separator (`src/app/globals.css:90`). If that line is relied on to distinguish the sticky action region, darken it or provide another 3:1 boundary; the normal text pairs themselves measure above their declared AA ratios.

### Verification and gates

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile --offline` | Pass |
| `pnpm lint` | Pass |
| `pnpm typecheck` | Pass |
| `pnpm build` | Pass; route compiles |
| `pnpm db:parse` | Pass; all 7 migrations |
| `pnpm db:test` | Pass; 6 files / 50 tests |
| `git diff --check main...HEAD` | Pass |
| Dev `GET /design-system` | Pass; HTTP 200 and reference content present |
| Production `GET /design-system` | Pass; HTTP 404 after `next build`/`next start` |
| `pnpm a11y:axe` | **Not executed**: Playwright Chromium executable is absent |
| `pnpm a11y:pa11y` | **Not executed**: Puppeteer Chrome executable is absent |
| Keyboard, screen reader, zoom/reflow, forced-colour, reduced-motion, touch and manual AT checks | **Not run** |

The missing browser/manual checks are an additional release gate, not the only reason for the recommendation: the tenant override and sticky-focus issues are concrete source blockers. No source, Docker, remote Supabase, or `.env.local` was accessed or modified during review.
