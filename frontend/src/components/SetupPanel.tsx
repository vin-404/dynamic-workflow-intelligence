"use client";

/**
 * The first steps of the journey: what are you accomplishing, in what domain,
 * and who is working on it.
 *
 * A domain is a row, and defining your own is a first-class path rather than
 * a settings page - which is what "domain-agnostic" has to mean in the UI if
 * it is to mean anything in the engine.
 *
 * Two presentation decisions, wave 2:
 *
 *   - `ProjectCreate` keeps a bounded surface. It is a focused task on an
 *     otherwise empty screen, and a create form with no edges has nothing to
 *     tell you where it begins. Everything else in this pass loses its box.
 *   - `MemberList` loses its box, because it sits under the builder and is
 *     subordinate to it.
 *
 * The roles copy here changed, and it is the one copy change in this pass:
 * `backend/app/api/deps.py` enforces `ProjectMember.role` whenever the app is
 * configured with a proxy secret, which it now is. A viewer may read and ask
 * questions; an editor may change the workflow; an owner may additionally
 * change who is on the project. The old line - "Roles are advisory - they say
 * who owns this, not what the software will let anyone do" - was true when it
 * was written and is now false, so it is corrected rather than softened.
 */

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import {
  ApiError,
  Domain,
  Member,
  Project,
  addMember,
  createProject,
  listDomains,
  listMembers,
  removeMember,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { roleLabel } from "@/lib/display";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorNote } from "./ui";

/** Radix's Select will not take `""` as a value; this is "nothing chosen". */
const NONE = "__none__";
const DEFINE_OWN = "__new__";

function today(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** A composer field: label above control, tight. */
function Lbl({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("flex flex-col gap-1", className)}>
      <span className="text-[12px] leading-none text-dim">{label}</span>
      {children}
      {hint && (
        <span className="text-[12px] leading-none text-dim">{hint}</span>
      )}
    </label>
  );
}

