/**
 * Auth.js v5, configured for this app.
 *
 * Three decisions worth knowing before reading the code:
 *
 * 1. **Sessions are JWTs, with no database adapter.** The backend already owns
 *    user rows; a second copy in a Next-side database would be a second source
 *    of truth about who someone is. It also means `proxy.ts` can decide whether
 *    a request is authenticated without a database round trip on every asset.
 *
 * 2. **The backend UUID is minted once, at sign-in.** `callbacks.signIn` calls
 *    `POST /api/users`, which upserts by email, and hangs the returned id on
 *    the user object; `callbacks.jwt` copies it into the token the first time
 *    the token is minted. Not on every request.
 *
 * 3. **If that upsert fails, the sign-in fails.** See `callbacks.signIn`.
 *
 * Environment: `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` are picked up by name
 * (Auth.js v5 infers `AUTH_<PROVIDER>_ID|SECRET`), `AUTH_SECRET` signs the
 * cookie, and `NEXTAUTH_URL` pins the origin used to build callback URLs.
 */
import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";

import { e2eCredentialsEnabled, upsertBackendUser } from "@/lib/session";

/**
 * A username-and-nothing-else provider, for the Playwright walkthroughs.
 *
 * ------------------------------------------------------------------------
 * THIS IS A LIABILITY IN PRODUCTION. It signs anyone in as any email, with
 * no password and no proof of anything. It exists because Google's consent
 * screen cannot be driven by a headless browser, and `npm run e2e:all` has
 * to keep working.
 * ------------------------------------------------------------------------
 *
 * It is only ever constructed when `e2eCredentialsEnabled()` is true - it is
 * absent from `providers`, not merely hidden - so a deployment cannot be
 * talked into using it by a crafted request. See `src/lib/session.ts` for the
 * two conditions.
 */
function walkthroughProvider() {
  return Credentials({
    id: "e2e",
    name: "Walkthrough sign-in (test only)",
    credentials: {
      email: { label: "Email", type: "email" },
      name: { label: "Name", type: "text" },
    },
    authorize(credentials) {
      const email =
        typeof credentials?.email === "string" ? credentials.email.trim() : "";
      const name =
        typeof credentials?.name === "string" ? credentials.name.trim() : "";
      if (!email || !email.includes("@")) return null;
      // No check of any kind. The backend upsert happens in `callbacks.signIn`,
      // the same one Google goes through, so the session shapes are identical.
      return { email, name: name || email.split("@")[0] };
    },
  });
}

const providers: NextAuthConfig["providers"] = [Google];
if (e2eCredentialsEnabled()) providers.push(walkthroughProvider());

export const config = {
  providers,
  session: { strategy: "jwt" },
  /**
   * Both sign-in and error land on our own page. Auth.js's built-in pages are
   * unstyled and say things like "Configuration" at the user; `/login` reads
   * the `?error=` param and says something a person can act on.
   */
  pages: { signIn: "/login", error: "/login" },
  /**
   * The origin is pinned by `NEXTAUTH_URL`/`AUTH_URL` (next-auth rewrites every
   * incoming request's origin to it before Auth.js sees it), so trusting the
   * host header adds no attack surface here - and leaving it to inference means
   * a deployment that sets only `NEXTAUTH_URL` fails at runtime with
   * `UntrustedHost`, which is a miserable way to find out.
   */
  trustHost: true,
  callbacks: {
    /**
     * Register the person with the backend, or refuse the sign-in.
     *
     * The failure mode being avoided: an id-less session. The user would see a
     * logged-in app, `proxy.ts` would have nothing to put in `X-User-Id`, and
     * every project they created would belong to nobody. Better to stop here,
     * where there is a page to put a message on.
     *
     * Throwing (or returning false) from this callback surfaces as
     * `?error=AccessDenied` - Auth.js only forwards a fixed set of error types
     * to the client, and a custom one degrades to "Configuration". `/login`
     * phrases that code for both of its real causes.
     *
     * Mutating `user` is load-bearing and safe: with no adapter configured,
     * Auth.js passes this exact object on to `callbacks.jwt`.
     */
    async signIn({ user }) {
      const email = user.email?.trim();
      if (!email) return false;
      user.backendUserId = await upsertBackendUser({
        email,
        name: user.name,
      });
      return true;
    },

    /**
     * Mint the token once, then leave it alone.
     *
     * `user` is only present on the request that creates the session, so the
     * common path is the last line. The recovery branch exists for a token
     * minted before this field did - or by some future path that skips
     * `signIn`. It costs a backend call per request while it fails, which is
     * the point: it is trying to stop failing. Auth.js re-encodes and re-sets
     * the cookie on every session read, so a successful recovery sticks.
     */
    async jwt({ token, user }) {
      if (user?.backendUserId) {
        token.backendUserId = user.backendUserId;
        return token;
      }
      if (!token.backendUserId && token.email) {
        try {
          token.backendUserId = await upsertBackendUser({
            email: token.email,
            name: token.name,
          });
        } catch {
          // Leave it unset. `proxy.ts` fails an id-less request closed with a
          // 401 rather than forwarding it anonymously.
        }
      }
      return token;
    },

    /** Expose the id to server components and to `proxy.ts` via `req.auth`. */
    session({ session, token }) {
      if (session.user) session.user.backendUserId = token.backendUserId;
      return session;
    },
  },
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(config);
