"use client";

/**
 * The before/after diff — genuinely side by side.
 *
 * Used by the what-if panel, the optimizer and the requirement replan,
 * because a hand-written hypothetical, an optimizer candidate and a costed
 * re-wording produce the same comparison payload from the same engine - so
 * they get the same view.
 *
 * Every measurement the engine compares is one row of one three-column table:
 * before, after, delta. Not two stacked lists, and not a single column with
 * arrows in it. A row whose delta is zero is deliberately quiet and a row
 * that moved is highlighted, so the eye lands on what changed rather than on
 * the frame around it. The evidence - dates, directions, the task keys that
 * caused a count to move - sits on the row rather than behind a click. The
 * critical path and the moved tasks keep the same shape: before on the left,
 * after on the right.
 *
 * The immutability proof is at the bottom on purpose: it is not decoration.
 * "The original workflow remains unchanged" is a product claim, and this is
 * where a sceptical reader checks it.
 */

import { Check, TriangleAlert } from "lucide-react";
import { Comparison, SimulationResponse } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  calendarDate,
  describeMutation,
  findingKindLabel,
  originLabel,
  verdictLabel,
} from "@/lib/display";
import { bandClasses, bandText } from "@/lib/severity";
import { cn } from "@/lib/utils";
import { days } from "./ui";

/** One inline icon size across every panel. */
const ICON = "size-3.5 shrink-0";
/** Column and section labels: meta size, quiet. */
const LABEL = "text-[12px] font-medium text-dim";
/** The disclosure summary, the same on every stage. */
const SUMMARY =
  "flex cursor-pointer list-none items-center gap-1 text-[14px] text-accent marker:content-none hover:underline [&::-webkit-details-marker]:hidden";
/**
 * A list whose length is the workflow's, not the diff's, scrolls in its own
 * box.
 *
 * Three things here are one row per *task* or per *mutation* rather than a
 * fixed set of measurements: the moved-tasks table, the unavailability
 * adjustments and the inverse mutations. On the seeded fixtures they are a
 * dozen rows and this changes nothing; on an imported Jira export of four
 * hundred issues, "which tasks move" is four hundred rows pushing the
 * immutability proof — the thing at the bottom that a sceptical reader came
 * for — a screen and a half below the fold. The comparison table itself is
 * deliberately *not* capped: it is seven rows by construction and it is the
 * answer.
 */
const SCROLL =
  "max-h-[24rem] overflow-y-auto overscroll-contain rounded-md border border-line/60";

/**
 * Better, worse, or no change — in the three states `severity.ts` already
 * owns. `bandText` is the right one of the two: on a delta, "low" genuinely
 * is the good end, which is the same reason bands are green and findings are
 * not. There is no fourth state; no change inherits `text-dim`.
 */
function deltaTone(
  delta: number | null | undefined,
  positiveIsWorse = true,
): string {
  if (delta === null || delta === undefined || Math.abs(delta) < 1e-9) {
    return "text-dim";
  }
  const worse = positiveIsWorse ? delta > 0 : delta < 0;
  return bandText(worse ? "high" : "low");
}

function signed(n: number): string {
  return `${n > 0 ? "+" : ""}${n}`;
}

/* -------------------------------------------------------------- scaffolding */

/** A section title and its right-hand meta. No card, no shadow. */
function Head({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h2 className="text-[18px] font-semibold">{children}</h2>
      {right && <span className="text-[12px] text-dim">{right}</span>}
    </div>
  );
}

function Caret() {
  return (
    <>
      <span className="inline-block w-3 group-open:hidden">▸</span>
      <span className="hidden w-3 group-open:inline-block">▾</span>
    </>
  );
}

function Reveal({
  summary,
  children,
}: {
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group mt-2">
      <summary className={SUMMARY}>
        <Caret />
        {summary}
      </summary>
      <div className="mt-2 pl-4">{children}</div>
    </details>
  );
}

