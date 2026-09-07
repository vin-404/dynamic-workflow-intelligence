/**
 * Verifies the two Phase-7 surfaces in a real browser: the natural-language
 * box and the narration. Fails on any console error.
 */
import { chromium } from "playwright";
import { signIn } from "./lib.mjs";

const BASE = "http://localhost:3000";
const OUT = process.argv[2] ?? ".";
const problems = [];
let step = 0;

async function shot(page, name) {
  step += 1;
  const file = `${OUT}/${String(step).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

function ok(label, condition, detail = "") {
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) problems.push(label);
  return condition;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(String(e)));

console.log("\n=== Explain: the narration on the analysis stage ===");
await page.goto(BASE, { waitUntil: "networkidle" });
await signIn(page, "Interpreter");
await page.getByText("Campus Tech Symposium").first().click();
await page.waitForTimeout(800);
// Walk to the analyze stage via the journey nav.
await page.getByRole("button", { name: /Bottlenecks/ }).click();
await page.waitForTimeout(2500);
ok("analysis rendered", await page.getByText(/day 26|Projected/i).first().isVisible());

const explainBtn = page.getByRole("button", { name: /Say this in plain language/i });
ok("the explain button is offered", await explainBtn.isVisible());
await explainBtn.click();
await page.waitForTimeout(1500);
ok(
  "the narration is labelled as engine wording, not passed off as a model",
  await page.getByText(/engine wording/i).first().isVisible(),
);
ok(
  "the presentation-only note is shown",
  await page.getByText(/cannot introduce/i).first().isVisible(),
);
console.log("  shot:", await shot(page, "explain"));

console.log("\n=== Ask: natural language to typed changes ===");
await page.getByRole("button", { name: /What if/ }).click();
await page.waitForTimeout(1200);
ok("the ask box is present", await page.getByText(/Ask in your own words/i).first().isVisible());
ok(
  "it says no model is configured rather than hiding it",
  await page.getByText(/no model configured/i).first().isVisible(),
);

const box = page.getByLabel(/Describe a change in your own words/i);
await box.fill("Anitha is unavailable from day 14 to day 21");
await page.getByRole("button", { name: /^Interpret$/ }).click();
await page.waitForTimeout(1800);

ok(
  "it reports what it understood",
  await page.getByRole("heading", { name: /What it understood/i }).isVisible(),
);
ok(
  "the typed mutation is shown to the user before anything runs",
  await page.getByText(/RESOURCE_UNAVAILABLE_WINDOW/).first().isVisible(),
);
ok("it states that nothing was applied", await page.getByText(/nothing applied/i).first().isVisible());
ok(
  "the method is labelled as a pattern match",
  await page.getByText(/matched by pattern/i).first().isVisible(),
);
console.log("  shot:", await shot(page, "ask-understood"));

await page.getByRole("button", { name: /Simulate this/i }).click();
await page.waitForTimeout(2500);
ok("the simulation renders a diff", await page.getByText(/What this would do/i).first().isVisible());
const later = await page.getByText(/day 33/).first().isVisible().catch(() => false);
ok("the projected finish moves to day 33", later);
ok(
  "the base workflow is shown to be unchanged",
  await page.getByText(/unchanged/i).first().isVisible(),
);
console.log("  shot:", await shot(page, "ask-simulated"));

console.log("\n=== Ask: something it cannot express ===");
await box.fill("make the coffee");
await page.getByRole("button", { name: /^Interpret$/ }).click();
await page.waitForTimeout(1500);
ok(
  "it says it did not understand rather than guessing",
  await page.getByText(/did not understand/i).first().isVisible(),
);
console.log("  shot:", await shot(page, "ask-refused"));

ok(`no console errors`, consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

await browser.close();
console.log(
  `\n${problems.length === 0 ? "ALL CHECKS PASSED" : `FAILURES: ${problems.join(", ")}`}`,
);
process.exit(problems.length === 0 ? 0 : 1);
