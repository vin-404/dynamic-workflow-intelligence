"use client";

/**
 * The requirement stage: pick a requirement, propose a new wording, read what
 * it would cost before committing to it.
 *
 * This component owns the whole stage and mounts `ImpactReport`,
 * `RequirementStaleness` and `RequirementHistory` itself, so `page.tsx` has
 * one mount point. Each of those sits in its own `ErrorBoundary`: a bug in
 * the history table must cost the reader the history table, not the composer
 * they were in the middle of using.
 *
 * **Shape.** A narrow rail lists the requirements with what each one is
 * already worth — consumers, finished days at risk, blast radius — because
 * that is the question you arrive with, and it is answerable before anybody
 * types a word. The wide column is where the work happens: the proposal, the
 * report, the provenance. The rail is the thing that gets narrow, not the
 * report: the must-redo table has six columns of evidence and needs the width.
 *
 * **The scope control is the honest half of this feature.** The report is a
 * blast radius computed from the dependency graph; it never reads the two
 * wordings, and no language model is asked to. Whether a re-wording genuinely
 * invalidates a given piece of work is a human judgement — so the composer
 * lets the reader make it, by naming which consuming tasks a wording actually
 * invalidates. That is `invalidates` on the API, it is what turns a comparison
 * of two wordings from a tie into a real answer (D-158), and it is stated on
 * screen as *your judgement about meaning, our arithmetic about cost*.
 *
 * **Comparing two plain wordings ties, and the tie is shown rather than
 * broken.** Two sentences have identical graph-derived cost because the graph
 * does not change when the sentence does. Inventing a difference out of how
 * much of the text moved would be a fabricated number in the one feature whose
 * whole claim is that it reasons from evidence.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import {
  ApiError,
  ImpactReport as Report,
  RequirementApplyResult,
  RequirementComparison,
  RequirementSummary,
  Workflow,
  WordingOption,
  applyRequirementChange,
  assumptionSentences,
  changeRequirement,
  compareRequirement,
  humanizeKey,
  listRequirements,
} from "@/lib/api";
import { severityText } from "@/lib/severity";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import ErrorBoundary from "./ErrorBoundary";
import ImpactReport from "./ImpactReport";
import RequirementHistory from "./RequirementHistory";
import RequirementStaleness from "./RequirementStaleness";
import { ErrorNote, Textarea, days } from "./ui";

/* --------------------------------------------------------------- shapes */

/**
 * The two fields the shared client deliberately leaves open.
 *
 * `RequirementComparison` is fully typed now, except for `differences.varies`
 * and `base`, which it types as `unknown` / `Record<string, unknown>` — they
 * are payload-shaped bags rather than a settled contract. Narrowing exactly
 * those two here, and nothing else, is using the client as intended rather
 * than working around it.
 */
interface VariesRow {
  field: string;
  means: string;
  values: number[];
  differs: boolean;
}

interface ComparisonBase {
  version_no?: number;
  same_base_for_every_option?: boolean;
}

/** One proposed wording in the composer. `scope` is the human judgement. */
interface Wording {
  id: number;
  text: string;
  /** Consuming task keys this wording is judged to invalidate. */
  scope: string[];
}

/* ----------------------------------------------------------------- rail */

