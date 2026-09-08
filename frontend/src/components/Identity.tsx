"use client";

/**
 * Who you are — now answered by Google, not by a text box.
 *
 * This replaces the name picker (`WhoAreYou.tsx`, deleted). The difference is
 * not cosmetic and the copy here should not pretend otherwise: the old panel
 * said "there is no login here, pick a name, anyone can pick any name", and
 * that was true. It is now false. A Google session decides who you are, and
 * `ProjectMember.role` decides what you may do with it.
 *
 * Two consequences worth knowing while reading this file:
 *
 *   * **The identity is not sent from here any more.** `src/proxy.ts` strips
 *     any `X-User-Id` the browser sends and injects the one it derives from
 *     the verified session cookie. So there is nothing for this component to
 *     put on a request, and a client that lies about who it is gets nowhere.
 *   * **A signed-out person normally never reaches this component.** The proxy
 *     redirects them to `/login` first, so the loading state below covers one
 *     round trip to `/api/auth/session` rather than a "not signed in" case.
 *     The exception is a public read-only demo (`PUBLIC_DEMO_VIEWER=1`),
 *     where a sessionless visitor is forwarded as the guest instead of turned
 *     away - and then this component's job is to say so, plainly, rather than
 *     to let them believe they are signed in as somebody.
 */

import { createContext, useContext, useEffect, useState } from "react";
import { getSession, signOut } from "next-auth/react";
import type { Person } from "@/lib/api";

/**
 * The public read-only guest, handed down from the server layout.
 *
 * `layout.tsx` reads `PUBLIC_DEMO_VIEWER` at request time and resolves the
 * guest there, because the flag is a *runtime* setting and a `NEXT_PUBLIC_*`
 * twin would be frozen into the bundle at build time - a public deployment
 * would then need a rebuild to stop being public. `null` in every private
 * deployment, which is the default.
 */
const GuestContext = createContext<Person | null>(null);

export function GuestIdentityProvider({
  guest,
  children,
}: {
  guest: Person | null;
  children: React.ReactNode;
}) {
  return <GuestContext value={guest}>{children}</GuestContext>;
}

/**
 * The signed-in person, or `null` while the session is still being read.
 *
 * `getSession()` rather than `useSession()`: the latter needs a
 * `SessionProvider` in `layout.tsx`, and one fetch on mount is the whole
 * requirement here. `backendUserId` is the id FastAPI knows this person by —
 * `session.user.id` would be Google's, which no row in our database uses.
 */
export function useIdentity(): {
  person: Person | null;
  failed: boolean;
  isGuest: boolean;
} {
  const guest = useContext(GuestContext);
  const [person, setPerson] = useState<Person | null>(null);
  const [failed, setFailed] = useState(false);
  const [isGuest, setIsGuest] = useState(false);

  useEffect(() => {
    let live = true;
    getSession()
      .then((session) => {
        if (!live) return;
        const user = session?.user;
        if (!user?.backendUserId || !user.email) {
          // No session. On a public read-only build the proxy has already
          // forwarded this visitor as the guest, so show who they actually
          // are rather than an error - and a real session, checked first
          // above, always wins over it.
          if (guest) {
            setPerson(guest);
            setIsGuest(true);
            return;
          }
          // The proxy fails an id-less session closed, so this is close to
          // unreachable. If it happens, say so rather than rendering an app
          // whose every write will be refused.
          setFailed(true);
          return;
        }
        setIsGuest(false);
        setPerson({
          id: user.backendUserId,
          email: user.email,
          name: user.name || user.email,
        });
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [guest]);

  return { person, failed, isGuest };
}

/**
 * The header control: who you are, and a way to stop being them.
 *
 * On a public read-only build it says so instead, in one line, and offers the
 * way in rather than the way out. It reads the guest context itself so that
 * `page.tsx` needs no change and cannot forget to pass the flag through.
 *
 * Deliberately not a banner. The honest line belongs where the identity
 * already is, at the same size as the name it replaces: a full-width
 * "you are a guest" bar would be the loudest element on a screen whose point
 * is the analysis, and a reader who dismissed it once would never see it
 * again. This cannot be dismissed and cannot be missed if you look at who
 * you are.
 */
export function IdentityBadge({ person }: { person: Person }) {
  const guest = useContext(GuestContext);
  const isGuest = guest !== null && guest.id === person.id;

  if (isGuest) {
    return (
      <span className="inline-flex shrink-0 items-baseline gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
        <span>viewing as a read-only guest</span>
        <a
          href="/login"
          className="rounded border border-line px-1.5 py-0.5 whitespace-nowrap text-foreground hover:border-dim"
        >
          Sign in
        </a>
      </span>
    );
  }

  return (
    <button
      onClick={() => void signOut({ callbackUrl: "/login" })}
      title={`Signed in as ${person.email} — sign out`}
      className="text-xs text-dim hover:text-foreground border border-line rounded px-1.5 py-0.5"
    >
      {person.name}
      <span className="opacity-60"> · sign out</span>
    </button>
  );
}
