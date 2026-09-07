"use client";

/**
 * Identity without a login.
 *
 * You pick a name. The browser remembers it. That is the whole system.
 *
 * There is no password, no session and no account, and the panel says so
 * plainly rather than implying a security model it does not have. Anyone with
 * the URL can pick any name here, including someone else's - which is the
 * correct amount of ceremony for a shared demo of a planning tool, and better
 * than a half-built login that looks like protection.
 *
 * The identity is stored in `localStorage` and sent as `X-User-Id`, so two
 * browsers can open the same project as different people.
 */

import { useEffect, useState } from "react";
import { ApiError, Person, createUser, getUser, listUsers } from "@/lib/api";
import { Badge, Button, Card, CardTitle, ErrorNote, Input, Spinner } from "./ui";

const STORAGE_KEY = "dwi.identity";

export function loadIdentity(): Person | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Person) : null;
  } catch {
    // A private window, or storage the browser refuses. Not an error - the
    // user just gets asked who they are again.
    return null;
  }
}

export function saveIdentity(person: Person | null) {
  try {
    if (person) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(person));
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    /* storage unavailable; the identity lasts for this page only */
  }
}

/**
 * Confirms a remembered identity still exists.
 *
 * After an admin reset it will not, and a browser that keeps sending a
 * dangling id would attribute everything to a user that is gone. Better to
 * ask again.
 */
export async function verifyIdentity(person: Person): Promise<Person | null> {
  try {
    return await getUser(person.id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    return person; // The API is unreachable; that is a different problem.
  }
}

export default function WhoAreYou({
  onPicked,
}: {
  onPicked: (person: Person) => void;
}) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listUsers()
      .then(setPeople)
      .catch(() => setPeople([]));
  }, []);

  async function pick(person: Person) {
    saveIdentity(person);
    onPicked(person);
  }

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await pick(await createUser(trimmed));
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardTitle right={<Badge tone="neutral">no password needed</Badge>}>
        Who are you?
      </CardTitle>
      <p className="text-sm text-dim mb-4">
        Your name goes on the workflows you create and the changes you make.
        There is no login here — pick a name, and this browser will remember
        it.
      </p>

      {error && <div className="mb-3"><ErrorNote>{error}</ErrorNote></div>}

      <div className="flex gap-2">
        <div className="flex-1">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
            }}
            placeholder="Your name"
            aria-label="Your name"
            autoFocus
          />
        </div>
        <Button variant="primary" onClick={create} disabled={busy || !name.trim()}>
          {busy ? "…" : "Continue"}
        </Button>
      </div>

      {people === null ? (
        <div className="mt-4">
          <Spinner label="Looking up who has been here" />
        </div>
      ) : people.length > 0 ? (
        <div className="mt-5 pt-4 border-t border-line">
          <div className="text-xs text-dim mb-2">
            Or continue as someone who has been here before:
          </div>
          <div className="flex flex-wrap gap-1.5">
            {people.slice(0, 12).map((p) => (
              <button
                key={p.id}
                onClick={() => pick(p)}
                className="px-2 py-1 text-sm rounded border border-line hover:border-accent"
                title={
                  p.project_count
                    ? `On ${p.project_count} workflow(s)`
                    : "No workflows yet"
                }
              >
                {p.name}
                {p.project_count ? (
                  <span className="text-dim text-xs"> · {p.project_count}</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <p className="mt-4 text-xs text-dim">
        Anyone with this link can pick any name, including one already listed.
        Nothing here is private and nothing is enforced — roles on a workflow
        say who does what, not who is allowed to.
      </p>
    </Card>
  );
}

/** The header control: who you are, and a way to stop being them. */
export function IdentityBadge({
  person,
  onSwitch,
}: {
  person: Person;
  onSwitch: () => void;
}) {
  return (
    <button
      onClick={onSwitch}
      title="Switch to a different name"
      className="text-xs text-dim hover:text-foreground border border-line rounded px-1.5 py-0.5"
    >
      {person.name}
      <span className="opacity-60"> · switch</span>
    </button>
  );
}
