import { redirect } from "next/navigation";
import { auth, signIn } from "../../../auth";
import ThemeToggle from "@/components/ThemeToggle";

export const metadata = {
  title: "Sign in — FlowTrace",
};

const ERROR_COPY: Record<string, string> = {
  AccessDenied: "We couldn't finish setting up your account. Please try again in a moment.",
  Configuration: "The sign-in service needs configuration. Check the server settings and try again.",
  Verification: "That sign-in link has expired or has already been used.",
  CredentialsSignin: "Those walkthrough credentials were rejected.",
  OAuthAccountNotLinked: "That email is already connected using a different sign-in method.",
  OAuthCallbackError: "Google did not complete the sign-in. Please try again.",
  OAuthSignin: "Google could not be reached. Please try again.",
  Callback: "The sign-in could not be completed. Please try again.",
};

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function safeCallbackUrl(raw: string): string {
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const callbackUrl = safeCallbackUrl(one(params.callbackUrl));
  const errorCode = one(params.error);
  const error = errorCode ? (ERROR_COPY[errorCode] ?? "Sign-in failed. Please try again.") : "";

  const session = await auth();
  if (session?.user?.backendUserId) redirect(callbackUrl);

  async function continueWithGoogle(formData: FormData) {
    "use server";
    const target = safeCallbackUrl(String(formData.get("callbackUrl") ?? "/"));
    await signIn("google", { redirectTo: target });
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#F7F7FC] text-[#17172A] dark:bg-[#0B0E1B] dark:text-white">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-40 -top-40 h-[520px] w-[520px] rounded-full bg-[#4164FA]/10 blur-[120px] dark:bg-[#4164FA]/15" />
        <div className="absolute -right-48 top-20 h-[620px] w-[620px] rounded-full bg-[#795CF7]/10 blur-[140px] dark:bg-[#795CF7]/15" />
        <div className="absolute inset-0 opacity-30 [background-image:linear-gradient(rgba(65,100,250,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(65,100,250,0.045)_1px,transparent_1px)] [background-size:44px_44px] dark:opacity-20" />
      </div>

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-5 py-8 sm:px-8">
        <div className="absolute left-5 top-6 sm:left-8 sm:top-8">
          <a href="/" className="group flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#090B18] shadow-lg shadow-[#4164FA]/10">
              <img src="/logo.jpeg" alt="FlowTrace" className="h-full w-full rounded-xl object-cover" />
            </div>
            <div>
              <div className="text-[17px] font-semibold tracking-[-0.03em]">Flow<span className="text-[#4164FA]">Trace</span></div>
              <div className="text-[8px] uppercase tracking-[0.18em] text-[#68677A] dark:text-white/40">FlowTrace</div>
            </div>
          </a>
        </div>

        <div className="absolute right-5 top-6 sm:right-8 sm:top-8">
          <ThemeToggle />
        </div>

        <section className="grid w-full max-w-5xl overflow-hidden rounded-[28px] border border-[#E2E1EC] bg-white/85 shadow-[0_30px_100px_rgba(31,35,70,0.12)] backdrop-blur-xl dark:border-white/10 dark:bg-[#111522]/90 dark:shadow-black/30 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="hidden border-r border-[#E2E1EC] p-10 dark:border-white/10 lg:flex lg:flex-col lg:justify-between xl:p-14">
            <div>
              <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-[#4164FA]/15 bg-[#EAF0FF] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#4164FA] dark:border-[#4164FA]/20 dark:bg-[#4164FA]/10">
                <span className="h-1.5 w-1.5 rounded-full bg-[#4164FA]" />
                Secure workspace access
              </div>
              <h1 className="max-w-md text-4xl font-semibold leading-[1.02] tracking-[-0.045em] xl:text-5xl">
                See the flow.<br />Understand what's next.
              </h1>
              <p className="mt-6 max-w-md text-sm leading-7 text-[#68677A] dark:text-white/55">
                Sign in to explore dependencies, bottlenecks, forecasts, requirements, and what-if scenarios in your workflow.
              </p>
            </div>

            <div className="mt-12 grid grid-cols-3 gap-4">
              {[["01", "Dependencies"], ["02", "Risk"], ["03", "What if"]].map(([n, label]) => (
                <div key={n} className="border-t border-[#E2E1EC] pt-3 dark:border-white/10">
                  <div className="text-[10px] font-semibold tracking-[0.16em] text-[#4164FA]">{n}</div>
                  <div className="mt-1 text-xs font-medium text-[#68677A] dark:text-white/60">{label}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="p-7 sm:p-10 lg:p-12 xl:p-14">
            <div className="max-w-md">
              <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#795CF7]">Welcome to FlowTrace</div>
              <h2 className="mt-3 text-3xl font-semibold tracking-[-0.04em]">Sign in to your workspace</h2>
              <p className="mt-3 text-sm leading-6 text-[#68677A] dark:text-white/55">
                Continue securely with Google. We'll use your name and email to create or open your FlowTrace account.
              </p>

              {error ? (
                <div role="alert" className="mt-6 rounded-2xl border border-[#E2E1EC] bg-[#F7F7FC] p-4 text-sm leading-6 text-[#17172A] dark:border-white/10 dark:bg-white/5 dark:text-white">
                  <div className="font-semibold">Sign-in didn't complete</div>
                  <div className="mt-1 text-[#68677A] dark:text-white/55">{error}</div>
                </div>
              ) : null}

              <form action={continueWithGoogle} className="mt-8">
                <input type="hidden" name="callbackUrl" value={callbackUrl} />
                <button
                  type="submit"
                  className="flex w-full items-center justify-center gap-3 rounded-2xl bg-gradient-to-r from-[#4164FA] to-[#795CF7] px-5 py-3.5 text-sm font-semibold text-white shadow-lg shadow-[#4164FA]/20 transition-all hover:-translate-y-0.5 hover:shadow-xl hover:shadow-[#4164FA]/25"
                >
                  <svg aria-hidden="true" viewBox="0 0 18 18" className="size-4 shrink-0">
                    <path fill="#fff" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
                    <path fill="#fff" d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
                    <path fill="#fff" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
                    <path fill="#fff" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
                  </svg>
                  Continue with Google
                </button>
              </form>

              <div className="mt-8 flex items-start gap-3 rounded-2xl bg-[#F7F7FC] p-4 dark:bg-white/5">
                <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#EAF0FF] text-[11px] font-bold text-[#4164FA] dark:bg-[#4164FA]/10">i</div>
                <p className="text-xs leading-5 text-[#68677A] dark:text-white/50">
                  FlowTrace only receives the basic Google profile information needed to identify your workspace account.
                </p>
              </div>

              <a href="/" className="mt-7 inline-flex text-xs font-medium text-[#68677A] transition-colors hover:text-[#4164FA] dark:text-white/50">
                ← Back to FlowTrace
              </a>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
