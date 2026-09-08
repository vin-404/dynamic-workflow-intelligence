"use client";

/**
 * Capability 2 - predicted risk, with the factor decomposition visible.
 *
 * The score is never shown alone. Every task expands into its nine factors,
 * each with its value, its weight, the product, and a sentence explaining
 * what the number is reading. The weights are on screen and adjustable,
 * because "this task is riskier" means nothing if the weights are invisible.
 *
 * And it is labelled for what it is: a structural estimate, not a
 * probability. The three-point range is three deterministic schedule runs,
 * and the panel says so where the range appears.
 *
 * Phase 11 put a real probability on this same stage, in the forecast panel
 * below. Nothing here was softened for it - the disclaimer, the
 * `is_probability: false` labelling and the three-point method note are all
 * byte-identical. What changed is that the two sentences the backend added to
 * keep the two numbers apart are now on screen, and the block explaining why
 * *this* range carries no percentage came out of its disclosure, because a
 * reader who never opens a triangle now has a percentage on the same screen
 * and no account of why this number is not one.
 *
 * Layout follows from that: the nine-factor table is the largest thing on the
 * stage and the score is a single small figure beside its task's name. The
 * table is never collapsed - picking a row in the exposure list re-points it,
 * so all nine factors are on screen without any interaction at all.
 */

import { useState } from "react";
import { Analysis, RiskFactor, TaskRisk } from "@/lib/api";
import { cn } from "@/lib/utils";
import { bandClasses, bandText, severityFill } from "@/lib/severity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Assumptions, Worked, days } from "./ui";

/**
 * Read a documented-but-untyped string off a payload block.
 *
 * `lib/api.ts` types `risk.assumptions` and `three_point.monte_carlo` as
 * closed objects, and that file belongs to the integrator. Phase 11's backend
 * added three sentences to those two blocks whose entire job is to keep the
 * structural score and the forecast from being read against each other. The
 * client's own rule is that the honesty layer must not need a type update to
 * become visible - so they are read defensively here rather than left off the
 * screen until someone widens an interface. A missing key renders nothing;
 * it never renders `undefined`.
 */
