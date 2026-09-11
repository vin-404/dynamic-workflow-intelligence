/**
 * Every workspace stage, as the public read-only guest, against a running
 * app - and every capability surface the overnight run added.
 *
 *   node e2e/capabilities.mjs <base> [--branch] [--shots dir]
 *
 * `<base>` is a public-viewer build: `PUBLIC_DEMO_VIEWER=1` locally, or the
 * production URL. No sign-in happens; the point is the guest's view.
 *
 * `--branch` turns on the checks for surfaces that exist on
 * `feat/capability-completion` and not on `main`: the capability dialog, the
 * point-of-use model labels, the staleness preview, the scenario list, the
 * constraints panel, the objectives before a search. Without it the script
 * checks what both builds must satisfy, which is how the production pass is
 * separated from the branch pass.
 *
 * `--skip-writes` leaves out the two guest actions that persist scratch rows
 * on the server - an optimizer search (its candidates are stored as
 * scenarios) and a requirement change (its replan is) - for a pass against
 * production, where those rows would outlive the check.
 *
 * Per stage it records: console errors, that the panels carry API data, that
 * the visible controls do something, and - on a deliberately failed request -
 * that an error is shown rather than an empty success state. It asserts the
 * claim, not the render, in the spirit of the other walkthroughs.
 */
import { chromium } from "playwright";
import { signIn } from "./lib.mjs";

const args = process.argv.slice(2);
const BASE = (args.find((a) => !a.startsWith("--")) ?? "http://localhost:3100").replace(/\/+$/, "");
const BRANCH = args.includes("--branch");
const SKIP_WRITES = args.includes("--skip-writes");
/** Also run the import to a commit, signed in through the e2e provider
 *  (`E2E_AUTH_ENABLED=1` under `next dev`). Local stacks only. */
const IMPORT_SIGNED_IN = args.includes("--import-signed-in");
const OUT = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;

const P = "00000000-0000-0000-0000-000000000001";
const STAGES = ["build", "live", "bottlenecks", "risk", "requirements", "whatif", "optimize", "history"];

const problems = [];
const defects = [];
let step = 0;

function ok(label, condition, detail = "") {
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) problems.push(`${label}${detail ? ` (${detail})` : ""}`);
  return condition;
}
function defect(stage, did, expected, happened) {
  defects.push({ stage, did, expected, happened });
}
async function shot(page, name) {
  if (!OUT) return;
  step += 1;
  await page.screenshot({ path: `${OUT}/${String(step).padStart(2, "0")}-${name}.png`, fullPage: true });
}
async function waitText(page, text, timeout = 20000) {
  try {
    await page.getByText(text, { exact: false }).first().waitFor({ timeout });
    return true;
  } catch {
    return false;
  }
}
async function body(page) {
  return page.locator("body").innerText();
}

/** "Load the bundled sample" lists the samples when there are several; pick
 *  the first, then wait for the paste box to fill. */
async function loadBundledSample(page) {
  await page.getByRole("button", { name: /Load the bundled sample/ }).click();
  try {
    await page.waitForFunction(() => {
      const ta = document.querySelector("textarea");
      return (ta && ta.value.length > 100) || !!Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Load");
    }, null, { timeout: 30000 });
  } catch { /* judged by the caller */ }
  const loadOne = page.getByRole("button", { name: /^Load$/ });
  if (await loadOne.count()) {
    await loadOne.first().click();
    await page.waitForFunction(() => (document.querySelector("textarea")?.value.length ?? 0) > 100, null, { timeout: 30000 }).catch(() => {});
  }
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();

/** Console errors, bucketed by the stage that was on screen. */
const consoleErrors = {};
let currentStage = "landing";
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const where = m.location()?.url ?? "";
  (consoleErrors[currentStage] ??= []).push(where ? `${m.text()} <- ${where}` : m.text());
});
page.on("pageerror", (e) => (consoleErrors[currentStage] ??= []).push(`pageerror: ${e.message}`));

