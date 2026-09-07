"use client";

/**
 * The workflow builder.
 *
 * This is the component the repository never had, and the reason nothing else
 * in the frontend mattered until it existed: before this, a user could not
 * create a project, add a task, or draw a dependency.
 *
 * The workflow is the centre of the experience - not cards, not KPI tiles.
 * Everything here writes to the project's draft version through the authoring
 * API, and every rejection is shown with the reason the backend gave, because
 * those reasons are the product: "T17 -> T01 would create a circular
 * dependency: T16 -> T17 -> T01 -> ..." is worth more than a red border.
 */

import { useMemo, useState } from "react";
import {
  ApiError,
  Workflow,
  WorkflowTask,
  addAssignment,
  createDependency,
  createResource,
  createTask,
  deleteDependency,
  deleteResource,
  deleteTask,
  patchTask,
  removeAssignment,
} from "@/lib/api";
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Disclose,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Select,
  days,
} from "./ui";

const STATUSES = ["not_started", "in_progress", "in_review", "blocked", "done"];
const STATUS_LABEL: Record<string, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  in_review: "In review",
  blocked: "Blocked",
  done: "Done",
};

function nextTaskKey(workflow: Workflow): string {
  const numbers = workflow.tasks
    .map((t) => /^T(\d+)$/.exec(t.key)?.[1])
    .filter(Boolean)
    .map((n) => parseInt(n as string, 10));
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  return `T${String(next).padStart(2, "0")}`;
}

export default function WorkflowBuilder({
  workflow,
  onChange,
  templates,
}: {
  workflow: Workflow;
  onChange: (next: Workflow) => void;
  templates?: { name: string; effort: number; divisible?: boolean }[];
}) {
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const projectId = workflow.project_id;

  async function run(action: () => Promise<Workflow>) {
    setBusy(true);
    setError(null);
    try {
      onChange(await action());
    } catch (e) {
      if (e instanceof ApiError) setError(e);
      else throw e;
    } finally {
      setBusy(false);
    }
  }

  const constraintsByTarget = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const c of workflow.constraints) {
      map.set(c.target, [...(map.get(c.target) ?? []), c.kind]);
    }
    return map;
  }, [workflow.constraints]);

  return (
    <div className="space-y-4">
      {error && (
        <ErrorNote
          onRetry={() => setError(null)}
          hint={error.hint}
          requestId={error.requestId}
        >
          <p>{error.userMessage}</p>
          {error.cycles && (
            <p className="mt-1 font-mono text-xs text-amber">
              {error.cycles[0].join(" → ")} → {error.cycles[0][0]}
            </p>
          )}
          {error.constraint && (
            <p className="mt-1 text-xs">
              <Badge tone="violet">{error.constraint.constraint}</Badge>{" "}
              <span className="text-dim">
                {error.constraint.constraint_reason}
              </span>
            </p>
          )}
        </ErrorNote>
      )}

      <ResourcePanel
        workflow={workflow}
        busy={busy}
        onCreate={(body) => run(() => createResource(projectId, body))}
        onDelete={(key) => run(() => deleteResource(projectId, key))}
      />

      <TaskPanel
        workflow={workflow}
        busy={busy}
        templates={templates}
        constraintsByTarget={constraintsByTarget}
        onCreate={(body) => run(() => createTask(projectId, body))}
        onPatch={(key, body) => run(() => patchTask(projectId, key, body))}
        onDelete={(key) => run(() => deleteTask(projectId, key))}
        onAssign={(taskKey, resourceKey) =>
          run(() => addAssignment(projectId, taskKey, resourceKey))
        }
        onUnassign={(taskKey, resourceKey) =>
          run(() => removeAssignment(projectId, taskKey, resourceKey))
        }
      />

      <DependencyPanel
        workflow={workflow}
        busy={busy}
        onCreate={(body) => run(() => createDependency(projectId, body))}
        onDelete={(from, to) => run(() => deleteDependency(projectId, from, to))}
      />
    </div>
  );
}

/* ------------------------------------------------------------- resources */

