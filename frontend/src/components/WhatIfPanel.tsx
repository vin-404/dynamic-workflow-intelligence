"use client";

/**
 * Capability 3 - what-if, without touching the real workflow.
 *
 * The user composes a list of typed mutations from the closed algebra the
 * backend publishes, evaluates it, and sees a before/after diff. The panel
 * shows the base version's content hash before and after evaluation, because
 * "the original workflow is provably unchanged" should be something the user
 * can read off the screen rather than take on trust.
 *
 * A refused mutation shows the reason and, where a constraint caused it, the
 * constraint and the reason on record.
 *
 * By default a simulation is discarded once read (`keep: false`), exactly as
 * before. "Keep it as a saved scenario" is an opt-in that stores the scenario
 * so it appears in the list on this stage; the host is told through `onKept`
 * so that list can refresh. Nothing about evaluation changes either way.
 *
 * The selects here are deliberately native `<select>` elements. The browser
 * walkthroughs index into `page.locator("select")` by position and drive them
 * with `selectOption`, which a button-and-listbox Select cannot answer; and a
 * dense composer wants the OS control anyway.
 */

import { useState } from "react";
import { ChevronDown, LoaderCircle, X } from "lucide-react";
import {
  ApiError,
  MutationIn,
  SimulationResponse,
  Workflow,
  whatIf,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { describeMutation } from "@/lib/display";
import DiffView from "./DiffView";
import MutationVocabulary from "./MutationVocabulary";
import { ErrorNote } from "./ui";

/** One inline icon size across every panel. */
const ICON = "size-3.5 shrink-0";
const LABEL = "text-[12px] font-medium uppercase tracking-wider text-dim";
/** A native control that matches the shadcn `Input` it sits beside. */
const CONTROL =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm " +
  "outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 " +
  "focus-visible:ring-ring/50 dark:bg-input/30";

/** The handful of questions a person actually asks, as mutation builders. */
type Recipe = {
  id: string;
  label: string;
  needs: ("task" | "resource" | "days" | "parts" | "window")[];
  build: (a: Record<string, string>) => MutationIn[];
  describe: (a: Record<string, string>) => string;
};

const RECIPES: Recipe[] = [
  {
    id: "delay",
    label: "A task slips",
    needs: ["task", "days"],
    build: (a) => [
      {
        kind: "TASK_DELAY_ADD",
        payload: { key: a.task, extra_days: Number(a.days) },
      },
    ],
    describe: (a) => `${a.task} takes ${a.days} more day(s) than it looks like`,
  },
  {
    id: "away",
    label: "Someone is unavailable",
    needs: ["resource", "window"],
    build: (a) => [
      {
        kind: "RESOURCE_UNAVAILABLE_WINDOW",
        payload: {
          resource_key: a.resource,
          from_day: Number(a.from_day),
          to_day: Number(a.to_day),
        },
      },
    ],
    describe: (a) =>
      `${a.resource} is away from day ${a.from_day} to day ${a.to_day}`,
  },
  {
    id: "split",
    label: "Put more people on a task",
    needs: ["task", "parts"],
    build: (a) => [
      {
        kind: "TASK_SPLIT",
        payload: { key: a.task, parts: Number(a.parts) },
      },
    ],
    describe: (a) => `${a.task} is split across ${a.parts} people`,
  },
  {
    id: "capacity",
    label: "Change a team's capacity",
    needs: ["resource", "parts"],
    build: (a) => [
      {
        kind: "RESOURCE_CAPACITY_SET",
        payload: { resource_key: a.resource, capacity: Number(a.parts) },
      },
    ],
    describe: (a) => `${a.resource} can run ${a.parts} task(s) at once`,
  },
  {
    id: "drop_dep",
    label: "Stop one task waiting on another",
    needs: ["task", "resource"],
    build: (a) => [
      {
        kind: "DEPENDENCY_REMOVE",
        payload: { from_task: a.task, to_task: a.resource },
      },
    ],
    describe: (a) => `${a.resource} no longer waits for ${a.task}`,
  },
];

export default function WhatIfPanel({
  workflow,
  onKept,
}: {
  workflow: Workflow;
  /** Fired after a simulation that was asked to be kept has been stored. */
  onKept?: () => void;
}) {
  const [pending, setPending] = useState<
    { mutation: MutationIn; label: string }[]
  >([]);
  const [result, setResult] = useState<SimulationResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [keep, setKeep] = useState(false);

  async function evaluate() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await whatIf(
          workflow.project_id,
          pending.map((p) => p.mutation),
          { name: pending.map((p) => p.label).join("; "), keep },
        ),
      );
      if (keep) {
        try {
          onKept?.();
        } catch {
          /* The list's refresh is not this panel's correctness. */
        }
      }
    } catch (e) {
      if (e instanceof ApiError) setError(e);
      else throw e;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border pb-1.5">
          <h2 className="text-[13px] font-semibold tracking-tight">
            Ask a hypothetical
          </h2>
          <span className="text-[12px] text-dim">
            {workflow.tasks.length} tasks · {workflow.resources.length} resources
          </span>
        </div>

        <RecipeForm
          workflow={workflow}
          onAdd={(mutation, label) =>
            setPending([...pending, { mutation, label }])
          }
        />

        {/* Each question above is one kind from a closed, published set.
            Naming the set here is what makes "validated before it runs" a
            claim the reader can check. */}
        <MutationVocabulary
          className="mt-2"
          highlight={pending.map((p) => p.mutation.kind)}
        />

        {pending.length > 0 && (
          <div className="mt-4">
            {/* A sentence, not a column head, so it is not shouted in
                small caps: it is the integrity claim for this panel. */}
            <div className="mb-1.5 text-[12px] text-dim">
              These changes, in order — nothing is written to your workflow:
            </div>
            <ol className="mb-3 max-w-3xl divide-y divide-border/60 border-y border-border/60">
              {pending.map((p, i) => (
                <li
                  key={i}
                  className="flex items-center gap-2 py-1 text-[13px]"
                >
                  <span className="w-4 shrink-0 text-right text-[12px] text-dim">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{p.label}</span>
                  <span className="text-[12px] text-dim" title={p.mutation.kind}>
                    {describeMutation(p.mutation)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove change ${i + 1}`}
                    onClick={() =>
                      setPending(pending.filter((_, j) => j !== i))
                    }
                  >
                    <X aria-hidden />
                  </Button>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={evaluate} disabled={busy}>
                Simulate
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setPending([]);
                  setResult(null);
                  setError(null);
                }}
              >
                Clear
              </Button>
              <label className="ml-1 flex items-center gap-1.5 text-xs text-dim">
                <input
                  type="checkbox"
                  checked={keep}
                  onChange={(e) => setKeep(e.target.checked)}
                  className="accent-primary"
                />
                keep it as a saved scenario
              </label>
            </div>
          </div>
        )}
      </section>

      {busy && (
        <div className="flex items-center gap-1.5 text-xs text-dim">
          <LoaderCircle className={cn(ICON, "animate-spin")} aria-hidden />
          Evaluating against an in-memory copy…
        </div>
      )}

      {error && (
        <ErrorNote hint={error.hint} requestId={error.requestId}>
          <p>{error.userMessage}</p>
          {error.constraint && (
            <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-xs">
              <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[12px]">
                {error.constraint.constraint}
              </span>
              <span className="text-dim">
                {error.constraint.constraint_reason}
              </span>
            </p>
          )}
          <p className="mt-2 text-xs text-dim">
            Nothing was changed. A refusal is the system declining to model
            something it has been told is not allowed.
          </p>
        </ErrorNote>
      )}

      {result && <DiffView result={result} />}
    </div>
  );
}

/* ------------------------------------------------------------- the composer */

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

function NumberField({
  label,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="flex w-24 flex-col gap-1">
      <span className={LABEL}>{label}</span>
      <Input type="number" {...props} />
    </label>
  );
}

function RecipeForm({
  workflow,
  onAdd,
}: {
  workflow: Workflow;
  onAdd: (mutation: MutationIn, label: string) => void;
}) {
  const [recipeId, setRecipeId] = useState(RECIPES[0].id);
  const [args, setArgs] = useState<Record<string, string>>({
    days: "5",
    parts: "2",
    from_day: String(Math.round(workflow.today_day)),
    to_day: String(Math.round(workflow.today_day) + 7),
  });

  const recipe = RECIPES.find((r) => r.id === recipeId)!;
  const set = (k: string, v: string) => setArgs({ ...args, [k]: v });

  /**
   * Why "Add change" is unavailable, in the user's words, or `null`.
   *
   * The original guard only asked whether each field had *something* in it,
   * so three shapes of nonsense reached the engine and came back as a
   * refusal: an unavailability window that ends before it starts, and a
   * "stop one task waiting on another" naming the same task twice, which is
   * an edge that cannot exist. A refusal is a good thing when the system
   * declined something meaningful; spending one on a form the composer could
   * have caught teaches the reader to discount them.
   */
  const blocked = ((): string | null => {
    for (const need of recipe.needs) {
      if (need === "task" && !args.task) return "choose a task";
      if (need === "resource" && !args.resource) {
        return recipeId === "drop_dep"
          ? "choose the task that would stop waiting"
          : workflow.resources.length === 0
            ? "this workflow has nobody to be unavailable"
            : "choose who";
      }
      if (need === "days" && !(Number(args.days) > 0)) {
        return "the delay has to be more than zero days";
      }
      if (need === "parts" && !(Number(args.parts) >= 1)) {
        return recipeId === "capacity"
          ? "capacity has to be at least one"
          : "a task has to be split across at least one person";
      }
      if (need === "window") {
        if (!args.from_day || !args.to_day) return "set both days";
        if (Number(args.to_day) <= Number(args.from_day)) {
          return "the window has to end after it starts";
        }
      }
    }
    if (recipeId === "drop_dep" && args.task && args.task === args.resource) {
      return "a task cannot wait on itself, so there is no such dependency";
    }
    return null;
  })();

  return (
    <div className="flex flex-wrap items-end gap-2">
      {/* First `<select>` in the DOM: the walkthroughs pick the question by
          label from `page.locator("select").first()`. */}
      <div className="min-w-[15rem] flex-1">
        <NativeSelect
          label="Question"
          value={recipeId}
          onChange={(e) => setRecipeId(e.target.value)}
        >
          {RECIPES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </NativeSelect>
      </div>

      {recipe.needs.includes("task") && (
        <div className="min-w-[13rem] flex-1">
          <NativeSelect
            label={recipeId === "drop_dep" ? "This task" : "Task"}
            value={args.task ?? ""}
            onChange={(e) => set("task", e.target.value)}
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

      {recipe.needs.includes("resource") && (
        <div className="min-w-[13rem] flex-1">
          <NativeSelect
            label={recipeId === "drop_dep" ? "No longer waits" : "Who"}
            value={args.resource ?? ""}
            onChange={(e) => set("resource", e.target.value)}
          >
            <option value="">choose…</option>
            {(recipeId === "drop_dep"
              ? workflow.tasks
              : workflow.resources
            ).map((item) => (
              <option key={item.key} value={item.key}>
                {item.key} · {item.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}

      {recipe.needs.includes("days") && (
        <NumberField
          label="Extra days"
          min={0}
          value={args.days ?? "5"}
          onChange={(e) => set("days", e.target.value)}
        />
      )}

      {recipe.needs.includes("parts") && (
        <NumberField
          label={recipeId === "capacity" ? "Capacity" : "People"}
          min={1}
          value={args.parts ?? "2"}
          onChange={(e) => set("parts", e.target.value)}
        />
      )}

      {recipe.needs.includes("window") && (
        <>
          <NumberField
            label="From day"
            min={0}
            value={args.from_day ?? ""}
            onChange={(e) => set("from_day", e.target.value)}
          />
          <NumberField
            label="To day"
            min={0}
            value={args.to_day ?? ""}
            onChange={(e) => set("to_day", e.target.value)}
          />
        </>
      )}

      <Button
        variant="secondary"
        disabled={blocked !== null}
        onClick={() => {
          const mutations = recipe.build(args);
          onAdd(mutations[0], recipe.describe(args));
        }}
      >
        Add change
      </Button>
      {blocked && (
        <span className="pb-1.5 text-[12px] text-dim">{blocked}</span>
      )}
    </div>
  );
}