/** One side of a before | after pair. */
function Side({
  label,
  children,
  quiet,
}: {
  label: string;
  children: React.ReactNode;
  quiet?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-lg bg-panel2/60 p-3">
      <p className={cn("mb-1", LABEL)}>{label}</p>
      <div className={cn("text-[14px]", quiet && "text-dim")}>{children}</div>
    </div>
  );
}

/* -------------------------------------------------- the three-column table */

type MetricRow = {
  label: string;
  /** The evidence for this row, on the row. */
  detail?: React.ReactNode;
  before: React.ReactNode;
  after: React.ReactNode;
  delta: React.ReactNode;
  changed: boolean;
  tone?: string;
};

function CompareTable({ rows }: { rows: MetricRow[] }) {
  return (
    /* Capped, so before/after/delta sit next to the measure they describe
       rather than at the far edge of a wide screen. */
    <Table className="max-w-3xl text-[14px]">
      <TableHeader>
        <TableRow className="border-line hover:bg-transparent">
          <TableHead className={cn("h-7 px-2", LABEL)}>Measure</TableHead>
          <TableHead className={cn("h-7 w-24 px-2 text-right", LABEL)}>
            Before
          </TableHead>
          <TableHead className={cn("h-7 w-24 px-2 text-right", LABEL)}>
            After
          </TableHead>
          <TableHead className={cn("h-7 w-24 px-2 text-right", LABEL)}>
            Delta
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow
            key={r.label}
            /* The primitive's own highlight, so a changed row lifts and an
               unchanged one stays quiet. */
            data-state={r.changed ? "selected" : undefined}
            className="border-line/50"
          >
            <TableCell className="max-w-[22rem] px-2 py-1.5 align-top whitespace-normal">
              <span className={cn(!r.changed && "text-dim")}>{r.label}</span>
              {r.detail && (
                <span className="mt-0.5 block text-[12px] leading-snug text-dim">
                  {r.detail}
                </span>
              )}
            </TableCell>
            <TableCell className="px-2 py-1.5 text-right align-top text-dim">
              {r.before}
            </TableCell>
            <TableCell
              className={cn(
                "px-2 py-1.5 text-right align-top",
                r.changed ? "font-medium" : "text-dim",
              )}
            >
              {r.after}
            </TableCell>
            <TableCell
              className={cn(
                "px-2 py-1.5 text-right align-top",
                r.tone ?? "text-dim",
              )}
            >
              {r.delta}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function verdictBadge(verdict: string) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "font-normal",
        bandClasses(verdict === "feasible" ? "low" : "high"),
      )}
    >
      {verdictLabel(verdict)}
    </Badge>
  );
}

function overloaded(
  side: Record<string, { overflow: number }>,
): number {
  return Object.values(side).filter((r) => r.overflow > 0).length;
}

/* ---------------------------------------------------------------- the panel */

