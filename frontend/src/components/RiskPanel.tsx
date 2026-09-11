"use client";

/**
 * Capability 2 - predicted risk, with the factor decomposition visible.
 *
 * The score is never shown alone. Every task's nine factors are drawn as a
 * stacked bar - nine muted shades, one per factor, hover a segment for its
 * name, weight, value and reading - and the full table with every reading
 * opens under the row. The weights are on screen and adjustable, because
 * "this task is riskier" means nothing if the weights are invisible.
 *
 * And it is labelled for what it is: a structural exposure, not a
 * probability. The three-point range is three deterministic schedule runs,
 * drawn as a band with the deadline through it, and one line under the band
 * says so; the engine's full account of why the range carries no percentage
 * is one click away, verbatim (design brief §2.2, §4 Risk & forecast).
 *
 * The sampled forecast - a genuine probability, on a different scale - is a
 * separate panel the host slots in between the range and the exposure list,
 * with its own band and its own label, so the two numbers are never adjacent
 * without their names.
 *
 * Moving a weight asks the engine. This panel does no arithmetic of its own:
 * `onReweight` hands the weights to the host, which posts them to `/risk`
 * and replaces the whole risk block with what comes back - scores, bands and
 * the echoed weights. While that request is out, the numbers on screen are
 * the *old* weights' answer, so the exposure section is dimmed and labelled
 * "recomputing" rather than left looking current. If it fails, the failure
 * is shown beside the weights and the old ranking stays visibly old.
 */

import { ReactNode, useState } from "react";
import { ChevronRightIcon, LoaderCircle } from "lucide-react";
import { Analysis, ApiError, RiskFactor, TaskRisk } from "@/lib/api";
import { cn } from "@/lib/utils";
import { bandClasses, bandText } from "@/lib/severity";
import {
  FACTOR_ORDER,
  bandLabel,
  factorLabel,
  humanize,
  prose as proseWords,
  provenanceLabel,
  scoreKindLabel,
  verdictLabel,
} from "@/lib/display";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Assumptions, ErrorNote, Worked, days } from "./ui";

const SUMMARY =
  "flex cursor-pointer list-none items-center gap-1 marker:content-none [&::-webkit-details-marker]:hidden";

/**
 * Read a documented-but-untyped string off a payload block.
 *
 * `lib/api.ts` types `risk.assumptions` and `three_point.monte_carlo` as
 * closed objects. The backend added sentences to those blocks whose job is
 * to keep the structural score and the forecast from being read against
 * each other; they are read defensively here so the honesty layer never
 * needs a type update to become visible. A missing key renders nothing.
 */
