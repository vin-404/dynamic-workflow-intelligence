/**
 * Identity plumbing, shared by `auth.ts` and `proxy.ts`.
 *
 * The browser never talks to FastAPI. It talks to Next, Next verifies the
 * session cookie, and only then does Next add the two headers the backend
 * trusts:
 *
 *   X-User-Id      the backend's own UUID for this person
 *   X-Proxy-Secret proof that the header came from us and not from a browser
 *
 * Nothing here imports `auth.ts`. `auth.ts` imports this, and a cycle between
 * the two would break the Auth.js singleton. A server component that wants the
 * current person should `import { auth } from "../../auth"` and read
 * `session.user.backendUserId`.
 */

/** The header carrying who is asking. Lowercase: `Headers` is case-insensitive. */
export const IDENTITY_HEADER = "x-user-id";

/** The header proving the identity header was set by this server. */
export const PROXY_SECRET_HEADER = "x-proxy-secret";

/**
 * Headers this server owns end to end.
 *
 * Every one of these is deleted from an incoming client request before we set
 * our own, unconditionally and whether or not we then set anything. A browser
 * that sends its own `X-Proxy-Secret` must not be able to get it forwarded -
 * that is the entire security property of this design.
 */
export const INJECTED_IDENTITY_HEADERS: readonly string[] = [
  IDENTITY_HEADER,
  PROXY_SECRET_HEADER,
];

/**
 * Where FastAPI actually lives.
 *
 * Called from `auth.ts` (to upsert the user) and from `proxy.ts` (to rewrite
 * `/api/*` upstream). Read lazily rather than at module scope: `proxy.ts` runs
 * in the Node.js runtime under Next 16, so this is the real environment of the
 * running container, not a value frozen at build time. (`NEXT_PUBLIC_API_URL`
 * is the exception - anything so prefixed is inlined at build.)
 */
export function backendOrigin(): string {
  const url =
    process.env.API_REWRITE_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    "http://localhost:8001";
  return url.replace(/\/+$/, "");
}

/**
 * The shared secret, or "" when this deployment has not configured one.
 *
 * Unset is a supported mode, not a misconfiguration: the backend keeps its
 * pre-auth open behaviour when its own setting is unset, and local development
 * runs that way. When it is unset we send neither header - but we still strip
 * the client's.
 */
export function proxySharedSecret(): string {
  return process.env.PROXY_SHARED_SECRET?.trim() ?? "";
}

/** Delete every header this server owns from a request's headers, in place. */
export function stripClientIdentity(headers: Headers): void {
  for (const name of INJECTED_IDENTITY_HEADERS) headers.delete(name);
}

/**
 * Strip the client's identity headers, then set ours.
 *
 * Returns the headers to send upstream. Strip happens first and always, so
 * there is no ordering in which a client-supplied value survives.
 *
 * The identity is sent **unconditionally**; only the secret is conditional.
 * The two are not symmetrical, and sending neither when no secret is
 * configured was a real bug: the backend keeps trusting a bare `X-User-Id`
 * when its own `PROXY_SHARED_SECRET` is unset, so withholding the identity in
 * that mode does not make anything safer - it just means `created_by` comes
 * back null and no member row is written, silently, in exactly the
 * configuration a developer runs locally. The session has already been
 * verified by the time we get here either way; the secret's job is only to
 * prove to the backend that the header came from us, and where the backend is
 * not asking for that proof there is nothing to withhold.
 */
export function withInjectedIdentity(
  incoming: Headers,
  backendUserId: string,
): Headers {
  const headers = new Headers(incoming);
  stripClientIdentity(headers);
  headers.set(IDENTITY_HEADER, backendUserId);
  const secret = proxySharedSecret();
  if (secret) headers.set(PROXY_SECRET_HEADER, secret);
  return headers;
}

/**
 * Is the walkthrough-only Credentials provider switched on?
 *
 * Two conditions, both required. `E2E_AUTH_ENABLED=1` is an explicit act; the
 * production check means that even an accidental `E2E_AUTH_ENABLED=1` in a
 * production environment does not create a password-free sign-in. When this
 * returns false the provider is not in the `providers` array at all - it is
 * absent, not hidden, so `/api/auth/callback/e2e` 404s rather than 401s.
 */
export function e2eCredentialsEnabled(): boolean {
  return (
    process.env.E2E_AUTH_ENABLED === "1" &&
    process.env.NODE_ENV !== "production"
  );
}

/**
 * The backend's error envelope, produced by us.
 *
 * `frontend/src/lib/api.ts` reads `detail`, `hint` and `request_id` off any
 * non-OK response. A 401 from the proxy has to look like a 401 from FastAPI or
 * the client renders "401 Unauthorized" and nothing a person can act on.
 */
export function apiErrorBody(
  error: string,
  detail: string,
  hint: string,
): { error: string; detail: string; hint: string; request_id: null } {
  return { error, detail, hint, request_id: null };
}

/** How long we will wait on the backend before calling the sign-in failed. */
const UPSERT_TIMEOUT_MS = 6000;

/**
 * Upsert this person into the backend and return their stable UUID.
 *
 * `POST /api/users` upserts by email and is deliberately callable without an
 * identity, which is what makes it usable to bootstrap one. We call the
 * backend at its own origin rather than through our own `/api` path: going
 * through our own proxy would mean this request needs a session, which is
 * exactly what we are in the middle of creating.
 *
 * Throws on any failure. The caller (`callbacks.signIn`) lets that fail the
 * sign-in, because a session with no `backendUserId` is worse than no session:
 * the user appears logged in while every request they make is anonymous.
 */
export async function upsertBackendUser(input: {
  email: string;
  name?: string | null;
}): Promise<string> {
  const email = input.email.trim();
  if (!email) throw new Error("Cannot upsert a user without an email address");
  const name = (input.name ?? "").trim() || email.split("@")[0] || email;
  const secret = proxySharedSecret();

  const response = await fetch(`${backendOrigin()}/api/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { [PROXY_SECRET_HEADER]: secret } : {}),
    },
    body: JSON.stringify({ name, email }),
    cache: "no-store",
    signal: AbortSignal.timeout(UPSERT_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Backend refused to register ${email}: ${response.status} ${response.statusText}`,
    );
  }

  const body: unknown = await response.json();
  const id = (body as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !id) {
    throw new Error(`Backend returned no user id for ${email}`);
  }
  return id;
}
