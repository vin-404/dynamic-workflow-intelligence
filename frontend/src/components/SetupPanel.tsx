"use client";

/**
 * The first steps of the journey: what are you accomplishing, in what domain,
 * and who is working on it.
 *
 * A domain is a row, and defining your own is a first-class path rather than
 * a settings page - which is what "domain-agnostic" has to mean in the UI if
 * it is to mean anything in the engine.
 */

import { useEffect, useState } from "react";
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
import {
  Badge,
  Button,
  Card,
  CardTitle,
  ErrorNote,
  Field,
  Input,
  Select,
  Textarea,
} from "./ui";

function today(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
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
    listDomains().then(setDomains).catch(() => setDomains([]));
  }, []);

  const defining = domainId === "__new__";

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
      <CardTitle>Start a workflow</CardTitle>
      <p className="text-sm text-dim mb-4">
        Two questions first: what are you trying to accomplish, and roughly
        what kind of work is it? The second one only ever feeds suggestions and
        vocabulary — the analysis engine never sees it.
      </p>

      {error && (
        <div className="mb-3">
          <ErrorNote>{error.userMessage}</ErrorNote>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="What is this workflow called?">
          <Input
            value={name}
            placeholder="Battery pack pilot line"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Kind of work" hint="context and templates only">
          <Select
            value={domainId}
            onChange={(e) => setDomainId(e.target.value)}
          >
            <option value="">not sure yet</option>
            {domains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.is_custom ? " (yours)" : ""}
              </option>
            ))}
            <option value="__new__">+ define my own…</option>
          </Select>
        </Field>

        {defining && (
          <>
            <Field label="Name your domain">
              <Input
                value={customName}
                placeholder="Clinical trial start-up"
                onChange={(e) => setCustomName(e.target.value)}
              />
            </Field>
            <Field label="What is it, in a sentence?">
              <Input
                value={customHints}
                placeholder="Site activation across regulated sites"
                onChange={(e) => setCustomHints(e.target.value)}
              />
            </Field>
          </>
        )}

        <Field
          label="What are you accomplishing?"
          className="sm:col-span-2"
          hint="one sentence; it appears on every analysis"
        >
          <Textarea
            rows={2}
            value={goal}
            placeholder="Reach a certified pilot run before the customer design freeze."
            onChange={(e) => setGoal(e.target.value)}
          />
        </Field>

        <Field label="Starts">
          <Input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </Field>
        <Field label="Deadline" hint="optional, but it unlocks feasibility">
          <Input
            type="date"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
          />
        </Field>
      </div>

      <div className="flex gap-2 mt-4">
        <Button
          variant="primary"
          onClick={submit}
          disabled={busy || !name.trim()}
        >
          Create and start building
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
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
    listMembers(projectId).then(setMembers).catch(() => setMembers([]));
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
    <Card>
      <CardTitle right={<span className="text-xs text-dim">{members.length}</span>}>
        Who is collaborating
      </CardTitle>

      {error && (
        <div className="mb-2">
          <ErrorNote>{error.userMessage}</ErrorNote>
        </div>
      )}

      {members.length === 0 ? (
        <p className="text-dim text-sm mb-3">
          Nobody yet. Roles are advisory — they say who owns this, not what the
          software will let anyone do.
        </p>
      ) : (
        <ul className="space-y-1 mb-3">
          {members.map((m) => (
            <li
              key={m.user_id}
              className="flex items-center gap-2 text-sm bg-panel2/50 border border-line/60 rounded px-2 py-1"
            >
              <span className="flex-1 truncate">{m.name || m.email}</span>
              <span className="text-xs text-dim truncate">{m.email}</span>
              <Badge tone={m.role === "owner" ? "accent" : "neutral"}>
                {m.role}
              </Badge>
              <button
                onClick={() => run(() => removeMember(projectId, m.user_id))}
                disabled={busy}
                className="text-dim hover:text-red"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
        <Field label="Email" className="sm:col-span-1">
          <Input
            value={email}
            placeholder="priya@example.com"
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="owner">owner</option>
            <option value="editor">editor</option>
            <option value="viewer">viewer</option>
          </Select>
        </Field>
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
    </Card>
  );
}