function RequirementRail({
  requirements,
  selected,
  onSelect,
}: {
  requirements: RequirementSummary[];
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <nav className="flex flex-col">
      <h3 className="mb-2 border-b border-line pb-1 text-[12px] font-medium tracking-wider text-dim uppercase">
        Requirements — {requirements.length}
      </h3>
      <ul>
        {requirements.map((r) => {
          const active = r.key === selected;
          return (
            <li key={r.key}>
              <button
                onClick={() => onSelect(r.key)}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "w-full border-b border-line py-2 text-left transition-colors last:border-0",
                  active ? "bg-panel2" : "hover:bg-panel2",
                )}
              >
                <div className="flex items-baseline gap-2 px-1.5">
                  {/* Selection is carried by the row's ground and weight, not
                      by the accent: a navigation affordance is not meaning,
                      and the accent is reserved for the critical path (D-117). */}
                  <span className={cn("font-mono text-xs", active && "font-semibold")}>
                    {r.key}
                  </span>
                  <span className="text-[12px] text-dim">
                    v{r.version_no}
                  </span>
                </div>
                <p className="px-1.5 text-sm leading-snug">{r.text}</p>
                <p className="px-1.5 text-xs text-dim">
                  {r.consumed_by_count} consuming ·{" "}
                  <span
                    className={cn(
                      r.completed_days_at_risk > 0 &&
                        cn("font-medium", severityText("high")),
                    )}
                  >
                    {days(r.completed_days_at_risk)} finished
                  </span>{" "}
                  · {days(r.blast_radius_effort_days)} reach
                </p>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-dim">
        &ldquo;Finished&rdquo; is effort already completed that a change to that
        requirement would invalidate, assuming the change is material. Nothing
        here reads the requirement text.
      </p>
    </nav>
  );
}

/* ------------------------------------------------------------- composer */

function ScopeChips({
  consumers,
  scope,
  onToggle,
  onAll,
}: {
  consumers: string[];
  scope: string[];
  onToggle: (key: string) => void;
  onAll: () => void;
}) {
  const unscoped = scope.length === consumers.length;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-dim">invalidates</span>
      {consumers.map((key) => {
        const on = scope.includes(key);
        return (
          <button
            key={key}
            onClick={() => onToggle(key)}
            aria-pressed={on}
            title={
              on
                ? `${key} consumed this requirement and this wording invalidates its work`
                : `${key} consumed this requirement but this wording is judged to spare its work`
            }
            className={cn(
              "rounded border px-1.5 py-px font-mono text-[12px] transition-colors",
              on
                ? "border-severity-high/40 bg-severity-high/10 text-severity-high"
                : "border-line text-dim line-through hover:border-foreground/40",
            )}
          >
            {key}
          </button>
        );
      })}
      {!unscoped && (
        <Button size="xs" variant="ghost" onClick={onAll}>
          reset to all
        </Button>
      )}
      <span className="text-xs text-dim">
        {unscoped
          ? "— all consumers, unscoped"
          : `— ${consumers.length - scope.length} spared by your judgement`}
      </span>
    </div>
  );
}

/* ------------------------------------------------------- comparison view */

const FIELD_ORDER = [
  "wasted_days",
  "additional_effort_days",
  "must_redo_count",
  "must_recheck_count",
  "blast_radius_effort_days",
  "projected_end_delta_days",
];

function ComparisonView({
  comparison,
  onOpen,
  opened,
}: {
  comparison: RequirementComparison;
  onOpen: (index: number) => void;
  opened: number | null;
}) {
  const tie = comparison.cheapest_option_index === null;
  const varies = ((comparison.differences?.varies ?? []) as VariesRow[])
    .slice()
    .sort((a, b) => FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field));
  const base = (comparison.base ?? {}) as ComparisonBase;
  const options = comparison.options;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="mb-2 border-b border-line pb-1">
          <h3 className="text-[12px] font-medium tracking-wider text-dim uppercase">
            {tie
              ? `${options.length} wordings, the same cost`
              : `Cheapest: ${
                  options.find(
                    (o) => o.index === comparison.cheapest_option_index,
                  )?.label ?? "—"
                }`}
          </h3>
        </div>

        {/* The tie is the answer, not a failure to distinguish them. */}
        {comparison.differences?.statement && (
          <p
            className={cn(
              "border-l-2 py-2 pr-2 pl-3 text-xs",
              tie
                ? "border-severity-medium bg-severity-medium/5"
                : "border-line",
            )}
          >
            {/* The API's sentence already opens with "these cost exactly the
                same, and that is the correct answer" — a bold restatement
                above it just says the same thing twice. The heading carries
                the label; this carries the reasoning. */}
            <span className={tie ? "text-foreground/90" : "text-dim"}>
              {comparison.differences.statement}
            </span>
            {tie && (
              <span className="mt-1 block font-medium">
                Use the <span className="font-mono">invalidates</span> chips on
                a wording above to say which consumers it spares. Your judgement
                about meaning, our arithmetic about cost.
              </span>
            )}
          </p>
        )}
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-[12px] tracking-wider text-dim uppercase">
              Measure
            </TableHead>
            {options.map((o) => (
              <TableHead
                key={o.index}
                className="text-right text-[12px] tracking-wider text-dim uppercase"
              >
                {o.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {varies.map((row) => (
            <TableRow
              key={row.field}
              data-state={row.differs ? "selected" : undefined}
            >
              <TableCell className="whitespace-normal">
                <span className="text-sm">{row.means}</span>
              </TableCell>
              {row.values.map((v, i) => (
                <TableCell
                  key={i}
                  className={cn(
                    "text-right",
                    row.differs ? "font-semibold" : "text-dim",
                  )}
                >
                  {row.field.endsWith("_count") ? v : days(v)}
                </TableCell>
              ))}
            </TableRow>
          ))}
          <TableRow>
            <TableCell className="whitespace-normal text-sm text-dim">
              which consumers this wording is judged to invalidate
            </TableCell>
            {options.map((o) => (
              <TableCell
                key={o.index}
                className="text-right text-xs text-dim"
              >
                {o.scoped
                  ? o.invalidates.length
                    ? o.invalidates.join(", ")
                    : "none"
                  : "all of them"}
              </TableCell>
            ))}
          </TableRow>
        </TableBody>
      </Table>

      <div className="flex flex-wrap items-center gap-2">
        {options.map((o) => (
          <Button
            key={o.index}
            size="sm"
            variant={opened === o.index ? "secondary" : "ghost"}
            onClick={() => onOpen(o.index)}
          >
            {opened === o.index ? "Hide" : "Read"} the full report for{" "}
            {o.label}
          </Button>
        ))}
      </div>

      {comparison.base && (
        <p className="text-xs text-dim">
          Both were costed against version {base.version_no} of this workflow.{" "}
          {base.same_base_for_every_option
            ? "Every option used the same base, and the base's content hash is unchanged by asking."
            : "The options did NOT share a base — do not compare these numbers."}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ main */

export default function RequirementChange({
  projectId,
  workflow,
  onApplied,
}: {
  projectId: string;
  workflow: Workflow;
  /**
   * Fired once, after a successful apply, so the shell can re-fetch the
   * workflow and drop the analysis it computed against the old version.
   *
   * Optional, and the on-screen note about the other stages holding the old
   * version stays either way: it is true until the reload actually lands, and
   * it is the honest thing to say when no host wired this up.
   */
  onApplied?: () => void;
}) {
  const [requirements, setRequirements] = useState<RequirementSummary[] | null>(
    null,
  );
  const [listError, setListError] = useState<ApiError | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const [wordings, setWordings] = useState<Wording[]>([]);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [comparison, setComparison] =
    useState<RequirementComparison | null>(null);
  const [opened, setOpened] = useState<number | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<ApiError | null>(null);
  const [applied, setApplied] = useState<RequirementApplyResult | null>(null);
  const [historyKey, setHistoryKey] = useState(0);

  const [listAttempt, setListAttempt] = useState(0);

  /**
   * The effect fetches and nothing else — no synchronous `setState` in its
   * body, which is what `react-hooks/set-state-in-effect` is there to prevent
   * (D-103). Retrying and refreshing after an apply are both event handlers,
   * so they may reset state and then bump the attempt counter.
   */
  useEffect(() => {
    let live = true;
    listRequirements(projectId)
      .then((r) => {
        if (live) setRequirements(r.requirements);
      })
      .catch((e: ApiError) => {
        if (live) setListError(e);
      });
    return () => {
      live = false;
    };
  }, [projectId, listAttempt]);

  const reloadList = useCallback(() => {
    setListError(null);
    setListAttempt((a) => a + 1);
  }, []);

  const current = useMemo(
    () => requirements?.find((r) => r.key === selected) ?? null,
    [requirements, selected],
  );

  /** Selecting a requirement starts a fresh proposal; nothing carries over. */
  function select(key: string) {
    const requirement = requirements?.find((r) => r.key === key);
    setSelected(key);
    setWordings([
      { id: 1, text: requirement?.text ?? "", scope: [...(requirement?.consumed_by ?? [])] },
    ]);
    setReport(null);
    setComparison(null);
    setOpened(null);
    setError(null);
    setApplied(null);
    setApplyError(null);
  }

  function patch(id: number, next: Partial<Wording>) {
    setWordings((w) => w.map((x) => (x.id === id ? { ...x, ...next } : x)));
  }

  function asOption(w: Wording, index: number): WordingOption {
    const consumers = current?.consumed_by ?? [];
    const scoped = w.scope.length !== consumers.length;
    return {
      label: `Option ${index + 1}`,
      text: w.text,
      ...(scoped ? { invalidates: w.scope } : {}),
    };
  }

  async function run() {
    if (!current) return;
    setBusy(true);
    setError(null);
    setReport(null);
    setComparison(null);
    setOpened(null);
    setApplied(null);
    setApplyError(null);
    try {
      if (wordings.length === 1) {
        const only = asOption(wordings[0], 0);
        setReport(
          await changeRequirement(projectId, current.key, {
            new_text: only.text,
            ...(only.invalidates ? { invalidates: only.invalidates } : {}),
          }),
        );
      } else {
        setComparison(
          await compareRequirement(projectId, current.key, {
            options: wordings.map(asOption),
          }),
        );
      }
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  /** Applying is the one act here that writes. It is always confirmed first. */
  async function apply(text: string, invalidates?: string[]) {
    if (!current) return;
    setApplying(true);
    setApplyError(null);
    try {
      const result = await applyRequirementChange(projectId, current.key, {
        new_text: text,
        ...(invalidates ? { invalidates } : {}),
      });
      setApplied(result);
      setHistoryKey((k) => k + 1);
      reloadList();
      // Last, and outside nothing: a host that throws here must not make a
      // write that already succeeded look like it failed.
      try {
        onApplied?.();
      } catch {
        /* The shell's reload is not this panel's correctness. */
      }
    } catch (e) {
      setApplyError(e as ApiError);
    } finally {
      setApplying(false);
    }
  }

  /* ------------------------------------------------------------ render */

  if (listError) {
    return (
      <ErrorNote
        hint={listError.hint}
        requestId={listError.requestId}
        onRetry={reloadList}
      >
        The requirements of this workflow could not be read.{" "}
        {listError.userMessage}
      </ErrorNote>
    );
  }

  if (!requirements) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }

  if (requirements.length === 0) {
    return (
      <div className="max-w-3xl">
        <p className="text-sm font-medium">
          This workflow has no requirements to change
        </p>
        <p className="mt-1 text-sm text-dim">
          A requirement is a statement the work depends on, and a dependency
          marked <span className="font-mono">consumes</span> is what makes a
          task&rsquo;s output depend on it. Without either, there is nothing to
          reason about: this report is graph reachability, not a reading of the
          text. Add requirements on the build stage.
        </p>
      </div>
    );
  }

  const consumers = current?.consumed_by ?? [];
  const openedOption =
    comparison && opened !== null
      ? (comparison.options.find((o) => o.index === opened) ?? null)
      : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <div className="lg:sticky lg:top-4 lg:self-start rounded-xl border border-line bg-panel p-4">
        <RequirementRail
          requirements={requirements}
          selected={selected}
          onSelect={select}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        {!current ? (
          <div className="max-w-3xl">
            <p className="text-sm font-medium">
              Pick a requirement to see what changing it would cost
            </p>
            <p className="mt-1 text-sm text-dim">
              Every figure on this stage comes from the dependency graph — which
              tasks consumed the requirement, what they cost, and what follows
              them. Nothing reads the requirement text, and no language model is
              involved in any number here.
            </p>
          </div>
        ) : (
          <>
            {/* ---------------------------------------------- composer */}
            <section className="rounded-xl border border-line bg-panel p-5">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line pb-1">
                <h3 className="text-[12px] font-medium tracking-wider text-dim uppercase">
                  Propose a new wording for {current.key}
                </h3>
                <span className="text-xs text-dim">
                  currently v{current.version_no} · consumed by{" "}
                  {consumers.length > 0 ? consumers.join(", ") : "nothing"}
                </span>
              </div>

              <p className="mb-2 text-sm text-dim">
                Now: <span className="text-foreground">{current.text}</span>
              </p>

              <div className="flex flex-col gap-3">
                {wordings.map((w, i) => (
                  <div key={w.id} className="flex flex-col gap-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-medium">
                        {wordings.length > 1 ? `Option ${i + 1}` : "New wording"}
                      </span>
                      {wordings.length > 1 && (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            setWordings((all) =>
                              all.filter((x) => x.id !== w.id),
                            )
                          }
                        >
                          <X data-icon="inline-start" />
                          remove
                        </Button>
                      )}
                    </div>
                    <Textarea
                      rows={2}
                      value={w.text}
                      onChange={(e) => patch(w.id, { text: e.target.value })}
                      placeholder="The requirement as it would now read…"
                    />
                    {consumers.length > 0 && (
                      <ScopeChips
                        consumers={consumers}
                        scope={w.scope}
                        onToggle={(key) =>
                          patch(w.id, {
                            scope: w.scope.includes(key)
                              ? w.scope.filter((k) => k !== key)
                              : [...w.scope, key],
                          })
                        }
                        onAll={() => patch(w.id, { scope: [...consumers] })}
                      />
                    )}
                  </div>
                ))}
              </div>

              <p className="mt-2 max-w-3xl text-xs text-dim">
                The chips are the one judgement this system cannot make for you.
                Every consuming task is assumed invalidated unless you strike it
                out. Striking one out says &ldquo;this wording does not change
                what that work relied on&rdquo; — your judgement about meaning,
                our arithmetic about cost. It is also the only thing that makes
                two wordings cost differently.
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  disabled={busy || wordings.some((w) => !w.text.trim())}
                  onClick={run}
                >
                  {busy
                    ? "Computing…"
                    : wordings.length > 1
                      ? `Compare ${wordings.length} wordings`
                      : "What would this cost?"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || wordings.length >= 4}
                  onClick={() =>
                    setWordings((all) => [
                      ...all,
                      {
                        id: Math.max(0, ...all.map((x) => x.id)) + 1,
                        text: current.text,
                        scope: [...consumers],
                      },
                    ])
                  }
                >
                  <Plus data-icon="inline-start" />
                  Add another wording to compare
                </Button>
                <span className="text-xs text-dim">
                  Asking writes nothing. The base version&rsquo;s content hash
                  is returned before and after so you can check that rather than
                  trust it.
                </span>
              </div>
            </section>

            {error && (
              <ErrorNote hint={error.hint} requestId={error.requestId}>
                {error.userMessage}
              </ErrorNote>
            )}

            {/* ------------------------------------- staleness, up front */}
            {/* Before a wording exists there is still an answer: what changing
                this requirement at all would invalidate, redo and recheck kept
                apart. It steps aside once a costed report or comparison is on
                screen, which carries the same lists with the arithmetic. */}
            {!report && !comparison && !busy && (
              <ErrorBoundary
                what="The staleness preview"
                resetKey={current.key}
              >
                <RequirementStaleness
                  key={current.key}
                  projectId={projectId}
                  requirementKey={current.key}
                />
              </ErrorBoundary>
            )}

            {/* ------------------------------------------------ result */}
            {report && (
              <ErrorBoundary what="The impact report" resetKey={current.key}>
                <ImpactReport
                  report={report}
                  applying={applying}
                  applied={applied}
                  applyError={
                    applyError && (
                      <ErrorNote
                        hint={applyError.hint}
                        requestId={applyError.requestId}
                      >
                        Nothing was applied. {applyError.userMessage}
                      </ErrorNote>
                    )
                  }
                  onApply={() =>
                    apply(
                      report.proposed_text,
                      report.scoped ? report.seeds_used : undefined,
                    )
                  }
                />
              </ErrorBoundary>
            )}

            {comparison && (
              <>
                <ComparisonView
                  comparison={comparison}
                  opened={opened}
                  onOpen={(i) => setOpened((o) => (o === i ? null : i))}
                />
                {openedOption && (
                  <div className="border-t border-line pt-4">
                    <p className="mb-3 text-[12px] font-medium tracking-wider text-dim uppercase">
                      {openedOption.label} in full
                    </p>
                    <ErrorBoundary
                      what="The impact report"
                      resetKey={`${current.key}:${openedOption.index}`}
                    >
                      <ImpactReport
                        report={openedOption.impact}
                        applying={applying}
                        applied={applied}
                        applyError={
                          applyError && (
                            <ErrorNote
                              hint={applyError.hint}
                              requestId={applyError.requestId}
                            >
                              Nothing was applied. {applyError.userMessage}
                            </ErrorNote>
                          )
                        }
                        onApply={() =>
                          apply(
                            openedOption.text,
                            openedOption.scoped
                              ? openedOption.invalidates
                              : undefined,
                          )
                        }
                      />
                    </ErrorBoundary>
                  </div>
                )}
                {/* The comparison carries its own assumptions block; it is the
                    same set the report shows, so it is rendered once, here,
                    when no individual report is open. */}
                {!openedOption &&
                  assumptionSentences(comparison.assumptions).length > 0 && (
                    <section className="border-t border-line pt-2 text-xs">
                      <div className="mb-1.5 font-medium tracking-wider text-dim uppercase">
                        What this comparison rests on
                      </div>
                      <dl className="flex flex-col gap-1.5">
                        {assumptionSentences(comparison.assumptions).map(
                          ({ key, text }) => (
                            <div key={key}>
                              <dt className="font-medium text-foreground/90">
                                {humanizeKey(key)}
                              </dt>
                              <dd className="text-dim">{text}</dd>
                            </div>
                          ),
                        )}
                      </dl>
                    </section>
                  )}
              </>
            )}

            {applied && (
              <p className="text-xs text-dim">
                Workflow version {applied.new_version?.version_no ?? "?"} is now
                current. The other stages still hold version{" "}
                {workflow.version.version_no} until you reload the project.
              </p>
            )}

            {/* --------------------------------------------- provenance */}
            <section className="border-t border-line pt-4">
              <ErrorBoundary
                what="The requirement history"
                resetKey={current.key}
              >
                <RequirementHistory
                  key={current.key}
                  projectId={projectId}
                  requirementKey={current.key}
                  refreshKey={historyKey}
                />
              </ErrorBoundary>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
