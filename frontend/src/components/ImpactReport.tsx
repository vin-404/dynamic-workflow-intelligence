"use client";

/**
 * What a re-worded requirement would cost, before anything is applied.
 *
 * **This screen leads with effort, not with the date, and that is deliberate.**
 * `cpm.py` is status-blind: a completed task already occupies its full
 * authored duration in the projection, so re-opening it cannot lengthen the
 * critical path. `schedule_impact.delta_days` is therefore usually 0 — and
 * that is *not* the change being free (D-157). The honest, non-zero, alarming
 * number is `wasted_effort.wasted_days`: days of finished work invalidated.
 * So that is the headline, the date sits under it as context, and the date is
 * never shown without `schedule_impact.caveat` when
 * `rework_shows_as_calendar_slip` is false.
 *
 * **The other thing this screen must not do is read as a judgement about
 * meaning.** It is not one. The blast radius is graph reachability over the
 * `consumes` edges; nothing here reads the two wordings and no language model
 * is involved. `assumptions.material_change_is_a_human_judgement` therefore
 * sits directly beside the headline numbers as the panel's caveat line, with
 * the full sentence one click away — and the whole assumptions block plus the
 * `unavailable` list are iterated at the foot, so a caveat the backend adds
 * later appears here with no change to this file.
 *
 * Every row carries its own evidence: `reason.sentence` says why a task is in
 * the list it is in, and `wasted_effort.rows[].arithmetic` shows the sum. A
 * number without its working is the thing this project is written against.
 *
 * **Shape.** A run of panels: the headline; must-redo and must-recheck side by
 * side, each with its count as the panel's one headline figure (the same pair
 * the staleness preview draws before a wording exists); who needs to know;
 * the findings; the wording before and after; the replan; the proof; and what
 * it all rests on.
 */

import { ReactNode, useState } from "react";
import { CircleCheck, LoaderCircle, TriangleAlert } from "lucide-react";
import {
  AffectedTask,
  ApiError,
  ImpactReport as Report,
  MutationIn,
  RequirementApplyResult,
  SimulationResponse,
  assumptionSentences,
  evaluateScenario,
  humanizeKey,
  unavailableEntries,
} from "@/lib/api";
import {
  calendarDate,
  describeMutation,
  findingKindLabel,
  prose,
  scenarioStatusLabel,
  statusLabel,
} from "@/lib/display";
import { severityClasses } from "@/lib/severity";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import DiffView from "./DiffView";
import ErrorBoundary from "./ErrorBoundary";
import { ErrorNote, Worked, days } from "./ui";

/* ------------------------------------------------------------------ bits */

const PANEL = "rounded-xl border border-line bg-panel p-5";

const SUMMARY =
  "flex cursor-pointer list-none items-center gap-1 text-[14px] text-accent marker:content-none hover:underline [&::-webkit-details-marker]:hidden";

const CHIP =
  "inline-flex items-center rounded-full border px-2 py-0.5 text-[12px] leading-4 whitespace-nowrap";

function Caret() {
  return (
    <>
      <span className="inline-block w-3 group-open:hidden">▸</span>
      <span className="hidden w-3 group-open:inline-block">▾</span>
    </>
  );
}

/**
 * `2026-09-23` as `23 Sep 2026`, through the display map's `calendarDate`
 * (UTC accessors, so the day never shifts per reader — D-127). An
 * unparsable string is shown as sent rather than hidden.
 */
function dateLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  return calendarDate(iso) ?? iso;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** A section title with its right-hand meta. */
function Heading({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h3 className="text-[18px] font-semibold">{children}</h3>
      {right && <span className="text-[12px] text-dim">{right}</span>}
    </div>
  );
}

/**
 * A panel title whose count is the panel's headline figure. "Must redo — 6"
 * stays one run of inline text, because the walkthrough reads it as such.
 */
function CountHeading({
  children,
  count,
  tone,
  right,
}: {
  children: ReactNode;
  count: number;
  tone: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
      <h3 className="text-[18px] font-semibold leading-none">
        {children} <span className="font-normal text-dim">—</span>{" "}
        <span className={cn("text-[36px] font-semibold leading-none", tone)}>
          {count}
        </span>
      </h3>
      {right && <span className="text-[12px] text-dim">{right}</span>}
    </div>
  );
}