export default function DiffView({ result }: { result: SimulationResponse }) {
  const c = result.comparison;
  const completion = c.projected_completion;
  const f = c.feasibility;
  const cp = c.critical_path;
  const s = c.structure;
  const scope = Math.abs(s.total_effort_delta) > 1e-9;

  const pathDelta = cp.after.length - cp.before.length;
  const findingsDelta = c.findings.after_count - c.findings.before_count;
  const overloadBefore = overloaded(c.resource_overload.before);
  const overloadAfter = overloaded(c.resource_overload.after);

  const rows: MetricRow[] = [
    {
      label: "projected completion",
      detail: `${calendarDate(result.projected_end_date_before) ?? result.projected_end_date_before} → ${calendarDate(result.projected_end_date_after) ?? result.projected_end_date_after} · ${completion.direction}`,
      before: `day ${Math.round(completion.before_day)}`,
      after: `day ${Math.round(completion.after_day)}`,
      delta: days(completion.delta_days, true),
      changed: Math.abs(completion.delta_days) > 1e-9,
      tone: deltaTone(completion.delta_days),
    },
    {
      label: "margin against the deadline",
      detail: f.verdict_changed
        ? "This changes the verdict, not just the margin."
        : f.before.deadline_day !== null
          ? `deadline is day ${Math.round(f.before.deadline_day)}`
          : "no deadline is set",
      before: days(f.before.margin_days, true),
      after: days(f.after.margin_days, true),
      delta:
        f.margin_delta_days === null ? "—" : days(f.margin_delta_days, true),
      changed: !!f.margin_delta_days,
      tone: deltaTone(f.margin_delta_days, false),
    },
    {
      label: "deadline verdict",
      before: verdictBadge(f.before.verdict),
      after: verdictBadge(f.after.verdict),
      delta: f.verdict_changed ? "changed" : "same",
      changed: f.verdict_changed,
      tone: f.verdict_changed ? bandText("high") : "text-dim",
    },
    {
      label: "open findings",
      detail:
        c.findings.removed.length || c.findings.created.length
          ? `${c.findings.removed.length} resolved · ${c.findings.created.length} newly appearing`
          : "The same problems, before and after.",
      before: c.findings.before_count,
      after: c.findings.after_count,
      delta: findingsDelta === 0 ? "—" : signed(findingsDelta),
      changed: findingsDelta !== 0,
      tone: deltaTone(findingsDelta),
    },
    {
      label: "zero-slack chain (tasks)",
      detail: cp.changed
        ? "the critical path is re-routed"
        : "the critical path holds",
      before: cp.before.length,
      after: cp.after.length,
      delta:
        pathDelta !== 0 ? signed(pathDelta) : cp.changed ? "re-routed" : "—",
      changed: cp.changed,
      tone: pathDelta !== 0 ? deltaTone(pathDelta) : "text-dim",
    },
    {
      label: "resources over capacity",
      detail:
        c.resource_overload.resolved.length ||
        c.resource_overload.introduced.length
          ? `resolved ${c.resource_overload.resolved.join(", ") || "none"} · introduced ${c.resource_overload.introduced.join(", ") || "none"}`
          : undefined,
      before: overloadBefore,
      after: overloadAfter,
      delta:
        overloadAfter === overloadBefore
          ? "—"
          : signed(overloadAfter - overloadBefore),
      changed: overloadAfter !== overloadBefore,
      tone: deltaTone(overloadAfter - overloadBefore),
    },
    {
      label: "total effort",
      detail: scope
        ? "This changes how much work there is, not just how it is arranged. That is a scope decision."
        : "same work, arranged differently",
      before: days(s.total_effort_before),
      after: days(s.total_effort_after),
      delta: scope ? days(s.total_effort_delta, true) : "—",
      changed: scope,
      tone: scope ? bandText("moderate") : "text-dim",
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* ------------------------------------------------ the comparison */}
      <section>
        <Head right={originLabel(result.origin)}>What this would do</Head>
        <p className="mb-3 max-w-3xl text-[14px]">{result.summary}</p>
        <CompareTable rows={rows} />
      </section>

      {/* ------------------------------------------------ what moved where */}
      {c.tasks_moved.length > 0 && (
        <section>
          <Head
            right={`${c.tasks_moved_count} task${
              c.tasks_moved_count === 1 ? "" : "s"
            } move · ${
              c.slack_consumed_total_days
                ? `${days(c.slack_consumed_total_days)} of slack used`
                : "no slack consumed"
            }`}
          >
            Which tasks move, and by how much
          </Head>
          <div className={cn(SCROLL, "max-w-4xl")}>
            <Table className="text-[14px]">
              <TableHeader>
                <TableRow className="border-line hover:bg-transparent">
                  <TableHead className={cn("h-7 px-2", LABEL)}>Task</TableHead>
                  <TableHead className={cn("h-7 w-20 px-2 text-right", LABEL)}>
                    Before
                  </TableHead>
                  <TableHead className={cn("h-7 w-20 px-2 text-right", LABEL)}>
                    After
                  </TableHead>
                  <TableHead className={cn("h-7 w-20 px-2 text-right", LABEL)}>
                    Delta
                  </TableHead>
                  <TableHead className={cn("h-7 w-24 px-2 text-right", LABEL)}>
                    Slack used
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {c.tasks_moved.map((m) => (
                  <TableRow
                    key={m.task}
                    data-state={m.delta_days !== 0 ? "selected" : undefined}
                    className="border-line/50"
                  >
                    <TableCell className="px-2 py-1 align-top whitespace-normal">
                      <span className="mr-2 font-mono text-[12px] text-dim">
                        {m.task}
                      </span>
                      {m.name}
                    </TableCell>
                    <TableCell className="px-2 py-1 text-right align-top text-dim">
                      day {Math.round(m.from_day)}
                    </TableCell>
                    <TableCell className="px-2 py-1 text-right align-top font-medium">
                      day {Math.round(m.to_day)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "px-2 py-1 text-right align-top",
                        deltaTone(m.delta_days),
                      )}
                    >
                      {days(m.delta_days, true)}
                    </TableCell>
                    <TableCell className="px-2 py-1 text-right align-top text-dim">
                      {c.slack_consumed[m.task]
                        ? days(c.slack_consumed[m.task])
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {/* ------------------------------------------------ the two chains */}
      <CriticalPathCompare comparison={c} />
      <StructureCompare comparison={c} />

      <FindingsCompare comparison={c} />

      {result.after.resource_unavailability?.is_approximation && (
        <section>
          <Head>How unavailability was modelled</Head>
          <p className="mb-1.5 max-w-3xl text-[12px] text-dim">
            {result.after.resource_unavailability.method}
          </p>
          <div className={cn(SCROLL, "max-w-3xl px-2.5 py-1.5")}>
            <ul className="flex flex-col gap-0.5 text-[12px]">
              {result.after.resource_unavailability.adjustments?.map((a) => (
                <li key={a.task}>
                  <span className="font-mono text-dim">{a.task}</span>{" "}
                  {a.task_name} — {days(a.days_added)} added because{" "}
                  {a.resource_name} is away during its window
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* ------------------------------------------------ the proof */}
      <section>
        <Head
          right={
            <span className="inline-flex items-center gap-1.5">
              {result.base_unchanged ? (
                <Check className={cn(ICON, bandText("low"))} aria-hidden />
              ) : (
                <TriangleAlert
                  className={cn(ICON, bandText("high"))}
                  aria-hidden
                />
              )}
              <Badge
                variant="outline"
                className={cn(
                  "font-normal",
                  bandClasses(result.base_unchanged ? "low" : "high"),
                )}
              >
                {result.base_unchanged ? "unchanged" : "CHANGED"}
              </Badge>
            </span>
          }
        >
          Is the original workflow untouched?
        </Head>
        <p className="mb-2 text-[14px] text-dim">
          The base version&apos;s content hash, before and after this
          evaluation.
        </p>
        <dl className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1 rounded-md bg-panel2 px-2.5 py-2 font-mono text-[12px]">
          <dt className="text-dim">before</dt>
          <dd className="truncate">{result.base_version_hash.slice(0, 32)}…</dd>
          <dt className="text-dim">after</dt>
          <dd className="truncate">
            {result.base_version_hash_after_evaluation.slice(0, 32)}…
          </dd>
          <dt className="text-dim">this scenario</dt>
          <dd className="truncate text-dim">
            {result.scenario_hash.slice(0, 32)}…
          </dd>
        </dl>
        <Reveal
          summary={`The ${result.inverse_mutations.length} mutation${
            result.inverse_mutations.length === 1 ? "" : "s"
          } that would undo this`}
        >
          <div className={cn(SCROLL, "max-w-3xl px-2.5 py-1.5")}>
            <ul className="flex flex-col gap-0.5 text-[12px] text-dim">
              {/* The phrase is the text; the recorded payload is hover text,
                  so a sceptical reader can still see exactly what was stored
                  without the primary line being JSON. */}
              {result.inverse_mutations.map((m, i) => (
                <li key={i} title={JSON.stringify(m.payload)}>
                  {describeMutation(m)}
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------ sub-sections */

function CriticalPathCompare({ comparison }: { comparison: Comparison }) {
  const cp = comparison.critical_path;
  return (
    <section>
      <Head right={cp.changed ? "re-routed" : "unchanged"}>Critical path</Head>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Side label="before" quiet>
          <span className="font-mono text-[12px] break-words">
            {cp.before.join(" → ")}
          </span>
        </Side>
        <Side label="after" quiet={!cp.changed}>
          <span className="font-mono text-[12px] break-words">
            {cp.after.join(" → ")}
          </span>
        </Side>
      </div>
      {cp.changed ? (
        <div className="mt-2 flex flex-col gap-0.5 text-[12px]">
          {cp.newly_critical.length > 0 && (
            <p className={bandText("high")}>
              newly critical: {cp.newly_critical.join(", ")}
            </p>
          )}
          {cp.no_longer_critical.length > 0 && (
            <p className={bandText("low")}>
              no longer critical: {cp.no_longer_critical.join(", ")}
            </p>
          )}
        </div>
      ) : (
        <p className="mt-2 text-[12px] text-dim">
          Unchanged: the same zero-slack chain before and after.
        </p>
      )}
    </section>
  );
}

function StructureCompare({ comparison }: { comparison: Comparison }) {
  const s = comparison.structure;
  const scope = Math.abs(s.total_effort_delta) > 1e-9;
  const lines: [string, string][] = [];
  if (s.tasks_added.length) lines.push(["tasks added", s.tasks_added.join(", ")]);
  if (s.tasks_removed.length)
    lines.push(["tasks removed", s.tasks_removed.join(", ")]);
  if (s.dependencies_removed.length)
    lines.push([
      "dependencies removed",
      s.dependencies_removed.map(([a, b]) => `${a}→${b}`).join(", "),
    ]);
  if (s.dependencies_added.length)
    lines.push([
      "dependencies added",
      s.dependencies_added.map(([a, b]) => `${a}→${b}`).join(", "),
    ]);

  return (
    <section>
      <Head
        right={
          scope ? (
            <span className={bandText("moderate")}>
              {days(s.total_effort_delta, true)} of work
            </span>
          ) : (
            "no scope change"
          )
        }
      >
        Structure and scope
      </Head>
      {lines.length > 0 ? (
        <dl className="grid grid-cols-[9.5rem_1fr] gap-x-3 gap-y-1 text-[12px]">
          {lines.map(([k, v]) => (
            <div key={k} className="col-span-2 grid grid-cols-subgrid">
              <dt className="text-dim">{k}</dt>
              <dd className="font-mono break-words">{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-[14px] text-dim">
          The same tasks and the same dependencies, in the same shape.
        </p>
      )}
      {scope && (
        <p className={cn("mt-2 max-w-prose text-[14px]", bandText("moderate"))}>
          This changes how much work there is, not just how it is arranged.
          That is a scope decision.
        </p>
      )}
    </section>
  );
}

function FindingsCompare({ comparison }: { comparison: Comparison }) {
  const f = comparison.findings;
  if (!f.removed.length && !f.created.length) return null;
  return (
    <section>
      <Head right={`${f.before_count} → ${f.after_count}`}>
        Findings, before and after
      </Head>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Side label={`${f.removed.length} resolved`}>
          {f.removed.length > 0 ? (
            <ul className="flex flex-col gap-0.5 text-[12px]">
              {f.removed.map((x, i) => (
                <li key={i} className="text-dim">
                  {findingKindLabel(x.kind)} on{" "}
                  <span className="font-mono text-foreground">
                    {x.root_cause}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-dim">none</p>
          )}
        </Side>
        <Side label={`${f.created.length} newly appearing`}>
          {f.created.length > 0 ? (
            <ul className="flex flex-col gap-0.5 text-[12px]">
              {f.created.map((x, i) => (
                <li key={i} className="text-dim">
                  {findingKindLabel(x.kind)} on{" "}
                  <span className="font-mono text-foreground">
                    {x.root_cause}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-dim">none</p>
          )}
        </Side>
      </div>
    </section>
  );
}
