/**
 * The gate. Everything that is not a static asset comes through here.
 *
 * Three jobs:
 *
 *   1. Send a signed-out visitor to `/login`, remembering where they were -
 *      unless this is a public read-only demo, see below.
 *   2. Turn a session cookie into the two headers FastAPI trusts, and rewrite
 *      `/api/*` upstream carrying them.
 *   3. With `PUBLIC_DEMO_VIEWER=1`, forward a visitor who has no session as
 *      the **public read-only guest** instead of turning them away.
 *
 * PUBLIC READ-ONLY MODE. A Google OAuth app in Testing mode admits only the
 * addresses on its test-user list, so a hard sign-in wall on a public link
 * shows everyone else a Google error page. `PUBLIC_DEMO_VIEWER=1` makes a
 * sessionless visitor a real backend user - upserted through the same
 * `POST /api/users` a Google user goes through - whom `api/deps.py` holds to
 * a read-only bar. Reads, analysis, risk, optimisation and what-ifs all work;
 * every mutation comes back as the backend's own 403.
 *
 * Two properties of that worth keeping true. **The refusal is the backend's**,
 * not this file hiding buttons - a guest who calls the API directly is
 * refused by the same code that refuses a viewer, so the read-only claim is
 * enforced where it can be checked. And **a session always wins**: the guest
 * is only reached when there is no session at all, so signing in on a public
 * build behaves exactly as it does on a private one.
 *
 * Why here and not `rewrites()` in `next.config.ts`: `rewrites()` is static
 * configuration. It runs per request but has no access to the request's
 * cookies, so it cannot know who is asking. The identity injection has to
 * happen somewhere a session is available, and Next 16 gives two such places -
 * this file, or a catch-all Route Handler under `app/api`. This file wins
 * because it is the one that already has to run (page protection needs it
 * anyway), because `NextResponse.rewrite` hands the request to Next's own
 * streaming proxy - method, body, response status and headers pass through
 * untouched, for free - and because a Route Handler would leave `/api/*`
 * reachable by anything that slipped past a narrowed matcher. Here, there is
 * one door.
 *
 * FILE NAME AND LOCATION: Next 16 deprecated `middleware.ts` and renamed the
 * convention to `proxy.ts` with an exported `proxy` function
 * (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
 * `middleware.ts` still works but warns, and having *both* files is a hard
 * build error (E900) - so this is `proxy.ts`, and there is no `middleware.ts`.
 * It lives in `src/`, not the repo root, because Next only looks for it beside
 * `app` (build/index.js: `rootDir = path.join(appDir, "..")`). A `proxy.ts` at
 * the project root with a `src/app` layout is silently ignored: it builds
 * clean, the manifest comes out empty, and nothing is protected.
 *
 * RUNTIME: Proxy defaults to the Node.js runtime in 16, and the `runtime`
 * segment option is not merely unnecessary here, it throws. That is why there
 * is no split `auth.config.ts`: the Edge-safe-config dance that Auth.js v5
 * needs for Edge middleware does not apply.
 */
import type { NextAuthRequest } from "next-auth";
import { NextResponse } from "next/server";

import { auth } from "../auth";
import {
  apiErrorBody,
  backendOrigin,
  INJECTED_IDENTITY_HEADERS,
  publicViewerEnabled,
  publicViewerId,
  stripClientIdentity,
  withInjectedIdentity,
} from "@/lib/session";

/** Auth.js's own routes. Never proxied upstream, never require a session. */
const AUTH_PREFIX = "/api/auth";

/** The sign-in page, and the only page a signed-out visitor may see. */
const LOGIN_PATH = "/login";

/**
 * A 401 shaped like the backend's.
 *
 * `src/lib/api.ts` reads `detail`, `hint` and `request_id` off any non-OK
 * response and throws an `ApiError` from them. An HTML redirect here would
 * reach a `fetch()` as unparseable text and surface as "Unexpected token '<'".
 */
function unauthorized(detail: string, hint: string): NextResponse {
  return NextResponse.json(apiErrorBody("unauthorized", detail, hint), {
    status: 401,
    headers: { "Cache-Control": "no-store" },
  });
}

