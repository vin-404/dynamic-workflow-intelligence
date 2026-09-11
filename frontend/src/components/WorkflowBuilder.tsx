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
 *
 * Wave 2, presentation only: three headed sections instead of three cards,
 * and the work is a table rather than a stack of full-width inputs. The
 * editing behaviour is untouched - every control is the same control, patched
 * on the same blur, with the same request.
 *
 * The table cells hold real inputs, drawn without their borders until they
 * are hovered or focused. That is a deliberate divergence from the shadcn
 * `Input` default: seventeen rows of outlined boxes reads as a form, and the
 * point of this table is that it reads as data you can type into.
 *
 * Design pass (brief §1 Build, §4 Build): resources are two-line cards that
 * wrap rather than clip; a task's constraint chips sit under the name input
 * instead of beside it; every label goes through the display map; type sits
 * on the four-step scale. Nothing here changes a request.
 */

import { useMemo, useState } from "react";
import { Lock, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  constraintKindLabel,
  edgeKindLabel,
  resourceKindLabel,
  statusLabel,
} from "@/lib/display";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ErrorNote, days } from "./ui";

const STATUSES = ["not_started", "in_progress", "in_review", "blocked", "done"];

/**
 * Radix's Select refuses an empty string as an item value, and the previous
 * native `<select>`s used `""` for "nothing chosen". This is that sentinel;
 * it never leaves the component - state still holds `""`.
 */
const NONE = "__none__";

/** One inline icon size across every panel. */
const ICON = "size-3.5 shrink-0";

/**
 * A constraint on record, not a status.
 *
 * `violet` used to carry this - a constraint badge in a fourth hue, next to
 * three severity states. It is distinguished by *form* now: a bordered chip
 * on the inset surface, in the display map's words ("Mandatory", "Cannot be
 * split"), so the token can be deleted.
 */
const TOKEN =
  "inline-flex items-center rounded border border-line bg-panel2 px-1.5 py-0.5 text-[12px] text-dim";

/** A borderless cell input: the border arrives on hover and focus. */
const CELL =
  "h-7 rounded-md border-transparent bg-transparent px-1.5 text-[14px] " +
  "hover:border-input focus-visible:border-ring " +
  "dark:bg-transparent dark:disabled:bg-transparent";

/** The same idea for a cell's select trigger. */
const CELL_TRIGGER =
  "h-7 w-full justify-between border-transparent bg-transparent px-1.5 " +
  "text-[14px] hover:border-input focus-visible:border-ring dark:bg-transparent " +
  "dark:hover:bg-transparent";

/** What each task-level constraint means, for a chip's hover text. */
const CONSTRAINT_HINT: Record<string, string> = {
  MANDATORY_TASK: "No proposal may remove this task",
  NON_DIVISIBLE_TASK: "No proposal may split this task across people",
  FIXED_ASSIGNMENT: "No proposal may reassign this task",
  MIN_DURATION: "No proposal may shorten this task below its minimum",
};

function nextTaskKey(workflow: Workflow): string {
  const numbers = workflow.tasks
    .map((t) => /^T(\d+)$/.exec(t.key)?.[1])
    .filter(Boolean)
    .map((n) => parseInt(n as string, 10));
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  return `T${String(next).padStart(2, "0")}`;
}

/* ------------------------------------------------------------ small parts */

/** A section heading. Typography carries it; there is no box. */
function Head({
  title,
  count,
  note,
}: {
  title: string;
  count: number;
  note?: string;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <h2 className="text-[18px] font-semibold">{title}</h2>
      <span className="font-mono text-[12px] text-dim">{count}</span>
      {note && <span className="text-[12px] text-dim">{note}</span>}
    </div>
  );
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
      {hint && <span className="text-[12px] leading-none text-dim">{hint}</span>}
    </label>
  );
}

