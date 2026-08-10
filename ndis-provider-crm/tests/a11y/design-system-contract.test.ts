import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

const root = resolve(process.cwd())
const tokens = readFileSync(resolve(root, "src/styles/tokens.css"), "utf8")
const route = readFileSync(resolve(root, "src/app/design-system/page.tsx"), "utf8")
const reference = readFileSync(resolve(root, "src/app/design-system/design-system-client.tsx"), "utf8")
const globals = readFileSync(resolve(root, "src/app/globals.css"), "utf8")

describe("accessibility rails", () => {
  it("keeps every defined design token visible in the reference route", () => {
    const defined = [...tokens.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((match) => match[1])
    const missing = defined.filter((token) => !reference.includes(`"${token}"`))
    expect(missing).toEqual([])
  })

  it("keeps production access as an actual 404 boundary", () => {
    expect(route).toContain("notFound()")
    expect(route).toContain('process.env.NODE_ENV === "production"')
  })

  it("exposes worker and ordinary target rails and constrained-mode fallbacks", () => {
    expect(tokens).toContain("--touch-ordinary-min: 24px")
    expect(tokens).toContain("--touch-worker-min: 48px")
    expect(globals).toContain("@media (forced-colors: active)")
    expect(globals).toContain("prefers-reduced-motion: reduce")
  })
})