function prose(block: object, key: string): string | null {
  const v = (block as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/**
 * A risk *band* is `low` / `moderate` / `high`; `severityFill` speaks
 * `low` / `medium` / `high`. This is the word alias between them, not a
 * second colour mapping - the classes still come from `severity.ts`.
 */
function bandFill(band: string): string {
  return severityFill(
    band === "high" ? "high" : band === "moderate" ? "medium" : "low",
  );
}

export default function RiskPanel({
  analysis,
  onReweight,
  busy,
}: {
  analysis: Analysis;
  onReweight: (weights: Record<string, number>) => void;
  busy: boolean;
}) {
  const risk = analysis.risk;
  const [weights, setWeights] = useState(risk.assumptions.weights);
  const [selected, setSelected] = useState<string | null>(
    risk.top[0]?.task_key ?? null,
  );

  if (risk.tasks.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
        <p className="text-sm font-medium">Nothing to score yet</p>
        <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
          Add some tasks and the risk panel will rank them by how exposed they
          are — with the arithmetic on show.
        </p>
      </div>
    );
  }

  const tp = analysis.feasibility.three_point;
  const focus =
    risk.tasks.find((t) => t.task_key === selected) ??
    risk.top[0] ??
    risk.tasks[0];
  const weightsTotal = Object.values(weights).reduce((a, b) => a + b, 0);

  return (
    <div className="flex flex-col gap-7">
      {/* ------------------------------------------------------ feasibility */}
      <section className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">
          Feasibility
        </h3>
        <p className="max-w-4xl text-sm">{analysis.feasibility.statement}</p>

        {tp && (
          <>
            <div className="grid grid-cols-3 divide-x divide-border border-y border-border">
              {(["optimistic", "likely", "pessimistic"] as const).map((band) => {
                const day = tp[`${band}_day` as const];
                const verdict = tp.verdicts[band];
                const feasible = verdict === "feasible";
                return (
                  <div key={band} className="px-3 py-2">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {band}
                    </div>
                    <div
                      className={cn(
                        "text-lg font-semibold leading-tight",
                        /* the band vocabulary, three states, from severity.ts */
                        bandText(feasible ? "low" : "high"),
                      )}
                    >
                      day {Math.round(day)}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {feasible
                        ? "meets the deadline"
                        : verdict.replace(/_/g, " ")}
                    </div>
                  </div>
                );
              })}
            </div>

            <dl className="flex flex-wrap gap-x-5 gap-y-0.5 text-[11px]">
              <div className="flex gap-1.5">
                <dt className="text-muted-foreground">spread</dt>
                <dd>{days(tp.spread_days)}</dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="text-muted-foreground">margin</dt>
                <dd>{days(analysis.feasibility.margin_days, true)}</dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="text-muted-foreground">deadline</dt>
                <dd>
                  {tp.deadline_day === null ? "none set" : `day ${tp.deadline_day}`}
                </dd>
              </div>
            </dl>

            <p className="max-w-4xl text-xs text-muted-foreground">
              {tp.method}
            </p>

            {/*
              * Open, not a disclosure (D-105). This is the block that says
              * why the range above is not a likelihood, and there is now a
              * genuine probability further down the same stage - so leaving
              * it one click away is leaving the two numbers one click away
              * from being confused.
              */}
            <div className="flex max-w-4xl flex-col gap-1 border-l border-border pl-3 text-xs">
              <p className="text-[11px] font-medium tracking-wider uppercase text-muted-foreground">
                Why this range carries no percentage
              </p>
              <p className="text-foreground/90">{tp.monte_carlo.why}</p>
              <p className="text-muted-foreground">
                It would report: {tp.monte_carlo.what_it_would_report}
              </p>
              <p className="text-severity-medium">
                {tp.monte_carlo.why_not_faked}
              </p>
              {prose(tp.monte_carlo, "now_computable_separately") && (
                <p className="text-muted-foreground">
                  {prose(tp.monte_carlo, "now_computable_separately")}
                </p>
              )}
            </div>
          </>
        )}
      </section>

      {/* -------------------------------------------------- per-task exposure */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">
            Per-task exposure
          </h3>
          <span className="ml-auto text-xs text-muted-foreground">
            {risk.band_counts.high} high · {risk.band_counts.moderate} moderate
            · {risk.band_counts.low} low
          </span>
        </div>

        {/* The disclaimer sits above every number it applies to, unfolded. */}
        <p className="max-w-4xl text-xs text-muted-foreground">
          {risk.assumptions.disclaimer}
        </p>
        {/*
          * The sentence that keeps this number and the forecast's apart. It
          * belongs beside the score rather than in the assumptions block at
          * the foot of the section, because the mistake it prevents is made
          * while looking at the ranking.
          */}
        {prose(risk.assumptions, "score_kind_is_not_the_forecast_kind") && (
          <p className="max-w-4xl text-xs text-severity-medium">
            {prose(risk.assumptions, "score_kind_is_not_the_forecast_kind")}
          </p>
        )}

        <FactorTable task={focus} />

        <div>
          <div className="flex items-baseline gap-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            <span>all {risk.tasks.length} tasks, ranked</span>
            <span className="ml-auto">pick one to decompose it above</span>
          </div>
          <div className="divide-y divide-border border-y border-border">
            {risk.tasks.map((task, i) => (
              <button
                key={task.task_key}
                onClick={() => setSelected(task.task_key)}
                aria-current={task.task_key === focus.task_key}
                className={cn(
                  "flex w-full items-center gap-3 px-1.5 py-1 text-left transition-colors hover:bg-muted/60",
                  task.task_key === focus.task_key && "bg-muted",
                )}
              >
                <span className="w-5 shrink-0 text-right text-[11px] text-muted-foreground">
                  {i + 1}
                </span>
                <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">
                  {task.task_key}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {task.task_name}
                </span>
                <span className="hidden h-1.5 w-32 shrink-0 overflow-hidden rounded-full bg-muted sm:block">
                  <span
                    className={cn("block h-full", bandFill(task.band))}
                    style={{ width: `${Math.min(task.score * 100, 100)}%` }}
                  />
                </span>
                <span className="w-9 shrink-0 text-right text-[13px] font-semibold">
                  {task.score.toFixed(2)}
                </span>
                <span
                  className={cn(
                    "w-16 shrink-0 text-right text-[11px]",
                    bandText(task.band),
                  )}
                >
                  {task.band}
                </span>
              </button>
            ))}
          </div>
        </div>

        <Assumptions
          disclaimer={risk.assumptions.what_would_make_this_a_probability}
          entries={[
            ["Score kind", risk.assumptions.score_kind.replace(/_/g, " ")],
            ["Formula", <code key="f">{risk.assumptions.formula}</code>],
            [
              "Duration spread",
              `${Math.round(risk.assumptions.duration_spread.relative_spread * 100)}% (${risk.assumptions.duration_spread.provenance})`,
            ],
            [
              "Tasks with a real estimate",
              risk.assumptions.duration_spread.tasks_with_three_point_estimate
                .length || "none",
            ],
            ["Rework modelled", risk.assumptions.rework_modelled ? "yes" : "no"],
            ["Monte Carlo run", risk.assumptions.monte_carlo_run ? "yes" : "no"],
            [
              "A probability, separately",
              prose(risk.assumptions, "forecast_offered_separately") ??
                "The forecast panel below samples the same three-point estimates and reports a probability. It is a different number on a different scale.",
            ],
            [
              "Factors unavailable",
              risk.assumptions.factors_unavailable.length
                ? risk.assumptions.factors_unavailable.join(", ")
                : "none",
            ],
          ]}
        />
        {risk.assumptions.factors_unavailable.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            {risk.assumptions.factors_unavailable_note}
          </p>
        )}
      </section>

      {/* ---------------------------------------------------------- weights */}
      <section className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">
          The weights are yours to move
        </h3>
        <p className="max-w-4xl text-xs text-muted-foreground">
          These are inputs, not findings. Change one and the ranking changes —
          which is the point of showing them instead of blending them away.
        </p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
          {Object.entries(weights).map(([name, value]) => (
            <label key={name} className="flex flex-col gap-0.5">
              <span className="text-[11px] text-muted-foreground">
                {name.replace(/_/g, " ")}
              </span>
              <Input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={value}
                className="h-7"
                onChange={(e) =>
                  setWeights({ ...weights, [name]: Number(e.target.value) })
                }
              />
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => onReweight(weights)}>
            Re-rank with these weights
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setWeights(risk.assumptions.weights)}
          >
            Reset
          </Button>
          <span className="text-xs text-muted-foreground">
            total {weightsTotal.toFixed(2)}
          </span>
        </div>
      </section>
    </div>
  );
}

/**
 * The nine factors, always open, for whichever task is selected.
 *
 * The bar is the point: the solid part is the contribution, the faint part
 * behind it is that factor's weight - the ceiling it could have reached. Both
 * are scaled against the largest weight in the set, so bar lengths compare
 * across rows instead of each one being normalised to itself.
 */
function FactorTable({ task }: { task: TaskRisk }) {
  const ceiling = Math.max(...task.factors.map((f) => f.weight), 0.01);
  const fill = bandFill(task.band);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="text-sm font-semibold">Factor decomposition</h4>
        <span className="font-mono text-xs text-muted-foreground">
          {task.task_key}
        </span>
        <span className="text-[13px]">{task.task_name}</span>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">
          score
        </span>
        <span className={cn("text-[13px] font-semibold", bandText(task.band))}>
          {task.score.toFixed(3)}
        </span>
        <Badge variant="outline" className={bandClasses(task.band)}>
          {task.band}
        </Badge>
      </div>

      <p className="max-w-4xl text-[13px] leading-snug text-foreground/90">
        {task.explanation}
      </p>

      <Table className="text-xs">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="h-7 px-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              Factor
            </TableHead>
            <TableHead className="h-7 w-14 px-1.5 text-right text-[10px] uppercase tracking-wider text-muted-foreground">
              Value
            </TableHead>
            <TableHead className="h-7 w-14 px-1.5 text-right text-[10px] uppercase tracking-wider text-muted-foreground">
              Weight
            </TableHead>
            <TableHead className="h-7 w-44 px-1.5 text-right text-[10px] uppercase tracking-wider text-muted-foreground">
              Contrib.
            </TableHead>
            <TableHead className="h-7 px-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              Reading
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...task.factors]
            .sort((a, b) => b.contribution - a.contribution)
            .map((factor) => (
              <FactorRow
                key={factor.name}
                factor={factor}
                ceiling={ceiling}
                fill={fill}
              />
            ))}
        </TableBody>
        <TableFooter className="bg-transparent">
          <TableRow className="hover:bg-transparent">
            <TableCell className="px-1.5 py-1 text-muted-foreground">
              total
            </TableCell>
            <TableCell />
            <TableCell className="px-1.5 py-1 text-right text-muted-foreground">
              {task.factors
                .reduce((a, f) => a + f.weight, 0)
                .toFixed(2)}
            </TableCell>
            <TableCell className="px-1.5 py-1 text-right font-semibold">
              {task.score.toFixed(3)}
            </TableCell>
            <TableCell className="px-1.5 py-1 whitespace-normal">
              <Worked>{task.formula}</Worked>
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

function FactorRow({
  factor,
  ceiling,
  fill,
}: {
  factor: RiskFactor;
  ceiling: number;
  fill: string;
}) {
  const pct = (v: number) => `${Math.min((v / ceiling) * 100, 100)}%`;
  return (
    <TableRow className={cn("hover:bg-muted/40", !factor.available && "opacity-60")}>
      <TableCell className="px-1.5 py-1 font-medium">
        <span className="flex items-center gap-1.5">
          {factor.name.replace(/_/g, " ")}
          {!factor.available && (
            <Badge
              variant="outline"
              title="Could not be measured, so it contributes 0"
            >
              n/a
            </Badge>
          )}
        </span>
      </TableCell>
      <TableCell className="px-1.5 py-1 text-right font-mono">
        {factor.value.toFixed(2)}
      </TableCell>
      <TableCell className="px-1.5 py-1 text-right font-mono text-muted-foreground">
        {factor.weight.toFixed(2)}
      </TableCell>
      <TableCell className="px-1.5 py-1">
        <span className="flex items-center gap-2">
          <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 bg-foreground/15"
              style={{ width: pct(factor.weight) }}
            />
            <span
              aria-hidden
              className={cn("absolute inset-y-0 left-0", fill)}
              style={{ width: pct(factor.contribution) }}
            />
          </span>
          <span className="w-11 shrink-0 text-right font-mono">
            {factor.contribution.toFixed(3)}
          </span>
        </span>
      </TableCell>
      <TableCell className="px-1.5 py-1 whitespace-normal text-muted-foreground">
        {factor.reason}
      </TableCell>
    </TableRow>
  );
}
