import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { connection } from "next/server";
import { GuestIdentityProvider } from "@/components/Identity";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { publicViewerPerson } from "@/lib/session";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "FlowTrace",
  description: "FlowTrace — understand how work changes",
};

/*
 * Async, so the public read-only guest can be resolved per request.
 *
 * `PUBLIC_DEMO_VIEWER` is a runtime setting, and this is a server component,
 * so the flag can be flipped with a restart rather than a rebuild. A
 * `NEXT_PUBLIC_*` twin would have been simpler and wrong: it is inlined at
 * build time, so a deployment could not stop being public without shipping a
 * new bundle.
 *
 * `publicViewerPerson()` returns `null` unless the flag is exactly `1`, so a
 * private deployment does no work here and provides no guest. It does not
 * check for a session: `useIdentity` reads the real session first and only
 * falls back to this, which is what makes "a session always wins" true on the
 * client as well as in the proxy.
 */
export default async function RootLayout({ children }: LayoutProps<"/">) {
  /*
   * `connection()` opts this render out of prerendering, and it has to be
   * called **unconditionally** - which is the whole subtlety here.
   *
   * Without it `/` prerenders at build time (the build output said
   * `○ (Static)`), the layout runs once with whatever the flag was during the
   * build, and the answer is frozen into the HTML. Turning the mode on later
   * would then change what the proxy forwards but not what the page says, so
   * the API would serve a guest while the UI showed the id-less-session error.
   *
   * Guarding the call behind `publicViewerEnabled()` looks tempting and has
   * exactly the same bug: the guard itself would be evaluated at build time,
   * so a build with the flag off prerenders the route and never reconsiders.
   * The decision between static and dynamic is made once, at build; the only
   * way a runtime flag can be honoured is to always be dynamic. This app is
   * entirely client-fetched and every request already passes through the
   * proxy, so the prerender was buying close to nothing.
   */
  await connection();
  const guest = await publicViewerPerson();

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground font-sans">
        {/*
         * The nova primitives' `Tooltip` does not wrap itself in a provider,
         * so one lives here rather than in each panel that wants a tooltip.
         * There is deliberately no theme provider: light and dark follow the
         * system preference in `globals.css`, and a toggle would be a feature
         * this pass is not adding.
         */}
        <TooltipProvider>
          <GuestIdentityProvider guest={guest}>
            {children}
            <Toaster />
          </GuestIdentityProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
