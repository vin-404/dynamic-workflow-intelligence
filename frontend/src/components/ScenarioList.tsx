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
 *
 * Optimizer candidates are the exception to "list everything": one search
 * persists up to forty of them, so after two searches they would bury every
 * what-if and replan. Authored scenarios are listed first; the candidates are
 * counted in the header and collapsed under one row that says how many there
 * are - hidden from the eye, never from the count - and their diffs are
 * computed only once that row is opened.
 *
 * Presentation (design brief §4, "What if"): a row leads with the name the
 * user gave, then the engine's finish-date effect in colour, then the typed
 * changes said in the product's words through `describeMutation`. The
 * engine's own `describes` sentences are still on the page, inside the
 * opened row, so nothing the API said is dropped.
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
import { bandClasses } from "@/lib/severity";
import {
  describeMutation,
  originLabel,
  scenarioStatusLabel,
} from "@/lib/display";
import { cn } from "@/lib/utils";
import When from "@/components/When";
import DiffView from "./DiffView";
import ErrorBoundary from "./ErrorBoundary";
import { ErrorNote, days } from "./ui";

const ICON = "size-3.5 shrink-0";
/** An identifier on record - an origin - named through the display map. */
const CHIP =
  "rounded border border-line bg-panel2 px-1.5 py-0.5 text-[12px] text-dim";
/** The one disclosure style on this stage: a link in the accent, no marker. */
const SUMMARY =
  "inline-flex cursor-pointer list-none items-center gap-1 text-[12px] text-accent " +
  "marker:content-none hover:underline [&::-webkit-details-marker]:hidden";

/** How many diffs are in flight at once. Pure reads, but still engine runs. */
const DIFF_CONCURRENCY = 4;

/** Origins the optimizer writes in bulk; collapsed by default. */
const OPTIMIZER_ORIGINS = new Set(["heuristic_proposal", "llm_proposal"]);

/** Status, in the three tones `severity.ts` owns. Applied is the good end. */
function statusTone(status: string): string {
  if (status === "applied" || status === "validated") return "low";
  if (status === "rejected") return "high";
  return "moderate";
}

/**
 * The typed changes as one sentence in the product's voice: "Anitha
 * unavailable day 14 to day 21". Only the first letter is raised, so a
 * lower-case resource key reads as the start of a sentence.
 */
