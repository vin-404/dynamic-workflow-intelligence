/**
 * Shared helpers for the walkthroughs.
 *
 * The one thing every script needs: the app now requires a real Google
 * session, and Google's consent screen cannot be driven headless. So the
 * walkthroughs sign in through the Credentials provider that `auth.ts`
 * constructs **only** when `E2E_AUTH_ENABLED=1` and the build is not a
 * production one — see D-79. That means these scripts must run against
 * `next dev` with that variable set; against `next start` the provider does
 * not exist in the bundle at all and `signIn` below will fail loudly rather
 * than quietly proceeding as nobody.
 *
 * Set-up, from `frontend/`:
 *
 *     E2E_AUTH_ENABLED=1 npm run dev          # bash
 *     $env:E2E_AUTH_ENABLED=1; npm run dev    # PowerShell
 */

const DEFAULT_BASE = "http://localhost:3000";

/** The email a walkthrough name signs in as. Stable, so re-runs reuse the row. */
export function e2eEmail(name) {
  return `${name.toLowerCase().replace(/\s+/g, "-")}@walkthrough.test`;
}

/**
 * Sign in, and leave the browser on the app.
 *
 * Idempotent: the session cookie lives in this browser context's jar, so the
 * second and later calls see a session and only re-navigate. Every call site
 * does `page.goto(BASE)` first and then calls this — and a signed-out `goto`
 * now lands on `/login`, so this has to navigate back afterwards rather than
 * assume the caller is already looking at the app.
 *
 * Throws on failure. A walkthrough that silently continued unauthenticated
 * would fail later, somewhere unrelated, with a missing element.
 */
export async function signIn(page, name = "Walkthrough", base = DEFAULT_BASE) {
  const session = await page.request
    .get(`${base}/api/auth/session`)
    .then((r) => r.json())
    .catch(() => null);

  if (!session?.user?.email) {
    // `page.request` shares the BrowserContext cookie jar, so the session
    // cookie this sets is the one the page will send.
    const csrf = await page.request.get(`${base}/api/auth/csrf`);
    if (!csrf.ok()) {
      throw new Error(
        `Cannot reach ${base}/api/auth/csrf (${csrf.status()}). Is the app running?`,
      );
    }
    const { csrfToken } = await csrf.json();

    // Credentials sign-in is CSRF-validated by Auth.js; without the token
    // this redirects to /login?error=MissingCSRF.
    const posted = await page.request.post(`${base}/api/auth/callback/e2e`, {
      form: { csrfToken, email: e2eEmail(name), name, callbackUrl: "/" },
      maxRedirects: 0,
    });
    const location = posted.headers()["location"] ?? "";
    if (location.includes("error=")) {
      throw new Error(
        `Walkthrough sign-in was refused: ${location}. ` +
          `If this says MissingCSRF the token was not sent; if the provider ` +
          `404s, start the app with E2E_AUTH_ENABLED=1 under \`next dev\`.`,
      );
    }

    const confirmed = await page.request
      .get(`${base}/api/auth/session`)
      .then((r) => r.json())
      .catch(() => null);
    if (!confirmed?.user?.email) {
      throw new Error(
        "Walkthrough sign-in produced no session. Check AUTH_SECRET is set " +
          "and that the backend is up — the sign-in upserts the user and " +
          "fails closed if that call fails.",
      );
    }
  }

  // A signed-out `goto` left us on /login; land on the app either way.
  if (!page.url().startsWith(base) || page.url().includes("/login")) {
    await page.goto(base, { waitUntil: "networkidle" });
  }
  return name;
}

/** Navigate and sign in, which is what every script actually wants. */
export async function open(page, base = DEFAULT_BASE, name) {
  await page.goto(base, { waitUntil: "networkidle" });
  await signIn(page, name, base);
}
