import pa11y from "pa11y"
import { chromium } from "playwright"

const url = process.env.A11Y_URL ?? "http://127.0.0.1:3000/design-system"
const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH ?? chromium.executablePath()
const results = await pa11y(url, {
  standard: "WCAG2AA",
  includeWarnings: true,
  chromeLaunchConfig: { headless: true, executablePath },
})
// No warning/error allowlist is configured: every WCAG issue is unbaselined.
console.log(`pa11y: ${results.issues.length} issues`)
if (results.issues.length) {
  console.error(JSON.stringify(results.issues, null, 2))
  process.exitCode = 1
}
