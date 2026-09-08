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
 * sits directly beside the headline numbers, in full, not behind a disclosure
 * triangle — and the whole assumptions block plus the `unavailable` list are
 * iterated at the foot, so a caveat the backend adds later appears here with
 * no change to this file.
 *
 * Every row carries its own evidence: `reason.sentence` says why a task is in
 * the list it is in, and `wasted_effort.rows[].arithmetic` shows the sum. A
 * number without its working is the thing this project is written against.
 */

import { ReactNode, useState } from "react";
import { CircleCheck, TriangleAlert } from "lucide-react";
import {
  AffectedTask,
  ImpactReport as Report,
  MutationIn,
  RequirementApplyResult,
  assumptionSentences,
  humanizeKey,
  unavailableEntries,
} from "@/lib/api";
import { severityClasses, severityText } from "@/lib/severity";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Worked, days } from "./ui";

/* ------------------------------------------------------------------ bits */

/**
 * `2026-09-23` as `23 Sep 2026`.
 *
 * Read through the UTC accessors. An ISO date-only string is parsed as UTC
 * midnight, so `getDate()` would shift the day backwards for every reader west
 * of Greenwich — silently, and differently per reader. Same reasoning as
 * D-127.
 */
function dateLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const month = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ][d.getUTCMonth()];
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** A ruled heading. Typography carries the hierarchy; there is no card. */
function Heading({
  children,
  note,
  right,
}: {
  children: ReactNode;
  note?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mb-2 border-b border-border pb-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
          {children}
        </h3>
        {right}
      </div>
      {note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

/** A task key, everywhere, in the one form identifiers take in this product. */
function Key({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs">{children}</span>;
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

/* ------------------------------------------------------- honesty elements */

const HUMAN_JUDGEMENT_KEY = "material_change_is_a_human_judgement";

/**
 * The caveat that makes this feature honest rather than a lie, rendered
 * beside the numbers.
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
    <div className="border-l-2 border-severity-medium bg-severity-medium/5 py-2 pr-2 pl-3">
      <p className="flex items-baseline gap-1.5 text-[13px] font-semibold">
        <TriangleAlert className="size-3.5 shrink-0 translate-y-0.5 text-severity-medium" />
        This is a blast radius, not a reading of your sentence
      </p>
      <p className="mt-1 text-xs text-foreground/90">{text}</p>
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
 * are gone. So the fact travels with the number: a badge on the headline line
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
    <Badge
      variant="outline"
      className={cn("h-5 px-2", severityClasses("medium"))}
      title={`Spared by your judgement: ${report.scoped_out.join(", ")}`}
    >
      Scoped by you —{" "}
      {spared === total ? `all ${total}` : `${spared} of ${total}`} consumers
      spared
    </Badge>
  );
}

/** The sentence under the headline naming what the badge is about. */
function ScopedNote({ report }: { report: Report }) {
  if (!isScoped(report)) return null;
  const spared = report.scoped_out;
  return (
    <p className="max-w-3xl border-l-2 border-severity-medium pl-3 text-xs">
      <span className="text-muted-foreground">
        You marked{" "}
        {spared.map((k, i) => (
          <span key={k}>
            {i > 0 && ", "}
            <Key>{k}</Key>
          </span>
        ))}{" "}
        as work this wording does not invalidate, so{" "}
        {spared.length === 1 ? "its" : "their"} reach is excluded from every
        number here. That exclusion is your assertion about meaning; the graph
        would have included {spared.length === 1 ? "it" : "them"}. Widen the{" "}
        <span className="font-mono">invalidates</span> chips above for the
        unscoped cost.
      </span>
    </p>
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
            "text-4xl leading-none font-semibold",
            lost ? severityText("high") : "text-muted-foreground",
          )}
        >
          {days(w.wasted_days)}
        </span>
        <span className="text-lg font-medium">
          of completed work invalidated
        </span>
        <span className="text-sm text-muted-foreground">
          and {days(w.redo_cost_days)} to do it again
        </span>
        <ScopedBadge report={report} />
      </div>

      <p className="text-sm">
        <span className={cn("font-semibold", severityText("high"))}>
          {b.must_redo_count} {plural(b.must_redo_count, "task")} must be redone
        </span>
        <span className="text-muted-foreground">
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
      <div className="border-l-2 border-border pl-3">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="text-[11px] tracking-wider text-muted-foreground uppercase">
            Projected finish
          </span>
          <span className="font-medium">
            {dateLabel(s.projected_end_date_before)}
          </span>
          <span className="text-muted-foreground">→</span>
          <span className="font-medium">
            {dateLabel(s.projected_end_date_after)}
          </span>
          <span
            className={cn(
              "font-semibold",
              s.delta_days > 0 ? severityText("high") : "text-muted-foreground",
            )}
          >
            {days(s.delta_days, true)}
          </span>
          <span className="text-muted-foreground">·</span>
          <span
            className={
              s.deadline_survives
                ? "text-muted-foreground"
                : severityText("high")
            }
          >
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
          <p className="mt-1 text-xs text-foreground/90">
            {!s.rework_shows_as_calendar_slip && (
              <span className="font-medium">
                The date not moving is not the change being free.{" "}
              </span>
            )}
            <span className="text-muted-foreground">{s.caveat}</span>
          </p>
        ) : (
          !s.rework_shows_as_calendar_slip &&
          w.wasted_days > 0 && (
            <p className="mt-1 text-xs text-foreground/90">
              <span className="font-medium">
                The date not moving is not the change being free.{" "}
              </span>
              <span className="text-muted-foreground">
                {days(w.wasted_days)} of finished work has to be spent again.
                This scheduler gives every task its full authored duration
                whatever its status, so the plan already contained those days
                and re-opening the work cannot lengthen the critical path. Read
                the cost above, not here.
              </span>
            </p>
          )
        )}
        {s.critical_path_changed && (
          <p className="mt-1 text-xs">
            <span className="text-muted-foreground">
              The critical path changes.{" "}
            </span>
            {s.newly_critical.length > 0 && (
              <>
                <span className="text-muted-foreground">Newly critical: </span>
                {s.newly_critical.map((k) => (
                  <span key={k} className="mr-1.5 text-accent">
                    <Key>{k}</Key>
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
        <span className="text-4xl leading-none font-semibold text-muted-foreground">
          0d
        </span>
        <span className="text-lg font-medium">
          of completed work invalidated
        </span>
        <ScopedBadge report={report} />
      </div>

      {/*
        The API's sentence is rendered as it comes. It used to claim "nothing
        consumes this" for both causes, which was false for the scoped one, and
        this component carried a correction. `services/requirements.py` now
        branches on `scoped` and says which situation it is, so the correction
        is gone and there is one source of truth for the sentence again.

        The badge and note above are structural rather than prose, so they hold
        the scoped fact independently of whichever wording arrives — including
        from an older backend that still sends the unbranched sentence.
      */}
      <p className="max-w-3xl text-sm text-foreground/90">{report.statement}</p>

      <ScopedNote report={report} />

      <p className="text-xs text-muted-foreground">
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
 * they are joined here rather than shown as two tables the reader has to walk
 * between. Not-started rows genuinely add no new cost and their arithmetic
 * says so — which is why every row keeps its sentence rather than only the
 * expensive ones.
 */
function MustRedo({ report }: { report: Report }) {
  const reasons = new Map(report.must_redo.map((t) => [t.key, t]));
  const rows = report.wasted_effort.rows;
  if (rows.length === 0) return null;

  return (
    <section>
      <Heading
        right={
          <span className="text-xs text-muted-foreground">
            {report.wasted_effort.completed_task_count}{" "}
            {plural(report.wasted_effort.completed_task_count, "task")} already
            finished · {days(report.wasted_effort.in_flight_days)} in flight ·{" "}
            {days(report.wasted_effort.not_yet_started_days)} not yet started
          </span>
        }
      >
        Must redo — {rows.length} {plural(rows.length, "task")}
      </Heading>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-[11px] tracking-wider text-muted-foreground uppercase">
              Task
            </TableHead>
            <TableHead className="text-[11px] tracking-wider text-muted-foreground uppercase">
              Status
            </TableHead>
            <TableHead className="text-[11px] tracking-wider text-muted-foreground uppercase">
              Owner
            </TableHead>
            <TableHead className="w-[1%] text-right text-[11px] tracking-wider text-muted-foreground uppercase">
              Effort
            </TableHead>
            <TableHead className="w-[1%] text-right text-[11px] tracking-wider text-muted-foreground uppercase">
              Wasted
            </TableHead>
            <TableHead className="w-[1%] text-right text-[11px] tracking-wider text-muted-foreground uppercase">
              Redo
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const task = reasons.get(row.key);
            return (
              <TableRow
                key={row.key}
                data-state={row.counts_as_wasted ? "selected" : undefined}
              >
                <TableCell className="align-top whitespace-normal">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <Key>{row.key}</Key>
                    <span className="font-medium">{row.name}</span>
                    {row.counts_as_wasted && (
                      <Badge
                        variant="outline"
                        className={cn("h-4 px-1.5", severityClasses("high"))}
                      >
                        completed work lost
                      </Badge>
                    )}
                  </div>
                  {task && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {task.reason.sentence}
                    </p>
                  )}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {row.arithmetic}
                  </p>
                </TableCell>
                <TableCell className="align-top text-xs text-muted-foreground">
                  {statusLabel(row.status)}
                </TableCell>
                <TableCell className="align-top text-xs text-muted-foreground">
                  {task?.owners.length
                    ? task.owners.map((o) => o.label).join(", ")
                    : "unassigned"}
                </TableCell>
                <TableCell className="align-top text-right text-muted-foreground">
                  {days(row.effort_days)}
                </TableCell>
                <TableCell
                  className={cn(
                    "align-top text-right",
                    row.wasted_days > 0
                      ? cn("font-semibold", severityText("high"))
                      : "text-muted-foreground",
                  )}
                >
                  {days(row.wasted_days)}
                </TableCell>
                <TableCell
                  className={cn(
                    "align-top text-right",
                    row.redo_days > 0 ? "font-medium" : "text-muted-foreground",
                  )}
                >
                  {days(row.redo_days)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {/*
        The total, worked out. `Worked` sets 11px mono in
        `text-muted-foreground` on a tinted ground, which is right for a short
        formula on a row and too faint for the sentence this whole section adds
        up to — so the marker stays (it is still the working) and the sentence
        is set at readable weight beside it.
      */}
      <p className="mt-2 flex flex-wrap items-baseline gap-2 border-l-2 border-border pl-3 text-xs">
        <Worked>total</Worked>
        <span className="flex-1 text-foreground/90">
          {report.wasted_effort.arithmetic}
        </span>
      </p>
    </section>
  );
}

/* ----------------------------------------------------------- must recheck */

function MustRecheck({ tasks }: { tasks: AffectedTask[] }) {
  if (tasks.length === 0) return null;
  return (
    <section>
      <Heading note="Downstream in time, but nothing they consumed is known to be wrong. Listed and deliberately not costed — a recheck may cost nothing or may cost the whole task, and guessing which would put an invented number beside real ones.">
        Must recheck — {tasks.length} {plural(tasks.length, "task")}
      </Heading>
      <ul>
        {tasks.map((t) => (
          <li
            key={t.key}
            className="border-b border-border py-1.5 last:border-0"
          >
            <div className="flex flex-wrap items-baseline gap-x-2">
              <Key>{t.key}</Key>
              <span className="text-sm font-medium">{t.name}</span>
              <span className="text-xs text-muted-foreground">
                {statusLabel(t.status)} · {days(t.effort_days)} ·{" "}
                {t.owners.length
                  ? t.owners.map((o) => o.label).join(", ")
                  : "unassigned"}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t.reason.sentence}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------ who needs to know */

function WhoNeedsToKnow({ report }: { report: Report }) {
  const who = report.who_needs_to_know;
  if (who.by_resource.length === 0 && !who.unassigned.note) return null;

  return (
    <section>
      <Heading>
        Who needs to know — {who.resource_count}{" "}
        {plural(who.resource_count, "owner")}
      </Heading>
      <ul>
        {who.by_resource.map((r) => (
          <li
            key={r.resource_key}
            className="border-b border-border py-2 last:border-0"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="text-sm font-medium">{r.label}</span>
              <span className="text-xs text-muted-foreground">
                {r.completed_work_lost_days > 0 && (
                  <span
                    className={cn("font-semibold", severityText("high"))}
                  >
                    {days(r.completed_work_lost_days)} of finished work lost ·{" "}
                  </span>
                )}
                {days(r.blast_radius_effort_days)} of effort in the blast radius
              </span>
            </div>
            <p className="mt-0.5 text-xs text-foreground/90">
              {r.what_they_lose}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {r.must_redo.length > 0 && (
                <span>
                  redo:{" "}
                  {r.must_redo.map((t, i) => (
                    <span key={t.key}>
                      {i > 0 && ", "}
                      <span
                        className={
                          t.completed_and_lost ? severityText("high") : ""
                        }
                        title={
                          t.completed_and_lost
                            ? `${t.name} — already finished, ${days(
                                t.effort_days,
                              )} lost`
                            : t.name
                        }
                      >
                        <Key>{t.key}</Key>
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
                      <span title={t.name}>
                        <Key>{t.key}</Key>
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
        <p className="mt-2 text-xs text-muted-foreground">
          {who.unassigned.note}
        </p>
      )}
    </section>
  );
}

/* --------------------------------------------------------------- findings */

function FindingsDelta({ report }: { report: Report }) {
  const f = report.findings;
  if (f.created_count === 0 && f.cleared_count === 0) return null;
  return (
    <section>
      <Heading
        note={`${f.before_count} findings before, ${f.after_count} after. ${f.unchanged_count} unchanged.`}
      >
        Findings this change would create and clear
      </Heading>
      <ul>
        {f.created.map((finding, i) => (
          <li
            key={`c${i}`}
            className="border-b border-border py-1.5 last:border-0"
          >
            <div className="flex flex-wrap items-baseline gap-x-2">
              <Badge
                variant="outline"
                className={cn("h-4 px-1.5", severityClasses(finding.severity))}
              >
                appears
              </Badge>
              <span className="text-sm font-medium">
                {finding.kind.replace(/_/g, " ")}
              </span>
              <span className="text-xs text-muted-foreground">
                {finding.task_ids.join(", ")}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {finding.explanation}
            </p>
          </li>
        ))}
        {f.cleared.map((finding, i) => (
          <li
            key={`x${i}`}
            className="border-b border-border py-1.5 last:border-0"
          >
            <div className="flex flex-wrap items-baseline gap-x-2">
              <Badge variant="outline" className="h-4 px-1.5">
                clears
              </Badge>
              <span className="text-sm font-medium text-muted-foreground line-through">
                {finding.kind.replace(/_/g, " ")}
              </span>
              <span className="text-xs text-muted-foreground">
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

function TextDiff({ report }: { report: Report }) {
  const d = report.text_diff;
  return (
    <section>
      <Heading>The wording</Heading>
      <p className="text-sm leading-relaxed">
        {d.segments.length > 0
          ? d.segments.map((seg, i) => {
              const op = String(seg.op ?? seg.kind ?? "equal");
              const text = String(seg.text ?? "");
              if (op === "removed")
                return (
                  <span
                    key={i}
                    className="mr-1 bg-severity-high/10 text-severity-high line-through"
                  >
                    {text}
                  </span>
                );
              if (op === "added")
                return (
                  <span
                    key={i}
                    className="mr-1 bg-severity-low/10 text-severity-low"
                  >
                    {text}
                  </span>
                );
              return (
                <span key={i} className="mr-1">
                  {text}
                </span>
              );
            })
          : d.after}
      </p>
      <p className="mt-1.5 text-xs text-muted-foreground">
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

  return (
    <section>
      <Heading
        note={replan.expressed_in}
        right={
          <span className="text-xs text-muted-foreground">
            {replan.status} · {applied ? "applied" : "not applied"}
          </span>
        }
      >
        {applied ? "The replan" : "The replan, ready and unapplied"}
      </Heading>

      <ul className="mb-2">
        {replan.mutations.map((m: MutationIn, i) => (
          <li
            key={i}
            className="flex flex-wrap items-baseline gap-x-2 border-b border-border py-1.5 text-xs last:border-0"
          >
            <span className="rounded border border-border px-1.5 py-px font-mono text-[11px]">
              {m.kind}
            </span>
            <span className="text-muted-foreground">
              {(m as { describes?: string }).describes ??
                JSON.stringify(m.payload)}
            </span>
          </li>
        ))}
      </ul>

      {replan.inverse_mutations.length > 0 && (
        <p className="mb-2 text-xs text-muted-foreground">
          Its inverse is stored too, in {replan.inverse_mutations.length}{" "}
          {plural(replan.inverse_mutations.length, "mutation")} — including the
          statuses that would have to be restored to undo it.
        </p>
      )}
      {replan.kept_note && (
        <p className="mb-2 text-xs text-muted-foreground">
          {replan.kept_note}
        </p>
      )}

      {applied ? (
        <div className="border-l-2 border-severity-low bg-severity-low/5 py-2 pr-2 pl-3 text-sm">
          <p>
            <span className="font-semibold text-severity-low">Applied.</span>{" "}
            <span className="text-muted-foreground">
              {report.requirement_key} is now v{applied.to_version}, and
              workflow version {applied.new_version.version_no} was written.
              {applied.parent_version.unchanged
                ? ` Version ${applied.parent_version.version_no} survives with its content hash intact, so this is reversible.`
                : " The parent version's hash is not reported as unchanged — check the history stage."}
            </span>
          </p>
          {(applied.attributed_to || applied.attribution_note) && (
            <p className="mt-1 text-xs text-muted-foreground">
              {applied.attributed_to
                ? `Recorded against ${applied.attributed_to}.`
                : applied.attribution_note}
            </p>
          )}
        </div>
      ) : !onApply ? null : confirming ? (
        <div className="border-l-2 border-severity-high bg-severity-high/5 py-2 pl-3">
          <p className="text-sm font-semibold text-severity-high">
            This one writes.
          </p>
          <ul className="mt-1 text-xs text-muted-foreground">
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
    <section>
      {/*
        Phrased about the *report*, not about the session. "Nothing was
        written" sat directly under an "Applied." banner and read as a
        contradiction; producing this report still wrote nothing, and that is
        what the hashes prove.
      */}
      <Heading>Producing this report wrote nothing</Heading>
      <p className="flex flex-wrap items-baseline gap-1.5 text-sm">
        <CircleCheck
          className={cn(
            "size-3.5 shrink-0 translate-y-0.5",
            report.base_unchanged ? "text-severity-low" : "text-severity-high",
          )}
        />
        <span className="font-medium">
          {report.base_unchanged
            ? "The base version's content hash is identical before and after."
            : "The base version's content hash CHANGED. That should not happen — do not trust this report."}
        </span>
      </p>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">hash before</dt>
        <dd className="truncate font-mono">{report.base_version_hash_before}</dd>
        <dt className="text-muted-foreground">hash after</dt>
        <dd className="truncate font-mono">{report.base_version_hash_after}</dd>
        <dt className="text-muted-foreground">workflow version</dt>
        <dd>
          {report.version_no}{" "}
          <span className="text-muted-foreground">
            (engine {report.engine_version}, run{" "}
            <span className="font-mono">{report.analysis_run_id}</span>)
          </span>
        </dd>
      </dl>
    </section>
  );
}

/* ----------------------------------------------------------- assumptions */

/**
 * The whole block, iterated — never a hand-written list of the keys it has
 * today. A caveat the backend adds tomorrow appears here on its own.
 */
function AssumptionsBlock({ report }: { report: Report }) {
  const sentences = assumptionSentences(report.assumptions);
  const unavailable = unavailableEntries(report.assumptions);
  const scalars = Object.entries(report.assumptions ?? {}).filter(
    ([, v]) => typeof v === "boolean",
  );

  return (
    <section className="border-t border-border pt-2 text-xs">
      <div className="mb-1.5 font-medium tracking-wider text-muted-foreground uppercase">
        What this rests on
      </div>
      <dl className="flex flex-col gap-1.5">
        {sentences.map(({ key, text }) => (
          <div key={key}>
            <dt className="font-medium text-foreground/90">
              {humanizeKey(key)}
            </dt>
            <dd className="text-muted-foreground">{text}</dd>
          </div>
        ))}
      </dl>

      {scalars.length > 0 && (
        <p className="mt-1.5 text-muted-foreground">
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
          <div className="mt-3 mb-1.5 font-medium tracking-wider text-muted-foreground uppercase">
            What this report cannot tell you — {unavailable.length}
          </div>
          <ul className="flex flex-col gap-1.5">
            {unavailable.map((entry, i) => (
              <li key={entry.check ?? entry.name ?? i}>
                <div className="font-medium text-foreground/90">
                  {humanizeKey(String(entry.check ?? entry.name ?? ""))}
                </div>
                {entry.why && (
                  <p className="text-muted-foreground">{entry.why}</p>
                )}
                {entry.would_unlock_it && (
                  <p className="text-accent">{entry.would_unlock_it}</p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
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
    <div className="flex flex-col gap-5">
      {report.no_impact ? (
        <NoImpact report={report} />
      ) : (
        <Headline report={report} />
      )}

      <HumanJudgement report={report} />

      {!report.no_impact && (
        <>
          <MustRedo report={report} />
          <MustRecheck tasks={report.must_recheck} />
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
