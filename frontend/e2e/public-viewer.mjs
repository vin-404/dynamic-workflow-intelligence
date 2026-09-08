/**
 * Public read-only viewer mode, in a browser, across the three states that
 * matter.
 *
 * The risk this feature exists for: a Google OAuth app in Testing mode admits
 * only the addresses on its test-user list, so a hard sign-in wall on a
 * public link shows every other visitor a Google error page. That is the
 * single worst thing that can happen when a stranger opens the demo URL, and
 * it is invisible to everyone whose address *is* on the list — which is
 * everyone who built it.
 *
 * The three states, and why each is here:
 *
 *   A. no session, flag OFF  -> redirected to /login. The default must not
 *                               have moved; this is what every other
 *                               walkthrough and every private deployment
 *                               relies on.
 *   B. no session, flag ON   -> the page is served, the guest identity is
 *                               forwarded upstream, reads work, and every
 *                               mutation comes back as the *backend's* 403.
 *                               Not a frontend hiding buttons.
 *   C. session, flag ON      -> the real identity wins outright. Turning a
 *                               public demo on must not demote the people
 *                               who can sign in.
 *
 * Needs two servers, because the flag is read at runtime per server:
 *
 *   node e2e/public-viewer.mjs <private-base> <public-base> [shots-dir]
 *
 * e.g. `node e2e/public-viewer.mjs http://localhost:3000 http://localhost:3100`
 * where :3000 is `npm run dev` and :3100 is
 * `PUBLIC_DEMO_VIEWER=1 E2E_AUTH_ENABLED=1 next dev -p 3100`.
 *
 * The backend must be in **enforcing** mode (`PROXY_SHARED_SECRET` set) or
 * every 403 below becomes a 201 and the suite is vacuous — so that is
 * asserted first, rather than discovered as a confusing failure later.
 */
import { chromium } from "playwright";
import { signIn } from "./lib.mjs";

const PRIVATE_BASE = process.argv[2] ?? "http://localhost:3000";
const PUBLIC_BASE = process.argv[3] ?? "http://localhost:3100";
const OUT = process.argv[4] ?? ".";

const SEEDED_PROJECT = "00000000-0000-0000-0000-000000000001";

const problems = [];
let step = 0;

function ok(label, condition, detail = "") {
  console.log(
    `  [${condition ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`,
  );
  if (!condition) problems.push(label);
  return condition;
}

async function shot(page, name) {
  step += 1;
  const file = `${OUT}/${String(step).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

const browser = await chromium.launch();

// ---------------------------------------------------------------------------
// The suite is only meaningful against an enforcing backend.
// ---------------------------------------------------------------------------
console.log("\n=== Preconditions ===");
{
  const ctx = await browser.newContext();
  const probe = await ctx.request.get(`${PUBLIC_BASE}/api/projects`);
  ok(
    "the public build serves the API without a session",
    probe.status() === 200,
    `got ${probe.status()} — is PUBLIC_DEMO_VIEWER=1 set on ${PUBLIC_BASE}?`,
  );

  // A guest write must be refused. If it is not, the backend has no
  // PROXY_SHARED_SECRET and nothing below proves anything.
  const write = await ctx.request.post(
    `${PUBLIC_BASE}/api/projects/${SEEDED_PROJECT}/tasks`,
    { data: { key: "PV0", name: "precondition", effort: 1 } },
  );
  ok(
    "and refuses a write, so the backend is enforcing roles",
    write.status() === 403,
    `got ${write.status()} — set PROXY_SHARED_SECRET on the backend`,
  );

  /*
   * The guest identity must actually be reaching the backend.
   *
   * If the database was reset *after* the public server started, that server
   * still holds the id of a row that no longer exists, and the backend serves
   * the request as `anonymous`: reads keep working, so nothing looks wrong,
   * and every assertion below about roles fails for a reason that has nothing
   * to do with the code under test. `session.ts` re-upserts on a five-minute
   * TTL, so this heals itself - but the fast fix is to restart the server, and
   * saying so here is worth more than four confusing failures later.
   */
  const refusal = await write.json().catch(() => ({}));
  const role = refusal?.detail?.your_role;
  ok(
    "and the guest identity is reaching the backend",
    role === "viewer",
    role === "anonymous"
      ? `the public server's cached guest id is stale (the database was reset ` +
        `after it started). Restart ${PUBLIC_BASE}, or wait out the 5-minute TTL.`
      : `your_role=${role}, expected viewer`,
  );
  await ctx.close();
}

