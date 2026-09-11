"use client";

/**
 * What changing this requirement at all would touch - before a word is typed.
 *
 * `POST /api/projects/{id}/requirement-impact` is the staleness propagation on
 * its own: given a requirement, which completed work consumed it and is
 * therefore wrong if it changes, versus which work is merely downstream in
 * time and needs a look. It needs no proposed wording, so it can be shown the
 * moment a requirement is picked, where the costed `ImpactReport` cannot -
 * that one needs the new text.
 *
 * The two lists are kept apart, deliberately and visibly. Collapsing them
 * into "affected tasks" is how a useful alert becomes "your whole project is
 * red". `must_redo` is reachable along `consumes` edges; `must_recheck` is
 * everything else downstream. The backend makes that distinction; this panel
 * refuses to lose it.
 *
 * Two things this panel does not do. It does not cost the recheck list - the
 * report proper explains why - and it does not read the requirement text:
 * every row is graph reachability, and the panel says so.
 */

import { useEffect, useState } from "react";
import { ApiError, RequirementImpactPreview, requirementImpact } from "@/lib/api";
import { statusLabel } from "@/lib/display";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorNote, days } from "./ui";

function TaskList({
  title,
  note,
  rows,
  emphasiseDone,
}: {
  title: string;
  note: string;
  rows: RequirementImpactPreview["must_redo"];
  /** In the redo list a finished task is the alarming case. */
  emphasiseDone?: boolean;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-1.5 border-b border-line pb-1">
        <h4 className="text-[12px] font-medium tracking-wider text-dim uppercase">
          {title} — {rows.length}
        </h4>
        <p className="mt-0.5 text-xs text-dim">{note}</p>
      </div>
      {rows.length === 0 ? (
        <p className="py-1 text-xs text-dim">none</p>
      ) : (
        <ul>
          {rows.map((t) => {
            const finished = t.status === "done";
            return (
              <li
                key={t.key}
                className="flex flex-wrap items-baseline gap-x-2 border-b border-line/60 py-1 text-xs last:border-0"
              >
                <span className="font-mono">{t.key}</span>
                <span className="text-sm">{t.name}</span>
                <span
                  className={
                    emphasiseDone && finished
                      ? "font-medium text-severity-high"
                      : "text-dim"
                  }
                >
                  {statusLabel(t.status)}
                </span>
                <span className="text-dim">
                  {t.assignees.length ? t.assignees.join(", ") : "unassigned"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default function RequirementStaleness({
  projectId,
  requirementKey,
}: {
  projectId: string;
  requirementKey: string;
}) {
  const [impact, setImpact] = useState<RequirementImpactPreview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Fetch only; the host remounts this by `key` when the requirement changes,
  // and retry resets from its own handler (the D-103 pattern used next door).
  useEffect(() => {
    let live = true;
    requirementImpact(projectId, requirementKey)
      .then((r) => {
        if (live) setImpact(r);
      })
      .catch((e: ApiError) => {
        if (live) setError(e);
      });
    return () => {
      live = false;
    };
  }, [projectId, requirementKey, attempt]);

  if (error) {
    return (
      <ErrorNote
        hint={error.hint}
        requestId={error.requestId}
        onRetry={() => {
          setError(null);
          setImpact(null);
          setAttempt((a) => a + 1);
        }}
      >
        What {requirementKey} would invalidate could not be computed.{" "}
        {error.userMessage}
      </ErrorNote>
    );
  }

  if (!impact) {
    return (
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-4 w-72" />
        <Skeleton className="h-4 w-full" />
      </div>
    );
  }

  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line pb-1">
        <h3 className="text-[12px] font-medium tracking-wider text-dim uppercase">
          If {impact.requirement_key} changes at all
        </h3>
        <span className="text-xs text-dim">
          {days(impact.wasted_days)} of finished work invalidated ·{" "}
          {impact.resources_hit.length}{" "}
          {impact.resources_hit.length === 1 ? "person" : "people"} affected
        </span>
      </div>

      <p className="mb-3 max-w-3xl text-xs text-dim">
        Consumed directly by{" "}
        {impact.directly_consumed_by.length > 0
          ? impact.directly_consumed_by.join(", ")
          : "nothing"}
        . Everything below is reachability over the dependency graph from
        there: nothing reads the wording, and a new wording is assumed to be
        material until you say otherwise in the composer above.
      </p>

      <div className="grid gap-5 md:grid-cols-2">
        <TaskList
          title="Must redo"
          note="Consumed the requirement, directly or through work that did. If the requirement is wrong, this work is wrong."
          rows={impact.must_redo}
          emphasiseDone
        />
        <TaskList
          title="Must recheck"
          note="Downstream in time only. Nothing it consumed is known to be wrong, so it is listed and not costed."
          rows={impact.must_recheck}
        />
      </div>

      {impact.resources_hit.length > 0 && (
        <p className="mt-3 text-xs text-dim">
          Owners of work that must be redone: {impact.resources_hit.join(", ")}.
        </p>
      )}
    </section>
  );
}
