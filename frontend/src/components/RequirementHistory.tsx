"use client";

/**
 * Requirement versions — who changed what, when, and against which
 * consumption set.
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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

/**
 * The real instant, to the second, labelled UTC — never a relative form.
 *
 * SQLite returns the value with no offset even though the column is
 * timezone-aware, and the default is `datetime.now(timezone.utc)`, so a
 * suffix-less string is UTC. Reading it as local time would shift every row by
 * the reader's own offset, silently and differently per reader (D-127).
 */
function instantUTC(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso);
  const t = Date.parse(zoned ? iso : `${iso}Z`);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border pb-1">
        <h3 className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
          Recorded wordings of {requirementKey}
        </h3>
        <span className="text-xs text-muted-foreground">
          {history.revision_count ?? revisions.length} recorded ·{" "}
          {history.changes_recorded ?? 0} applied through this system
        </span>
      </div>

      {/* The wording in force now, whether or not history knows about it. */}
      {current && (
        <div className="flex flex-col gap-0.5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-xs">v{current.version_no}</span>
            <Badge variant="outline" className="h-4 px-1.5">
              current
            </Badge>
            {!current.recorded_in_history && (
              <span className="text-xs text-muted-foreground">
                not in the revision table
              </span>
            )}
          </div>
          <p className="text-sm">{current.text}</p>
          <p className="text-xs text-muted-foreground">
            consumed by{" "}
            {current.consumed_by?.length
              ? current.consumed_by.join(", ")
              : "nothing"}
          </p>
        </div>
      )}

      {revisions.length > 0 && (
        <ul>
          {revisions
            .slice()
            .reverse()
            .map((rev, i, all) => {
              const previous = all[i + 1];
              return (
                <li
                  key={rev.version_no}
                  className="border-b border-border py-2 last:border-0"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-mono text-xs">
                        v{rev.version_no}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {rev.attributed && rev.changed_by
                          ? rev.changed_by
                          : "author unknown"}
                      </span>
                      {rev.backfilled && (
                        <Badge variant="outline" className="h-4 px-1.5">
                          backfilled
                        </Badge>
                      )}
                    </div>
                    <span className="font-mono text-xs text-muted-foreground">
                      {rev.backfilled
                        ? "instant unknown"
                        : `${instantUTC(rev.recorded_at) ?? "—"} UTC`}
                    </span>
                  </div>
                  <p className="mt-0.5 text-sm">{rev.text}</p>
                  {rev.consumed_by && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      consumed then by{" "}
                      {rev.consumed_by.length > 0
                        ? rev.consumed_by.join(", ")
                        : "nothing"}
                    </p>
                  )}
                  {rev.provenance_note && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {rev.provenance_note}
                    </p>
                  )}
                  {previous && (
                    <Button
                      size="xs"
                      /* The open pair is marked by the button's own selected
                         variant. The accent stays reserved (D-117). */
                      variant={
                        pair?.[0] === previous.version_no &&
                        pair?.[1] === rev.version_no
                          ? "secondary"
                          : "ghost"
                      }
                      className="mt-1 -ml-2"
                      onClick={() =>
                        showDiff(previous.version_no, rev.version_no)
                      }
                    >
                      Diff v{previous.version_no} → v{rev.version_no}
                    </Button>
                  )}
                </li>
              );
            })}
        </ul>
      )}

      {diffError && (
        <ErrorNote hint={diffError.hint} requestId={diffError.requestId}>
          {diffError.userMessage}
        </ErrorNote>
      )}

      {diff && (
        <div className="border-l-2 border-border pl-3">
          <p className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            v{diff.from_version} → v{diff.to_version}
          </p>
          <p className="mt-1 text-sm leading-relaxed">
            {diff.text_diff.segments.map((seg, i) => {
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
            })}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {diff.text_diff.note}
          </p>
          <p className="mt-1 text-xs">
            <span className="text-muted-foreground">
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
          {diff.note && (
            <p className="mt-1 text-xs text-muted-foreground">{diff.note}</p>
          )}
        </div>
      )}

      {/* Rendered full or empty. An empty list is silence, not evidence. */}
      {history.note && (
        <p className="border-t border-border pt-2 text-xs text-muted-foreground">
          {history.note}
        </p>
      )}
    </div>
  );
}