export function ProjectCreate({
  onCreated,
  onCancel,
}: {
  onCreated: (project: Project) => void;
  onCancel?: () => void;
}) {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [domainId, setDomainId] = useState("");
  const [customName, setCustomName] = useState("");
  const [customHints, setCustomHints] = useState("");
  const [start, setStart] = useState(today());
  const [deadline, setDeadline] = useState(today(30));
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listDomains()
      .then(setDomains)
      .catch(() => setDomains([]));
  }, []);

  const defining = domainId === DEFINE_OWN;

  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const project = await createProject({
        name: name.trim(),
        goal: goal.trim(),
        start_date: start,
        deadline: deadline || null,
        owner_email: "you@example.com",
        ...(defining
          ? {
              new_domain: {
                key:
                  customName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_") ||
                  `custom_${Date.now()}`,
                name: customName.trim() || "Custom domain",
                description: customHints.trim(),
              },
            }
          : { domain_id: domainId || null }),
      });
      onCreated(project);
    } catch (e) {
      if (e instanceof ApiError) setError(e);
      else throw e;
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Start a workflow</CardTitle>
        <CardDescription>
          Two questions first: what are you trying to accomplish, and roughly
          what kind of work is it? The second one only ever feeds suggestions
          and vocabulary — the analysis engine never sees it.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {error && (
          <ErrorNote hint={error.hint} requestId={error.requestId}>
            {error.userMessage}
          </ErrorNote>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Lbl label="What is this workflow called?">
            <Input
              value={name}
              placeholder="Battery pack pilot line"
              onChange={(e) => setName(e.target.value)}
            />
          </Lbl>
          <Lbl label="Kind of work" hint="context and templates only">
            <Select
              value={domainId || NONE}
              onValueChange={(v) => setDomainId(v === NONE ? "" : v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={NONE}>not sure yet</SelectItem>
                  {domains.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                      {d.is_custom ? " (yours)" : ""}
                    </SelectItem>
                  ))}
                </SelectGroup>
                <SelectSeparator />
                <SelectGroup>
                  <SelectItem value={DEFINE_OWN}>+ define my own…</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Lbl>

          {defining && (
            <>
              <Lbl label="Name your domain">
                <Input
                  value={customName}
                  placeholder="Clinical trial start-up"
                  onChange={(e) => setCustomName(e.target.value)}
                />
              </Lbl>
              <Lbl label="What is it, in a sentence?">
                <Input
                  value={customHints}
                  placeholder="Site activation across regulated sites"
                  onChange={(e) => setCustomHints(e.target.value)}
                />
              </Lbl>
            </>
          )}

          <Lbl
            label="What are you accomplishing?"
            className="sm:col-span-2"
            hint="one sentence; it appears on every analysis"
          >
            <textarea
              rows={2}
              value={goal}
              placeholder="Reach a certified pilot run before the customer design freeze."
              onChange={(e) => setGoal(e.target.value)}
              className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            />
          </Lbl>

          <Lbl label="Starts">
            <Input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </Lbl>
          <Lbl label="Deadline" hint="optional, but it unlocks feasibility">
            <Input
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
            />
          </Lbl>
        </div>
      </CardContent>

      <CardFooter className="gap-2 border-t pt-4">
        <Button onClick={submit} disabled={busy || !name.trim()}>
          Create and start building
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

export function MemberList({ projectId }: { projectId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("editor");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listMembers(projectId)
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [projectId]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setMembers(await listMembers(projectId));
    } catch (e) {
      if (e instanceof ApiError) setError(e);
      else throw e;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      {/* The same heading the builder's sections use: 18px and a count. */}
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 className="text-[18px] font-semibold">Who is collaborating</h2>
        <span className="font-mono text-[12px] text-dim">{members.length}</span>
      </div>

      {/* Enforced, not advisory. See the note at the top of this file. */}
      <p className="max-w-3xl text-[12px] text-dim">
        Roles are enforced, not advisory: a viewer may read and ask questions,
        an editor may also change the workflow, and an owner may additionally
        change who is on the project. Reads stay open to anyone signed in —
        what a role protects is who can change the plan.
      </p>

      {error && (
        <div className="mt-2">
          <ErrorNote hint={error.hint} requestId={error.requestId}>
            {error.userMessage}
          </ErrorNote>
        </div>
      )}

      {members.length === 0 ? (
        <p className="mt-2 text-[14px] text-dim">Nobody yet.</p>
      ) : (
        <ul className="mt-2">
          {/* Name, email, role, remove - as grid columns, so a long name or
              address wraps in its column instead of being clipped. */}
          {members.map((m) => (
            <li
              key={m.user_id}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto_auto] items-baseline gap-3 border-b border-line/50 py-1 text-[14px]"
            >
              <span className="break-words">{m.name || m.email}</span>
              <span className="font-mono text-[12px] break-all text-dim">
                {m.email}
              </span>
              <span
                className={cn(
                  "text-[12px]",
                  m.role === "owner" ? "text-foreground" : "text-dim",
                )}
              >
                {roleLabel(m.role)}
              </span>
              <button
                type="button"
                onClick={() => run(() => removeMember(projectId, m.user_id))}
                disabled={busy}
                aria-label={`Remove ${m.email}`}
                title="Remove"
                className="text-dim transition-colors hover:text-severity-high disabled:opacity-40"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 grid grid-cols-1 items-end gap-2 sm:grid-cols-3">
        <Lbl label="Email">
          <Input
            value={email}
            placeholder="priya@example.com"
            onChange={(e) => setEmail(e.target.value)}
          />
        </Lbl>
        <Lbl label="Role">
          <Select value={role} onValueChange={setRole}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="owner">{roleLabel("owner")}</SelectItem>
                <SelectItem value="editor">{roleLabel("editor")}</SelectItem>
                <SelectItem value="viewer">{roleLabel("viewer")}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Lbl>
        <Button
          disabled={busy || !email.includes("@")}
          onClick={() => {
            run(() => addMember(projectId, { email: email.trim(), role }));
            setEmail("");
          }}
        >
          Add member
        </Button>
      </div>
    </section>
  );
}
