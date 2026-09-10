"use client";

/**
 * The project's saved scenarios: see them, revisit one, delete one.
 *
 * A scenario is scratch paper over a workflow version. The sentence box saves
 * one for every interpretation, the optimizer saves one per surviving
 * candidate, a requirement change saves its replan, and the what-if composer
 * saves one when asked to. Until now none of them could be seen again.
 *
 * Three things this list refuses to do:
 *
 * - **Invent the headline.** "Its effect on the finish date" is read from
 *   `GET /api/scenarios/{id}/diff`, a pure read that re-simulates the
 *   scenario against its base and returns the engine's comparison. A row
 *   whose diff has not come back yet says "computing"; one whose diff failed
 *   says so, with the error. There is no placeholder number.
 * - **Show an empty list as a spinner or a sample.** No saved scenarios is a
 *   real state with real copy, and the copy says how scenarios come to exist.
 * - **Confuse a scenario with a version.** Deleting one removes the scratch
 *   paper and nothing else; the backend refuses to delete an applied one
 *   because that is the provenance of a version, and the refusal is shown.
 *   The confirmation step says exactly what will and will not be touched.
 *
 * Opening a scenario evaluates it (`POST .../evaluate`, a read that writes
 * one analysis run) and renders the same `DiffView` the what-if panel uses,
 * because it is the same comparison from the same engine.
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, LoaderCircle, Trash2 } from "lucide-react";
import {
  ApiError,
  Scenario,
  ScenarioDiff,
  SimulationResponse,
  deleteScenario,
  evaluateScenario,
  listScenarios,
  scenarioDiff,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { bandClasses, bandText } from "@/lib/severity";
import { cn } from "@/lib/utils";
import DiffView from "./DiffView";
import ErrorBoundary from "./ErrorBoundary";
import { ErrorNote, days, instantUTC } from "./ui";

const ICON = "size-3.5 shrink-0";
/** An identifier on record - an origin, a kind - not a status. */
const TOKEN =
  "rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px]";

/** How many diffs are in flight at once. Pure reads, but still engine runs. */
const DIFF_CONCURRENCY = 4;

/** Where a scenario came from, in the reader's words. */
const ORIGIN_LABEL: Record<string, string> = {
  user_whatif: "what-if",
  heuristic_proposal: "optimizer generator",
  llm_proposal: "model proposal",
};

/** Status, in the three tones `severity.ts` owns. Applied is the good end. */
function statusTone(status: string): string {
  if (status === "applied" || status === "validated") return "low";
  if (status === "rejected") return "high";
  return "moderate";
}

type Effect =
  | { state: "pending" }
  | { state: "ok"; diff: ScenarioDiff }
  | { state: "failed"; error: ApiError };

