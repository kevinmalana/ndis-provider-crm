import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { DEFAULT_TENANT_THEME, contrastRatio, resolveValidatedTenantTheme } from "@/lib/tenant-theme"

const root = resolve(process.cwd())
const tokens = readFileSync(resolve(root, "src/styles/tokens.css"), "utf8")
const route = readFileSync(resolve(root, "src/app/design-system/page.tsx"), "utf8")
const reference = readFileSync(resolve(root, "src/app/design-system/design-system-client.tsx"), "utf8")
const globals = readFileSync(resolve(root, "src/app/globals.css"), "utf8")
const accessibility = readFileSync(resolve(root, "src/components/ui/accessibility.tsx"), "utf8")

describe("accessibility rails", () => {
  it("keeps every defined design token visible in the reference route", () => {
    const defined = [...tokens.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((match) => match[1])
    const missing = defined.filter((token) => !reference.includes(`"${token}"`))
    expect(missing).toEqual([])
  })

  it("keeps production access as an actual 404 boundary", () => {
    expect(route).toContain("notFound()")
    expect(route).toContain('process.env.NODE_ENV === "production"')
    expect(reference).not.toContain('data-theme-validated="true"')
  })

  it("fails closed for absent, malformed, and low-contrast tenant themes", () => {
    for (const candidate of [undefined, {}, { primary: "nope", primaryForeground: "#ffffff" }, { primary: "#ffffff", primaryForeground: "#eeeeee", accent: "#ffffff", accentForeground: "#eeeeee" }]) {
      const result = resolveValidatedTenantTheme(candidate)
      expect(result.validated).toBe(false)
      expect(result.theme).toEqual(DEFAULT_TENANT_THEME)
    }
    const valid = resolveValidatedTenantTheme({ primary: "#166534", primaryForeground: "#ffffff", accent: "#075985", accentForeground: "#ffffff" })
    expect(valid.validated).toBe(true)
    expect(contrastRatio(valid.theme.primary, valid.theme.primaryForeground)).toBeGreaterThanOrEqual(4.5)
  })

  it("requires a measured sticky scroll-space contract", () => {
    expect(globals).toContain("scroll-padding-block-end: var(--sticky-action-space")
    expect(globals).toContain("padding-block-end: var(--sticky-action-space")
    expect(accessibility).toContain("ResizeObserver")
    expect(accessibility).toContain("offsetHeight")
    expect(reference).toContain("StickyActionLayout")
  })

  it("exposes worker and ordinary target rails and constrained-mode fallbacks", () => {
    expect(tokens).toContain("--touch-ordinary-min: 24px")
    expect(tokens).toContain("--touch-worker-min: 48px")
    expect(globals).toContain("@media (forced-colors: active)")
    expect(globals).toContain("prefers-reduced-motion: reduce")
    expect(tokens).toContain("--color-border-strong: #71717a")
  })
})
