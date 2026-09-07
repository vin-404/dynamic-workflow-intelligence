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
 *   * **A signed-out person never reaches this component.** The proxy redirects
 *     them to `/login` first. The loading state below therefore covers one
 *     round trip to `/api/auth/session`, not a "not signed in" case.
 */

import { useEffect, useState } from "react";
import { getSession, signOut } from "next-auth/react";
import type { Person } from "@/lib/api";

/**
 * The signed-in person, or `null` while the session is still being read.
 *
 * `getSession()` rather than `useSession()`: the latter needs a
 * `SessionProvider` in `layout.tsx`, and one fetch on mount is the whole
 * requirement here. `backendUserId` is the id FastAPI knows this person by —
 * `session.user.id` would be Google's, which no row in our database uses.
 */
export function useIdentity(): { person: Person | null; failed: boolean } {
  const [person, setPerson] = useState<Person | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    getSession()
      .then((session) => {
        if (!live) return;
        const user = session?.user;
        if (!user?.backendUserId || !user.email) {
          // The proxy fails an id-less session closed, so this is close to
          // unreachable. If it happens, say so rather than rendering an app
          // whose every write will be refused.
          setFailed(true);
          return;
        }
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
  }, []);

  return { person, failed };
}

/** The header control: who you are, and a way to stop being them. */
export function IdentityBadge({ person }: { person: Person }) {
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
