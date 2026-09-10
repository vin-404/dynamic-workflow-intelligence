"use client";

/**
 * Capability 2b - a real probability, and the criticality index.
 *
 * This panel exists to report ONE number: the fraction of seeded simulated
 * runs in which the workflow finished on or before the deadline. It sits
 * directly beneath the Layer-A risk panel, which reports a *different* number
 * on a different scale, and the whole design of this file is organised around
 * making it impossible to read one against the other.
 *
 * Three structural devices do that, rather than a warning sentence:
 *
 *   1. **The panel renders exactly one answer block**, chosen by
 *      `answer_kind`. There is no code path in which a probability and a
 *      structural score are both presented as "the answer". When
 *      `forecast.available` is false the structural estimate is shown, with
 *      `unavailable_reason` and `fall_back_to` beside it, and no percentage
 *      appears anywhere on screen.
 *   2. **A two-row legend of kinds opens the panel, and it contains no
 *      values at all** - only what each number is, what scale it is on, and
 *      which panel it lives in. A legend with no numbers in it cannot be
 *      misread as a comparison of numbers.
 *   3. **A band label cannot be rendered without its number.** `BandLabel`
 *      takes the number as a required prop and prints it in the same element,
 *      so "on track" and "0.96" are one string or neither exists. The
 *      payload's own `band_note` sits under it, always.
 *
 * Nothing honest here is behind a disclosure (D-105). `disclaimer`, the
 * independence assumption, the resource-contention assumption, the
 * distribution's cost, `band_note`, `iterations`, `seed`, the input hash and
 * every per-task spread provenance are all on screen unfolded. The prose in
 * the `assumptions` bag is rendered through `assumptionSentences()` and the
 * rest of it through `flatten()`, so a caveat the backend adds later appears
 * here without a frontend change whatever type it arrives as. The handful of
 * sentences lifted up next to the numbers they qualify are subtracted from
 * that list *by key* (`LIFTED`), which means a backend rename degrades to
 * showing a sentence twice rather than to hiding it.
 */

import { ReactNode, useEffect, useState } from "react";
import {
  ApiError,
  AssumptionsBlock,
  ForecastResponse,
  HistogramBin,
  TaskForecast,
  assumptionSentences,
  getForecast,
  humanizeKey,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { bandClasses, bandText } from "@/lib/severity";
import { Badge } from "@/components/ui/badge";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Assumptions, ErrorNote } from "./ui";

/* -------------------------------------------------------------- formatting */

const HEAD =
  "text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground";

/** A cell head: the same small caps the other analysis panels use. */
const TH = "h-7 px-1.5 text-[10px] uppercase tracking-wider text-muted-foreground";

function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function runs(n: number): string {
  return n.toLocaleString("en-US");
}

