/**
 * The gate. Everything that is not a static asset comes through here.
 *
 * Three jobs:
 *
 *   1. Send a signed-out visitor to `/login`, remembering where they were -
 *      unless this is a public read-only demo, see below.
 *   2. Turn a session cookie into the two headers FastAPI trusts, and rewrite
 *      `/api/*` upstream carrying them.
 *   3. With `PUBLIC_DEMO_VIEWER=1`, serve pages to a visitor with no session,
 *      and forward their API calls as the **public read-only guest**.
 *
 * PUBLIC READ-ONLY MODE. A Google OAuth app in Testing mode admits only the
 * addresses on its test-user list, so a hard sign-in wall on a public link
 * shows everyone else a Google error page. `PUBLIC_DEMO_VIEWER=1` makes a
 * sessionless visitor a real backend user - upserted through the same
 * `POST /api/users` a Google user goes through - whom `api/deps.py` holds to
 * a read-only bar. Reads, analysis, risk, optimisation and what-ifs all work;
 * every mutation comes back as the backend's own 403.
 *
 * Note what that does and does not mean for `/api/*`. Those requests are
 * still gated - but the guest identity is precisely how a signed-out visitor
 * passes that gate, so it is wrong to say they "require an authenticated
 * identity" in the sign-in sense. What is true is that a request with no
 * identity at all, guest included, is refused: if the guest upsert cannot
 * reach the backend there is no id to inject, and the API branch below fails
 * closed with a 401 rather than forwarding an anonymous request.
 *
 * Pages are the looser half, deliberately. Under `PUBLIC_DEMO_VIEWER` a page
 * request is served even when no guest id resolved, so the shell renders and
 * the failure surfaces where it can be explained - in the panel that could
 * not load - instead of as a bounce to `/login` that tells the visitor
 * nothing.
 *
 * Two properties worth keeping true. **The refusal is the backend's**, not
 * this file hiding buttons - a guest who calls the API directly is refused by
 * the same code that refuses a viewer, so the read-only claim is enforced
 * where it can be checked. And **a session always wins**: the guest is only
 * reached when there is no session at all, so signing in on a public build
 * behaves exactly as it does on a private one.
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

/** The sign-in page, and the only page a signed-out visitor may see
 * when public read-only mode is off. */
const LOGIN_PATH = "/login";

/**
 * A 401 shaped like the backend's.
 *
 * `src/lib/api.ts` reads `detail`, `hint` and `request_id` off any non-OK
 * response and throws an `ApiError` from them.
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
   * A real session always wins.
   *
   * When there is no session and public demo mode is enabled, we still try
   * to resolve the public viewer identity for API requests.
   */
  const sessionUserId = request.auth?.user?.backendUserId;

  const guestUserId = sessionUserId
    ? undefined
    : publicViewerEnabled()
      ? ((await publicViewerId()) ?? undefined)
      : undefined;

  const backendUserId = sessionUserId ?? guestUserId;

  /*
   * API REQUESTS
   *
   * These remain protected. "Protected" means an identity is required, not
   * that a sign-in is - the public guest is an identity.
   *
   * If a real session exists, use its backend identity.
   *
   * If public demo mode is enabled, publicViewerId() can provide the
   * read-only guest identity.
   *
   * If neither exists, fail closed with a backend-shaped 401.
   */
  if (isApi) {
    if (!backendUserId) {
      return unauthorized(
        "This request needs a signed-in session.",
        "Sign in again at /login, then retry. If you were signed in, the " +
          "session expired.",
      );
    }

    return NextResponse.rewrite(
      new URL(`${backendOrigin()}${pathname}${search}`),
      {
        /*
         * Inject the trusted backend identity.
         *
         * The client's own identity headers are replaced so a browser cannot
         * choose which backend user it wants to act as.
         */
        request: {
          headers: withInjectedIdentity(
            request.headers,
            backendUserId,
          ),
        },
      },
    );
  }

  /*
   * PAGE REQUESTS
   *
   * THIS IS THE FRONTEND-DEMO CHANGE.
   *
   * When public demo mode is enabled, allow the frontend pages to render
   * without requiring Google OAuth.
   *
   * This means:
   *
   *   http://localhost:3000/
   *
   * can show the FlowTrace landing page directly.
   *
   * `/login` also remains public.
   *
   * Authentication for `/api/*` above is unchanged.
   */
  if (!backendUserId) {
    if (publicViewerEnabled()) {
      return NextResponse.next();
    }

    if (pathname === LOGIN_PATH) {
      return NextResponse.next();
    }

    const login = new URL(LOGIN_PATH, request.nextUrl);

    /*
     * Where to come back to.
     *
     * Path-and-query only: an absolute URL here would be an open redirect.
     */
    login.searchParams.set("callbackUrl", `${pathname}${search}`);

    return NextResponse.redirect(login);
  }

  /*
   * Signed in and asking for a page.
   *
   * Nothing needs to be injected into page requests, but remove any
   * client-supplied identity headers so a server component reading
   * `headers()` cannot see an attacker-chosen identity.
   */
  if (
    INJECTED_IDENTITY_HEADERS.some((name) =>
      request.headers.has(name),
    )
  ) {
    const headers = new Headers(request.headers);

    stripClientIdentity(headers);

    return NextResponse.next({
      request: {
        headers,
      },
    });
  }

  return NextResponse.next();
});

export const config = {
  /**
   * Two entries, and the split matters.
   *
   * `/api/:path*` first, with no exclusions at all. This ensures API
   * requests always pass through the identity gate.
   *
   * The second entry is everything else except static assets.
   *
   * `/login` is intentionally included because it is exempted in code above.
   *
   * Next also handles `/_next/data/*` through the proxy so protected page
   * data routes are not accidentally left open.
   */
  matcher: [
    "/api/:path*",
    "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|avif|woff|woff2|ttf|otf|txt|xml|webmanifest)$).*)",
  ],
};