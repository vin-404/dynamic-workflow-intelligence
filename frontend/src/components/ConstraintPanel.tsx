"use client";

/**
 * Constraints: what may not be optimised away, declared by the person who
 * knows why.
 *
 * The optimizer refuses any candidate that breaks one of these and quotes
 * the constraint and the reason on record. The refusals were on screen; the
 * declaring was not. `POST /api/projects/{id}/constraints` existed and the
 * client for it was called from nowhere, so a user could only inherit the
 * constraints a fixture shipped with.
 *
 * The five kinds come from `ConstraintIn` in `backend/app/schemas/
 * authoring.py` - `ConstraintKind` in `core/workflow.py` is the closed enum.
 * Each has a plain-language label here; the identifier on record sits in the
 * chip's hover text, because that is what the optimizer's refusal quotes.
 *
 * The reason is required by this composer even though the API allows it to
 * be empty. A constraint with no reason is a rule nobody can argue with,
 * and the reason is what the refusal shows the reader - it is the feature.
 *
 * Removing a constraint is `DELETE .../constraints/{kind}/{target}` on the
 * draft; like every authoring write it needs the editor role, and a viewer
 * gets the API's refusal, not a hidden button. Everything here writes to the
 * draft version and hands the returned workflow back through `onChange`,
 * exactly as the builder above does.
 */