function day(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

/* ---------------------------------------------------- reading the prose bag */

/*
 * `assumptions` is `Record<string, unknown>` on purpose - see the Phase 11
 * block in `lib/api.ts`. These readers are how a scalar is pulled out of it
 * without pretending the bag has a fixed shape.
 */

function str(block: AssumptionsBlock | undefined, key: string): string | null {
  const v = block?.[key];
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function num(block: AssumptionsBlock | undefined, key: string): number | null {
  const v = block?.[key];
  return typeof v === "number" ? v : null;
}

function list(block: AssumptionsBlock | undefined, key: string): string[] {
  const v = block?.[key];
  return Array.isArray(v) ? v.map(String) : [];
}

/** One line of an assumptions bag, whatever type the payload used. */
type Entry = { key: string; label: string; value: string; prose: boolean };

/**
 * Flatten the whole assumptions bag, dropping nothing.
 *
 * `assumptionSentences()` returns only the string values, which is right for
 * the prose but silently skips every boolean, count and task list - and
 * "resource contention simulated: no" is exactly the kind of fact that must
 * not be skipped. So this walks the bag itself: strings long enough to be a
 * sentence are rendered as prose, everything else as a `key: value` row.
 *
 * Nothing is keyed by name, so a caveat the backend adds tomorrow appears
 * here in the right form with no change to this file.
 */
function flatten(block: AssumptionsBlock | undefined, prefix = ""): Entry[] {
  if (!block) return [];
  const out: Entry[] = [];
  for (const [rawKey, v] of Object.entries(block)) {
    const key = prefix ? `${prefix}.${rawKey}` : rawKey;
    const label = humanizeKey(key.replace(/\./g, " · "));
    if (v === null || v === undefined) {
      out.push({ key, label, value: "—", prose: false });
    } else if (typeof v === "string") {
      if (!v.trim()) continue;
      out.push({ key, label, value: v, prose: v.trim().length > 60 });
    } else if (typeof v === "number" || typeof v === "boolean") {
      const value = typeof v === "boolean" ? (v ? "yes" : "no") : String(v);
      out.push({ key, label, value, prose: false });
    } else if (Array.isArray(v)) {
      out.push({
        key,
        label,
        value: v.length ? v.map(String).join(", ") : "none",
        prose: false,
      });
    } else if (typeof v === "object" && !prefix) {
      // One level of nesting only - `effort_model` is the only nested block
      // the payload has, and unbounded recursion here would be a way to print
      // a graph into the page.
      out.push(...flatten(v as AssumptionsBlock, key));
    }
  }
  return out;
}

/**
 * The sentences shown verbatim beside the number they qualify, so they are
 * not repeated in the full list at the foot of the panel.
 *
 * Subtracting by key rather than by text means a backend rename fails in the
 * safe direction: the sentence appears in the full list as well, instead of
 * disappearing from both places.
 */
const LIFTED = new Set([
  "independence_note",
  "resource_contention_note",
  "distribution_cost",
  "spread_provenance_note",
  "criticality_index_definition",
  "reproducible",
]);

/* ==========================================================================
 * The panel
 * ======================================================================== */

/** What one completed run of the forecast produced, and what it was for. */
type Loaded = {
  projectId: string;
  attempt: number;
  data: ForecastResponse | null;
  error: ApiError | null;
};

function StatLine({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <div className="bg-panel px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-lg font-semibold tracking-tight">{value}</span>
        {detail && <span className="text-[11px] text-muted-foreground">{detail}</span>}
      </div>
    </div>
  );
}

export default function ForecastPanel({
  projectId,
  demoData,
}: {
  projectId: string;
  demoData?: ForecastResponse;
}) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  /*
   * The effect only starts the request; every `setState` here happens in an
   * async callback, never synchronously in the effect body. That is the same
   * correction D-103 made in the optimizer: `react-hooks/set-state-in-effect`
   * is right that a synchronous reset inside an effect is a cascading render.
   *
   * "Which project is this data for" and "is a request in flight" are
   * therefore *derived at render* from what came back, rather than reset by a
   * second effect - so changing project can never leave a stale forecast on
   * screen, and a re-run keeps the previous numbers visible while it runs
   * instead of flashing the whole panel back to a skeleton.
   */
  useEffect(() => {
    if (demoData) return;

    let live = true;
    getForecast(projectId)
      .then((r) => {
        if (live) setLoaded({ projectId, attempt, data: r, error: null });
      })
      .catch((e) => {
        if (!live) return;
        const err = e instanceof ApiError ? e : new ApiError(0, String(e), null);
        setLoaded({ projectId, attempt, data: null, error: err });
      });
    return () => {
      live = false;
    };
  }, [projectId, attempt, demoData]);

  const forProject = loaded?.projectId === projectId ? loaded : null;
  const busy = demoData ? false : forProject === null || forProject.attempt !== attempt;
  const data = demoData ?? forProject?.data ?? null;
  const error = demoData ? null : forProject?.error ?? null;
  const run = () => {
    if (!demoData) setAttempt((n) => n + 1);
  };

  if (error) {
    return (
      <section className="mt-7 border-t border-border pt-4">
        <h3 className={HEAD}>Forecast</h3>
        <div className="mt-2">
          <ErrorNote
            onRetry={() => run()}
            hint={error.hint}
            requestId={error.requestId}
          >
            <p>{error.userMessage}</p>
          </ErrorNote>
        </div>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="mt-7 flex flex-col gap-2 border-t border-border pt-4">
        <h3 className={HEAD}>Forecast</h3>
        <Skeleton className="h-4 w-72" />
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-24 w-full" />
      </section>
    );
  }

  const f = data.forecast;
  const a = f.assumptions;
  const isProbability = data.answer_kind === "monte_carlo_probability";
  const deadlineProbability = f.deadline?.probability_of_meeting_deadline ?? null;

  return (
    <section className="mt-7 flex flex-col gap-7 border-t border-border pt-4">
      {isProbability && f.available && (
        <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3">
          <StatLine
            label="Deadline probability"
            value={deadlineProbability === null ? "—" : pct(deadlineProbability)}
            detail="simulated runs"
          />
          <StatLine
            label="P50 completion"
            value={f.completion?.p50_date ?? "—"}
            detail={f.completion ? `day ${day(f.completion.p50_day)}` : undefined}
          />
          <StatLine
            label="P90 completion"
            value={f.completion?.p90_date ?? "—"}
            detail={f.completion ? `day ${day(f.completion.p90_day)}` : undefined}
          />
        </div>
      )}

      {/* ------------------------------------------------------------ head */}
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <h3 className={HEAD}>Forecast</h3>
          <span className="text-xs text-muted-foreground">
            {runs(f.iterations)} runs · seed{" "}
            <span className="font-mono">{f.seed}</span> ·{" "}
            {(f.distribution ?? "").replace(/_/g, "-")} · v{data.version_no} ·
            input <span className="font-mono">{data.input_hash.slice(0, 8)}</span>
          </span>
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            disabled={busy}
            onClick={() => run()}
          >
            {busy ? "Running…" : "Run again"}
          </Button>
        </div>
        {str(a, "reproducible") && (
          <p className="max-w-4xl text-xs text-muted-foreground">
            {str(a, "reproducible")}
          </p>
        )}
      </div>

      {/* --------------------------------------------- which of two numbers */}
      <WhichNumber data={data} />

      {isProbability && f.available ? (
        <>
          <Probability data={data} />
          <Completion data={data} />
          <Criticality data={data} />
        </>
      ) : (
        <Structural data={data} />
      )}

      {/* --------------------------------------------------- everything else */}
      <RestsOn data={data} />
    </section>
  );
}

/* ==========================================================================
 * 1. The two kinds, with no values in it
 * ======================================================================== */

/**
 * A legend of *kinds*, deliberately containing no numbers.
 *
 * The one thing a reader must never do on this stage is take a band from the
 * structural score and read it against the probability. Saying so is weaker
 * than showing the two things side by side with their scales and nothing to
 * compare - so this table has a "what it is" column, a "scale" column and a
 * "where" column, and not a single figure.
 */
function WhichNumber({ data }: { data: ForecastResponse }) {
  const here = data.answer_kind;
  const rows: {
    kind: string;
    what: string;
    scale: string;
    where: string;
    mine: boolean;
  }[] = [
    {
      kind: "structural_estimate",
      what: "Ranks how exposed a task is, given the shape of the workflow.",
      scale: "0–1 exposure rank · not a probability",
      where:
        here === "structural_estimate"
          ? "here, and in the risk panel above"
          : "the risk panel above",
      mine: here === "structural_estimate",
    },
    {
      kind: "monte_carlo_probability",
      what: "Counts how often something happened across simulated runs.",
      scale: `share of ${runs(data.forecast.iterations)} runs · a probability, uncalibrated`,
      where:
        here === "monte_carlo_probability"
          ? "here"
          : "not available for this workflow",
      mine: here === "monte_carlo_probability",
    },
  ];

  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-sm font-semibold">
        Two different numbers on this stage
      </h4>
      <Table className="text-xs">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className={cn(TH, "w-52")}>Number</TableHead>
            <TableHead className={TH}>What it says</TableHead>
            <TableHead className={cn(TH, "w-64")}>Scale</TableHead>
            <TableHead className={cn(TH, "w-44")}>Shown</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow
              key={r.kind}
              data-state={r.mine ? "selected" : undefined}
              className="hover:bg-transparent"
            >
              <TableCell className="px-1.5 py-1.5 font-mono">
                {r.kind}
              </TableCell>
              <TableCell className="whitespace-normal px-1.5 py-1.5 text-muted-foreground">
                {r.what}
              </TableCell>
              <TableCell className="whitespace-normal px-1.5 py-1.5 text-muted-foreground">
                {r.scale}
              </TableCell>
              <TableCell className="whitespace-normal px-1.5 py-1.5">
                {r.mine ? (
                  <span className="font-medium">
                    {r.where} — you are reading this one
                  </span>
                ) : (
                  <span className="text-muted-foreground">{r.where}</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="max-w-4xl text-xs text-muted-foreground">
        {data.answer_kind_note}
      </p>
      {/*
        * `not_the_structural_estimate` is written from the forecast's point of
        * view ("this one is a probability"), so it only reads true when the
        * forecast is what is on screen. In the fallback branch the same
        * distinction is made, correctly worded for that case, by
        * `score_kind_is_not_the_forecast_kind` inside `Structural` - so this
        * is a choice between two phrasings of one caveat, not a caveat
        * dropped.
        */}
      {here === "monte_carlo_probability" && (
        <p className="max-w-4xl text-xs text-muted-foreground">
          {data.forecast.not_the_structural_estimate}
        </p>
      )}
    </div>
  );
}

/* ==========================================================================
 * 2a. The probability
 * ======================================================================== */

/**
 * The deadline's bands are `on_track` / `at_risk` / `unlikely`; a risk band is
 * `low` / `moderate` / `high`. Same three states in the same good-end-first
 * order, two vocabularies - so this is a *word alias* onto the one shared
 * mapping in `severity.ts`, exactly like `bandFill` in the risk panel, and not
 * a second palette. Anything unrecognised is passed through untranslated and
 * lands on `bandClasses`'s neutral default, so a band the engine adds shows up
 * as unstyled rather than as a wrong colour.
 */
const BAND_ALIAS: Record<string, string> = {
  on_track: "low",
  at_risk: "moderate",
  unlikely: "high",
};

/**
 * A band word and the number it was cut from, in one element.
 *
 * `value` is required and is printed here, so there is no way to render the
 * label on its own - which is the rule `deadline.band_note` states and the
 * reason this is a component rather than a `<span>` at each call site.
 */
function BandLabel({ band, value }: { band: string; value: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5", bandClasses(BAND_ALIAS[band] ?? band))}
    >
      <span>{band.replace(/_/g, " ")}</span>
      <span aria-hidden className="opacity-50">
        ·
      </span>
      <span className="font-semibold">{value}</span>
    </Badge>
  );
}

function Probability({ data }: { data: ForecastResponse }) {
  const f = data.forecast;
  const d = f.deadline;
  const a = f.assumptions;
  const p = d?.probability_of_meeting_deadline ?? null;
  const hasDeadline = d?.deadline_day !== null && d?.deadline_day !== undefined;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        {p === null || !hasDeadline ? (
          <p className="max-w-4xl text-sm">
            No deadline is set on this project, so there is no probability of
            meeting one. The completion distribution below is still sampled and
            still says when the work is likely to finish.
          </p>
        ) : (
          <>
            {/*
             * D-116's dense line, not a tile: the probability is the answer
             * and carries the size; the denominator that produced it sits on
             * the same baseline rather than in a box of its own.
             */}
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-4xl leading-none font-semibold [font-variant-numeric:proportional-nums]">
                {pct(p)}
              </span>
              <span className="text-sm">
                of {runs(f.iterations)} simulated runs finished on or before the
                deadline
              </span>
              {d.band && <BandLabel band={d.band} value={pct(p)} />}
            </div>
            <p className="text-xs text-muted-foreground">
              {runs(d.iterations_meeting_deadline)} of {runs(f.iterations)} runs
              met day {day(d.deadline_day as number)}
              {d.deadline_date ? ` (${d.deadline_date})` : ""}.{" "}
              {runs(f.iterations - d.iterations_meeting_deadline)} did not.
            </p>
            {d.band_note && (
              <p className="max-w-4xl text-xs text-muted-foreground">
                {d.band_note}
              </p>
            )}
          </>
        )}
      </div>

      {/* The disclaimer is not a disclosure. It is the sentence the number is
          only true inside of, so it sits under the number. */}
      <p className="max-w-4xl border-l-2 border-severity-medium py-1 pl-3 text-[13px] leading-snug">
        {f.disclaimer}
      </p>

      {/* The two assumptions the brief names, lifted out of the bag to sit
          beside the number rather than at the foot of the panel. */}
      <dl className="flex max-w-4xl flex-col gap-2 border-l border-border pl-3 text-xs">
        <div className="flex flex-col gap-0.5">
          <dt className="font-medium">
            Durations are sampled independently — which is optimistic
          </dt>
          <dd className="text-muted-foreground">
            {str(a, "independence_note") ??
              "Task durations are sampled independently of one another. Real delays correlate, so this is optimistic."}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="font-medium">Resource contention is not simulated</dt>
          <dd className="text-muted-foreground">
            {str(a, "resource_contention_note") ??
              "Every iteration runs the same resource-blind schedule the rest of the engine runs."}
          </dd>
        </div>
        {str(a, "distribution_cost") && (
          <div className="flex flex-col gap-0.5">
            <dt className="font-medium">
              What {str(a, "distribution_name") ?? f.distribution} costs
            </dt>
            <dd className="text-muted-foreground">{str(a, "distribution_cost")}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

/* ==========================================================================
 * 2b. Completion dates and the histogram
 * ======================================================================== */

function Completion({ data }: { data: ForecastResponse }) {
  const f = data.forecast;
  const c = f.completion;
  const bins = f.histogram?.bins ?? [];

  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold">Completion date</h4>

      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 border-y border-border py-2">
        {(
          [
            ["P50", c.p50_day, c.p50_date],
            ["P80", c.p80_day, c.p80_date],
            ["P90", c.p90_day, c.p90_date],
          ] as const
        ).map(([label, dayValue, date]) => (
          <div key={label} className="flex items-baseline gap-2">
            <span className="text-[11px] font-medium tracking-wider text-muted-foreground">
              {label}
            </span>
            <span className="text-lg leading-none font-semibold">{date}</span>
            <span className="text-[11px] text-muted-foreground">
              day {day(dayValue)}
            </span>
          </div>
        ))}
      </div>

      <dl className="flex flex-wrap gap-x-5 gap-y-0.5 text-[11px]">
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">mean</dt>
          <dd>
            {c.mean_date} · day {day(c.mean_day)}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">earliest run</dt>
          <dd>
            {c.earliest_date} · day {day(c.earliest_day)}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">latest run</dt>
          <dd>
            {c.latest_date} · day {day(c.latest_day)}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">deterministic projection</dt>
          <dd>
            {data.deterministic.projected_end_date} · day{" "}
            {day(data.deterministic.projected_end_day)}
          </dd>
        </div>
      </dl>

      {bins.length > 0 && <Histogram data={data} bins={bins} />}
    </div>
  );
}

/**
 * The distribution of finish dates, as a column chart.
 *
 * One series, so there is no categorical palette and no legend box for
 * identity - the two colours here encode a *threshold*, not two series, and
 * the key beneath carries the run counts rather than restating the title.
 * Both colours come from `severity.ts`'s band mapping via `currentColor`
 * rather than from a local palette: green is honest at the good end of a
 * band, which is exactly what "met the deadline" is.
 *
 * A bin whose right edge falls past the deadline contains runs that missed
 * it, so it is coloured as missed. That is the conservative rounding - the
 * colour never over-claims, and the exact count is the number printed above.
 */
function Histogram({
  data,
  bins,
}: {
  data: ForecastResponse;
  bins: HistogramBin[];
}) {
  const f = data.forecast;
  const deadlineDay = f.deadline?.deadline_day ?? null;
  const max = Math.max(...bins.map((b) => b.count), 1);
  const from = bins[0].from_day;
  const to = bins[bins.length - 1].to_day;
  const span = to - from;

  // Only draw the reference line when the deadline is actually inside the
  // sampled range. Clamping it to an edge would draw a line that is not where
  // the deadline is.
  const inRange =
    deadlineDay !== null && span > 0 && deadlineDay >= from && deadlineDay <= to;
  const x = inRange ? ((deadlineDay - from) / span) * 100 : null;

  const met = f.deadline?.iterations_meeting_deadline ?? null;
  const missed = met === null ? null : f.iterations - met;

  const tone = (bin: HistogramBin) =>
    deadlineDay === null
      ? "text-dim"
      : bandText(bin.to_day <= deadlineDay ? "low" : "high");

  return (
    <figure className="mt-1 flex flex-col gap-1.5">
      <figcaption className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>
          {runs(f.iterations)} runs, binned by finish day — taller is more runs
        </span>
        {deadlineDay !== null && (
          <span className="ml-auto">
            deadline day {day(deadlineDay)}
            {f.deadline.deadline_date ? ` · ${f.deadline.deadline_date}` : ""}
          </span>
        )}
      </figcaption>

      <div
        className="relative flex h-24 items-end gap-[2px]"
        role="img"
        aria-label={
          `Distribution of ${runs(f.iterations)} simulated finish days, ` +
          `from day ${day(from)} to day ${day(to)}` +
          (met === null
            ? "."
            : `. ${runs(met)} runs met the deadline and ${runs(missed as number)} did not.`)
        }
      >
        {bins.map((bin, i) => (
          <Tooltip key={i}>
            <TooltipTrigger asChild>
              <div className="flex h-full min-w-0 flex-1 items-end">
                <span
                  className={cn(
                    "block w-full rounded-t-[3px] bg-current",
                    tone(bin),
                  )}
                  style={{ height: `${(bin.count / max) * 100}%` }}
                />
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">
              <span className="flex flex-col gap-0.5 text-left">
                <span className="font-mono">
                  day {day(bin.from_day)}–{day(bin.to_day)}
                </span>
                <span className="opacity-80">
                  {bin.from_date}
                  {bin.to_date !== bin.from_date ? ` – ${bin.to_date}` : ""}
                </span>
                <span className="opacity-80">
                  {runs(bin.count)} runs · {pct(bin.share, 2)} ·{" "}
                  {pct(bin.cumulative_share, 1)} cumulative
                </span>
              </span>
            </TooltipContent>
          </Tooltip>
        ))}

        {x !== null && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-px bg-foreground"
            style={{ left: `${x}%` }}
          />
        )}
      </div>

      <div className="flex items-baseline justify-between border-t border-border pt-1 text-[10px] text-muted-foreground">
        <span>
          {bins[0].from_date} · day {day(from)}
        </span>
        <span>
          {bins[bins.length - 1].to_date} · day {day(to)}
        </span>
      </div>

      {met !== null && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={cn("size-2 rounded-[2px] bg-current", bandText("low"))}
            />
            met the deadline — {runs(met)} runs
          </span>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={cn("size-2 rounded-[2px] bg-current", bandText("high"))}
            />
            missed it — {runs(missed as number)} runs
          </span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span aria-hidden className="h-2.5 w-px bg-foreground" />
            deadline
          </span>
        </div>
      )}

      {deadlineDay !== null && !inRange && (
        <p className="text-[11px] text-muted-foreground">
          The deadline (day {day(deadlineDay)}) falls outside the sampled range,
          so no line is drawn for it: every run
          {deadlineDay > to ? " met it" : " missed it"}.
        </p>
      )}

      {f.histogram.method && (
        <p className="max-w-4xl text-[11px] text-muted-foreground">
          {f.histogram.method}
        </p>
      )}
    </figure>
  );
}

/* ==========================================================================
 * 2c. Criticality index - what the feature is for
 * ======================================================================== */

/**
 * Every task, ranked by the fraction of runs in which it lay on the critical
 * path.
 *
 * The bar is the accent, and this is the one place in the analysis panels
 * that spends it: criticality index *is* the critical path, measured over
 * many runs, so the accent is answering the question D-107 reserved it for
 * rather than decorating a ranking. Magnitude is length, one hue - the
 * ranking is a sequential scale, not four categories.
 *
 * `assumed` is marked by **form**, not by a fourth colour: a bordered mono
 * chip, the same device D-102 and D-128 settled on for a constraint. On an
 * imported project every row carries it, which is the case this marking
 * exists for.
 */
function Criticality({ data }: { data: ForecastResponse }) {
  const f = data.forecast;
  const a = f.assumptions;
  const tasks = [...f.tasks].sort(
    (x, y) => y.criticality_index - x.criticality_index,
  );
  const assumedCount = tasks.filter((t) => t.assumed).length;
  const sampled = num(a, "tasks_sampled");
  const held = list(a, "tasks_held_constant");
  const means = tasks[0]?.criticality_means ?? null;

  if (tasks.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="text-sm font-semibold">Criticality index</h4>
        <span className="text-xs text-muted-foreground">
          {tasks.length} task{tasks.length === 1 ? "" : "s"}
          {sampled !== null ? ` · ${sampled} sampled` : ""}
          {held.length > 0 ? ` · ${held.length} held constant` : ""}
          {assumedCount > 0
            ? ` · ${assumedCount} with an assumed spread`
            : ""}
        </span>
      </div>

      {means && (
        <p className="max-w-4xl text-[13px] leading-snug text-foreground/90">
          {means.charAt(0).toUpperCase() + means.slice(1)}.
        </p>
      )}
      {str(a, "criticality_index_definition") && (
        <p className="max-w-4xl text-xs text-muted-foreground">
          {str(a, "criticality_index_definition")}
        </p>
      )}

      <Table className="text-xs">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className={cn(TH, "w-6 text-right")}>#</TableHead>
            <TableHead className={cn(TH, "w-12")}>Task</TableHead>
            <TableHead className={TH}>Name</TableHead>
            <TableHead className={cn(TH, "w-52 text-right")}>
              Criticality index
            </TableHead>
            <TableHead className={cn(TH, "w-32 text-right")}>
              Runs on the path
            </TableHead>
            <TableHead className={cn(TH, "w-28 text-right")}>
              Duration o–p
            </TableHead>
            <TableHead className={cn(TH, "w-44")}>Spread came from</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.map((t, i) => (
            <CriticalityRow
              key={t.task_key}
              task={t}
              rank={i + 1}
              iterations={f.iterations}
            />
          ))}
        </TableBody>
      </Table>

      {str(a, "spread_provenance_note") && (
        <p className="max-w-4xl text-[11px] text-muted-foreground">
          {str(a, "spread_provenance_note")}
        </p>
      )}
    </div>
  );
}

function CriticalityRow({
  task,
  rank,
  iterations,
}: {
  task: TaskForecast;
  rank: number;
  iterations: number;
}) {
  const width = `${Math.min(Math.max(task.criticality_index, 0), 1) * 100}%`;
  const d = task.duration;
  return (
    <TableRow className="hover:bg-muted/40">
      <TableCell className="px-1.5 py-1 text-right text-muted-foreground">
        {rank}
      </TableCell>
      <TableCell className="px-1.5 py-1 font-mono text-muted-foreground">
        {task.task_key}
      </TableCell>
      <TableCell className="max-w-0 truncate px-1.5 py-1">
        {task.task_name}
      </TableCell>
      <TableCell className="px-1.5 py-1">
        <span className="flex items-center gap-2">
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <span className="block h-full bg-accent" style={{ width }} />
          </span>
          <span className="w-9 shrink-0 text-right font-mono font-semibold">
            {task.criticality_index.toFixed(2)}
          </span>
        </span>
      </TableCell>
      <TableCell className="px-1.5 py-1 text-right font-mono text-muted-foreground">
        {runs(task.iterations_on_critical_path)} / {runs(iterations)}
      </TableCell>
      <TableCell className="px-1.5 py-1 text-right font-mono text-muted-foreground">
        {day(d.optimistic_days)}–{day(d.pessimistic_days)}d
      </TableCell>
      <TableCell className="px-1.5 py-1">
        <span className="flex items-center gap-1.5">
          <span className="text-muted-foreground">
            {d.spread_provenance.replace(/_/g, " ")}
          </span>
          {task.assumed && (
            <Badge
              variant="outline"
              className="font-mono"
              title="The spread came from the domain's variance prior, not from a three-point estimate somebody wrote down."
            >
              assumed
            </Badge>
          )}
        </span>
      </TableCell>
    </TableRow>
  );
}

/* ==========================================================================
 * 3. The fallback: no distribution to report
 * ======================================================================== */

/**
 * What is on screen when there is nothing to sample.
 *
 * No percentage appears anywhere in this branch. The structural estimate is
 * shown as itself, on its own 0–1 scale, with the reason the forecast is
 * absent and what it fell back to.
 */
function Structural({ data }: { data: ForecastResponse }) {
  const f = data.forecast;
  const s = data.structural_risk;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h4 className="text-sm font-semibold text-severity-medium">
          No distribution to report
        </h4>
        {f.unavailable_reason && (
          <p className="max-w-4xl text-[13px] leading-snug">
            {f.unavailable_reason}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Falling back to:{" "}
          <span className="font-mono">
            {f.fall_back_to ?? "structural_estimate"}
          </span>
          . That is a different quantity, so nothing below is a probability and
          no percentage is shown.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h4 className="text-sm font-semibold">
            Structural estimate · exposure rank
          </h4>
          <span className="text-xs text-muted-foreground">
            {s.band_counts.high ?? 0} high · {s.band_counts.moderate ?? 0}{" "}
            moderate · {s.band_counts.low ?? 0} low
          </span>
        </div>
        <p className="max-w-4xl text-xs text-muted-foreground">
          {s.disclaimer}
        </p>
        {s.top.length > 0 && (
          <div className="divide-y divide-border border-y border-border">
            {s.top.map((t, i) => (
              <div
                key={t.task_key}
                className="flex items-center gap-3 px-1.5 py-1"
              >
                <span className="w-5 shrink-0 text-right text-[11px] text-muted-foreground">
                  {i + 1}
                </span>
                <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">
                  {t.task_key}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {t.task_name}
                </span>
                {/* The band never appears without the score it was cut from. */}
                <BandLabel band={t.band} value={`${t.score.toFixed(2)} / 1`} />
              </div>
            ))}
          </div>
        )}
        {str(s.assumptions, "score_kind_is_not_the_forecast_kind") && (
          <p className="max-w-4xl text-xs text-severity-medium">
            {str(s.assumptions, "score_kind_is_not_the_forecast_kind")}
          </p>
        )}
      </div>
    </div>
  );
}

/* ==========================================================================
 * 4. What this rests on
 * ======================================================================== */

/**
 * Every remaining sentence in the assumptions bag, plus the scalars that are
 * not prose.
 *
 * Rendered through `assumptionSentences()` rather than from a hardcoded key
 * list, so a caveat the backend adds tomorrow shows up here with no frontend
 * change. That is the whole reason `AssumptionsBlock` is untyped.
 */
function RestsOn({ data }: { data: ForecastResponse }) {
  const f = data.forecast;
  /*
   * The prose comes from `assumptionSentences()` - the function `lib/api.ts`
   * exists for, so a caveat the backend adds tomorrow lands here untouched.
   * `flatten()` then picks up everything that function cannot see: the
   * booleans, the counts and the task lists. "Resource contention simulated:
   * no" is a fact of exactly the kind that must not fall through the gap
   * between a string filter and a type.
   */
  const prose = assumptionSentences(f.assumptions).filter(
    (s) => !LIFTED.has(s.key) && s.text.trim().length > 60,
  );
  const facts = flatten(f.assumptions).filter(
    (e) => !LIFTED.has(e.key) && !e.prose,
  );

  return (
    <div className="flex flex-col gap-2">
      <h4 className={HEAD}>What this rests on</h4>

      {prose.length > 0 && (
        <dl className="flex max-w-4xl flex-col gap-1.5 text-xs">
          {prose.map((e) => (
            <div key={e.key} className="flex flex-col gap-0.5">
              <dt className="font-medium">{humanizeKey(e.key)}</dt>
              <dd className="text-muted-foreground">{e.text}</dd>
            </div>
          ))}
        </dl>
      )}

      {facts.length > 0 && (
        <Assumptions
          title="The run itself"
          entries={[
            ...facts.map(
              (e) => [e.label, e.value] as [string, ReactNode],
            ),
            [
              "Version",
              <span key="v" className="font-mono">
                v{data.version_no} · {data.input_hash.slice(0, 12)}
              </span>,
            ],
          ]}
        />
      )}

      <p className="max-w-4xl text-[11px] text-muted-foreground">
        {data.deterministic.note}
      </p>
    </div>
  );
}
