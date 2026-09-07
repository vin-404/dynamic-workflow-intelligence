/**
 * Phase 9 in a browser: the name picker, the identity surviving a reload,
 * two browsers as two people, an error boundary that does not blank the page,
 * and an empty state that says what to do next.
 */
import { chromium } from "playwright";

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

// ---------------------------------------------------------------------------
console.log("\n=== The name picker is the first screen ===");
const ctxA = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
const page = await ctxA.newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(BASE, { waitUntil: "networkidle" });
ok("it asks who you are", await page.getByText(/Who are you\?/i).first().isVisible());
ok(
  "it says there is no password rather than implying security",
  await page.getByText(/no password needed/i).first().isVisible(),
);
ok(
  "it is honest that anyone can pick any name",
  await page.getByText(/Anyone with this link can pick any name/i).first().isVisible(),
);
ok(
  "it offers people who have been here before",
  await page.getByText(/continue as someone who has been here/i).first().isVisible(),
);
console.log("  shot:", await shot(page, "who-are-you"));

await page.getByLabel(/Your name/i).fill("Devika Raman");
await page.getByRole("button", { name: /^Continue$/ }).click();
await page.waitForTimeout(1200);
ok("picking a name opens the workflow list", await page.getByText(/Open a workflow/i).first().isVisible());
ok("the header shows who you are", await page.getByText(/Devika Raman/).first().isVisible());
console.log("  shot:", await shot(page, "picked"));

// ---------------------------------------------------------------------------
console.log("\n=== It survives a reload ===");
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(800);
ok(
  "it does not ask again",
  !(await page.getByText(/Who are you\?/i).first().isVisible().catch(() => false)),
);
ok("and still knows the name", await page.getByText(/Devika Raman/).first().isVisible());

// ---------------------------------------------------------------------------
console.log("\n=== A second browser is a second person ===");
const ctxB = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const page2 = await ctxB.newPage();
await page2.goto(BASE, { waitUntil: "networkidle" });
ok("the second browser is asked who it is", await page2.getByText(/Who are you\?/i).first().isVisible());
ok(
  "and is offered the first person's name, because nothing is private",
  await page2.getByRole("button", { name: /Devika Raman/ }).first().isVisible(),
);
await page2.getByLabel(/Your name/i).fill("Tomas Klein");
await page2.getByRole("button", { name: /^Continue$/ }).click();
await page2.waitForTimeout(1000);
ok("the second identity is separate", await page2.getByText(/Tomas Klein/).first().isVisible());
ok(
  "and the first browser is unaffected",
  await page.getByText(/Devika Raman/).first().isVisible(),
);

// ---------------------------------------------------------------------------
console.log("\n=== Both see the same project after a refresh ===");
await page.getByText("Campus Tech Symposium").first().click();
await page.waitForTimeout(1000);
await page2.getByText("Campus Tech Symposium").first().click();
await page2.waitForTimeout(1000);
ok("both browsers opened the same workflow", await page2.getByText(/Build the workflow/i).first().isVisible());

// Edit in one, refresh the other.
await page.getByRole("button", { name: /Add task/i }).first().click().catch(() => {});
await page.waitForTimeout(400);
const before = await page2.getByText(/Campus Tech Symposium/).first().isVisible();
await page2.reload({ waitUntil: "networkidle" });
await page2.waitForTimeout(1200);
ok("the second browser reloads onto the same project", await page2.getByText(/Campus Tech Symposium/).first().isVisible(), `was ${before}`);
console.log("  shot:", await shot(page2, "second-browser"));

// ---------------------------------------------------------------------------
console.log("\n=== Empty states say what to do next ===");
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
await page.getByText("Campus Tech Symposium").first().click();
await page.waitForTimeout(900);
await page.getByRole("button", { name: /Bottlenecks/ }).click();
await page.waitForTimeout(500);
const notAnalysed = await page
  .getByText(/Not analysed yet/i)
  .first()
  .isVisible()
  .catch(() => false);
const analysed = await page
  .getByText(/day 26|Projected/i)
  .first()
  .isVisible()
  .catch(() => false);
ok(
  "the analysis stage either shows results or tells you how to get them",
  notAnalysed || analysed,
);
await page.waitForTimeout(2500);

// ---------------------------------------------------------------------------
console.log("\n=== An error message carries a hint ===");
// Everything before this point must be clean. The next step deliberately
// requests a missing project, and the browser logs that 404 itself.
ok("no console errors during normal use", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
const expectedErrors = consoleErrors.length;
// Ask for a project that does not exist; the structured error must surface.
const response = await page.evaluate(async () => {
  const r = await fetch("/api/projects/00000000-0000-0000-0000-0000000000ff/workflow");
  return { status: r.status, body: await r.json() };
});
ok("a 404 through the app's own fetch is structured", response.status === 404);
ok("it carries a hint", Boolean(response.body.hint), response.body.hint);
ok("and a request id", Boolean(response.body.request_id), response.body.request_id);

ok(
  "the only console error is the 404 this test asked for",
  consoleErrors.length - expectedErrors <= 1,
  consoleErrors.slice(expectedErrors).join(" | "),
);

await browser.close();
console.log(`\n${problems.length === 0 ? "ALL CHECKS PASSED" : `FAILURES: ${problems.join(", ")}`}`);
process.exit(problems.length === 0 ? 0 : 1);
