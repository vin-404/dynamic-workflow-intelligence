/**
 * The sign-in page.
 *
 * Also the error page: `auth.ts` points `pages.error` here too, so every
 * Auth.js failure arrives as `?error=<code>` instead of on an unstyled
 * built-in page that says "Configuration" at the user.
 *
 * Styling is plain Tailwind against the tokens already in `globals.css`
 * (`bg-background`, `bg-panel`, `border-line`, `text-dim`, `text-accent`).
 * Deliberately no `@/components/ui/*` imports: this page has to compile on its
 * own while the design system lands alongside it.
 */
import { redirect } from "next/navigation";

import { auth, signIn } from "../../../auth";

export const metadata = {
  title: "Sign in — Workflow Intelligence",
};

/**
 * Auth.js only forwards a fixed set of error codes to the client; everything
 * else arrives as `Configuration`. Each line below says what the user can do,
 * not what went wrong internally.
 */
const ERROR_COPY: Record<string, string> = {
  AccessDenied:
    "Sign-in did not complete. If the account itself is fine, the service " +
    "that registers new users was unreachable — wait a moment and try again.",
  Configuration:
    "Sign-in is misconfigured on this server. Nothing you can do from here; " +
    "the details are in the server log.",
  Verification: "That sign-in link has expired or has already been used.",
  CredentialsSignin: "Those walkthrough credentials were rejected.",
  OAuthAccountNotLinked:
    "That email address is already here under a different sign-in method.",
  OAuthCallbackError: "Google did not complete the sign-in. Try again.",
  OAuthSignin: "Google could not be reached. Try again.",
  Callback: "The sign-in could not be completed. Try again.",
};

/** First value of a possibly-repeated query parameter. */
function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/**
 * Where to go after signing in.
 *
 * Same-origin paths only. `//evil.example` and `https://evil.example` are both
 * rejected — a `callbackUrl` comes off the query string, so treating it as a
 * destination without checking is an open redirect.
 */
function safeCallbackUrl(raw: string): string {
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return "/";
  }
  return raw;
}

export default async function LoginPage({
  searchParams,
}: {
  // Next 16: `searchParams` is a promise and must be awaited.
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const callbackUrl = safeCallbackUrl(one(params.callbackUrl));
  const errorCode = one(params.error);
  const error = errorCode
    ? (ERROR_COPY[errorCode] ?? "Sign-in failed. Try again.")
    : "";

  // Already signed in and arrived here by hand: there is nothing to do.
  const session = await auth();
  if (session?.user?.backendUserId) redirect(callbackUrl);

  async function continueWithGoogle(formData: FormData) {
    "use server";
    const target = safeCallbackUrl(String(formData.get("callbackUrl") ?? "/"));
    await signIn("google", { redirectTo: target });
  }

  return (
    <main className="flex min-h-full flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-lg border border-line bg-panel p-8">
        <h1 className="text-lg font-semibold text-foreground">
          Workflow Intelligence
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-dim">
          Signing in reads your name and email address from Google, and nothing
          else.
        </p>

        {error ? (
          <p
            role="alert"
            className="mt-6 rounded border border-line bg-background p-3 text-sm leading-relaxed text-red"
          >
            {error}
          </p>
        ) : null}

        <form action={continueWithGoogle} className="mt-6">
          <input type="hidden" name="callbackUrl" value={callbackUrl} />
          <button
            type="submit"
            className="flex w-full items-center justify-center gap-3 rounded border border-line bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-accent hover:text-accent"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 18 18"
              className="size-4 shrink-0"
            >
              <path
                fill="#4285F4"
                d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
              />
              <path
                fill="#34A853"
                d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
              />
              <path
                fill="#FBBC05"
                d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
              />
              <path
                fill="#EA4335"
                d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
              />
            </svg>
            Continue with Google
          </button>
        </form>
      </div>
    </main>
  );
}