// ---------------------------------------------------------------------------
// A. No session, flag off. The default, unchanged.
// ---------------------------------------------------------------------------
console.log("\n=== A · no session, PUBLIC_DEMO_VIEWER off ===");
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const res = await page.goto(PRIVATE_BASE, { waitUntil: "networkidle" });
  ok(
    "a signed-out visit is still redirected to /login",
    new URL(page.url()).pathname === "/login",
    page.url(),
  );
  ok(
    "and it remembers where they were going",
    new URL(page.url()).searchParams.get("callbackUrl") === "/",
  );
  ok("the redirect is not an error page", (res?.status() ?? 0) < 400);

  const api = await ctx.request.get(`${PRIVATE_BASE}/api/projects`);
  const body = await api.json().catch(() => ({}));
  ok("and the API is still closed", api.status() === 401, `got ${api.status()}`);
  ok("with the standard envelope", "detail" in body && "hint" in body);
  ok(
    "no guest identity leaked into the private build",
    !(await page.getByText(/read-only guest/i).first().isVisible().catch(() => false)),
  );
  await ctx.close();
}

// ---------------------------------------------------------------------------
// B. No session, flag on. A guest gets the product, read-only.
// ---------------------------------------------------------------------------
console.log("\n=== B · no session, PUBLIC_DEMO_VIEWER=1 ===");
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await page.goto(PUBLIC_BASE, { waitUntil: "networkidle" });
  ok(
    "a signed-out visit is NOT redirected",
    new URL(page.url()).pathname === "/",
    page.url(),
  );
  ok(
    "the workflow list renders",
    await page.getByText(/Open a workflow/i).first().isVisible(),
  );
  ok(
    "the seeded workflows are there",
    await page.getByText("Campus Tech Symposium").first().isVisible(),
  );

  // Requirement 5: one honest line, in the identity area.
  ok(
    "it says it is a read-only guest",
    await page.getByText(/viewing as a read-only guest/i).first().isVisible(),
  );
  ok(
    "and offers a way to sign in",
    await page.getByRole("link", { name: /^Sign in$/i }).first().isVisible(),
  );
  ok(
    "and does not claim to be signed in as somebody",
    !(await page.getByText(/sign out/i).first().isVisible().catch(() => false)),
  );
  console.log("  shot:", await shot(page, "guest-list"));

  // Requirement 6: /login stays reachable from the public build.
  const loginRes = await page.goto(`${PUBLIC_BASE}/login`, {
    waitUntil: "networkidle",
  });
  ok("/login is still reachable", (loginRes?.status() ?? 0) === 200);
  ok(
    "and still offers Google",
    await page.getByRole("button", { name: /Continue with Google/i }).first().isVisible(),
  );

  // The analysis itself works — a read-only seat that cannot analyse is a
  // screenshot, and this is the reason the mode exists at all.
  await page.goto(PUBLIC_BASE, { waitUntil: "networkidle" });
  await page.getByText("Campus Tech Symposium").first().click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /Bottlenecks/ }).click();
  await page.waitForTimeout(3500);
  ok(
    "a guest can run the analysis",
    await page.getByText(/Projected finish/i).first().isVisible(),
  );
  ok(
    "and sees the findings",
    (await page.getByText(/findings/i).count()) > 0,
  );

  // Requirement 8: the honesty layer is untouched for a guest.
  ok(
    "the evidence tier and its limits are shown",
    await page.getByText(/Evidence tier/i).first().isVisible(),
  );
  ok(
    "including what the analysis cannot assess",
    await page.getByText(/cannot assess yet/i).first().isVisible(),
  );
  // Phase 11 renamed this stage; it carries both the structural score and
  // the Monte Carlo forecast, so it is "Risk & forecast" now.
  await page.getByRole("button", { name: /Risk & forecast/ }).click();
  await page.waitForTimeout(3000);
  ok(
    "the risk disclaimer is not softened for a guest",
    await page.getByText(/not a probability/i).first().isVisible(),
  );
  ok(
    "and the structural-estimate wording is intact",
    await page.getByText(/structural estimate/i).first().isVisible(),
  );
  console.log("  shot:", await shot(page, "guest-risk"));

  // Requirement 2: the refusal is the backend's, not a hidden button.
  console.log("  -- mutations, refused upstream --");
  // The required role differs by route, and asserting one value for all four
  // would have hidden that: changing the member list is owner-only (D-84),
  // everything else needs editor. A test that expected "editor" everywhere
  // passed three times and failed on the one route whose answer it had wrong.
  const attempts = [
    ["a task write", "POST", `/api/projects/${SEEDED_PROJECT}/tasks`, "editor",
      { key: "PV1", name: "should never exist", effort: 1 }],
    ["a task delete", "DELETE", `/api/projects/${SEEDED_PROJECT}/tasks/T01`, "editor", null],
    ["sealing a version", "POST", `/api/projects/${SEEDED_PROJECT}/versions/seal`, "editor", null],
    ["adding a member", "POST", `/api/projects/${SEEDED_PROJECT}/members`, "owner",
      { email: "x@example.com", name: "x", role: "editor" }],
  ];
  for (const [label, method, path, required, data] of attempts) {
    const res = await ctx.request.fetch(`${PUBLIC_BASE}${path}`, {
      method,
      ...(data ? { data } : {}),
    });
    const body = await res.json().catch(() => ({}));
    ok(
      `${label} is refused with the backend's own 403`,
      res.status() === 403 && body?.detail?.reason === "insufficient_role",
      `${res.status()} ${JSON.stringify(body?.detail?.reason ?? body).slice(0, 80)}`,
    );
    ok(
      `  ...and names the role it holds and the one it needed`,
      body?.detail?.your_role === "viewer" &&
        body?.detail?.required_role === required,
      `your_role=${body?.detail?.your_role} required=${body?.detail?.required_role} (expected ${required})`,
    );
  }

  // The routes a role cannot gate. Without naming the guest in deps.py these
  // would succeed, because they ask only for *an* identity.
  for (const [label, path, data] of [
    ["creating a project", "/api/projects",
      { name: "Guest project", start_date: "2026-06-06", today_day: 0 }],
    ["creating a domain", "/api/domains",
      { key: "guest-e2e", name: "No", description: "No" }],
  ]) {
    const res = await ctx.request.post(`${PUBLIC_BASE}${path}`, { data });
    const body = await res.json().catch(() => ({}));
    ok(
      `${label} is refused as a read-only guest`,
      res.status() === 403 && body?.detail?.reason === "read_only_guest",
      `${res.status()} ${body?.detail?.reason ?? ""}`,
    );
  }

  const real = consoleErrors.filter(
    (e) => !/favicon|React DevTools|403 \(Forbidden|Failed to load resource/i.test(e),
  );
  ok("no unexpected console errors", real.length === 0, real.slice(0, 2).join(" | "));
  await ctx.close();
}