/** The requests the page made, so "does this control do something" is provable. */
const requests = [];
page.on("request", (r) => requests.push({ method: r.method(), url: r.url(), at: Date.now() }));
function requestsSince(t, pattern) {
  return requests.filter((r) => r.at >= t && pattern.test(`${r.method} ${r.url}`));
}

async function open(stage) {
  currentStage = stage;
  await page.goto(`${BASE}/workspace/${P}/${stage}`, { waitUntil: "networkidle", timeout: 120000 });
}

/** A console 404 on GET /replay is the live stage's probe, by design. */
function realErrors(list = []) {
  return list.filter(
    (e) =>
      !/favicon|React DevTools|422 \(|403 \(/i.test(e) &&
      !(/404/.test(e) && /\/replay(\?|$|\s)/.test(e)),
  );
}

try {
  /* ================================================================ precondition */
  console.log(`\n=== Preconditions against ${BASE} (${BRANCH ? "branch" : "main"} checks) ===`);
  {
    const probe = await context.request.get(`${BASE}/api/projects`);
    ok("the API answers a sessionless visitor", probe.status() === 200, `got ${probe.status()}`);
    const write = await context.request.post(`${BASE}/api/projects/${P}/tasks`, {
      data: { key: "PV0", name: "precondition", effort: 1 },
    });
    const refusal = await write.json().catch(() => ({}));
    ok("a guest write is refused by the backend with 403", write.status() === 403, `got ${write.status()}`);
    ok("and the refusal names the role", refusal?.detail?.your_role === "viewer", `your_role=${refusal?.detail?.your_role}`);
  }

  /* ======================================================================= build */
  console.log("\n=== build ===");
  await open("build");
  ok("the builder renders", await waitText(page, "Build the workflow"));
  ok("tasks come from the API", await waitText(page, "T01"));
  ok("the member list renders", (await body(page)).match(/member|owner|editor|viewer/i) !== null);
  if (BRANCH) {
    ok("the constraints panel is on the build stage", await waitText(page, "What may not be optimised away"));
    ok("the seeded constraints are listed with their reasons", await waitText(page, "Mandatory") && await waitText(page, "go/no-go gate"));
    // Declare one as the guest: the composer allows it; the backend refuses it.
    const selects = page.locator("select");
    const n = await selects.count();
    if (n >= 2) {
      await selects.nth(n - 1).selectOption({ index: 1 });
      await page.getByPlaceholder(/reason on record/i).fill("Overnight probe - should be refused for a guest.");
      const t = Date.now();
      await page.getByRole("button", { name: /Declare this constraint/ }).click();
      const shown = await waitText(page, /requires the editor role/i, 15000);
      ok("declaring as the guest sends the request and shows the backend's 403", shown && requestsSince(t, /POST .*\/constraints/).length === 1);
      if (!shown) defect("build", "declared a constraint as the guest", "the API's insufficient_role refusal shown in the panel", "no refusal text appeared");
    } else {
      ok("the constraint composer has its selects", false, `found ${n} selects`);
    }
  }
  await shot(page, "build");

  /* ======================================================================== live */
  console.log("\n=== live ===");
  await open("live");
  let liveOpened = await waitText(page, /simulated day/i, 30000);
  if (!liveOpened) {
    const start = page.getByRole("button", { name: /Start a new replay/ });
    if (await start.count()) {
      await start.first().click();
      liveOpened = await waitText(page, /simulated day/i, 30000);
    }
  }
  ok("a replay starts and frames arrive (a simulated day is on screen)", liveOpened);
  if (liveOpened && !(await page.getByRole("button", { name: /^Pause$/ }).count())) {
    // Joined a replay that had already finished (an earlier run's). Restart
    // it, which is what the control is for, then judge the live behaviour.
    const restart = page.getByRole("button", { name: /^Restart$/ });
    if (await restart.count()) {
      await restart.first().click();
      await page.waitForTimeout(1500);
    }
  }
  if (liveOpened) {
    const readDay = async () => {
      const t = await body(page);
      const m = t.match(/simulated day\s+([0-9]+(?:\.[0-9]+)?)/i) || t.match(/\bday\s+([0-9]+(?:\.[0-9]+)?)\b/i);
      return m ? Number(m[1]) : null;
    };
    const d1 = await readDay();
    await page.waitForTimeout(3500);
    const d2 = await readDay();
    ok("frames keep arriving over SSE: the clock advances", d1 !== null && d2 !== null && d2 > d1, `${d1} -> ${d2}`);
    ok("the frame is labelled a reconstruction", await waitText(page, /reconstruction/i));
    ok("the evidence tier is on screen and tied to the frame", await waitText(page, /evidence from/i));

    const pause = page.getByRole("button", { name: /^Pause$/ });
    if (await pause.count()) {
      const t = Date.now();
      await pause.first().click();
      const paused = requestsSince(t, /POST .*\/replay\/control/).length > 0;
      await page.waitForTimeout(2500);
      const d3 = await readDay();
      await page.waitForTimeout(2500);
      const d4 = await readDay();
      ok("pause sends a control request and the clock stops", paused && d3 !== null && d4 === d3, `control=${paused} ${d3} -> ${d4}`);
      if (!(paused && d4 === d3)) defect("live", "pressed Pause", "a replay/control request and a still clock", `control request sent: ${paused}; day ${d3} -> ${d4}`);
    } else {
      ok("a Pause control is visible", false);
    }
    const speed = page.getByLabel("Replay speed");
    ok("a speed control is visible", (await speed.count()) > 0);
    if (await speed.count()) {
      const t = Date.now();
      await speed.first().click();
      const options = page.getByRole("option");
      if (await options.count()) {
        await options.last().click();
        ok("changing speed sends a control request", requestsSince(t, /POST .*\/replay\/control/).length > 0);
      }
    }
    const slider = page.getByLabel("Scrub to a simulated day");
    ok("a seek control is visible", (await slider.count()) > 0);
    if (await slider.count()) {
      const t = Date.now();
      await slider.first().focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(1200);
      ok("seeking sends a control request", requestsSince(t, /POST .*\/replay\/control/).length > 0);
    }
  } else {
    defect("live", "opened the live stage", "a replay to start and a simulated day to appear", "no 'simulated day' text appeared within 30s");
  }
  await shot(page, "live");

  /* ================================================================= bottlenecks */
  console.log("\n=== bottlenecks ===");
  await open("bottlenecks");
  ok("the analysis renders", await waitText(page, /Evidence from/, 40000));
  ok("the checks that ran are counted", await waitText(page, /\d+ checks? ran/));
  ok("the unavailable checks are rendered, not dropped", await waitText(page, /could not/));
  const details = page.getByText("What this analysis cannot assess yet");
  if (await details.count()) {
    await details.first().click();
    ok("opening it names what each missing tier needs", await waitText(page, /needs actuals|Tier 3/i));
  }
  ok("findings carry a root cause and an action", await waitText(page, "Do this:"));
  const explain = page.getByRole("button", { name: /Say this in plain language/ });
  if (await explain.count()) {
    await explain.first().click();
    ok("the narration arrives", await waitText(page, /Numbers checked against the engine output/i, 30000));
    if (BRANCH) {
      ok("the narration is labelled as the deterministic fallback at the point of use", await waitText(page, /deterministic fallback/i));
    } else {
      ok("the narration says which method produced it", await waitText(page, /engine wording|rephrased by model/i));
    }
  } else {
    ok("the plain-language button is present", false);
  }
  await shot(page, "bottlenecks");

  // Deliberate failure: the analysis endpoint dies. The stage must say so.
  console.log("\n=== bottlenecks, with /analyze failing ===");
  currentStage = "deliberate-failure";
  await context.route(`**/api/projects/${P}/analyze`, (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable", detail: "Deliberately failed by the walkthrough.", hint: "This is the test." }) }),
  );
  await page.goto(`${BASE}/workspace/${P}/bottlenecks`, { waitUntil: "networkidle", timeout: 120000 });
  const failed = await waitText(page, /Deliberately failed by the walkthrough|did not work/i, 30000);
  ok("a failed analysis shows an error, not an empty success state", failed);
  if (!failed) defect("bottlenecks", "made /analyze return 503", "an error note on the stage", "no error text appeared");
  const emptyLooksOk = (await body(page)).includes("Nothing found at this evidence tier");
  ok("and no 'nothing found' copy pretends the check ran", !emptyLooksOk);
  await context.unroute(`**/api/projects/${P}/analyze`);

  /* ======================================================================== risk */
  console.log("\n=== risk ===");
  await open("risk");
  ok("the structural disclaimer survives verbatim", await waitText(page, /structural estimate/i, 40000) && await waitText(page, /not a probability/i));
  ok("the factor decomposition renders", await waitText(page, "Factor decomposition"));
  ok("the forecast panel renders below it", await waitText(page, /iterations|seed/i));
  const weightInputs = page.locator('section:has-text("The weights are yours to move") input[type=number]');
  if (await weightInputs.count()) {
    await weightInputs.first().fill("0.9");
    const t = Date.now();
    await page.getByRole("button", { name: /Re-rank with these weights/ }).click();
    let riskReq = false;
    try {
      await page.waitForRequest((r) => r.method() === "POST" && /\/risk(\?|$)/.test(r.url()), { timeout: 10000 });
      riskReq = true;
    } catch {
      riskReq = requestsSince(t, /POST .*\/risk(\?|$)/).length > 0;
    }
    if (BRANCH) {
      ok("re-weighting sends a POST /risk to the engine", riskReq);
      await page.waitForTimeout(1500);
      // The bands on screen must be the engine's for the same weights.
      const w = {};
      const inputs = await weightInputs.all();
      for (const input of inputs) {
        const name = await input.evaluate((el) => el.closest("label")?.innerText.split("\n")[0].trim().replace(/ /g, "_"));
        w[name] = Number(await input.inputValue());
      }
      const r = await context.request.post(`${BASE}/api/projects/${P}/risk`, { data: { weights: w } });
      const engine = await r.json();
      const counts = engine.band_counts ?? {};
      const text = await body(page);
      const shown = `${counts.high} high · ${counts.moderate} moderate · ${counts.low} low`;
      ok("the bands on screen are the engine's bands for those weights", text.includes(shown), `engine says ${shown}`);
      if (!text.includes(shown)) defect("risk", "moved slack_ratio to 0.9 and re-ranked", `band counts ${shown} from POST /risk`, "the screen shows different counts");
    } else {
      ok("re-weighting on main recomputes in the browser (no POST /risk) - the defect Prompt 1 fixes", !riskReq, riskReq ? "a request went out" : "no request; bands come from a client-side copy of the thresholds");
      if (!riskReq) defect("risk", "moved a weight and re-ranked", "a POST /risk so the engine bands the scores", "no request: the browser recomputed with its own thresholds (0.6/0.35 vs the engine's 0.55/0.30)");
    }
  } else {
    ok("the weight inputs are present", false);
  }
  await shot(page, "risk");

  /* ================================================================ requirements */
  console.log("\n=== requirements ===");
  await open("requirements");
  ok("the requirement rail renders from the API", await waitText(page, "Single-day event, 400 attendees", 40000));
  await page.getByText("Single-day event, 400 attendees").first().click();
  ok("the composer opens for R1", await waitText(page, "Propose a new wording for R1"));
  if (BRANCH) {
    ok("the staleness preview appears before a wording exists", await waitText(page, "If R1 changes at all", 30000));
    const t = await body(page);
    // `innerText` applies the headings' CSS `uppercase`, so match case-blind.
    ok("must-redo and must-recheck are separate lists", /Must redo — \d+/i.test(t) && /Must recheck — \d+/i.test(t));
    ok("the finished task in the redo list is named", t.includes("Draft budget"));
  }
  ok("the history panel renders with the API's own note", await waitText(page, "Recorded wordings of R1") && await waitText(page, /never changed/i));
  if (SKIP_WRITES) {
    console.log("  [SKIP] requirement change (persists a replan scenario on the server)");
  } else {
  const ta = page.locator("textarea").first();
  await ta.fill("Two-day event, 600 attendees");
  const t0 = Date.now();
  await page.getByRole("button", { name: /What would this cost/ }).click();
  ok("the impact report arrives from POST .../change", await waitText(page, "This is a blast radius", 40000) && requestsSince(t0, /POST .*\/requirements\/R1\/change/).length === 1);
  const rt = await body(page);
  ok("the report keeps redo and recheck apart", /Must redo/i.test(rt) && /Must recheck/i.test(rt));
  ok("the human-judgement caveat is on screen", /human judgement|blast radius/i.test(rt));
  }
  if (BRANCH && !SKIP_WRITES) {
    const diffBtn = page.getByRole("button", { name: /before and after this replan/ });
    if (await diffBtn.count()) {
      await diffBtn.first().click();
      ok("the replan's full diff renders via DiffView", await waitText(page, "Is the original workflow untouched?", 40000));
    } else {
      ok("the replan offers its before/after", false);
    }
  }
  await shot(page, "requirements");

  /* ====================================================================== whatif */
  console.log("\n=== whatif ===");
  await open("whatif");
  ok("the sentence box renders", await waitText(page, "Ask in your own words", 40000));
  ok("the composer renders", await waitText(page, "Ask a hypothetical"));
  ok("the sentence box says no model is configured", await waitText(page, /no model configured/i));
  if (BRANCH) {
    ok("the saved scenarios list is on the stage", await waitText(page, "Saved scenarios"));
    ok("the closed algebra is named where changes are authored", await waitText(page, /kinds of change this system can express/));
  }
  const q = page.locator("select").first();
  await q.selectOption({ label: "A task slips" });
  await page.locator("select").nth(1).selectOption({ index: 1 });
  await page.getByRole("button", { name: "Add change" }).click();
  ok("the change is queued and nothing is written", await waitText(page, "nothing is written"));
  const keep = page.getByLabel(/keep it as a saved scenario/i);
  if (BRANCH) {
    ok("the composer offers to keep the scenario, unticked by default", (await keep.count()) > 0 && !(await keep.first().isChecked()));
    if (await keep.count()) await keep.first().check();
  }
  const t1 = Date.now();
  await page.getByRole("button", { name: "Simulate" }).click();
  ok("the diff appears", await waitText(page, "What this would do", 40000));
  ok("the base workflow is proved untouched", await waitText(page, "Is the original workflow untouched?"));
  const kept = requestsSince(t1, /POST .*\/what-if/).length === 1;
  ok("one what-if request went out", kept);
  if (BRANCH) {
    const listed = await waitText(page, /finish \+\d+(\.\d+)?d · day \d+ → \d+|finish date unchanged/, 40000);
    ok("the kept scenario appears in the list with the engine's finish-date effect", listed);
    if (!listed) defect("whatif", "kept a what-if and looked at the scenario list", "the new row with its finish-date delta", "no row with a computed effect appeared");
    const rowToggle = page.locator('section:has(h2:text("Saved scenarios")) button[aria-expanded="false"]').first();
    if (await rowToggle.count()) {
      await rowToggle.click();
      ok("opening a scenario shows its diff", await waitText(page, "Is the original workflow untouched?", 40000));
      const del = page.getByRole("button", { name: /Delete this scenario/ });
      if (await del.count()) {
        await del.first().click();
        ok("deleting asks for confirmation and says no version is touched", await waitText(page, /no workflow version is touched/i));
        const t2 = Date.now();
        await page.getByRole("button", { name: /Yes — delete the scenario/ }).click();
        const refused = await waitText(page, /Not deleted/i, 15000);
        ok("as the guest the delete is refused by the backend and shown", refused && requestsSince(t2, /DELETE .*\/scenarios\//).length === 1);
      } else {
        ok("a delete control is offered", false);
      }
    }
  }
  await shot(page, "whatif");

  /* ==================================================================== optimize */
  console.log("\n=== optimize ===");
  await open("optimize");
  ok("the search controls render", await waitText(page, "Find better workflows", 40000));
  if (BRANCH) {
    ok("the objectives are on screen before a search", await waitText(page, "What a ranking will be scored on") && await waitText(page, "expected completion"));
    ok("each criterion says what it measures and which way is better", await waitText(page, /is better/));
    ok("the proposer's availability is stated up front", await waitText(page, /No model is configured|Model .* is configured/));
  }
  if (SKIP_WRITES) {
    console.log("  [SKIP] optimizer search (persists its candidates as scenarios on the server)");
  } else {
  const t3 = Date.now();
  await page.getByRole("button", { name: /Find better workflows/ }).click();
  const ranked = await waitText(page, /recommended|No candidate improved/, 90000);
  ok("a search runs and returns a ranking from the engine", ranked && requestsSince(t3, /POST .*\/optimize(\?|$)/).length === 1);
  ok("the per-criterion table is shown", await waitText(page, /expected completion/));
  ok("the total is labelled a ranking aid", await waitText(page, "ranking aid"));
  if (BRANCH) {
    ok("each rationale is labelled with what wrote it", await waitText(page, /deterministic fallback/));
    ok("the response says which sources produced the ranking", await waitText(page, /deterministic generators/));
    ok("the closed algebra is named beside the exact changes", await waitText(page, /kinds of change this system can express/));
  }
  }
  await shot(page, "optimize");

  /* ===================================================================== history */
  console.log("\n=== history ===");
  await open("history");
  ok("the version history renders from the API", await waitText(page, /Seeded from fixture|v1|version 1/i, 40000));
  await shot(page, "history");

  /* ========================================================= capability dialog */
  if (BRANCH) {
    console.log("\n=== the capability dialog ===");
    await open("build");
    await page.getByRole("button", { name: /What this build can and cannot do/ }).click();
    ok("the dialog opens", await waitText(page, "What this build can and cannot do right now", 20000));
    ok("the AI roles are listed as unavailable with what they need", await waitText(page, /ANTHROPIC_API_KEY/, 30000));
    ok("the reached tier and the unavailable tiers come from the analysis", await waitText(page, /Evidence reached · From history/, 60000) && await waitText(page, /From other projects/));
    ok("roles are reported as enforced from the API", await waitText(page, /Roles are enforced on this instance/, 30000));
    ok("the guest's seat is named", await waitText(page, /public read-only guest/));
    ok("calibration is stated as unavailable with what would calibrate it", await waitText(page, /A calibrated probability/) && await waitText(page, /not available/));
    await shot(page, "capabilities");
    await page.keyboard.press("Escape");

    // Deliberate failure inside the dialog: the AI status dies.
    currentStage = "deliberate-failure";
    await context.route("**/api/ai/status", (route) => route.abort());
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: /What this build can and cannot do/ }).click();
    ok("an unreachable source is drawn as 'could not determine', not as available", await waitText(page, /Could not determine the AI layer/, 30000));
    await context.unroute("**/api/ai/status");
    await page.keyboard.press("Escape");
  }

  /* ====================================================================== import */
  console.log("\n=== /workspace/import, as the guest ===");
  currentStage = "import";
  await page.goto(`${BASE}/workspace/import`, { waitUntil: "networkidle", timeout: 120000 });
  ok("the import route renders", await waitText(page, /Import from a Jira export/i, 40000));
  await loadBundledSample(page);
  ok("a bundled sample loads into the paste box", (await page.locator("textarea").first().inputValue()).length > 100);
  {
    const t4 = Date.now();
    await page.getByRole("button", { name: /Preview the import/ }).click();
    const previewed = await waitText(page, /step 2 of 2/i, 30000);
    const refused = !previewed && (await waitText(page, /not available to the public read-only guest/i, 5000));
    ok("the preview request goes out", requestsSince(t4, /POST .*\/import\/preview/).length === 1);
    ok("as the guest the preview is either served or refused by the backend with its own message - never an empty state", previewed || refused, previewed ? "served" : refused ? "refused: read_only_guest" : "neither");
    if (refused) {
      defect("import", "loaded the bundled sample as the guest and pressed Preview", "a preview - the panel says it reads the file and writes nothing", "403 read_only_guest from POST /api/import/preview: preview is a project-less POST and not on the read exemption list, so the guest cannot see the mapping step at all");
    }
  }
  await shot(page, "import-guest");

  if (IMPORT_SIGNED_IN) {
    console.log("\n=== /workspace/import, signed in (e2e credentials provider) ===");
    currentStage = "import-signed-in";
    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const p2 = await ctx2.newPage();
    p2.on("console", (m) => {
      if (m.type() === "error") (consoleErrors["import-signed-in"] ??= []).push(m.text());
    });
    await p2.goto(BASE, { waitUntil: "networkidle", timeout: 120000 });
    await signIn(p2, "Overnight Importer", BASE);
    await p2.goto(`${BASE}/workspace/import`, { waitUntil: "networkidle", timeout: 120000 });
    ok("the import route renders for a signed-in person", await waitText(p2, /Import from a Jira export/i, 40000));
    await loadBundledSample(p2);
    await p2.getByRole("button", { name: /Preview the import/ }).click();
    ok("the preview step arrives", await waitText(p2, /step 2 of 2/i, 40000));
    const pv = await body(p2);
    ok("the mapping is shown: what was read and what was not", /unmapped|not read|mapped/i.test(pv));
    ok("rows that cannot import are named, not dropped", /cannot|rejected|dropped/i.test(pv));
    const nameBox = p2.getByPlaceholder(/What to call the imported workflow/);
    if (await nameBox.count()) await nameBox.fill("Overnight import probe");
    const before = await ctx2.request.get(`${BASE}/api/projects`).then((r) => r.json());
    await p2.getByRole("button", { name: /Import as a new workflow/ }).click();
    ok("the commit reports what it created", await waitText(p2, /^Imported$|Imported/i, 40000));
    const after = await ctx2.request.get(`${BASE}/api/projects`).then((r) => r.json());
    const created = after.find((x) => !before.some((y) => y.id === x.id));
    ok("a real project now exists on the API", !!created, created ? `${created.name} (${created.id})` : "no new project");
    if (created) {
      const wf = await ctx2.request.get(`${BASE}/api/projects/${created.id}/workflow`).then((r) => r.json());
      ok("and it has the imported tasks", Array.isArray(wf.tasks) && wf.tasks.length > 0, `${wf.tasks?.length} tasks`);
    }
    await shot(p2, "import-signed-in");
    await ctx2.close();
  }

  /* ===================================================================== console */
  console.log("\n=== console errors by stage ===");
  for (const stage of [...STAGES, "import", ...(IMPORT_SIGNED_IN ? ["import-signed-in"] : [])]) {
    const real = realErrors(consoleErrors[stage]);
    ok(`${stage}: no unexpected console errors`, real.length === 0, real.slice(0, 2).join(" | "));
    if (real.length) defect(stage, "loaded the stage as the guest", "no console errors", real.slice(0, 3).join(" | "));
  }
} catch (e) {
  console.error("harness crashed:", e);
  problems.push(`harness crashed: ${e.message}`);
} finally {
  await browser.close();
}

console.log(`\n${problems.length === 0 ? "ALL PASSED" : `${problems.length} problem(s)`}`);
problems.forEach((p) => console.log(`  - ${p}`));
if (defects.length) {
  console.log("\nDEFECTS (stage · did · expected · happened):");
  defects.forEach((d) => console.log(`  - ${d.stage} · ${d.did} · ${d.expected} · ${d.happened}`));
}
process.exit(problems.length === 0 ? 0 : 1);