export const proxy = auth(async function proxy(request: NextAuthRequest) {
  const { pathname, search } = request.nextUrl;

  // Auth.js's own endpoints. Untouched, in both directions.
  if (pathname === AUTH_PREFIX || pathname.startsWith(`${AUTH_PREFIX}/`)) {
    return NextResponse.next();
  }

  const isApi = pathname === "/api" || pathname.startsWith("/api/");

  /*
   * Who this request is.
   *
   * A **session always wins**: the guest identity is only ever reached when
   * `request.auth` has nothing, so signing in on a public build behaves
   * exactly as it does on a private one. The guest is resolved lazily, so a
   * private deployment never touches this path and never upserts anything.
   */
  const sessionUserId = request.auth?.user?.backendUserId;
  const guestUserId = sessionUserId
    ? undefined
    : publicViewerEnabled()
      ? ((await publicViewerId()) ?? undefined)
      : undefined;
  const backendUserId = sessionUserId ?? guestUserId;

  if (isApi) {
    if (!backendUserId) {
      // Strip anyway: nothing about a refused request should teach a client
      // that its headers would have been forwarded.
      //
      // This is also where public-viewer mode fails **closed**. If the mode
      // is on but the guest upsert could not reach the backend, there is no
      // guest id, and the honest answer is the 401 a signed-out request has
      // always got - not a request forwarded with no identity, which would
      // look like it worked while quietly dropping who was asking.
      return unauthorized(
        "This request needs a signed-in session.",
        "Sign in again at /login, then retry. If you were signed in, the " +
          "session expired.",
      );
    }
    return NextResponse.rewrite(
      new URL(`${backendOrigin()}${pathname}${search}`),
      {
        // `NextResponse.rewrite` to an absolute external URL with modified
        // request headers is supported: Next serialises these into
        // `x-middleware-request-*` / `x-middleware-override-headers`, applies
        // them to the incoming request, and only then hands it to its proxy.
        // The override *replaces* the header set, so anything not listed here
        // is dropped - which is how the client's own `X-Proxy-Secret` dies.
        request: { headers: withInjectedIdentity(request.headers, backendUserId) },
      },
    );
  }

  if (!backendUserId) {
    if (pathname === LOGIN_PATH) return NextResponse.next();
    const login = new URL(LOGIN_PATH, request.nextUrl);
    // Where to come back to. Path-and-query only: an absolute URL here would
    // be an open redirect waiting to happen.
    login.searchParams.set("callbackUrl", `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  // Signed in and asking for a page. Nothing to inject, but the client's
  // identity headers get stripped from page requests too - a server component
  // reading `headers()` must not see an attacker-chosen `X-User-Id`. Only
  // rebuild the header set when there is actually something to remove:
  // `request: { headers }` re-sends every header as `x-middleware-request-*`,
  // and doing that on every page request risks a 431 on a large session.
  if (INJECTED_IDENTITY_HEADERS.some((name) => request.headers.has(name))) {
    const headers = new Headers(request.headers);
    stripClientIdentity(headers);
    return NextResponse.next({ request: { headers } });
  }
  return NextResponse.next();
});

export const config = {
  /**
   * Two entries, and the split matters.
   *
   * `/api/:path*` first, with no exclusions at all. The matcher every tutorial
   * copies starts `(?!api|...)`, which takes `/api/*` out of the proxy
   * entirely and leaves identity injection with nowhere to happen; and the
   * asset-extension exclusions in the second pattern would punch a
   * `/api/anything.png` hole straight through to the backend. Listing `/api`
   * on its own closes both.
   *
   * The second entry is everything else except what the browser fetches to
   * paint a page. `/login` is inside it on purpose - it is exempted in code,
   * above, so the redirect rule lives in one place.
   *
   * Next runs the proxy for `/_next/data/*` regardless of this pattern, on
   * purpose: it stops a protected page's data route from being left open by a
   * matcher that only covered the page.
   */
  matcher: [
    "/api/:path*",
    "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|avif|woff|woff2|ttf|otf|txt|xml|webmanifest)$).*)",
  ],
};
