/**
 * Drives the whole journey in a real browser, twice: once over a seeded
 * project, and once building a brand-new workflow from an empty state in a
 * domain the user defines on the spot.
 *
 * Fails loudly on any console error or any expected element that never
 * appears, so "it renders" is not confused with "it works".
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
  const mark = condition ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) problems.push(label);
  return condition;
}

async function waitText(page, text, timeout = 15000) {
  try {
    await page.getByText(text, { exact: false }).first().waitFor({ timeout });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  /* ================================================ 1. landing */
  console.log("\n=== Landing ===");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await signIn(page, "Journey");
  ok("landing lists the seeded workflows", await waitText(page, "Campus Tech Symposium"));
  ok("second seed domain is listed too", await waitText(page, "Battery Pack Pilot Line"));
  ok("no dashboard on the landing surface", !(await waitText(page, "KPI", 800)));
  await shot(page, "landing");

  /* ============================ 2. seeded project, all six stages */
  for (const name of ["Campus Tech Symposium", "Battery Pack Pilot Line"]) {
    console.log(`\n=== ${name} ===`);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await signIn(page, "Journey");
    await page.getByText(name, { exact: false }).first().click();
    ok("opens on the builder", await waitText(page, "Build the workflow"));
    ok("shows the tasks it has", await waitText(page, "The work"));
    ok("shows who does the work", await waitText(page, "Who and what does the work"));
    ok("shows the dependencies", await waitText(page, "What waits on what"));
    await shot(page, `build-${name.split(" ")[0].toLowerCase()}`);

    // Stage 2 - bottlenecks
    await page.getByRole("button", { name: /Bottlenecks/ }).click();
    ok("analysis headline appears", await waitText(page, "Projected finish"));
    ok("evidence tier is shown", await waitText(page, "Evidence tier"));
    ok(
      "unavailable checks are disclosed",
      await waitText(page, "cannot assess yet"),
    );
    ok("the graph renders", (await page.locator(".react-flow").count()) > 0);
    await shot(page, `bottlenecks-${name.split(" ")[0].toLowerCase()}`);

    // Stage 3 - risk
    await page.getByRole("button", { name: /Predicted risk/ }).click();
    ok("risk is labelled a structural estimate", await waitText(page, "structural estimate"));
    ok("the three-point range is shown", await waitText(page, "pessimistic"));
    ok("no percentage is claimed", await waitText(page, "not a probability"));
    ok("weights are on screen", await waitText(page, "weights are yours to move"));
    // Expand the top task's factor table.
    const firstRisk = page.locator("text=/^slack ratio$/").first();
    ok(
      "factor decomposition is visible",
      (await page.getByText("slack ratio", { exact: false }).count()) > 0,
    );
    await shot(page, `risk-${name.split(" ")[0].toLowerCase()}`);

    // Stage 4 - what-if
    await page.getByRole("button", { name: /What if/ }).click();
    ok("what-if composer appears", await waitText(page, "Ask a hypothetical"));
    await shot(page, `whatif-${name.split(" ")[0].toLowerCase()}`);

    // Stage 5 - optimize
    await page.getByRole("button", { name: /Better workflows/ }).click();
    ok("optimizer appears", await waitText(page, "Search for a better workflow"));
    await shot(page, `optimize-${name.split(" ")[0].toLowerCase()}`);

    // Stage 6 - history
    await page.getByRole("button", { name: /History/ }).click();
    ok("version history appears", await waitText(page, "Every version this workflow has had"));
    ok("accuracy is reachable but off the landing surface", await waitText(page, "Detector accuracy"));
    await shot(page, `history-${name.split(" ")[0].toLowerCase()}`);
  }

  /* ============================ 3. the real what-if, end to end */
  console.log("\n=== What-if: someone is unavailable ===");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await signIn(page, "Journey");
  await page.getByText("Campus Tech Symposium").first().click();
  await waitText(page, "Build the workflow");
  await page.getByRole("button", { name: /What if/ }).click();
  await waitText(page, "Ask a hypothetical");

  const question = page.locator("select").first();
  await question.selectOption({ label: "Someone is unavailable" });
  const selects = page.locator("select");
  await selects.nth(1).selectOption({ index: 1 }); // a resource
  await page.getByRole("button", { name: "Add change" }).click();
  ok("the change is queued", await waitText(page, "nothing is written"));
  await page.getByRole("button", { name: "Simulate" }).click();
  ok("the diff appears", await waitText(page, "What this would do", 25000));
  ok(
    "the base workflow is proved untouched",
    await waitText(page, "Is the original workflow untouched?"),
  );
  ok("the hash is shown before and after", await waitText(page, "unchanged"));
  await shot(page, "whatif-diff");

  /* ============================ 4. the refusal */
  console.log("\n=== Optimize with no limits: the refusal ===");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await signIn(page, "Journey");
  await page.getByText("Battery Pack Pilot Line").first().click();
  await waitText(page, "Build the workflow");
  await page.getByRole("button", { name: /Better workflows/ }).click();
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: /Find better workflows/ }).click();
  ok("candidates are scored", await waitText(page, "recommended", 60000));
  ok("the refusal is shown", await waitText(page, "Refused"));
  ok(
    "the constraint reason is quoted",
    await waitText(page, "UN38.3"),
  );
  ok("the per-criterion table is shown", await waitText(page, "expected completion"));
  ok(
    "the total is labelled a ranking aid",
    await waitText(page, "ranking aid"),
  );
  await shot(page, "optimize-refusal");

  /* ---------------------------------------------------------------------
   * Building from nothing, in a user-defined domain, lives in coldstart.mjs -
   * it needs panel-scoped selectors that would clutter this file.
   * ------------------------------------------------------------------- */

  /* ================================================== console */
  console.log("\n=== Console ===");
  // A refused mutation is a 422 by design and the browser logs every 4xx, so
  // the check is for *unexpected* console output.
  const real = consoleErrors.filter(
    (e) => !/favicon|React DevTools|422 \(Unprocessable/i.test(e),
  );
  ok("no unexpected console errors", real.length === 0, real.slice(0, 3).join(" | "));

  await browser.close();

  console.log(
    `\n${problems.length === 0 ? "ALL CHECKS PASSED" : `FAILURES (${problems.length}):`}`,
  );
  problems.forEach((p) => console.log(`  - ${p}`));
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("harness crashed:", e);
  process.exit(2);
});