function describeChanges(scenario: Scenario): string {
  const text = scenario.mutations.map((m) => describeMutation(m)).join("; ");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
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
  const [showCandidates, setShowCandidates] = useState(false);

  const authored = (scenarios ?? []).filter((s) => !OPTIMIZER_ORIGINS.has(s.origin));
  const candidates = (scenarios ?? []).filter((s) => OPTIMIZER_ORIGINS.has(s.origin));

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

  // The headline effect for every *visible* row that can have one, a few at
  // a time. Rejected scenarios are skipped: they have no valid after-state to
  // diff. Rows already computed are not asked again.
  useEffect(() => {
    if (!scenarios) return;
    let live = true;
    const wanted = showCandidates ? scenarios : scenarios.filter((s) => !OPTIMIZER_ORIGINS.has(s.origin));
    const queue = wanted.filter((s) => s.status !== "rejected" && !effects[s.id]);
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
    // `effects` is deliberately not a dependency: it is what this effect
    // writes, and re-running on every write would re-queue the in-flight rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarios, showCandidates]);

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

  const candidateWord = `optimizer candidate${candidates.length === 1 ? "" : "s"}`;

  const row = (s: Scenario) => (
    <ScenarioRow
      key={s.id}
      scenario={s}
      effect={effects[s.id] ?? { state: "pending" }}
      olderBase={
        currentVersionId !== null && s.base_version_id !== currentVersionId
      }
      onDeleted={reload}
    />
  );

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-[18px] font-semibold">Saved scenarios</h2>
        <span className="text-[12px] text-dim">
          {scenarios.length === 0
            ? "none"
            : `${authored.length} authored · ${candidates.length} ${candidateWord} · newest first`}
        </span>
      </div>

      {/* The panel's one caveat, always visible. */}
      <p className="text-[12px] text-dim">
        Each effect is computed on the engine against the scenario&apos;s own
        base; nothing here is estimated by the page.
      </p>

      {scenarios.length === 0 ? (
        <div className="max-w-3xl">
          <p className="text-[14px] font-medium">No saved scenarios yet</p>
          <p className="mt-1 text-[14px] text-dim">
            A simulation from the composer above is discarded once you have
            read it unless you tick &ldquo;keep it&rdquo;.
          </p>
          <details className="group mt-1.5">
            <summary className={SUMMARY}>
              <ChevronRight
                className={cn(ICON, "transition-transform group-open:rotate-90")}
                aria-hidden
              />
              How scenarios come to exist
            </summary>
            <p className="mt-1.5 max-w-2xl pl-4 text-[14px] text-dim">
              The sentence box saves each interpretation it understood, the
              optimizer saves every candidate that survived its gates, and a
              requirement change saves its replan. Any of those will appear
              here.
            </p>
          </details>
        </div>
      ) : (
        <>
          {authored.length === 0 && (
            <p className="text-[14px] text-dim">
              Nothing authored by hand yet; every saved scenario here is an
              optimizer candidate.
            </p>
          )}
          {authored.length > 0 && (
            <ul className="divide-y divide-line rounded-xl border border-line bg-panel px-4">
              {authored.map(row)}
            </ul>
          )}
          {candidates.length > 0 && (
            <details
              className="group rounded-xl border border-line bg-panel px-4"
              onToggle={(e) => setShowCandidates(e.currentTarget.open)}
            >
              {/* One row for all of them. Their diffs are asked for only
                  once this is open, because each is an engine run. */}
              <summary
                className={cn(
                  SUMMARY,
                  "flex w-full py-2.5 text-[14px] font-medium text-foreground",
                )}
              >
                <ChevronRight
                  className={cn(
                    ICON,
                    "text-dim transition-transform group-open:rotate-90",
                  )}
                  aria-hidden
                />
                {candidates.length} {candidateWord}
                <span className="ml-auto text-[12px] font-normal text-dim">
                  saved by the searches
                </span>
              </summary>
              <ul className="divide-y divide-line border-t border-line">
                {candidates.map(row)}
              </ul>
            </details>
          )}
        </>
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

  const rejected = scenario.status === "rejected";
  const changes = describeChanges(scenario);
  const name = scenario.name.trim() || "(unnamed scenario)";

  return (
    <li className="py-3">
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
          <span className="text-[14px] font-medium">{name}</span>
        </button>
        <Badge
          variant="outline"
          className={cn(
            "text-[12px] font-normal",
            bandClasses(statusTone(scenario.status)),
          )}
        >
          {scenarioStatusLabel(scenario.status)}
        </Badge>
        <span className={CHIP}>{originLabel(scenario.origin)}</span>
        {olderBase && (
          <span
            className="text-[12px] text-severity-medium"
            title="This scenario was written over a workflow version that is no longer current. Its diff is against that older base."
          >
            over an older version
          </span>
        )}
        <span className="ml-auto text-[12px] text-dim">
          <When iso={scenario.created_at} />
        </span>
      </div>

      {/* The headline: the engine's finish-date delta, or why there is none,
          then the typed changes in the product's words. */}
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 pl-5">
        {rejected ? (
          <span className="text-[14px] text-critical">
            rejected — {scenario.rejection_reason || "no reason recorded"}
          </span>
        ) : effect.state === "pending" ? (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-dim">
            <LoaderCircle className={cn(ICON, "animate-spin")} aria-hidden />
            computing its effect on the finish date…
          </span>
        ) : effect.state === "failed" ? (
          <span className="text-[14px] text-critical">
            effect could not be computed — {effect.error.userMessage}
          </span>
        ) : (
          <Headline diff={effect.diff} />
        )}
        {changes && (
          <span className="min-w-0 text-[12px] text-dim">{changes}</span>
        )}
      </div>

      {open && (
        <div className="mt-3 flex flex-col gap-3 border-l-2 border-line pl-4">
          {scenario.rationale && (
            <p className="max-w-3xl text-[14px]">{scenario.rationale}</p>
          )}

          {/* The typed changes as the engine recorded them, beside the
              product's reading of each. */}
          {scenario.mutations.length > 0 && (
            <div>
              <div className="mb-1 text-[12px] text-dim">
                {scenario.mutations.length} typed change
                {scenario.mutations.length === 1 ? "" : "s"}, in order:
              </div>
              <ol className="flex max-w-3xl flex-col divide-y divide-line border-y border-line">
                {scenario.mutations.map((m, i) => (
                  <li
                    key={i}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5 text-[14px]"
                  >
                    <span className="w-4 shrink-0 text-right text-[12px] text-dim">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">{describeMutation(m)}</span>
                    {m.describes && (
                      <span className="text-[12px] text-dim">
                        recorded as &ldquo;{m.describes}&rdquo;
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {evaluating && (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-dim">
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
          <div className="border-t border-line pt-2">
            {scenario.status === "applied" ? (
              <p className="text-[12px] text-dim">
                Applied scenarios cannot be deleted: this one is the provenance
                of a workflow version.
              </p>
            ) : confirming ? (
              <div className="border-l-2 border-critical bg-critical/5 py-2 pl-3">
                <p className="text-[14px] font-semibold text-critical">
                  Delete this scenario?
                </p>
                <p className="mt-1 max-w-2xl text-[12px] text-dim">
                  It is scratch paper over a workflow version. Deleting it
                  removes the scenario and its typed changes and nothing
                  else: no workflow version is touched, and nothing that has
                  been applied changes.
                </p>
                <p className="mt-1 max-w-2xl text-[12px] text-dim">
                  Needs the editor role; a viewer is refused by the API.
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

/**
 * The engine's projected-completion delta, signed, with the direction. A
 * later finish is the one warm colour; earlier or unchanged is the good
 * green. The text keeps its exact shape: `finish +5d · day 26 → 31`.
 */
function Headline({ diff }: { diff: ScenarioDiff }) {
  const pc = diff.comparison.projected_completion;
  if (!diff.validation.valid) {
    return (
      <span className="text-[14px] text-critical">
        would be refused now — its base has changed under it
      </span>
    );
  }
  const none = Math.abs(pc.delta_days) < 1e-9;
  return (
    <span
      className={cn(
        "text-[14px] font-medium",
        pc.delta_days > 0 ? "text-critical" : "text-severity-low",
      )}
      title={`Projected finish day ${pc.before_day} → ${pc.after_day} (${pc.direction})`}
    >
      {none
        ? "finish date unchanged"
        : `finish ${days(pc.delta_days, true)} · day ${Math.round(pc.before_day)} → ${Math.round(pc.after_day)}`}
    </span>
  );
}
