import { chromium } from "playwright"
import AxeBuilder from "@axe-core/playwright"

const url = process.env.A11Y_URL ?? "http://127.0.0.1:3000/design-system"
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
try {
  const page = await context.newPage()
  await page.goto(url, { waitUntil: "networkidle" })
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze()
  // No allowlist is configured: every WCAG violation is an unbaselined release failure.
  const blocking = results.violations
  console.log(`axe: ${results.passes.length} pass groups, ${results.violations.length} violation groups`)
  if (blocking.length) {
    console.error(JSON.stringify(blocking, null, 2))
    process.exitCode = 1
  }
} finally {
  await context.close()
  await browser.close()
}