/** A row-level remove control. Dim until you are near it. */
function Remove({
  onClick,
  disabled,
  label,
  title,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title ?? label}
      className="text-dim transition-colors hover:text-severity-high disabled:opacity-40"
    >
      <X className={ICON} />
    </button>
  );
}

/* ------------------------------------------------------------------- main */

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
    <div className="flex flex-col gap-6">
      {error && (
        <ErrorNote
          onRetry={() => setError(null)}
          hint={error.hint}
          requestId={error.requestId}
        >
          <p>{error.userMessage}</p>
          {error.cycles && (
            <p className="mt-1 font-mono text-[12px] text-severity-medium">
              {error.cycles[0].join(" → ")} → {error.cycles[0][0]}
            </p>
          )}
          {error.constraint && (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-[12px]">
              <span className={TOKEN}>
                {constraintKindLabel(error.constraint.constraint)}
              </span>
              <span className="text-dim">
                {error.constraint.constraint_reason}
              </span>
            </p>
          )}
        </ErrorNote>
      )}

      {/* The order matches the stage's own subtitle - who does the work, then
          the work, then what waits on what - so it is not reshuffled here. */}
      <ResourcePanel
        workflow={workflow}
        busy={busy}
        onCreate={(body) => run(() => createResource(projectId, body))}
        onDelete={(key) => run(() => deleteResource(projectId, key))}
      />

      <Separator />

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

      <Separator />

      <DependencyPanel
        workflow={workflow}
        busy={busy}
        onCreate={(body) => run(() => createDependency(projectId, body))}
        onDelete={(from, to) => run(() => deleteDependency(projectId, from, to))}
      />
    </div>
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

  const totalEffort =
    Math.round(workflow.tasks.reduce((n, t) => n + t.effort, 0) * 10) / 10;

  return (
    <section>
      <Head
        title="The work"
        count={workflow.tasks.length}
        note={
          workflow.tasks.length
            ? `${days(totalEffort)} of effort in total`
            : undefined
        }
      />

      {workflow.tasks.length === 0 ? (
        <p className="max-w-2xl text-[14px] text-dim">
          Add the first piece of work below. Effort is the amount of work in
          days, not the elapsed time — the engine derives duration from effort
          and who is on it, and it will not pretend two people halve a task.
        </p>
      ) : (
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {[
                ["Key", "w-14"],
                ["Task", ""],
                ["Effort", "w-20"],
                ["Divisible", "w-24"],
                ["Status", "w-32"],
                ["Assignees", "w-64"],
              ].map(([label, width]) => (
                <TableHead
                  key={label}
                  className={cn(
                    "h-7 px-1.5 text-[12px] font-medium tracking-wider text-dim uppercase",
                    width,
                  )}
                >
                  {label}
                </TableHead>
              ))}
              <TableHead className="h-7 w-8 px-1.5" />
            </TableRow>
          </TableHeader>
          <TableBody>
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
          </TableBody>
        </Table>
      )}

      <div className="mt-4 grid grid-cols-1 items-end gap-2 sm:grid-cols-6">
        <Lbl label="New task" className="sm:col-span-2">
          <Input
            value={name}
            placeholder="Draft the budget…"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </Lbl>
        <Lbl label="Effort" hint="days of work">
          <Input
            type="number"
            min={0}
            step={0.5}
            value={effort}
            onChange={(e) => setEffort(Number(e.target.value))}
          />
        </Lbl>
        <Lbl label="Divisible" hint="can more people help?">
          <Select
            value={divisible ? "yes" : "no"}
            onValueChange={(v) => setDivisible(v === "yes")}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="yes">Yes</SelectItem>
                <SelectItem value="no">No — one signature</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Lbl>
        <Lbl label="Assign to">
          <Select
            value={assignee || NONE}
            onValueChange={(v) => setAssignee(v === NONE ? "" : v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={NONE}>nobody yet</SelectItem>
                {workflow.resources.map((r) => (
                  <SelectItem key={r.key} value={r.key}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Lbl>
        <Button onClick={submit} disabled={busy || !name.trim()}>
          Add task
        </Button>
      </div>

      {templates && templates.length > 0 && workflow.tasks.length === 0 && (
        <details className="mt-3 text-[12px]">
          <summary className="cursor-pointer text-accent">
            Start from this domain&apos;s templates ({templates.length})
          </summary>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {templates.map((t) => (
              <Button
                key={t.name}
                variant="outline"
                size="xs"
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
          <p className="mt-2 text-[12px] text-dim">
            Templates are suggestions from the domain you picked. They fill the
            form; nothing is added until you press Add task.
          </p>
        </details>
      )}
    </section>
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
  const [name, setName] = useState(String(task.name));
  const [effort, setEffort] = useState(String(task.effort));
  const mandatory = constraints.includes("MANDATORY_TASK");
  const locked = constraints.includes("NON_DIVISIBLE_TASK");
  const chips = Array.from(new Set(constraints));
  const unassigned = workflow.resources.filter(
    (r) => !task.assignees.some((a) => a.key === r.key),
  );

  return (
    <TableRow className="border-line/60">
      <TableCell className="px-1.5 py-1 align-top font-mono text-[12px] leading-7 text-dim">
        {task.key}
      </TableCell>
      <TableCell className="px-1.5 py-1 align-top">
        {/* The name keeps the whole column. Constraint chips, when there are
            any, take a second line beneath it - never a slice of the input. */}
        <div className="flex flex-col gap-1">
          <Input
            value={name}
            disabled={busy}
            aria-label={`Name of ${task.key}`}
            className={CELL}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name !== task.name && onPatch(task.key, { name })}
          />
          {chips.length > 0 && (
            <div className="flex flex-wrap gap-1 px-1.5 pb-0.5">
              {chips.map((kind) => (
                <span
                  key={kind}
                  className={TOKEN}
                  title={CONSTRAINT_HINT[kind]}
                >
                  {constraintKindLabel(kind)}
                </span>
              ))}
            </div>
          )}
        </div>
      </TableCell>
      <TableCell className="px-1.5 py-1 align-top">
        <Input
          type="number"
          min={0}
          step={0.5}
          value={effort}
          disabled={busy}
          aria-label={`Effort of ${task.key}`}
          className={CELL}
          onChange={(e) => setEffort(e.target.value)}
          onBlur={() =>
            Number(effort) !== task.effort &&
            onPatch(task.key, { effort: Number(effort) })
          }
        />
      </TableCell>
      <TableCell className="px-1.5 py-1 align-top">
        <Select
          value={task.divisible ? "yes" : "no"}
          disabled={busy || locked}
          onValueChange={(v) => onPatch(task.key, { divisible: v === "yes" })}
        >
          <SelectTrigger
            size="sm"
            aria-label={`Divisible: ${task.key}`}
            title={
              locked ? "A constraint fixes this task as indivisible" : undefined
            }
            className={CELL_TRIGGER}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="yes">Yes</SelectItem>
              <SelectItem value="no">No</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell className="px-1.5 py-1 align-top">
        <Select
          value={task.status}
          disabled={busy}
          onValueChange={(v) => onPatch(task.key, { status: v })}
        >
          <SelectTrigger
            size="sm"
            aria-label={`Status of ${task.key}`}
            className={CELL_TRIGGER}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {statusLabel(s)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell className="px-1.5 py-1 align-top">
        <div className="flex min-h-7 flex-wrap items-center gap-1">
          {task.assignees.map((a) => (
            <span
              key={a.key}
              className="inline-flex items-center gap-1 rounded-full border border-line bg-panel2 py-0.5 pr-1.5 pl-2 text-[12px] text-foreground"
            >
              {a.label}
              <Remove
                onClick={() => onUnassign(task.key, a.key)}
                disabled={busy}
                label={`Unassign ${a.label} from ${task.key}`}
              />
            </span>
          ))}
          <Select
            value={NONE}
            disabled={busy || unassigned.length === 0}
            onValueChange={(v) => v !== NONE && onAssign(task.key, v)}
          >
            {/* A small round "+" rather than the word "add…": the chips are
                the content of this cell, the button is how one more arrives.
                Same Select, same picker, same request. */}
            <SelectTrigger
              size="sm"
              aria-label="Add an assignee"
              title={
                workflow.resources.length
                  ? `Assign someone to ${task.key}`
                  : "Add a resource first"
              }
              className={cn(
                CELL_TRIGGER,
                "w-6 justify-center rounded-full border-line p-0 text-dim",
                "data-[size=sm]:h-6 data-[size=sm]:rounded-full",
                "hover:text-foreground [&>svg:last-child]:hidden",
              )}
            >
              <Plus className={ICON} aria-hidden />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={NONE}>
                  {workflow.resources.length
                    ? "Choose someone…"
                    : "Add a resource first"}
                </SelectItem>
                {unassigned.map((r) => (
                  <SelectItem key={r.key} value={r.key}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </TableCell>
      <TableCell className="px-1.5 py-1 align-top leading-7">
        <Remove
          onClick={() => onDelete(task.key)}
          disabled={busy}
          label={`Delete ${task.key}`}
          title={mandatory ? "This task is mandatory" : "Delete task"}
        />
      </TableCell>
    </TableRow>
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
    const key = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 30);
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
    <section>
      <Head
        title="Who and what does the work"
        count={workflow.resources.length}
      />

      {workflow.resources.length === 0 ? (
        <p className="max-w-2xl text-[14px] text-dim">
          Nothing is assignable yet. A resource is a person, a team, a machine
          or a budget line — the engine only ever sees a name, a kind and a
          capacity, which is what keeps it domain-agnostic.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {/* Two lines, one card each: the name, then the meta. The rows
              share a height through the grid; the meta wraps rather than
              clips when a team name runs long. */}
          {workflow.resources.map((r) => {
            const parent = r.parent_key
              ? workflow.resources.find((p) => p.key === r.parent_key)?.name
              : null;
            return (
              <li
                key={r.key}
                className="flex min-h-[3.5rem] items-start gap-2 rounded-xl border border-line bg-panel px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] leading-5 font-medium break-words">
                    {r.name}
                  </div>
                  <div className="text-[12px] leading-4 text-dim">
                    {resourceKindLabel(r.kind)} · capacity {r.capacity}
                    {parent ? ` · in ${parent}` : ""}
                  </div>
                </div>
                <Remove
                  onClick={() => onDelete(r.key)}
                  disabled={busy}
                  label={`Remove ${r.name}`}
                  title="Remove"
                />
              </li>
            );
          })}
        </ul>
      )}

      {/* Five controls, each in its own column, so "Belongs to" has a column
          of its own instead of sharing one with the button and wrapping. */}
      <div className="mt-4 grid grid-cols-1 items-end gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <Lbl label="Name">
          <Input
            value={name}
            placeholder="Priya, Marketing, Test rig…"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </Lbl>
        <Lbl label="Kind">
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="person">{resourceKindLabel("person")}</SelectItem>
                <SelectItem value="team">{resourceKindLabel("team")}</SelectItem>
                <SelectItem value="equipment">
                  {resourceKindLabel("equipment")}
                </SelectItem>
                <SelectItem value="budget">{resourceKindLabel("budget")}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Lbl>
        <Lbl label="Capacity" hint="How many at once">
          <Input
            type="number"
            min={0}
            value={capacity}
            onChange={(e) => setCapacity(Number(e.target.value))}
          />
        </Lbl>
        <Lbl label="Belongs to">
          <Select
            value={parent || NONE}
            onValueChange={(v) => setParent(v === NONE ? "" : v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={NONE}>—</SelectItem>
                {teams.map((t) => (
                  <SelectItem key={t.key} value={t.key}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Lbl>
        <Button onClick={submit} disabled={busy || !name.trim()}>
          Add resource
        </Button>
      </div>
      <p className="mt-2 text-[12px] text-dim">
        A team&apos;s capacity can be lower than its headcount — that gap is
        how a bottleneck gets found.
      </p>
    </section>
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

  const artifacts = workflow.dependencies.filter((d) => d.consumes).length;

  return (
    <section>
      <Head
        title="What waits on what"
        count={workflow.dependencies.length}
        note={
          workflow.dependencies.length
            ? `${artifacts} carry an artifact, ${
                workflow.dependencies.length - artifacts
              } are ordering only`
            : undefined
        }
      />

      {workflow.tasks.length < 2 ? (
        <p className="text-[14px] text-dim">
          Add at least two tasks and you can draw the order between them.
        </p>
      ) : (
        <>
          {workflow.dependencies.length === 0 ? (
            <p className="max-w-2xl text-[14px] text-dim">
              Nothing depends on anything yet, so every task starts on day one.
              That is rarely the real plan.
            </p>
          ) : (
            <ul className="max-h-72 overflow-y-auto">
              {workflow.dependencies.map((d) => {
                const isProtected = protectedEdges.has(
                  `${d.from_task}->${d.to_task}`,
                );
                return (
                  <li
                    key={`${d.from_task}-${d.to_task}`}
                    className="flex items-center gap-3 border-b border-line/50 py-1.5 text-[14px] hover:bg-panel2/60"
                  >
                    <span className="w-24 shrink-0 font-mono text-[12px] text-dim">
                      {d.from_task} → {d.to_task}
                    </span>
                    <span className="min-w-0 flex-1 text-[14px]">
                      {nameOf(d.from_task)} before {nameOf(d.to_task)}
                    </span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className={cn(
                            "shrink-0 text-[12px]",
                            d.consumes ? "text-foreground" : "text-dim",
                          )}
                        >
                          {edgeKindLabel(d.consumes)}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {d.consumes
                          ? "Artifact: the successor consumes what this produces, so a requirement change invalidates it"
                          : "Ordering only: no artifact passes between them"}
                      </TooltipContent>
                    </Tooltip>
                    {isProtected ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className={cn(TOKEN, "shrink-0 gap-1")}>
                            <Lock className={ICON} />
                            {constraintKindLabel("IMMUTABLE_DEPENDENCY")}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          Protected by a constraint
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <Remove
                        onClick={() => onDelete(d.from_task, d.to_task)}
                        disabled={busy}
                        label={`Remove ${d.from_task} to ${d.to_task}`}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {/* The kind column is sized for its longest item, "Artifact — it
              uses the output", so the chosen value is never clipped; the two
              task pickers share what is left. */}
          <div className="mt-4 grid grid-cols-1 items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,16rem)_auto]">
            <Lbl label="This must finish">
              <Select
                value={from || NONE}
                onValueChange={(v) => setFrom(v === NONE ? "" : v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={NONE}>choose…</SelectItem>
                    {workflow.tasks.map((t) => (
                      <SelectItem key={t.key} value={t.key}>
                        {t.key} · {t.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Lbl>
            <Lbl label="before this starts">
              <Select
                value={to || NONE}
                onValueChange={(v) => setTo(v === NONE ? "" : v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={NONE}>choose…</SelectItem>
                    {workflow.tasks
                      .filter((t) => t.key !== from)
                      .map((t) => (
                        <SelectItem key={t.key} value={t.key}>
                          {t.key} · {t.name}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Lbl>
            <Lbl label="Kind" hint="artifact edges carry requirement changes">
              <Select
                value={consumes ? "artifact" : "ordering"}
                onValueChange={(v) => setConsumes(v === "artifact")}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="artifact">
                      Artifact — it uses the output
                    </SelectItem>
                    <SelectItem value="ordering">Ordering only</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Lbl>
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
    </section>
  );
}