/** A task key, everywhere, in the one form identifiers take in this product. */
function Key({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[12px] text-dim">{children}</span>;
}

/* ------------------------------------------------------- honesty elements */

const HUMAN_JUDGEMENT_KEY = "material_change_is_a_human_judgement";

/**
 * The caveat that makes this feature honest rather than a lie, rendered
 * beside the numbers: the one-line statement always visible, the backend's
 * full sentence one click away, verbatim.
 *
 * It falls back to the first sentence in the block if the backend ever renames
 * the key, because the failure mode of "the key moved so the most important
 * caveat silently vanished" is not one this screen may have. The full block is
 * rendered at the foot regardless, so this appearing twice is the safe side of
 * the trade.
 */
function HumanJudgement({ report }: { report: Report }) {
  const explicit = report.assumptions?.[HUMAN_JUDGEMENT_KEY];
  const text =
    typeof explicit === "string" && explicit.trim()
      ? explicit
      : (assumptionSentences(report.assumptions)[0]?.text ?? "");
  if (!text) return null;
  return (
    <div className="border-l-2 border-severity-medium pl-3">
      <p className="flex items-baseline gap-1.5 text-[14px] font-semibold">
        <TriangleAlert className="size-3.5 shrink-0 translate-y-0.5 text-severity-medium" />
        This is a blast radius, not a reading of your sentence
      </p>
      <details className="group mt-1">
        <summary className={SUMMARY}>
          <Caret />
          Why no number here is a judgement about meaning
        </summary>
        <p className="mt-2 max-w-2xl text-[12px] text-dim">{text}</p>
      </details>
    </div>
  );
}

/** Did a human remove consumers from this change's reach? */
function isScoped(report: Report): boolean {
  return report.scoped && report.scoped_out.length > 0;
}

/**
 * The badge that stops a scoped report being screenshot as an unscoped one.
 *
 * A scoped report's numbers are small *because somebody said so*, and by the
 * time it is a picture in a chat window the struck-out chips in the composer
 * are gone. So the fact travels with the number: a chip on the headline line
 * itself, and a sentence naming exactly which consumers were spared. It is on
 * the headline and not in the assumptions for the same reason the
 * human-judgement caveat is — a qualification a reader has to scroll to find
 * is a qualification that does not qualify anything.
 *
 * It is tied to `scoped_out`, not to `scoped`: a scope that names every
 * consumer removes nothing, so the numbers are the unscoped ones and a badge
 * would be claiming a judgement nobody made.
 */
function ScopedBadge({ report }: { report: Report }) {
  if (!isScoped(report)) return null;
  const spared = report.scoped_out.length;
  const total = report.directly_consumed_by.length;
  return (
    <span
      className={cn(CHIP, severityClasses("medium"))}
      title={`Spared by your judgement: ${report.scoped_out.join(", ")}`}
    >
      Scoped by you —{" "}
      {spared === total ? `all ${total}` : `${spared} of ${total}`} consumers
      spared
    </span>
  );
}

/** The sentence under the headline naming what the badge is about. */
function ScopedNote({ report }: { report: Report }) {
  if (!isScoped(report)) return null;
  const spared = report.scoped_out;
  return (
    <div className="border-l-2 border-severity-medium pl-3">
      <p className="text-[14px] text-dim">
        You marked{" "}
        {spared.map((k, i) => (
          <span key={k}>
            {i > 0 && ", "}
            <Key>{k}</Key>
          </span>
        ))}{" "}
        as work this wording does not invalidate, so{" "}
        {spared.length === 1 ? "its" : "their"} reach is excluded from every
        number here.
      </p>
      <details className="group mt-1">
        <summary className={SUMMARY}>
          <Caret />
          What that exclusion means
        </summary>
        <p className="mt-2 max-w-2xl text-[12px] text-dim">
          That exclusion is your assertion about meaning; the graph would have
          included {spared.length === 1 ? "it" : "them"}. Widen the{" "}
          <span className="font-mono">invalidates</span> chips above for the
          unscoped cost.
        </p>
      </details>
    </div>
  );
}

/* --------------------------------------------------------------- headline */

/**
 * Lead with the effort. The date is context and never appears without its
 * caveat.
 */
function Headline({ report }: { report: Report }) {
  const w = report.wasted_effort;
  const s = report.schedule_impact;
  const b = report.blast_radius;
  const lost = w.wasted_days > 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className={cn(
            "text-[36px] leading-none font-semibold",
            lost ? "text-critical" : "text-dim",
          )}
        >
          {days(w.wasted_days)}
        </span>
        <span className="text-[14px] font-medium">
          of completed work invalidated
        </span>
        <span className="text-[12px] text-dim">
          and {days(w.redo_cost_days)} to do it again
        </span>
        <ScopedBadge report={report} />
      </div>

      <p className="text-[14px]">
        <span className="font-semibold text-critical">
          {b.must_redo_count} {plural(b.must_redo_count, "task")} must be redone
        </span>
        <span className="text-dim">
          {" "}
          across {b.owners_affected} {plural(b.owners_affected, "owner")} ·{" "}
          {b.must_recheck_count} more to recheck ·{" "}
          {days(w.blast_radius_effort_days)} of planned effort inside the blast
          radius · {Math.round(b.share_of_project * 100)}% of the{" "}
          {b.tasks_in_project} tasks in this project
        </span>
      </p>

      <ScopedNote report={report} />

      {/* The date, and its caveat, as one indivisible unit. */}
      <div className="border-l-2 border-line pl-3">
        <p className="flex flex-wrap items-baseline gap-x-2 text-[14px]">
          <span className="text-[12px] text-dim">Projected finish</span>
          <span className="font-medium">
            {dateLabel(s.projected_end_date_before)}
          </span>
          <span className="text-dim">→</span>
          <span className="font-medium">
            {dateLabel(s.projected_end_date_after)}
          </span>
          <span
            className={cn(
              "font-semibold",
              s.delta_days > 0 ? "text-critical" : "text-dim",
            )}
          >
            {days(s.delta_days, true)}
          </span>
          <span className="text-dim">·</span>
          <span className={s.deadline_survives ? "text-dim" : "text-critical"}>
            {s.deadline_date
              ? s.deadline_survives
                ? `deadline ${dateLabel(s.deadline_date)} holds, ${days(
                    s.margin_days_after,
                  )} to spare`
                : `deadline ${dateLabel(s.deadline_date)} is missed`
              : "no deadline set"}
          </span>
        </p>
        {/*
          The delta never appears without its caveat when the payload says the
          rework does not show as calendar slip. The backend sends an empty
          `caveat` when nothing was actually wasted — there is then nothing to
          warn about, because the date and the effort agree. The last branch is
          the belt-and-braces case: real days lost and no sentence to explain
          why the date sat still. It should never fire; if it does, the screen
          still says the true thing rather than showing a bare `+0d`.
        */}
        {s.caveat ? (
          <div className="mt-1">
            {!s.rework_shows_as_calendar_slip && (
              <p className="text-[14px] font-medium">
                The date not moving is not the change being free.
              </p>
            )}
            <details className="group mt-1">
              <summary className={SUMMARY}>
                <Caret />
                Why the date sits still
              </summary>
              <p className="mt-2 max-w-2xl text-[12px] text-dim">{s.caveat}</p>
            </details>
          </div>
        ) : (
          !s.rework_shows_as_calendar_slip &&
          w.wasted_days > 0 && (
            <div className="mt-1">
              <p className="text-[14px] font-medium">
                The date not moving is not the change being free.
              </p>
              <details className="group mt-1">
                <summary className={SUMMARY}>
                  <Caret />
                  Why the date sits still
                </summary>
                <p className="mt-2 max-w-2xl text-[12px] text-dim">
                  {days(w.wasted_days)} of finished work has to be spent again.
                  This scheduler gives every task its full authored duration
                  whatever its status, so the plan already contained those days
                  and re-opening the work cannot lengthen the critical path.
                  Read the cost above, not here.
                </p>
              </details>
            </div>
          )
        )}
        {s.critical_path_changed && (
          <p className="mt-1 text-[12px] text-dim">
            The critical path changes.{" "}
            {s.newly_critical.length > 0 && (
              <>
                Newly critical:{" "}
                {s.newly_critical.map((k) => (
                  <span key={k} className="mr-1.5 font-mono text-accent">
                    {k}
                  </span>
                ))}
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- no impact */

/**
 * `no_impact` is a well-formed answer, not an error and not an empty state.
 *
 * It has two causes and they read differently: nothing in the graph consumes
 * this requirement at all, or the reader scoped the change to no consumers.
 * The second must not be dressed up as the first, so the scoped-out keys are
 * named.
 */
function NoImpact({ report }: { report: Report }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[36px] leading-none font-semibold text-dim">
          0d
        </span>
        <span className="text-[14px] font-medium">
          of completed work invalidated
        </span>
        <ScopedBadge report={report} />
      </div>

      {/*
        The API's sentence is rendered as it comes. `services/requirements.py`
        branches on `scoped` and says which situation it is, so there is one
        source of truth for the sentence. The badge and note above are
        structural rather than prose, so they hold the scoped fact
        independently of whichever wording arrives.
      */}
      <p className="max-w-3xl text-[14px]">{report.statement}</p>

      <ScopedNote report={report} />

      <p className="text-[12px] text-dim">
        Still worth reading the assumptions below: the reach of a requirement is
        only as good as the <code className="font-mono">consumes</code> flags on
        this project&rsquo;s dependencies.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------- must redo */

/**
 * One row per task, with the arithmetic on the row.
 *
 * `wasted_effort.rows` and `must_redo` are the same set in the same order, so
 * they are joined here rather than shown as two lists the reader has to walk
 * between. Not-started rows genuinely add no new cost and their arithmetic
 * says so — which is why every row keeps its sentence rather than only the
 * expensive ones.
 */
function MustRedo({ report }: { report: Report }) {
  const reasons = new Map(report.must_redo.map((t) => [t.key, t]));
  const rows = report.wasted_effort.rows;
  const w = report.wasted_effort;

  return (
    <section className={cn(PANEL, "flex min-w-0 flex-col")}>
      <CountHeading count={rows.length} tone="text-critical">
        Must redo
      </CountHeading>
      <p className="text-[12px] text-dim">
        {w.completed_task_count} {plural(w.completed_task_count, "task")}{" "}
        already finished · {days(w.in_flight_days)} in flight ·{" "}
        {days(w.not_yet_started_days)} not yet started
      </p>

      {rows.length === 0 ? (
        <p className="mt-3 text-[14px] text-dim">none</p>
      ) : (
        <ul className="mt-3 flex flex-col">
          {rows.map((row) => {
            const task = reasons.get(row.key);
            return (
              <li
                key={row.key}
                className="flex flex-col gap-y-0.5 border-b border-line/60 py-2 last:border-0"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Key>{row.key}</Key>
                  <span className="text-[14px] font-medium">{row.name}</span>
                  {row.counts_as_wasted && (
                    <span
                      className={cn(
                        CHIP,
                        "border-critical/30 bg-critical/10 text-critical",
                      )}
                    >
                      completed work lost
                    </span>
                  )}
                </div>
                <p className="text-[12px] text-dim">
                  <span
                    className={cn(
                      row.status === "done" && "font-semibold text-critical",
                    )}
                  >
                    {statusLabel(row.status)}
                  </span>
                  {" · "}
                  {task?.owners.length
                    ? task.owners.map((o) => o.label).join(", ")
                    : "unassigned"}
                  {" · "}
                  {days(row.effort_days)} of effort ·{" "}
                  <span
                    className={cn(
                      row.wasted_days > 0 && "font-semibold text-critical",
                    )}
                  >
                    {days(row.wasted_days)} wasted
                  </span>{" "}
                  · {days(row.redo_days)} to redo
                </p>
                <details className="group">
                  <summary className={cn(SUMMARY, "text-[12px]")}>
                    <Caret />
                    Why, and the arithmetic
                  </summary>
                  <div className="mt-1 flex flex-col gap-0.5 pl-4 text-[12px] text-dim">
                    {task && <p>{task.reason.sentence}</p>}
                    <p>{row.arithmetic}</p>
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}

      {/* The total, worked out. */}
      {rows.length > 0 && (
        <p className="mt-auto flex flex-wrap items-baseline gap-2 border-t border-line pt-3 text-[12px]">
          <Worked>total</Worked>
          <span className="flex-1 text-dim">{w.arithmetic}</span>
        </p>
      )}
    </section>
  );
}

/* ----------------------------------------------------------- must recheck */

function MustRecheck({ tasks }: { tasks: AffectedTask[] }) {
  return (
    <section className={cn(PANEL, "flex min-w-0 flex-col")}>
      <CountHeading count={tasks.length} tone="text-severity-medium">
        Must recheck
      </CountHeading>
      <p className="text-[12px] text-dim">
        Downstream in time, but nothing they consumed is known to be wrong.
        Listed and deliberately not costed — a recheck may cost nothing or may
        cost the whole task, and guessing which would put an invented number
        beside real ones.
      </p>
      {tasks.length === 0 ? (
        <p className="mt-3 text-[14px] text-dim">none</p>
      ) : (
        <ul className="mt-3 flex flex-col">
          {tasks.map((t) => (
            <li
              key={t.key}
              className="flex flex-col gap-y-0.5 border-b border-line/60 py-2 last:border-0"
            >
              <div className="flex flex-wrap items-baseline gap-x-2">
                <Key>{t.key}</Key>
                <span className="text-[14px] font-medium">{t.name}</span>
              </div>
              <p className="text-[12px] text-dim">
                {statusLabel(t.status)} · {days(t.effort_days)} ·{" "}
                {t.owners.length
                  ? t.owners.map((o) => o.label).join(", ")
                  : "unassigned"}
              </p>
              <p className="text-[12px] text-dim">{t.reason.sentence}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------ who needs to know */

function WhoNeedsToKnow({ report }: { report: Report }) {
  const who = report.who_needs_to_know;
  if (who.by_resource.length === 0 && !who.unassigned.note) return null;

  return (
    <section className={PANEL}>
      <Heading>
        Who needs to know — {who.resource_count}{" "}
        {plural(who.resource_count, "owner")}
      </Heading>
      <ul>
        {who.by_resource.map((r) => (
          <li
            key={r.resource_key}
            className="border-b border-line/60 py-2 last:border-0"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="text-[14px] font-medium">{r.label}</span>
              <span className="text-[12px] text-dim">
                {r.completed_work_lost_days > 0 && (
                  <span className="font-semibold text-critical">
                    {days(r.completed_work_lost_days)} of finished work lost ·{" "}
                  </span>
                )}
                {days(r.blast_radius_effort_days)} of effort in the blast radius
              </span>
            </div>
            <p className="mt-0.5 text-[14px]">{r.what_they_lose}</p>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-dim">
              {r.must_redo.length > 0 && (
                <span>
                  redo:{" "}
                  {r.must_redo.map((t, i) => (
                    <span key={t.key}>
                      {i > 0 && ", "}
                      <span
                        className={cn(
                          "font-mono",
                          t.completed_and_lost && "text-critical",
                        )}
                        title={
                          t.completed_and_lost
                            ? `${t.name} — already finished, ${days(
                                t.effort_days,
                              )} lost`
                            : t.name
                        }
                      >
                        {t.key}
                      </span>
                    </span>
                  ))}
                </span>
              )}
              {r.must_recheck.length > 0 && (
                <span>
                  recheck:{" "}
                  {r.must_recheck.map((t, i) => (
                    <span key={t.key}>
                      {i > 0 && ", "}
                      <span className="font-mono" title={t.name}>
                        {t.key}
                      </span>
                    </span>
                  ))}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
      {who.unassigned.note && (
        <p className="mt-2 text-[12px] text-dim">{who.unassigned.note}</p>
      )}
    </section>
  );
}

/* --------------------------------------------------------------- findings */

function FindingsDelta({ report }: { report: Report }) {
  const f = report.findings;
  if (f.created_count === 0 && f.cleared_count === 0) return null;
  return (
    <section className={PANEL}>
      <Heading
        right={`${f.before_count} findings before, ${f.after_count} after · ${f.unchanged_count} unchanged`}
      >
        Findings this change would create and clear
      </Heading>
      <ul>
        {f.created.map((finding, i) => (
          <li
            key={`c${i}`}
            className="border-b border-line/60 py-2 last:border-0"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={cn(CHIP, severityClasses(finding.severity))}>
                appears
              </span>
              <span className="text-[14px] font-medium">
                {findingKindLabel(finding.kind)}
              </span>
              <span className="font-mono text-[12px] text-dim">
                {finding.task_ids.join(", ")}
              </span>
            </div>
            <p className="mt-0.5 text-[12px] text-dim">
              {prose(finding.explanation)}
            </p>
          </li>
        ))}
        {f.cleared.map((finding, i) => (
          <li
            key={`x${i}`}
            className="border-b border-line/60 py-2 last:border-0"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={cn(CHIP, "border-line bg-panel2 text-dim")}>
                clears
              </span>
              <span className="text-[14px] font-medium text-dim line-through">
                {findingKindLabel(finding.kind)}
              </span>
              <span className="font-mono text-[12px] text-dim">
                {finding.task_ids.join(", ")}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------- text diff */

type Segment = { op?: unknown; kind?: unknown; text?: unknown };

/**
 * One side of the wording, from the API's merged segments: the "before"
 * column drops the additions, the "after" column drops the removals. Nothing
 * is re-diffed here.
 */
function WordingSide({
  segments,
  side,
  fallback,
}: {
  segments: Segment[];
  side: "before" | "after";
  fallback: string;
}) {
  if (segments.length === 0) {
    return <p className="text-[14px] leading-relaxed">{fallback}</p>;
  }
  return (
    <p className="text-[14px] leading-relaxed">
      {segments.map((seg, i) => {
        const op = String(seg.op ?? seg.kind ?? "equal");
        const text = String(seg.text ?? "");
        if (op === "removed") {
          if (side === "after") return null;
          return (
            <span key={i} className="mr-1 bg-critical/10 text-critical line-through">
              {text}
            </span>
          );
        }
        if (op === "added") {
          if (side === "before") return null;
          return (
            <span key={i} className="mr-1 bg-severity-low/10 text-severity-low">
              {text}
            </span>
          );
        }
        return (
          <span key={i} className="mr-1">
            {text}
          </span>
        );
      })}
    </p>
  );
}

function TextDiff({ report }: { report: Report }) {
  const d = report.text_diff;
  const segments = d.segments as Segment[];
  return (
    <section className={PANEL}>
      <Heading>The wording</Heading>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg bg-panel2/60 p-3">
          <p className="mb-1 text-[12px] text-dim">
            before · v{report.from_version}
          </p>
          <WordingSide segments={segments} side="before" fallback={d.before} />
        </div>
        <div className="rounded-lg bg-panel2/60 p-3">
          <p className="mb-1 text-[12px] text-dim">
            after · v{report.to_version}
          </p>
          <WordingSide segments={segments} side="after" fallback={d.after} />
        </div>
      </div>
      <p className="mt-2 text-[12px] text-dim">
        {d.note}
        {typeof d.similarity === "number" && (
          <>
            {" "}
            ({Math.round(d.similarity * 100)}% of the words are shared — shown
            because it is readable, used for nothing.)
          </>
        )}
      </p>
    </section>
  );
}

/* ----------------------------------------------------------------- replan */

/**
 * The ready-to-apply replan, and applying it.
 *
 * Applying is separated from asking by an explicit confirm step that names
 * what will be written, rather than by a modal: the consequences belong beside
 * the evidence the reader has just read, not on top of it. `.../apply` is
 * `editor`-gated and writes a new workflow version, which is the one operation
 * on this screen with no undo.
 */
function Replan({
  report,
  onApply,
  applying,
  applyError,
  applied,
}: {
  report: Report;
  onApply?: () => void;
  applying?: boolean;
  applyError?: ReactNode;
  applied?: RequirementApplyResult | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const replan = report.replan;

  /*
   * The replan is a stored scenario, so it has the same before/after diff a
   * what-if has - the schedule, the critical path, the findings that appear
   * and clear. `POST /api/scenarios/{id}/evaluate` is a read: it writes an
   * analysis run and nothing else, and the guest may call it. Fetched on
   * demand rather than with the report, because the report already says
   * what a change costs; this is for the reader who wants to see the shape
   * of the workflow after it.
   */
  const [diff, setDiff] = useState<SimulationResponse | null>(null);
  const [diffError, setDiffError] = useState<ApiError | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);

  async function showDiff() {
    if (!replan.scenario_id) return;
    setDiffBusy(true);
    setDiffError(null);
    try {
      setDiff(await evaluateScenario(replan.scenario_id));
    } catch (e) {
      setDiffError(e as ApiError);
    } finally {
      setDiffBusy(false);
    }
  }

  return (
    <section className={PANEL}>
      <Heading
        right={`${scenarioStatusLabel(replan.status)} · ${
          applied ? "applied" : "not applied"
        }`}
      >
        {applied ? "The replan" : "The replan, ready and unapplied"}
      </Heading>

      {/* The mutations, each through the display map. The engine's own
          `describes` sentence, when it says something more, stays beside
          it. The raw payload is hover text, never the primary line. */}
      <ul className="mb-2">
        {replan.mutations.map((m: MutationIn, i) => {
          const phrase = describeMutation(m);
          const describes = (m as { describes?: string }).describes;
          return (
            <li
              key={i}
              className="flex flex-wrap items-baseline gap-x-2 border-b border-line/60 py-1.5 text-[14px] last:border-0"
            >
              <span title={JSON.stringify(m.payload)}>{phrase}</span>
              {describes && describes !== phrase && (
                <span className="text-[12px] text-dim">{describes}</span>
              )}
            </li>
          );
        })}
      </ul>

      {replan.inverse_mutations.length > 0 && (
        <p className="mb-2 text-[12px] text-dim">
          Its inverse is stored too, in {replan.inverse_mutations.length}{" "}
          {plural(replan.inverse_mutations.length, "mutation")} — including the
          statuses that would have to be restored to undo it.
        </p>
      )}
      {replan.kept_note && (
        <p className="mb-2 text-[12px] text-dim">{replan.kept_note}</p>
      )}
      {replan.expressed_in && (
        <details className="group mb-3">
          <summary className={SUMMARY}>
            <Caret />
            How this replan is expressed
          </summary>
          <p className="mt-2 max-w-2xl pl-4 text-[12px] text-dim">
            {replan.expressed_in}
          </p>
        </details>
      )}

      {replan.kept && replan.scenario_id && !applied && (
        <div className="mb-3">
          {!diff && (
            <Button
              size="sm"
              variant="ghost"
              disabled={diffBusy}
              onClick={showDiff}
            >
              {diffBusy && (
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
              )}
              {diffBusy
                ? "Evaluating the replan…"
                : "Show the workflow before and after this replan"}
            </Button>
          )}
          {diffError && (
            <ErrorNote
              hint={diffError.hint}
              requestId={diffError.requestId}
              onRetry={showDiff}
            >
              The replan could not be evaluated. {diffError.userMessage}
            </ErrorNote>
          )}
          {diff && (
            <div className="mt-2 border-t border-line pt-4">
              <ErrorBoundary what="The before/after diff">
                <DiffView result={diff} />
              </ErrorBoundary>
            </div>
          )}
        </div>
      )}

      {applied ? (
        <div className="border-l-2 border-severity-low pl-3 text-[14px]">
          <p>
            <span className="font-semibold text-severity-low">Applied.</span>{" "}
            <span className="text-dim">
              {report.requirement_key} is now v{applied.to_version}, and
              workflow version {applied.new_version.version_no} was written.
            </span>
          </p>
          <p className="mt-1 text-[12px] text-dim">
            {applied.parent_version.unchanged
              ? `Version ${applied.parent_version.version_no} survives with its content hash intact, so this is reversible.`
              : "The parent version's hash is not reported as unchanged — check the history stage."}
          </p>
          {(applied.attributed_to || applied.attribution_note) && (
            <p className="mt-1 text-[12px] text-dim">
              {applied.attributed_to
                ? `Recorded against ${applied.attributed_to}.`
                : applied.attribution_note}
            </p>
          )}
        </div>
      ) : !onApply ? null : confirming ? (
        <div className="border-l-2 border-critical pl-3">
          <p className="text-[14px] font-semibold text-critical">
            This one writes.
          </p>
          <ul className="mt-1 text-[12px] text-dim">
            <li>
              · {report.requirement_key} becomes version {report.to_version},
              worded as proposed.
            </li>
            <li>
              · {report.blast_radius.must_redo_count}{" "}
              {plural(report.blast_radius.must_redo_count, "task")} are
              re-opened, including {report.wasted_effort.completed_task_count}{" "}
              already finished.
            </li>
            <li>
              · A new workflow version is sealed. Version{" "}
              {report.version_no} is not destroyed.
            </li>
            <li>· It needs the editor role. A viewer gets a refusal, not a write.</li>
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={applying}
              onClick={onApply}
            >
              {applying ? "Applying…" : "Yes — apply and write a new version"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={applying}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
          Apply this replan…
        </Button>
      )}

      {applyError && <div className="mt-2">{applyError}</div>}
    </section>
  );
}

/* ------------------------------------------------------------ the proof */

function Proof({ report }: { report: Report }) {
  return (
    <section className={PANEL}>
      {/*
        Phrased about the *report*, not about the session. "Nothing was
        written" sat directly under an "Applied." banner and read as a
        contradiction; producing this report still wrote nothing, and that is
        what the hashes prove.
      */}
      <Heading right={`workflow version ${report.version_no}`}>
        Producing this report wrote nothing
      </Heading>
      <p className="flex flex-wrap items-baseline gap-1.5 text-[14px]">
        <CircleCheck
          className={cn(
            "size-3.5 shrink-0 translate-y-0.5",
            report.base_unchanged ? "text-severity-low" : "text-critical",
          )}
        />
        <span className="font-medium">
          {report.base_unchanged
            ? "The base version's content hash is identical before and after."
            : "The base version's content hash CHANGED. That should not happen — do not trust this report."}
        </span>
      </p>
      <dl className="mt-2 grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1 rounded-md bg-panel2 px-2.5 py-2 font-mono text-[12px]">
        <dt className="text-dim">hash before</dt>
        <dd className="break-all">{report.base_version_hash_before}</dd>
        <dt className="text-dim">hash after</dt>
        <dd className="break-all">{report.base_version_hash_after}</dd>
      </dl>
      {/* Engine and run identifiers are provenance for a bug report, not
          reading matter: one click away, never on the face of the panel. */}
      <details className="group mt-2">
        <summary className={SUMMARY}>
          <Caret />
          Engine and run identifiers
        </summary>
        <dl className="mt-2 grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1 pl-4 text-[12px]">
          <dt className="text-dim">engine</dt>
          <dd className="font-mono">{report.engine_version}</dd>
          <dt className="text-dim">analysis run</dt>
          <dd className="font-mono break-all">{report.analysis_run_id}</dd>
        </dl>
      </details>
    </section>
  );
}

/* ----------------------------------------------------------- assumptions */

/**
 * The whole block, iterated — never a hand-written list of the keys it has
 * today. A caveat the backend adds tomorrow appears here on its own. Behind
 * one disclosure, because the caveat that matters most is already on the
 * headline panel.
 */
function AssumptionsBlock({ report }: { report: Report }) {
  const sentences = assumptionSentences(report.assumptions);
  const unavailable = unavailableEntries(report.assumptions);
  const scalars = Object.entries(report.assumptions ?? {}).filter(
    ([, v]) => typeof v === "boolean",
  );
  if (sentences.length === 0 && scalars.length === 0 && unavailable.length === 0)
    return null;

  return (
    <details className={cn(PANEL, "group")}>
      <summary className={SUMMARY}>
        <Caret />
        What this rests on
        {unavailable.length > 0 &&
          ` — and ${unavailable.length} ${plural(unavailable.length, "thing")} it cannot tell you`}
      </summary>
      <div className="mt-3 border-l border-line pl-3 text-[12px]">
        <dl className="flex flex-col gap-2">
          {sentences.map(({ key, text }) => (
            <div key={key}>
              <dt className="font-medium text-foreground">{humanizeKey(key)}</dt>
              <dd className="text-dim">{text}</dd>
            </div>
          ))}
        </dl>

        {scalars.length > 0 && (
          <p className="mt-2 text-dim">
            {scalars.map(([k, v], i) => (
              <span key={k}>
                {i > 0 && " · "}
                {humanizeKey(k)}: {v ? "yes" : "no"}
              </span>
            ))}
          </p>
        )}

        {unavailable.length > 0 && (
          <>
            <div className="mt-3 mb-1.5 text-[14px] font-semibold">
              What this report cannot tell you — {unavailable.length}
            </div>
            <ul className="flex flex-col gap-2">
              {unavailable.map((entry, i) => (
                <li key={entry.check ?? entry.name ?? i}>
                  <div className="font-medium text-foreground">
                    {humanizeKey(String(entry.check ?? entry.name ?? ""))}
                  </div>
                  {entry.why && <p className="text-dim">{entry.why}</p>}
                  {entry.would_unlock_it && (
                    <p className="text-accent">{entry.would_unlock_it}</p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </details>
  );
}

/* ------------------------------------------------------------------ main */

export default function ImpactReport({
  report,
  onApply,
  applying,
  applyError,
  applied,
}: {
  report: Report;
  /** Omitted where applying makes no sense — a comparison option, say. */
  onApply?: () => void;
  applying?: boolean;
  applyError?: ReactNode;
  applied?: RequirementApplyResult | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      {/* The headline panel: the one figure, and the caveat beside it. */}
      <section className={cn(PANEL, "flex flex-col gap-4")}>
        {report.no_impact ? (
          <NoImpact report={report} />
        ) : (
          <Headline report={report} />
        )}
        <HumanJudgement report={report} />
      </section>

      {!report.no_impact && (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <MustRedo report={report} />
            <MustRecheck tasks={report.must_recheck} />
          </div>
          <WhoNeedsToKnow report={report} />
          <FindingsDelta report={report} />
        </>
      )}

      <TextDiff report={report} />

      <Replan
        report={report}
        onApply={onApply}
        applying={applying}
        applyError={applyError}
        applied={applied}
      />

      <Proof report={report} />
      <AssumptionsBlock report={report} />
    </div>
  );
}