function readProse(block: object, key: string): string | null {
  const v = (block as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/**
 * Nine muted shades, one per factor, in `FACTOR_ORDER` so a segment's colour
 * means the same thing on every row. Low chroma on purpose: magnitude is
 * the length, the hue is only identity, and none of these is the warm
 * colour the critical chain owns or the green a good band owns.
 */
const FACTOR_SHADES = [
  "#5b6b8c",
  "#7d8fb3",
  "#9aa8c4",
  "#6f8a8a",
  "#94aaa4",
  "#8c8298",
  "#ab9fb4",
  "#a09a8a",
  "#c2bcae",
];

function factorShade(name: string): string {
  const i = FACTOR_ORDER.indexOf(name);
  return FACTOR_SHADES[i === -1 ? FACTOR_SHADES.length - 1 : i];
}

/* ==========================================================================
 * The panel
 * ======================================================================== */

export default function RiskPanel({
  analysis,
  onReweight,
  busy,
  reweighting = false,
  reweightError = null,
  forecast,
}: {
  analysis: Analysis;
  /** Hands the weights to the engine. The host owns the request. */
  onReweight: (weights: Record<string, number>) => void;
  busy: boolean;
  /** True while the engine is re-scoring with new weights. */
  reweighting?: boolean;
  /** The engine's refusal or failure to re-score, shown by the weights. */
  reweightError?: ApiError | null;
  /** The sampled forecast panel, slotted between the range and the exposure. */
  forecast?: ReactNode;
}) {
  const risk = analysis.risk;
  const [weights, setWeights] = useState(risk.assumptions.weights);
  // The engine's defaults are whatever it echoed on first mount, before the
  // reader moved anything. Kept so "Reset" means "back to the engine's
  // weights" and not "back to the last thing I typed".
  const [defaults] = useState(risk.assumptions.weights);
  const [open, setOpen] = useState<string | null>(null);

  if (risk.tasks.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
        <p className="text-[14px] font-medium">Nothing to score yet</p>
        <p className="mx-auto mt-1 max-w-lg text-[14px] text-muted-foreground">
          Add some tasks and the risk panel will rank them by how exposed they
          are — with the arithmetic on show.
        </p>
      </div>
    );
  }

  const tp = analysis.feasibility.three_point;
  const weightsTotal = Object.values(weights).reduce((a, b) => a + b, 0);
  const maxScore = Math.max(0.01, ...risk.tasks.map((t) => t.score));

  return (
    <div className="flex flex-col gap-8">
      {/* ------------------------------------------------------ three-point */}
      {tp && (
        <section className="flex flex-col gap-3" data-panel="three-point">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="text-[18px] font-semibold">Three-point range</h3>
            <span className="text-[12px] text-dim">
              spread {days(tp.spread_days)} · margin {days(analysis.feasibility.margin_days, true)} ·
              deadline {tp.deadline_day === null ? "none set" : `day ${tp.deadline_day}`}
            </span>
          </div>

          <p className="max-w-4xl text-[14px]">{analysis.feasibility.statement}</p>

          <RangeBand
            optimistic={tp.optimistic_day}
            likely={tp.likely_day}
            pessimistic={tp.pessimistic_day}
            deadline={tp.deadline_day}
            today={analysis.today_day}
          />

          <div className="grid grid-cols-3 divide-x divide-line rounded-xl border border-line bg-panel">
            {(["optimistic", "likely", "pessimistic"] as const).map((band) => {
              const dayValue = tp[`${band}_day` as const];
              const verdict = tp.verdicts[band];
              const feasible = verdict === "feasible";
              return (
                <div key={band} className="px-5 py-3">
                  <div className="text-[12px] text-dim">{bandLabel(band)}</div>
                  <div
                    className={cn(
                      "mt-1 text-[36px] font-semibold leading-none tracking-[-0.02em]",
                      band === "likely" ? "" : feasible ? "text-severity-low" : "text-critical",
                    )}
                  >
                    day {Math.round(dayValue)}
                  </div>
                  <div className="mt-1.5 text-[12px] text-dim">
                    {feasible ? "meets the deadline" : verdictLabel(verdict)}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[14px]">
            <span className="font-medium">
              Three deterministic runs — a range, not a probability.
            </span>
            <details className="group">
              <summary className={cn(SUMMARY, "text-accent hover:underline")}>
                <ChevronRightIcon aria-hidden className="size-3.5 transition-transform group-open:rotate-90" />
                Why?
              </summary>
              <div className="mt-2 flex max-w-4xl flex-col gap-2 border-l border-line pl-3 text-[12px]">
                <p className="text-foreground/90">{tp.method}</p>
                <p className="font-medium text-dim">Why this range carries no percentage</p>
                <p className="text-foreground/90">{tp.monte_carlo.why}</p>
                <p className="text-dim">It would report: {tp.monte_carlo.what_it_would_report}</p>
                <p className="text-severity-medium">{tp.monte_carlo.why_not_faked}</p>
                {readProse(tp.monte_carlo, "now_computable_separately") && (
                  <p className="text-dim">{readProse(tp.monte_carlo, "now_computable_separately")}</p>
                )}
              </div>
            </details>
          </div>
        </section>
      )}

      {/* ----------------------------------------------- the sampled forecast */}
      {forecast}

      {/* -------------------------------------------------- per-task exposure */}
      <section
        className={cn("flex flex-col gap-3 transition-opacity", reweighting && "pointer-events-none opacity-50")}
        aria-busy={reweighting || undefined}
        data-panel="exposure"
      >
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-[18px] font-semibold">Per-task exposure</h3>
          {reweighting && (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-dim">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
              recomputing on the engine with your weights — the figures below are the
              previous weights&apos; answer
            </span>
          )}
          <span className="ml-auto text-[12px] text-dim">
            {risk.band_counts.high} high · {risk.band_counts.moderate} moderate
            · {risk.band_counts.low} low
          </span>
        </div>

        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[14px]">
          <span className="font-medium">
            {scoreKindLabel(risk.assumptions.score_kind)} — not a probability.
          </span>
          <details className="group">
            <summary className={cn(SUMMARY, "text-accent hover:underline")}>
              <ChevronRightIcon aria-hidden className="size-3.5 transition-transform group-open:rotate-90" />
              How this is scored
            </summary>
            <div className="mt-2 flex max-w-4xl flex-col gap-2 border-l border-line pl-3 text-[12px]">
              <p className="text-foreground/90">{risk.assumptions.disclaimer}</p>
              {readProse(risk.assumptions, "score_kind_is_not_the_forecast_kind") && (
                <p className="text-severity-medium">
                  {readProse(risk.assumptions, "score_kind_is_not_the_forecast_kind")}
                </p>
              )}
              <Assumptions
                disclaimer={risk.assumptions.what_would_make_this_a_probability}
                entries={[
                  ["Score kind", scoreKindLabel(risk.assumptions.score_kind)],
                  ["Formula", <code key="f">{risk.assumptions.formula}</code>],
                  [
                    "Duration spread",
                    `${Math.round(risk.assumptions.duration_spread.relative_spread * 100)}% (${provenanceLabel(risk.assumptions.duration_spread.provenance)})`,
                  ],
                  [
                    "Tasks with a real estimate",
                    risk.assumptions.duration_spread.tasks_with_three_point_estimate.length || "none",
                  ],
                  ["Rework modelled", risk.assumptions.rework_modelled ? "yes" : "no"],
                  ["Monte Carlo run", risk.assumptions.monte_carlo_run ? "yes" : "no"],
                  [
                    "A probability, separately",
                    readProse(risk.assumptions, "forecast_offered_separately") ??
                      "The forecast panel samples the same three-point estimates and reports a probability. It is a different number on a different scale.",
                  ],
                  [
                    "Factors unavailable",
                    risk.assumptions.factors_unavailable.length
                      ? risk.assumptions.factors_unavailable.map(factorLabel).join(", ")
                      : "none",
                  ],
                ]}
              />
              {risk.assumptions.factors_unavailable.length > 0 && (
                <p className="text-dim">{risk.assumptions.factors_unavailable_note}</p>
              )}
            </div>
          </details>
        </div>

        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          {risk.tasks.map((task, i) => (
            <ExposureRow
              key={task.task_key}
              task={task}
              rank={i + 1}
              maxScore={maxScore}
              open={open === task.task_key}
              onToggle={() => setOpen(open === task.task_key ? null : task.task_key)}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-dim">
          <span className="font-medium text-foreground">Factor decomposition</span>
          {FACTOR_ORDER.map((name) => (
            <span key={name} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block size-2.5 rounded-[3px]"
                style={{ background: factorShade(name) }}
              />
              {factorLabel(name)}
            </span>
          ))}
          <span className="ml-auto">hover a segment · open a row for every reading</span>
        </div>
      </section>

      {/* ---------------------------------------------------------- weights */}
      <details className="group rounded-xl border border-line bg-panel" open data-panel="weights">
        <summary className={cn(SUMMARY, "px-5 py-3 text-[18px] font-semibold")}>
          <ChevronRightIcon aria-hidden className="size-4 transition-transform group-open:rotate-90" />
          The weights are yours to move
        </summary>
        <section className="flex flex-col gap-3 border-t border-line px-5 py-4">
          <p className="max-w-4xl text-[14px] text-dim">
            These are inputs, not findings. Change one and the ranking changes — which is
            the point of showing them instead of blending them away.
          </p>
          <div className="grid grid-cols-3 gap-x-4 gap-y-2 sm:grid-cols-5 lg:grid-cols-9">
            {Object.entries(weights).map(([name, value]) => (
              <label key={name} className="flex flex-col gap-1">
                {/* The factor's words, lower-case: this label is the field's
                    name in a form, and the walkthrough reads the key back from
                    it, so it stays "downstream fan out", not "fan-out". */}
                <span className="flex items-center gap-1.5 text-[12px] text-dim">
                  <span
                    aria-hidden
                    className="inline-block size-2 shrink-0 rounded-[2px]"
                    style={{ background: factorShade(name) }}
                  />
                  {humanize(name).toLowerCase()}
                </span>
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={value}
                  className="h-8"
                  onChange={(e) => setWeights({ ...weights, [name]: Number(e.target.value) })}
                />
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => onReweight(weights)}>
              Re-rank with these weights
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setWeights(defaults)}>
              Reset
            </Button>
            <span className="text-[12px] text-dim">
              total {weightsTotal.toFixed(2)}
              {reweighting && " · recomputing…"}
              {" · "}The re-scoring happens on the engine, which returns every score and
              band; nothing is recomputed in this page.
            </span>
          </div>
          {reweightError && (
            <ErrorNote
              hint={reweightError.hint}
              requestId={reweightError.requestId}
              onRetry={() => onReweight(weights)}
            >
              The engine did not re-score with these weights. {reweightError.userMessage} The
              ranking above is still the previous weights&apos; answer.
            </ErrorNote>
          )}
        </section>
      </details>
    </div>
  );
}

/* ==========================================================================
 * The three-point band
 * ======================================================================== */

/**
 * Optimistic to pessimistic as a horizontal band, the likely day as a
 * marker, the deadline as a line through it. Every position is one of the
 * engine's days on a linear day scale; nothing is estimated here.
 */
function RangeBand({
  optimistic,
  likely,
  pessimistic,
  deadline,
  today,
}: {
  optimistic: number;
  likely: number;
  pessimistic: number;
  deadline: number | null;
  today: number;
}) {
  const points = [optimistic, pessimistic, likely, today, ...(deadline === null ? [] : [deadline])];
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const pad = Math.max(1, (hi - lo) * 0.08);
  const from = Math.floor(lo - pad);
  const to = Math.ceil(hi + pad);
  const x = (d: number) => `${((d - from) / (to - from)) * 100}%`;

  return (
    <div className="relative mt-4 mb-1 h-16" role="img" aria-label={`Optimistic day ${Math.round(optimistic)}, likely day ${Math.round(likely)}, pessimistic day ${Math.round(pessimistic)}${deadline === null ? "" : `, deadline day ${deadline}`}`}>
      {/* track */}
      <div className="absolute inset-x-0 top-7 h-3 rounded-full bg-panel2" />
      {/* the range */}
      <div
        className="absolute top-7 h-3 rounded-full bg-dim/35"
        style={{ left: x(optimistic), width: `calc(${x(pessimistic)} - ${x(optimistic)})` }}
      />
      {/* likely */}
      <div className="absolute top-5 h-7 w-[3px] -translate-x-1/2 rounded-full bg-foreground" style={{ left: x(likely) }} />
      <span className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-[12px] font-medium" style={{ left: x(likely) }}>
        likely · day {Math.round(likely)}
      </span>
      {/* ends */}
      <span className="absolute top-11 -translate-x-1/2 whitespace-nowrap text-[12px] text-dim" style={{ left: x(optimistic) }}>
        day {Math.round(optimistic)}
      </span>
      <span className="absolute top-11 -translate-x-1/2 whitespace-nowrap text-[12px] text-dim" style={{ left: x(pessimistic) }}>
        day {Math.round(pessimistic)}
      </span>
      {/* today */}
      <div className="absolute top-6 h-5 w-px -translate-x-1/2 bg-foreground/50" style={{ left: x(today) }} />
      <span className="absolute top-11 -translate-x-1/2 whitespace-nowrap text-[12px] text-dim" style={{ left: x(today) }}>
        today
      </span>
      {/* deadline */}
      {deadline !== null && (
        <>
          <div className="absolute top-4 h-9 w-0.5 -translate-x-1/2 border-l-2 border-dashed border-critical" style={{ left: x(deadline) }} />
          <span className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-[12px] font-medium text-critical" style={{ left: x(deadline) }}>
            deadline · day {deadline}
          </span>
        </>
      )}
    </div>
  );
}

/* ==========================================================================
 * One task's exposure: a stacked bar of nine factors, the table beneath
 * ======================================================================== */

function ExposureRow({
  task,
  rank,
  maxScore,
  open,
  onToggle,
}: {
  task: TaskRisk;
  rank: number;
  maxScore: number;
  open: boolean;
  onToggle: () => void;
}) {
  const ordered = [...task.factors].sort(
    (a, b) => FACTOR_ORDER.indexOf(a.name) - FACTOR_ORDER.indexOf(b.name),
  );
  const barWidth = `${Math.min(100, (task.score / maxScore) * 100)}%`;

  return (
    <div className={cn("border-b border-line last:border-b-0", open && "bg-panel2/40")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-panel2/60"
      >
        <span className="w-5 shrink-0 text-right text-[12px] text-dim">{rank}</span>
        <span className="w-9 shrink-0 font-mono text-[12px] text-dim">{task.task_key}</span>
        <span className="w-44 min-w-0 shrink-0 truncate text-[14px] sm:w-56" title={task.task_name}>
          {task.task_name}
        </span>

        <span className="relative h-3 min-w-0 flex-1 overflow-hidden rounded-full bg-panel2">
          <span className="absolute inset-y-0 left-0 flex" style={{ width: barWidth }}>
            {ordered.map((factor) => (
              <Segment key={factor.name} factor={factor} score={task.score} />
            ))}
          </span>
        </span>

        <span className="w-12 shrink-0 text-right text-[14px] font-semibold">{task.score.toFixed(2)}</span>
        <Badge variant="outline" className={cn("w-[84px] justify-center text-[12px]", bandClasses(task.band))}>
          {bandLabel(task.band)}
        </Badge>
        <ChevronRightIcon
          aria-hidden
          className={cn("size-4 shrink-0 text-dim transition-transform", open && "rotate-90")}
        />
      </button>

      {open && (
        <div className="border-t border-line/60 px-3 pb-4 pt-3">
          <FactorTable task={task} />
        </div>
      )}
    </div>
  );
}

function Segment({ factor, score }: { factor: RiskFactor; score: number }) {
  const share = score > 0 ? Math.max(0, factor.contribution) / score : 0;
  if (share <= 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="block h-full border-r border-white/60 last:border-r-0"
          style={{ width: `${share * 100}%`, background: factorShade(factor.name) }}
        />
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <span className="flex flex-col gap-0.5 text-left">
          <span className="font-medium">{factorLabel(factor.name)}</span>
          <span className="opacity-80">
            weight {factor.weight.toFixed(2)} × value {factor.value.toFixed(2)} ={" "}
            {factor.contribution.toFixed(3)}
          </span>
          <span className="opacity-80">{proseWords(factor.reason)}</span>
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The nine factors with every reading, for one task.
 *
 * The bar is the point: the solid part is the contribution, the faint part
 * behind it is that factor's weight - the ceiling it could have reached. Both
 * are scaled against the largest weight in the set, so bar lengths compare
 * across rows instead of each one being normalised to itself.
 */
function FactorTable({ task }: { task: TaskRisk }) {
  const ceiling = Math.max(...task.factors.map((f) => f.weight), 0.01);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="text-[14px] font-semibold">How this was scored</h4>
        <span className="font-mono text-[12px] text-dim">{task.task_key}</span>
        <span className="text-[14px]">{task.task_name}</span>
        <span className="ml-auto text-[12px] text-dim">score</span>
        <span className={cn("text-[14px] font-semibold", bandText(task.band))}>{task.score.toFixed(3)}</span>
        <Badge variant="outline" className={bandClasses(task.band)}>
          {bandLabel(task.band)}
        </Badge>
      </div>

      <p className="max-w-4xl text-[12px] leading-snug text-foreground/90">{task.explanation}</p>

      <Table className="text-[12px]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="h-7 px-1.5 text-[12px] uppercase tracking-wider text-muted-foreground">Factor</TableHead>
            <TableHead className="h-7 w-14 px-1.5 text-right text-[12px] uppercase tracking-wider text-muted-foreground">Value</TableHead>
            <TableHead className="h-7 w-14 px-1.5 text-right text-[12px] uppercase tracking-wider text-muted-foreground">Weight</TableHead>
            <TableHead className="h-7 w-44 px-1.5 text-right text-[12px] uppercase tracking-wider text-muted-foreground">Contrib.</TableHead>
            <TableHead className="h-7 px-1.5 text-[12px] uppercase tracking-wider text-muted-foreground">Reading</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...task.factors]
            .sort((a, b) => b.contribution - a.contribution)
            .map((factor) => (
              <FactorRow key={factor.name} factor={factor} ceiling={ceiling} />
            ))}
        </TableBody>
        <TableFooter className="bg-transparent">
          <TableRow className="hover:bg-transparent">
            <TableCell className="px-1.5 py-1 text-muted-foreground">total</TableCell>
            <TableCell />
            <TableCell className="px-1.5 py-1 text-right text-muted-foreground">
              {task.factors.reduce((a, f) => a + f.weight, 0).toFixed(2)}
            </TableCell>
            <TableCell className="px-1.5 py-1 text-right font-semibold">{task.score.toFixed(3)}</TableCell>
            <TableCell className="px-1.5 py-1 whitespace-normal">
              <Worked>{task.formula}</Worked>
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

function FactorRow({ factor, ceiling }: { factor: RiskFactor; ceiling: number }) {
  const pct = (v: number) => `${Math.min((v / ceiling) * 100, 100)}%`;
  return (
    <TableRow className={cn("hover:bg-muted/40", !factor.available && "opacity-60")}>
      <TableCell className="px-1.5 py-1 font-medium">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-2.5 rounded-[3px]" style={{ background: factorShade(factor.name) }} />
          {factorLabel(factor.name)}
          {!factor.available && (
            <Badge variant="outline" title="Could not be measured, so it contributes 0">
              n/a
            </Badge>
          )}
        </span>
      </TableCell>
      <TableCell className="px-1.5 py-1 text-right font-mono">{factor.value.toFixed(2)}</TableCell>
      <TableCell className="px-1.5 py-1 text-right font-mono text-muted-foreground">{factor.weight.toFixed(2)}</TableCell>
      <TableCell className="px-1.5 py-1">
        <span className="flex items-center gap-2">
          <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <span aria-hidden className="absolute inset-y-0 left-0 bg-foreground/15" style={{ width: pct(factor.weight) }} />
            <span aria-hidden className="absolute inset-y-0 left-0" style={{ width: pct(factor.contribution), background: factorShade(factor.name) }} />
          </span>
          <span className="w-11 shrink-0 text-right font-mono">{factor.contribution.toFixed(3)}</span>
        </span>
      </TableCell>
      <TableCell className="px-1.5 py-1 whitespace-normal text-muted-foreground">{proseWords(factor.reason)}</TableCell>
    </TableRow>
  );
}
