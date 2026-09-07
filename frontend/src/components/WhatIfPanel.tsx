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
 */

import { useState } from "react";
import {
  ApiError,
  MutationIn,
  SimulationResponse,
  Workflow,
  whatIf,
} from "@/lib/api";
import DiffView from "./DiffView";
import {
  Badge,
  Button,
  Card,
  CardTitle,
  ErrorNote,
  Field,
  Input,
  Select,
  Spinner,
} from "./ui";

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

export default function WhatIfPanel({ workflow }: { workflow: Workflow }) {
  const [pending, setPending] = useState<
    { mutation: MutationIn; label: string }[]
  >([]);
  const [result, setResult] = useState<SimulationResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function evaluate() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await whatIf(
          workflow.project_id,
          pending.map((p) => p.mutation),
          { name: pending.map((p) => p.label).join("; "), keep: false },
        ),
      );
    } catch (e) {
      if (e instanceof ApiError) setError(e);
      else throw e;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>Ask a hypothetical</CardTitle>
        <RecipeForm
          workflow={workflow}
          onAdd={(mutation, label) =>
            setPending([...pending, { mutation, label }])
          }
        />

        {pending.length > 0 && (
          <div className="mt-4 pt-3 border-t border-line">
            <div className="text-xs text-dim mb-2">
              These changes, in order — nothing is written to your workflow:
            </div>
            <ol className="space-y-1 mb-3">
              {pending.map((p, i) => (
                <li
                  key={i}
                  className="flex items-center gap-2 text-sm bg-panel2/50 border border-line/60 rounded px-2 py-1"
                >
                  <span className="text-dim text-xs w-4">{i + 1}.</span>
                  <span className="flex-1">{p.label}</span>
                  <Badge tone="neutral">{p.mutation.kind}</Badge>
                  <button
                    onClick={() =>
                      setPending(pending.filter((_, j) => j !== i))
                    }
                    className="text-dim hover:text-red"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ol>
            <div className="flex gap-2">
              <Button variant="primary" onClick={evaluate} disabled={busy}>
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
            </div>
          </div>
        )}
      </Card>

      {busy && <Spinner label="Evaluating against an in-memory copy…" />}

      {error && (
        <ErrorNote hint={error.hint} requestId={error.requestId}>
          <p>{error.userMessage}</p>
          {error.constraint && (
            <p className="mt-2 text-xs">
              <Badge tone="violet">{error.constraint.constraint}</Badge>{" "}
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

  const ready = recipe.needs.every((need) => {
    if (need === "task") return !!args.task;
    if (need === "resource") return !!args.resource;
    if (need === "days") return !!args.days;
    if (need === "parts") return !!args.parts;
    if (need === "window") return !!args.from_day && !!args.to_day;
    return true;
  });

  return (
    <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 items-end">
      <Field label="Question" className="sm:col-span-2">
        <Select
          value={recipeId}
          onChange={(e) => setRecipeId(e.target.value)}
        >
          {RECIPES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </Select>
      </Field>

      {recipe.needs.includes("task") && (
        <Field label={recipeId === "drop_dep" ? "This task" : "Task"}>
          <Select
            value={args.task ?? ""}
            onChange={(e) => set("task", e.target.value)}
          >
            <option value="">choose…</option>
            {workflow.tasks.map((t) => (
              <option key={t.key} value={t.key}>
                {t.key} · {t.name}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {recipe.needs.includes("resource") && (
        <Field label={recipeId === "drop_dep" ? "No longer waits" : "Who"}>
          <Select
            value={args.resource ?? ""}
            onChange={(e) => set("resource", e.target.value)}
          >
            <option value="">choose…</option>
            {(recipeId === "drop_dep" ? workflow.tasks : workflow.resources).map(
              (item) => (
                <option key={item.key} value={item.key}>
                  {item.key} · {item.name}
                </option>
              ),
            )}
          </Select>
        </Field>
      )}

      {recipe.needs.includes("days") && (
        <Field label="Extra days">
          <Input
            type="number"
            min={0}
            value={args.days ?? "5"}
            onChange={(e) => set("days", e.target.value)}
          />
        </Field>
      )}

      {recipe.needs.includes("parts") && (
        <Field label={recipeId === "capacity" ? "Capacity" : "People"}>
          <Input
            type="number"
            min={1}
            value={args.parts ?? "2"}
            onChange={(e) => set("parts", e.target.value)}
          />
        </Field>
      )}

      {recipe.needs.includes("window") && (
        <>
          <Field label="From day">
            <Input
              type="number"
              min={0}
              value={args.from_day ?? ""}
              onChange={(e) => set("from_day", e.target.value)}
            />
          </Field>
          <Field label="To day">
            <Input
              type="number"
              min={0}
              value={args.to_day ?? ""}
              onChange={(e) => set("to_day", e.target.value)}
            />
          </Field>
        </>
      )}

      <Button
        disabled={!ready}
        onClick={() => {
          const mutations = recipe.build(args);
          onAdd(mutations[0], recipe.describe(args));
        }}
      >
        Add change
      </Button>
    </div>
  );
}
