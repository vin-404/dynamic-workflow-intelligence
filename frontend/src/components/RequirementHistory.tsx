"use client";

/**
 * Requirement versions — who changed what, when, and against which
 * consumption set — as a vertical timeline: one dot on the rail per recorded
 * wording, newest first, the wording in force today at the top.
 *
 * The empty state is the one that matters and it must not be read as
 * "this requirement never changed". History begins when the first change is
 * applied through `.../apply`; a seeded or hand-authored project therefore has
 * no rows and that is silence, not evidence. The API says so in its `note`,
 * and the note is rendered whether the list is empty or full.
 *
 * A row marked `backfilled` was reconstructed from a workflow snapshot at the
 * moment the first change landed, so it carries no author and no real instant.
 * That is stated on the row rather than filled in with a plausible guess —
 * same discipline as D-127's absent author column in `VersionHistory`.
 *
 * `consumed_by` is copied onto every revision (D-155), so a historical impact
 * is read against the consumption set that existed *then*. When that no longer
 * matches today's graph the diff reports `consumption_drifted`, and that is
 * surfaced rather than absorbed.
 */

import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  RequirementHistoryResponse,
  RequirementDiffResponse,
  requirementDiff,
  requirementHistory,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import When from "@/components/When";
import { ErrorNote } from "./ui";

/* --------------------------------------------------------------- shapes */

/**
 * `RequirementHistoryResponse.current` is typed `Record<string, unknown>` in
 * the shared client — it is the live wording read off the snapshot rather than
 * a revision row, so it has no settled contract. Narrowed here, and nothing
 * else is: the revisions themselves are fully typed.
 */
interface CurrentWording {
  version_no?: number;
  text?: string;
  consumed_by?: string[];
  recorded_in_history?: boolean;
}

type Segment = { op?: unknown; kind?: unknown; text?: unknown };

/* ---------------------------------------------------------------- bits */

const CHIP =
  "inline-flex items-center rounded-full border px-2 py-0.5 text-[12px] leading-4 whitespace-nowrap";

/**
 * One side of the wording comparison. The API sends a single merged segment
 * list; the "before" column is that list without its additions and the
 * "after" column is it without its removals, so both columns are the API's
 * own segments and nothing is re-diffed here.
 */
