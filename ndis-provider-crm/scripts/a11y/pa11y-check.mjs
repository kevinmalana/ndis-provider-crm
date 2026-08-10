import pa11y from "pa11y"

const url = process.env.A11Y_URL ?? "http://127.0.0.1:3000/design-system"
const results = await pa11y(url, {
  standard: "WCAG2AA",
  includeWarnings: true,
  browserLaunchOptions: { headless: true },
})
const errors = results.issues.filter((issue) => issue.type === "Error")
console.log(`pa11y: ${results.issues.length} issues (${errors.length} errors)`)
if (errors.length) {
  console.error(JSON.stringify(errors, null, 2))
  process.exitCode = 1
}