function ResourcePanel({
  workflow,
  busy,
  onCreate,
  onDelete,
}: {
  workflow: Workflow;
  busy: boolean;
  onCreate: (body: {
    key: string;
    name: string;
    kind: string;
    capacity: number;
    parent_key: string | null;
  }) => void;
  onDelete: (key: string) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("person");
  const [capacity, setCapacity] = useState(1);
  const [parent, setParent] = useState("");

  const teams = workflow.resources.filter((r) => r.kind !== "person");

  function submit() {
    if (!name.trim()) return;
    const key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
    onCreate({
      key,
      name: name.trim(),
      kind,
      capacity,
      parent_key: parent || null,
    });
    setName("");
    setParent("");
  }

  return (
    <Card>
      <CardTitle right={<span className="text-xs text-dim">{workflow.resources.length}</span>}>
        Who and what does the work
      </CardTitle>

      {workflow.resources.length === 0 ? (
        <p className="text-dim text-sm mb-3">
          Nothing is assignable yet. A resource is a person, a team, a machine
          or a budget line — the engine only ever sees a name, a kind and a
          capacity, which is what keeps it domain-agnostic.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {workflow.resources.map((r) => (
            <span
              key={r.key}
              className="inline-flex items-center gap-1.5 bg-panel2 border border-line rounded px-2 py-1 text-xs"
            >
              <span className="text-dim">{r.kind}</span>
              <span>{r.name}</span>
              <span className="text-dim">cap {r.capacity}</span>
              {r.parent_key && (
                <span className="text-dim">
                  in {workflow.resources.find((p) => p.key === r.parent_key)?.name}
                </span>
              )}
              <button
                onClick={() => onDelete(r.key)}
                disabled={busy}
                title="Remove"
                className="text-dim hover:text-red ml-0.5"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-5 gap-2 items-end">
        <Field label="Name" className="sm:col-span-2">
          <Input
            value={name}
            placeholder="Priya, Marketing, Test rig…"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </Field>
        <Field label="Kind">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="person">person</option>
            <option value="team">team</option>
            <option value="equipment">equipment</option>
            <option value="budget">budget</option>
          </Select>
        </Field>
        <Field label="Capacity" hint="How many at once">
          <Input
            type="number"
            min={0}
            value={capacity}
            onChange={(e) => setCapacity(Number(e.target.value))}
          />
        </Field>
        <div className="flex gap-2">
          <Field label="Belongs to" className="flex-1">
            <Select value={parent} onChange={(e) => setParent(e.target.value)}>
              <option value="">—</option>
              {teams.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            Add resource
          </Button>
        </div>
      </div>
      <p className="text-[11px] text-dim mt-2">
        A team&apos;s capacity can be lower than its headcount — that gap is how
        a bottleneck gets found.
      </p>
    </Card>
  );
}

/* ----------------------------------------------------------------- tasks */

function TaskPanel({
  workflow,
  busy,
  templates,
  constraintsByTarget,
  onCreate,
  onPatch,
  onDelete,
  onAssign,
  onUnassign,
}: {
  workflow: Workflow;
  busy: boolean;
  templates?: { name: string; effort: number; divisible?: boolean }[];
  constraintsByTarget: Map<string, string[]>;
  onCreate: (body: {
    key: string;
    name: string;
    effort: number;
    divisible: boolean;
    assignees: string[];
  }) => void;
  onPatch: (key: string, body: Record<string, unknown>) => void;
  onDelete: (key: string) => void;
  onAssign: (taskKey: string, resourceKey: string) => void;
  onUnassign: (taskKey: string, resourceKey: string) => void;
}) {
  const [name, setName] = useState("");
  const [effort, setEffort] = useState(3);
  const [divisible, setDivisible] = useState(true);
  const [assignee, setAssignee] = useState("");

  function submit() {
    if (!name.trim()) return;
    onCreate({
      key: nextTaskKey(workflow),
      name: name.trim(),
      effort,
      divisible,
      assignees: assignee ? [assignee] : [],
    });
    setName("");
    setEffort(3);
    setDivisible(true);
  }

  return (
    <Card>
      <CardTitle right={<span className="text-xs text-dim">{workflow.tasks.length}</span>}>
        The work
      </CardTitle>

      {workflow.tasks.length === 0 ? (
        <EmptyState title="No tasks yet">
          Add the first piece of work below. Effort is the amount of work in
          days, not the elapsed time — the engine derives duration from effort
          and who is on it, and it will not pretend two people halve a task.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-sm min-w-[720px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-dim">
                <th className="font-medium py-1.5 px-1 w-14">Key</th>
                <th className="font-medium py-1.5 px-1">Task</th>
                <th className="font-medium py-1.5 px-1 w-20">Effort</th>
                <th className="font-medium py-1.5 px-1 w-24">Divisible</th>
                <th className="font-medium py-1.5 px-1 w-32">Status</th>
                <th className="font-medium py-1.5 px-1 w-56">Assigned to</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {workflow.tasks.map((task) => (
                <TaskRow
                  key={task.key}
                  task={task}
                  workflow={workflow}
                  busy={busy}
                  constraints={constraintsByTarget.get(task.key) ?? []}
                  onPatch={onPatch}
                  onDelete={onDelete}
                  onAssign={onAssign}
                  onUnassign={onUnassign}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-6 gap-2 items-end mt-4 pt-3 border-t border-line">
        <Field label="New task" className="sm:col-span-2">
          <Input
            value={name}
            placeholder="Draft the budget…"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </Field>
        <Field label="Effort" hint="days of work">
          <Input
            type="number"
            min={0}
            step={0.5}
            value={effort}
            onChange={(e) => setEffort(Number(e.target.value))}
          />
        </Field>
        <Field label="Divisible" hint="can more people help?">
          <Select
            value={divisible ? "yes" : "no"}
            onChange={(e) => setDivisible(e.target.value === "yes")}
          >
            <option value="yes">Yes</option>
            <option value="no">No — one signature</option>
          </Select>
        </Field>
        <Field label="Assign to">
          <Select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">nobody yet</option>
            {workflow.resources.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="primary" onClick={submit} disabled={busy || !name.trim()}>
          Add task
        </Button>
      </div>

      {templates && templates.length > 0 && workflow.tasks.length === 0 && (
        <div className="mt-3">
          <Disclose summary={`Start from this domain's templates (${templates.length})`}>
            <div className="flex flex-wrap gap-1.5">
              {templates.map((t) => (
                <Button
                  key={t.name}
                  onClick={() => {
                    setName(t.name);
                    setEffort(t.effort);
                    setDivisible(t.divisible !== false);
                  }}
                >
                  {t.name} · {days(t.effort)}
                </Button>
              ))}
            </div>
            <p className="text-[11px] text-dim mt-2">
              Templates are suggestions from the domain you picked. They fill
              the form; nothing is added until you press Add task.
            </p>
          </Disclose>
        </div>
      )}
    </Card>
  );
}

function TaskRow({
  task,
  workflow,
  busy,
  constraints,
  onPatch,
  onDelete,
  onAssign,
  onUnassign,
}: {
  task: WorkflowTask;
  workflow: Workflow;
  busy: boolean;
  constraints: string[];
  onPatch: (key: string, body: Record<string, unknown>) => void;
  onDelete: (key: string) => void;
  onAssign: (taskKey: string, resourceKey: string) => void;
  onUnassign: (taskKey: string, resourceKey: string) => void;
}) {
  const [name, setName] = useState(task.name);
  const [effort, setEffort] = useState(String(task.effort));
  const mandatory = constraints.includes("MANDATORY_TASK");
  const locked = constraints.includes("NON_DIVISIBLE_TASK");

  return (
    <tr className="border-t border-line/60 align-top">
      <td className="py-1.5 px-1 font-mono text-xs text-dim">{task.key}</td>
      <td className="py-1.5 px-1">
        <Input
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== task.name && onPatch(task.key, { name })}
        />
        {constraints.length > 0 && (
          <div className="flex gap-1 mt-1">
            {mandatory && (
              <Badge tone="violet" title="Cannot be removed">
                mandatory
              </Badge>
            )}
            {locked && (
              <Badge tone="violet" title="Cannot be split">
                indivisible
              </Badge>
            )}
          </div>
        )}
      </td>
      <td className="py-1.5 px-1">
        <Input
          type="number"
          min={0}
          step={0.5}
          value={effort}
          disabled={busy}
          onChange={(e) => setEffort(e.target.value)}
          onBlur={() =>
            Number(effort) !== task.effort &&
            onPatch(task.key, { effort: Number(effort) })
          }
        />
      </td>
      <td className="py-1.5 px-1">
        <Select
          value={task.divisible ? "yes" : "no"}
          disabled={busy || locked}
          title={locked ? "A constraint fixes this task as indivisible" : undefined}
          onChange={(e) =>
            onPatch(task.key, { divisible: e.target.value === "yes" })
          }
        >
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </Select>
      </td>
      <td className="py-1.5 px-1">
        <Select
          value={task.status}
          disabled={busy}
          onChange={(e) => onPatch(task.key, { status: e.target.value })}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
      </td>
      <td className="py-1.5 px-1">
        <div className="flex flex-wrap gap-1 mb-1">
          {task.assignees.map((a) => (
            <span
              key={a.key}
              className="inline-flex items-center gap-1 bg-panel2 border border-line rounded px-1.5 py-0.5 text-[11px]"
            >
              {a.label}
              <button
                onClick={() => onUnassign(task.key, a.key)}
                disabled={busy}
                className="text-dim hover:text-red"
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <Select
          value=""
          disabled={busy || workflow.resources.length === 0}
          onChange={(e) => e.target.value && onAssign(task.key, e.target.value)}
        >
          <option value="">
            {workflow.resources.length ? "add…" : "add a resource first"}
          </option>
          {workflow.resources
            .filter((r) => !task.assignees.some((a) => a.key === r.key))
            .map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
        </Select>
      </td>
      <td className="py-1.5 px-1">
        <button
          onClick={() => onDelete(task.key)}
          disabled={busy}
          title={mandatory ? "This task is mandatory" : "Delete task"}
          className="text-dim hover:text-red"
        >
          ×
        </button>
      </td>
    </tr>
  );
}

/* ---------------------------------------------------------- dependencies */

function DependencyPanel({
  workflow,
  busy,
  onCreate,
  onDelete,
}: {
  workflow: Workflow;
  busy: boolean;
  onCreate: (body: {
    from_task: string;
    to_task: string;
    consumes: boolean;
  }) => void;
  onDelete: (from: string, to: string) => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [consumes, setConsumes] = useState(true);

  const protectedEdges = useMemo(
    () =>
      new Set(
        workflow.constraints
          .filter((c) => c.kind === "IMMUTABLE_DEPENDENCY")
          .map((c) => c.target),
      ),
    [workflow.constraints],
  );

  const nameOf = (key: string) =>
    workflow.tasks.find((t) => t.key === key)?.name ?? key;

  return (
    <Card>
      <CardTitle
        right={<span className="text-xs text-dim">{workflow.dependencies.length}</span>}
      >
        What waits on what
      </CardTitle>

      {workflow.tasks.length < 2 ? (
        <p className="text-dim text-sm">
          Add at least two tasks and you can draw the order between them.
        </p>
      ) : (
        <>
          {workflow.dependencies.length === 0 ? (
            <p className="text-dim text-sm mb-3">
              Nothing depends on anything yet, so every task starts on day one.
              That is rarely the real plan.
            </p>
          ) : (
            <ul className="space-y-1 mb-3 max-h-64 overflow-y-auto">
              {workflow.dependencies.map((d) => {
                const isProtected = protectedEdges.has(
                  `${d.from_task}->${d.to_task}`,
                );
                return (
                  <li
                    key={`${d.from_task}-${d.to_task}`}
                    className="flex items-center gap-2 text-sm bg-panel2/50 border border-line/60 rounded px-2 py-1"
                  >
                    <span className="font-mono text-xs text-dim w-12">
                      {d.from_task}
                    </span>
                    <span className="text-dim">→</span>
                    <span className="font-mono text-xs text-dim w-12">
                      {d.to_task}
                    </span>
                    <span className="flex-1 truncate text-xs">
                      {nameOf(d.from_task)} before {nameOf(d.to_task)}
                    </span>
                    <Badge
                      tone={d.consumes ? "accent" : "neutral"}
                      title={
                        d.consumes
                          ? "Artifact: the successor consumes what this produces, so a requirement change invalidates it"
                          : "Ordering only: no artifact passes between them"
                      }
                    >
                      {d.consumes ? "artifact" : "ordering"}
                    </Badge>
                    {isProtected ? (
                      <Badge tone="violet" title="Protected by a constraint">
                        locked
                      </Badge>
                    ) : (
                      <button
                        onClick={() => onDelete(d.from_task, d.to_task)}
                        disabled={busy}
                        className="text-dim hover:text-red"
                      >
                        ×
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 items-end pt-3 border-t border-line">
            <Field label="This must finish">
              <Select value={from} onChange={(e) => setFrom(e.target.value)}>
                <option value="">choose…</option>
                {workflow.tasks.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.key} · {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="before this starts">
              <Select value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">choose…</option>
                {workflow.tasks
                  .filter((t) => t.key !== from)
                  .map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.key} · {t.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field
              label="Kind"
              hint="artifact edges carry requirement changes"
            >
              <Select
                value={consumes ? "artifact" : "ordering"}
                onChange={(e) => setConsumes(e.target.value === "artifact")}
              >
                <option value="artifact">Artifact — it uses the output</option>
                <option value="ordering">Ordering only</option>
              </Select>
            </Field>
            <Button
              onClick={() => {
                if (from && to) {
                  onCreate({ from_task: from, to_task: to, consumes });
                  setFrom("");
                  setTo("");
                }
              }}
              disabled={busy || !from || !to}
            >
              Add dependency
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