import { useState } from "react";
import { ChevronDown, X } from "lucide-react";
import {
  ApiError,
  Constraint,
  Workflow,
  createConstraint,
  deleteConstraint,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { constraintKindLabel } from "@/lib/display";
import { ErrorNote, Textarea } from "./ui";

const ICON = "size-3.5 shrink-0";
const LABEL = "text-[12px] font-medium uppercase tracking-wider text-dim";
/** A constraint id on record, not a status - the same chip the builder uses. */
const TOKEN =
  "rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[12px]";
const CONTROL =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm " +
  "outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 " +
  "focus-visible:ring-ring/50 dark:bg-input/30";

/**
 * The closed set, from `ConstraintKind`. `targets` says what the target names:
 * a task, a dependency written FROM->TO, or an assignment written TASK or
 * TASK:RESOURCE (the gate accepts either - see `_v_assignment_remove`).
 */
type KindSpec = {
  kind: string;
  label: string;
  what: string;
  targets: "task" | "dependency" | "assignment";
  needsValue?: { label: string; unit: string };
};

const KINDS: KindSpec[] = [
  {
    kind: "MANDATORY_TASK",
    label: "This task is mandatory",
    what: "No candidate may remove it, and the authoring API refuses to delete it.",
    targets: "task",
  },
  {
    kind: "IMMUTABLE_DEPENDENCY",
    label: "This dependency cannot be removed",
    what: "The order it enforces is a fact about the work, not a scheduling choice.",
    targets: "dependency",
  },
  {
    kind: "NON_DIVISIBLE_TASK",
    label: "This work cannot be split across people",
    what: "More hands do not make it faster; a split proposal is refused.",
    targets: "task",
  },
  {
    kind: "FIXED_ASSIGNMENT",
    label: "This assignment is fixed",
    what: "The task stays with who has it; reassignment proposals are refused. Name the task alone to fix every assignment on it, or one person.",
    targets: "assignment",
  },
  {
    kind: "MIN_DURATION",
    label: "This task has a minimum duration",
    what: "Effort cannot be set below this many days, however the plan is rearranged.",
    targets: "task",
    needsValue: { label: "Minimum", unit: "days" },
  },
];

function NativeSelect({
  label,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className={LABEL}>{label}</span>
      <span className="relative block">
        <select {...props} className={cn(CONTROL, "appearance-none pr-7")}>
          {children}
        </select>
        <ChevronDown
          className={cn(
            ICON,
            "pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-dim",
          )}
          aria-hidden
        />
      </span>
    </label>
  );
}

/** The target, in the reader's words, from the workflow it names. */
function describeTarget(c: Constraint, workflow: Workflow): string {
  if (c.kind === "IMMUTABLE_DEPENDENCY") {
    const [from, to] = c.target.split("->");
    const f = workflow.tasks.find((t) => t.key === from);
    const t = workflow.tasks.find((x) => x.key === to);
    return `${f?.name ?? from} → ${t?.name ?? to}`;
  }
  if (c.kind === "FIXED_ASSIGNMENT" && c.target.includes(":")) {
    const [task, res] = c.target.split(":");
    const t = workflow.tasks.find((x) => x.key === task);
    const r = workflow.resources.find((x) => x.key === res);
    return `${t?.name ?? task} stays with ${r?.name ?? res}`;
  }
  const t = workflow.tasks.find((x) => x.key === c.target);
  return t?.name ?? c.target;
}

export default function ConstraintPanel({
  workflow,
  onChange,
}: {
  workflow: Workflow;
  onChange: (next: Workflow) => void;
}) {
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const [kind, setKind] = useState(KINDS[0].kind);
  const [task, setTask] = useState("");
  const [dependency, setDependency] = useState("");
  const [resource, setResource] = useState("");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");

  const spec = KINDS.find((k) => k.kind === kind) ?? KINDS[0];

  async function run(action: () => Promise<Workflow>) {
    setBusy(true);
    setError(null);
    try {
      onChange(await action());
      return true;
    } catch (e) {
      if (e instanceof ApiError) setError(e);
      else throw e;
      return false;
    } finally {
      setBusy(false);
    }
  }

  const target =
    spec.targets === "dependency"
      ? dependency
      : spec.targets === "assignment"
        ? resource
          ? `${task}:${resource}`
          : task
        : task;

  /** Why "Declare" is unavailable, in the reader's words, or null. */
  const blocked = ((): string | null => {
    if (!target) {
      return spec.targets === "dependency"
        ? workflow.dependencies.length === 0
          ? "this workflow has no dependencies to protect"
          : "choose a dependency"
        : workflow.tasks.length === 0
          ? "this workflow has no tasks yet"
          : "choose a task";
    }
    if (spec.needsValue && !(Number(value) > 0)) {
      return "the minimum has to be more than zero days";
    }
    if (!reason.trim()) return "say why - the reason is what a refusal quotes";
    return null;
  })();

  async function declare() {
    const ok = await run(() =>
      createConstraint(workflow.project_id, {
        kind,
        target,
        reason: reason.trim(),
        ...(spec.needsValue ? { value: Number(value) } : {}),
      }),
    );
    if (ok) {
      setReason("");
      setValue("");
    }
  }

  const assignedTo = workflow.tasks.find((t) => t.key === task)?.assignees ?? [];

  return (
    <section className="flex flex-col gap-4">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 className="text-sm font-medium">What may not be optimised away</h2>
        <span className="font-mono text-[12px] text-dim">
          {workflow.constraints.length}
        </span>
        <span className="text-[12px] text-dim">
          Declared here, enforced on every proposal - the optimizer, a what-if,
          a sentence - and quoted back with your reason when one is refused.
        </span>
      </div>

      {error && (
        <ErrorNote
          onRetry={() => setError(null)}
          hint={error.hint}
          requestId={error.requestId}
        >
          <p>{error.userMessage}</p>
        </ErrorNote>
      )}

      {/* ------------------------------------------------------ on record */}
      {workflow.constraints.length === 0 ? (
        <p className="text-sm text-dim">
          No constraints on record. Until one is declared, every task can be
          removed, split or reassigned by a proposal, and every dependency can
          be dropped.
        </p>
      ) : (
        <ul className="divide-y divide-border/60 border-y border-border/60">
          {workflow.constraints.map((c) => (
            <li
              key={`${c.kind}:${c.target}`}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm"
            >
              <span className={TOKEN} title={c.kind}>
                {constraintKindLabel(c.kind)}
              </span>
              <span className="font-mono text-xs">{c.target}</span>
              <span className="text-[13px]">{describeTarget(c, workflow)}</span>
              {c.value !== null && (
                <span className="text-xs text-dim">≥ {c.value} days</span>
              )}
              <span className="min-w-0 flex-1 text-xs text-dim">
                {c.reason || "no reason recorded"}
              </span>
              <button
                type="button"
                disabled={busy}
                aria-label={`Remove constraint ${constraintKindLabel(c.kind)} on ${c.target}`}
                title="Remove this constraint from the draft"
                onClick={() =>
                  run(() =>
                    deleteConstraint(workflow.project_id, c.kind, c.target),
                  )
                }
                className="text-dim transition-colors hover:text-severity-high disabled:opacity-40"
              >
                <X className={ICON} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* ------------------------------------------------------- declare */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[16rem] flex-1">
            <NativeSelect
              label="Declare"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              {KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </NativeSelect>
          </div>

          {spec.targets !== "dependency" && (
            <div className="min-w-[13rem] flex-1">
              <NativeSelect
                label="Task"
                value={task}
                onChange={(e) => {
                  setTask(e.target.value);
                  setResource("");
                }}
              >
                <option value="">choose…</option>
                {workflow.tasks.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.key} · {t.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}

          {spec.targets === "dependency" && (
            <div className="min-w-[16rem] flex-1">
              <NativeSelect
                label="Dependency"
                value={dependency}
                onChange={(e) => setDependency(e.target.value)}
              >
                <option value="">choose…</option>
                {workflow.dependencies.map((d) => (
                  <option
                    key={`${d.from_task}->${d.to_task}`}
                    value={`${d.from_task}->${d.to_task}`}
                  >
                    {d.from_task} → {d.to_task}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}

          {spec.targets === "assignment" && (
            <div className="min-w-[12rem] flex-1">
              <NativeSelect
                label="Who (optional)"
                value={resource}
                onChange={(e) => setResource(e.target.value)}
                disabled={!task}
              >
                <option value="">everyone assigned</option>
                {assignedTo.map((a) => (
                  <option key={a.key} value={a.key}>
                    {a.key} · {a.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}

          {spec.needsValue && (
            <label className="flex w-28 flex-col gap-1">
              <span className={LABEL}>
                {spec.needsValue.label} ({spec.needsValue.unit})
              </span>
              <Input
                type="number"
                min={0}
                step={0.5}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
          )}
        </div>

        <p className="max-w-3xl text-xs text-dim">
          <span className={cn(TOKEN, "mr-1.5")} title={spec.kind}>
            {constraintKindLabel(spec.kind)}
          </span>
          {spec.what}
        </p>

        <label className="flex max-w-3xl flex-col gap-1">
          <span className={LABEL}>Because</span>
          <Textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="The reason on record. This is what a refused proposal will quote back."
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || blocked !== null}
            onClick={declare}
          >
            {busy ? "Writing…" : "Declare this constraint"}
          </Button>
          {blocked && <span className="text-[12px] text-dim">{blocked}</span>}
          {!blocked && (
            <span className="text-[12px] text-dim">
              Writes to the draft version. Needs the editor role.
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