function WordingSide({
  segments,
  side,
}: {
  segments: Segment[];
  side: "before" | "after";
}) {
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

/* ----------------------------------------------------------------- main */

export default function RequirementHistory({
  projectId,
  requirementKey,
  /** Bumped by the stage after an apply, so the new revision shows up. */
  refreshKey = 0,
}: {
  projectId: string;
  requirementKey: string;
  refreshKey?: number;
}) {
  const [history, setHistory] =
    useState<RequirementHistoryResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [diff, setDiff] = useState<RequirementDiffResponse | null>(null);
  const [diffError, setDiffError] = useState<ApiError | null>(null);
  const [pair, setPair] = useState<[number, number] | null>(null);

  const [attempt, setAttempt] = useState(0);

  /**
   * The effect fetches and nothing else.
   *
   * Clearing the previous requirement's rows from inside the effect body is a
   * synchronous `setState` in an effect — a cascading render, and what
   * `react-hooks/set-state-in-effect` exists to catch (D-103). So the reset
   * lives in the retry handler, and switching requirement is handled by the
   * stage giving this component a `key`, which remounts it with fresh state.
   */
  useEffect(() => {
    let live = true;
    requirementHistory(projectId, requirementKey)
      .then((h) => {
        if (live) setHistory(h);
      })
      .catch((e: ApiError) => {
        if (live) setError(e);
      });
    return () => {
      live = false;
    };
  }, [projectId, requirementKey, refreshKey, attempt]);

  const retry = useCallback(() => {
    setHistory(null);
    setError(null);
    setDiff(null);
    setDiffError(null);
    setPair(null);
    setAttempt((a) => a + 1);
  }, []);

  const revisions = history?.revisions ?? [];
  const current = (history?.current ?? null) as CurrentWording | null;

  async function showDiff(from: number, to: number) {
    setDiff(null);
    setDiffError(null);
    setPair([from, to]);
    try {
      setDiff(await requirementDiff(projectId, requirementKey, from, to));
    } catch (e) {
      setDiffError(e as ApiError);
    }
  }

  if (error) {
    return (
      <ErrorNote hint={error.hint} requestId={error.requestId} onRetry={retry}>
        The history of {requirementKey} could not be read. {error.userMessage}
      </ErrorNote>
    );
  }

  if (!history) {
    return (
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-4 w-full" />
      </div>
    );
  }

  // Newest first, as the panel has always read. The current wording leads
  // when history has no row for it; when it does, the top revision *is* it.
  const ordered = revisions.slice().reverse();
  const showCurrentDot = !!current && !current.recorded_in_history;

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-[18px] font-semibold">
          Recorded wordings of {requirementKey}
        </h3>
        <span className="text-[12px] text-dim">
          {history.revision_count ?? revisions.length} recorded ·{" "}
          {history.changes_recorded ?? 0} applied through this system
        </span>
      </div>

      <ol className="relative ml-1.5 border-l border-line">
        {/* The wording in force now, whether or not history knows about it. */}
        {showCurrentDot && current && (
          <li className={cn("relative pl-6", ordered.length ? "pb-5" : "pb-0")}>
            <span
              aria-hidden
              className="absolute top-[5px] -left-[6px] h-[11px] w-[11px] rounded-full border-2 border-panel bg-accent"
            />
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={cn(CHIP, "border-accent text-accent")}>
                v{current.version_no}
              </span>
              <span className={cn(CHIP, "border-line bg-panel2 text-dim")}>
                current
              </span>
              <span className="text-[12px] text-dim">
                not in the revision table
              </span>
            </div>
            <p className="mt-1 text-[14px]">{current.text}</p>
            <p className="mt-0.5 text-[12px] text-dim">
              consumed by{" "}
              {current.consumed_by?.length
                ? current.consumed_by.join(", ")
                : "nothing"}
            </p>
          </li>
        )}

        {ordered.map((rev, i, all) => {
          const previous = all[i + 1];
          const last = i === all.length - 1;
          const isCurrent =
            !!current?.recorded_in_history &&
            current.version_no === rev.version_no;
          const open =
            !!previous &&
            pair?.[0] === previous.version_no &&
            pair?.[1] === rev.version_no;
          return (
            <li
              key={rev.version_no}
              className={cn("relative pl-6", last ? "pb-0" : "pb-5")}
            >
              <span
                aria-hidden
                className={cn(
                  "absolute top-[5px] -left-[6px] h-[11px] w-[11px] rounded-full border-2 border-panel",
                  isCurrent ? "bg-accent" : "bg-dim",
                )}
              />
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span
                  className={cn(
                    CHIP,
                    isCurrent
                      ? "border-accent text-accent"
                      : "border-line bg-panel2 text-dim",
                  )}
                >
                  v{rev.version_no}
                </span>
                {isCurrent && (
                  <span className={cn(CHIP, "border-line bg-panel2 text-dim")}>
                    current
                  </span>
                )}
                {rev.backfilled && (
                  <span className={cn(CHIP, "border-line bg-panel2 text-dim")}>
                    backfilled
                  </span>
                )}
                <span className="text-[12px] text-dim">
                  {rev.attributed && rev.changed_by
                    ? rev.changed_by
                    : "author unknown"}
                </span>
                <span aria-hidden className="text-[12px] text-dim">
                  ·
                </span>
                <span className="text-[12px] text-dim">
                  {rev.backfilled ? (
                    "instant unknown"
                  ) : (
                    <When iso={rev.recorded_at} precise />
                  )}
                </span>
              </div>

              <p className="mt-1 text-[14px]">{rev.text}</p>

              {rev.consumed_by && (
                <p className="mt-0.5 text-[12px] text-dim">
                  consumed then by{" "}
                  {rev.consumed_by.length > 0
                    ? rev.consumed_by.join(", ")
                    : "nothing"}
                </p>
              )}
              {rev.provenance_note && (
                <p className="mt-0.5 text-[12px] text-dim">
                  {rev.provenance_note}
                </p>
              )}

              {previous && (
                <button
                  type="button"
                  aria-pressed={open}
                  onClick={() => showDiff(previous.version_no, rev.version_no)}
                  className={cn(
                    "mt-1 text-[14px] text-accent hover:underline",
                    open && "font-semibold",
                  )}
                >
                  Diff v{previous.version_no} → v{rev.version_no}
                </button>
              )}
            </li>
          );
        })}
      </ol>

      {diffError && (
        <ErrorNote hint={diffError.hint} requestId={diffError.requestId}>
          {diffError.userMessage}
        </ErrorNote>
      )}

      {diff && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <h4 className="text-[14px] font-semibold">
            v{diff.from_version} → v{diff.to_version}
          </h4>
          {/* Before | after, side by side, from the API's own segments. */}
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg bg-panel2/60 p-3">
              <p className="mb-1 text-[12px] text-dim">
                before · v{diff.from_version}
              </p>
              <WordingSide
                segments={diff.text_diff.segments as Segment[]}
                side="before"
              />
            </div>
            <div className="rounded-lg bg-panel2/60 p-3">
              <p className="mb-1 text-[12px] text-dim">
                after · v{diff.to_version}
              </p>
              <WordingSide
                segments={diff.text_diff.segments as Segment[]}
                side="after"
              />
            </div>
          </div>
          <p className="text-[12px] text-dim">{diff.text_diff.note}</p>
          <p className="text-[12px]">
            <span className="text-dim">
              Consumed then: {diff.consumed_by_then.join(", ") || "nothing"} ·
              consumed now: {diff.consumed_by_now.join(", ") || "nothing"}.{" "}
            </span>
            {diff.consumption_drifted && (
              <span className="text-severity-medium">
                The consumption set has drifted since, so a cost recomputed
                today is not the cost that change had at the time.
              </span>
            )}
          </p>
          {diff.note && <p className="text-[12px] text-dim">{diff.note}</p>}
        </div>
      )}

      {/* Rendered full or empty. An empty list is silence, not evidence. The
          walkthrough reads it, so it stays visible rather than disclosed. */}
      {history.note && (
        <p className="border-t border-line pt-3 text-[14px] text-dim">
          {history.note}
        </p>
      )}
    </section>
  );
}
