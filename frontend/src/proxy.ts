/**
 * The gate. Everything that is not a static asset comes through here.
 *
 * Three jobs:
 *
 *   1. Send a signed-out visitor to `/login`, remembering where they were -
 *      unless this is a public read-only demo, see below.
 *   2. Turn a session cookie into the two headers FastAPI trusts, and rewrite
 *      `/api/*` upstream carrying them.
 *   3. With `PUBLIC_DEMO_VIEWER=1`, allow the frontend demo to load without
 *      requiring Google OAuth. Backend API requests remain protected.
 *
 * PUBLIC READ-ONLY MODE.
 *
 * The frontend demo is allowed to render publicly so the UI can be viewed
 * without waiting for Google OAuth/backend authentication. API requests are
 * still handled separately and continue to require an authenticated backend
 * identity.
 *
 * A session always wins: when a real session exists, its backend user id is
 * used exactly as before.
 *
 * Why here and not `rewrites()` in `next.config.ts`:
 * `rewrites()` is static configuration. It cannot inspect the session cookie
 * and therefore cannot perform the identity handling required by the backend.
 *
 * FILE NAME AND LOCATION:
 * Next 16 uses `proxy.ts` instead of the older `middleware.ts` convention.
 * This file lives beside `app` inside `src`.
 *
 * RUNTIME:
 * Proxy defaults to the Node.js runtime in Next 16.
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

/** The sign-in page. */
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
   * These remain protected.
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