// ---------------------------------------------------------------------------
// C. A session, flag on. The real identity wins.
// ---------------------------------------------------------------------------
console.log("\n=== C · session present, PUBLIC_DEMO_VIEWER=1 ===");
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(PUBLIC_BASE, { waitUntil: "networkidle" });
  await signIn(page, "Public Build Signer", PUBLIC_BASE);
  // A reload is needed here and it is the *test* that needs it, not the app.
  // `signIn` sets the session cookie through `page.request` and only
  // re-navigates when the browser is sitting on /login - which is what
  // happens on a private build. On a public build the page loaded fine as a
  // guest, so nothing re-navigated and the client still holds the React
  // state it mounted with. A real visitor never sees this: the Google flow
  // ends in a redirect, which is a page load.
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  ok(
    "the guest line is gone once signed in",
    !(await page.getByText(/viewing as a read-only guest/i).first().isVisible().catch(() => false)),
  );
  ok(
    "the real name is shown instead",
    await page.getByText(/Public Build Signer/).first().isVisible(),
  );
  ok(
    "with a way to sign out",
    await page.getByRole("button", { name: /sign out/i }).first().isVisible(),
  );
  console.log("  shot:", await shot(page, "signed-in-on-public-build"));

  // The decisive one: a signed-in person on a public build is NOT read-only.
  const created = await ctx.request.post(`${PUBLIC_BASE}/api/projects`, {
    data: { name: "Signed in on a public build", start_date: "2026-07-07", today_day: 0 },
  });
  ok(
    "a signed-in visitor may still create a project",
    created.status() === 201,
    `got ${created.status()}`,
  );

  if (created.status() === 201) {
    const id = (await created.json()).id;
    const write = await ctx.request.post(`${PUBLIC_BASE}/api/projects/${id}/tasks`, {
      data: { key: "OWN1", name: "allowed", effort: 2 },
    });
    ok(
      "and may write to what they own",
      write.status() === 201,
      `got ${write.status()}`,
    );
    const members = await (
      await ctx.request.get(`${PUBLIC_BASE}/api/projects/${id}/members`)
    ).json();
    ok(
      "and the member row names them, not the guest",
      members.some((m) => m.name === "Public Build Signer") &&
        !members.some((m) => /guest/i.test(m.email)),
      JSON.stringify(members.map((m) => m.name)),
    );
  }
  await ctx.close();
}

await browser.close();

console.log(
  `\n${problems.length === 0 ? "ALL CHECKS PASSED" : `FAILURES (${problems.length}):`}`,
);
problems.forEach((p) => console.log(`  - ${p}`));
process.exit(problems.length === 0 ? 0 : 1);