export default function ScenarioList({
  projectId,
  currentVersionId,
  refreshKey = 0,
}: {
  projectId: string;
  /** The workflow version on screen, to flag scenarios over an older base. */
  currentVersionId: string | null;
  /** Bumped by the stage when something saves a scenario. */
  refreshKey?: number;
}) {
  const [scenarios, setScenarios] = useState<Scenario[] | null>(null);
  const [listError, setListError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [effects, setEffects] = useState<Record<string, Effect>>({});

  // Fetch only. Resets live in the handlers (D-103).
  useEffect(() => {
    let live = true;
    listScenarios(projectId)
      .then((rows) => {
        if (!live) return;
        // The API already orders newest first; sorting again costs nothing
        // and keeps the promise if that ever changes.
        const sorted = [...rows].sort((a, b) =>
          b.created_at.localeCompare(a.created_at),
        );
        setScenarios(sorted);
      })
      .catch((e: ApiError) => {
        if (live) setListError(e);
      });
    return () => {
      live = false;
    };
  }, [projectId, refreshKey, attempt]);

  // The headline effect for every row that can have one, a few at a time.
  // Rejected scenarios are skipped: they have no valid after-state to diff.
  useEffect(() => {
    if (!scenarios) return;
    let live = true;
    const queue = scenarios.filter((s) => s.status !== "rejected");
    let next = 0;
    async function worker() {
      while (live && next < queue.length) {
        const s = queue[next++];
        try {
          const diff = await scenarioDiff(s.id);
          if (live) {
            setEffects((e) => ({ ...e, [s.id]: { state: "ok", diff } }));
          }
        } catch (err) {
          if (live) {
            setEffects((e) => ({
              ...e,
              [s.id]: {
                state: "failed",
                error:
                  err instanceof ApiError
                    ? err
                    : new ApiError(0, String(err), String(err)),
              },
            }));
          }
        }
      }
    }
    for (let i = 0; i < DIFF_CONCURRENCY; i++) void worker();
    return () => {
      live = false;
    };
  }, [scenarios]);

  const reload = useCallback(() => {
    setListError(null);
    setScenarios(null);
    setEffects({});
    setAttempt((a) => a + 1);
  }, []);

  if (listError) {
    return (
      <ErrorNote
        hint={listError.hint}
        requestId={listError.requestId}
        onRetry={reload}
      >
        The saved scenarios could not be read. {listError.userMessage}
      </ErrorNote>
    );
  }

  if (!scenarios) {
    return (
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-4 w-full" />
      </div>
    );
  }

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border pb-1.5">
        <h2 className="text-[13px] font-semibold tracking-tight">
          Saved scenarios
        </h2>
        <span className="text-[11px] text-dim">
          {scenarios.length === 0
            ? "none"
            : `${scenarios.length} · newest first · effects computed on the engine`}
        </span>
      </div>

      {scenarios.length === 0 ? (
        <div className="max-w-3xl py-2">
          <p className="text-sm font-medium">No saved scenarios yet</p>
          <p className="mt-1 text-sm text-dim">
            A simulation from the composer above is discarded once you have
            read it unless you tick &ldquo;keep it&rdquo;. The sentence box
            saves each interpretation it understood, the optimizer saves every
            candidate that survived its gates, and a requirement change saves
            its replan. Any of those will appear here.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border/60">
          {scenarios.map((s) => (
            <ScenarioRow
              key={s.id}
              scenario={s}
              effect={effects[s.id] ?? { state: "pending" }}
              olderBase={
                currentVersionId !== null &&
                s.base_version_id !== currentVersionId
              }
              onDeleted={reload}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- one row */

function ScenarioRow({
  scenario,
  effect,
  olderBase,
  onDeleted,
}: {
  scenario: Scenario;
  effect: Effect;
  olderBase: boolean;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<SimulationResponse | null>(null);
  const [evalError, setEvalError] = useState<ApiError | null>(null);
  const [evaluating, setEvaluating] = useState(false);

  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<ApiError | null>(null);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (result || evaluating) return;
    setEvaluating(true);
    setEvalError(null);
    try {
      setResult(await evaluateScenario(scenario.id));
    } catch (e) {
      setEvalError(
        e instanceof ApiError ? e : new ApiError(0, String(e), String(e)),
      );
    } finally {
      setEvaluating(false);
    }
  }

  async function remove() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteScenario(scenario.id);
      onDeleted();
    } catch (e) {
      setDeleteError(
        e instanceof ApiError ? e : new ApiError(0, String(e), String(e)),
      );
    } finally {
      setDeleting(false);
    }
  }

  const when = instantUTC(scenario.created_at);
  const rejected = scenario.status === "rejected";

  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="inline-flex min-w-0 items-baseline gap-1.5 text-left hover:text-foreground"
        >
          <ChevronRight
            className={cn(
              ICON,
              "translate-y-0.5 text-dim transition-transform",
              open && "rotate-90",
            )}
            aria-hidden
          />
          <span className="text-sm font-medium">
            {scenario.name.trim() || "(unnamed scenario)"}
          </span>
        </button>
        <Badge
          variant="outline"
          className={cn("font-normal", bandClasses(statusTone(scenario.status)))}
        >
          {scenario.status}
        </Badge>
        <span className={cn(TOKEN, "text-dim")}>
          {ORIGIN_LABEL[scenario.origin] ?? scenario.origin}
        </span>
        {olderBase && (
          <span
            className="text-[11px] text-severity-medium"
            title="This scenario was written over a workflow version that is no longer current. Its diff is against that older base."
          >
            over an older version
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] text-dim">
          {when ? `${when} UTC` : scenario.created_at}
        </span>
      </div>

      {/* The headline: the engine's finish-date delta, or why there is none. */}
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 pl-5 text-xs">
        {rejected ? (
          <span className={bandText("high")}>
            rejected — {scenario.rejection_reason || "no reason recorded"}
          </span>
        ) : effect.state === "pending" ? (
          <span className="inline-flex items-center gap-1.5 text-dim">
            <LoaderCircle className={cn(ICON, "animate-spin")} aria-hidden />
            computing its effect on the finish date…
          </span>
        ) : effect.state === "failed" ? (
          <span className={bandText("high")}>
            effect could not be computed — {effect.error.userMessage}
          </span>
        ) : (
          <Headline diff={effect.diff} />
        )}
        <span className="text-dim">
          {scenario.mutations.length} typed change
          {scenario.mutations.length === 1 ? "" : "s"}
          {scenario.mutations.length > 0 && (
            <>
              {": "}
              {scenario.mutations.map((m) => m.describes).join("; ")}
            </>
          )}
        </span>
      </div>

      {open && (
        <div className="mt-3 flex flex-col gap-3 border-l-2 border-border pl-4">
          {scenario.rationale && (
            <p className="max-w-3xl text-sm">{scenario.rationale}</p>
          )}

          {evaluating && (
            <span className="inline-flex items-center gap-1.5 text-xs text-dim">
              <LoaderCircle className={cn(ICON, "animate-spin")} aria-hidden />
              Evaluating against an in-memory copy of its base…
            </span>
          )}
          {evalError && (
            <ErrorNote
              hint={evalError.hint}
              requestId={evalError.requestId}
              onRetry={() => {
                setResult(null);
                setOpen(false);
                void toggle();
              }}
            >
              This scenario could not be evaluated. {evalError.userMessage}
            </ErrorNote>
          )}
          {result && (
            <ErrorBoundary what="The scenario diff">
              <DiffView result={result} />
            </ErrorBoundary>
          )}

          {/* ------------------------------------------------- delete */}
          <div className="border-t border-border pt-2">
            {scenario.status === "applied" ? (
              <p className="text-xs text-dim">
                Applied scenarios cannot be deleted: this one is the provenance
                of a workflow version.
              </p>
            ) : confirming ? (
              <div className="border-l-2 border-severity-high bg-severity-high/5 py-2 pl-3">
                <p className="text-sm font-semibold text-severity-high">
                  Delete this scenario?
                </p>
                <p className="mt-1 max-w-2xl text-xs text-dim">
                  It is scratch paper over a workflow version. Deleting it
                  removes the scenario and its typed changes and nothing
                  else: no workflow version is touched, and nothing that has
                  been applied changes. Needs the editor role; a viewer is
                  refused by the API.
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={deleting}
                    onClick={remove}
                  >
                    {deleting ? "Deleting…" : "Yes — delete the scenario"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={deleting}
                    onClick={() => setConfirming(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirming(true)}
              >
                <Trash2 data-icon="inline-start" aria-hidden />
                Delete this scenario…
              </Button>
            )}
            {deleteError && (
              <div className="mt-2">
                <ErrorNote
                  hint={deleteError.hint}
                  requestId={deleteError.requestId}
                >
                  Not deleted. {deleteError.userMessage}
                </ErrorNote>
              </div>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/** The engine's projected-completion delta, signed, with the direction. */
function Headline({ diff }: { diff: ScenarioDiff }) {
  const pc = diff.comparison.projected_completion;
  if (!diff.validation.valid) {
    return (
      <span className={bandText("high")}>
        would be refused now — its base has changed under it
      </span>
    );
  }
  const none = Math.abs(pc.delta_days) < 1e-9;
  return (
    <span
      className={cn(
        "font-medium",
        none ? "text-dim" : bandText(pc.delta_days > 0 ? "high" : "low"),
      )}
      title={`Projected finish day ${pc.before_day} → ${pc.after_day} (${pc.direction})`}
    >
      {none
        ? "finish date unchanged"
        : `finish ${days(pc.delta_days, true)} · day ${Math.round(pc.before_day)} → ${Math.round(pc.after_day)}`}
    </span>
  );
}
