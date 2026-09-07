/**
 * Shared helpers for the walkthroughs.
 *
 * The one thing every script needs: the app asks who you are before it shows
 * you anything (Phase 9.5). It is not a login - there is no password and
 * nothing is checked - but a script that navigates straight to the project
 * list will sit waiting for a list that is not on screen yet.
 */

/**
 * Get past the name picker, if it is showing.
 *
 * Idempotent: the identity lives in this browser context's localStorage, so
 * the second and later navigations skip it. Returns the name in use.
 */
export async function signIn(page, name = "Walkthrough") {
  const picker = page.getByLabel(/Your name/i);
  if (await picker.isVisible().catch(() => false)) {
    await picker.fill(name);
    await page.getByRole("button", { name: /^Continue$/ }).click();
    // The list only renders once the identity is set, so wait for it rather
    // than for a fixed delay.
    await page
      .getByText(/Open a workflow/i)
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => {});
  }
  return name;
}

/** Navigate and sign in, which is what every script actually wants. */
export async function open(page, base, name) {
  await page.goto(base, { waitUntil: "networkidle" });
  await signIn(page, name);
}
