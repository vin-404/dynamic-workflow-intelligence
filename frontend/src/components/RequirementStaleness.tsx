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
 * The two lists are kept apart, deliberately and visibly: two panels side by
 * side, each with its count as the panel's one headline figure. Collapsing
 * them into "affected tasks" is how a useful alert becomes "your whole project
 * is red". `must_redo` is reachable along `consumes` edges; `must_recheck` is
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
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorNote, days } from "./ui";

type Row = RequirementImpactPreview["must_redo"][number];

/**
 * One of the two panels. The heading keeps "Must redo — 6" as one run of
 * inline text (the walkthrough reads it from `innerText`), with the count set
 * as the panel's headline figure.
 */
export function StalenessColumn({
  title,
  note,
  rows,
  tone,
  emphasiseDone,
  footer,
}: {
  title: string;
  note: string;
  rows: Row[];
  /** The count's colour: warm for redo, amber for re-check. */
  tone: string;
  /** In the redo list a finished task is the alarming case. */
  emphasiseDone?: boolean;
  footer?: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col rounded-xl border border-line bg-panel p-5">
      <h3 className="text-[18px] font-semibold leading-none">
        {title} <span className="font-normal text-dim">—</span>{" "}
        <span className={cn("text-[36px] font-semibold leading-none", tone)}>
          {rows.length}
        </span>
      </h3>
      <p className="mt-2 text-[12px] text-dim">{note}</p>

      {rows.length === 0 ? (
        <p className="mt-3 text-[14px] text-dim">none</p>
      ) : (
        <ul className="mt-3 flex flex-col">
          {rows.map((t) => {
            const finished = t.status === "done";
            return (
              <li
                key={t.key}
                className="flex flex-col gap-y-0.5 border-b border-line/60 py-2 last:border-0"
              >
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-[12px] text-dim">{t.key}</span>
                  <span className="text-[14px] font-medium">{t.name}</span>
                </div>
                <p className="text-[12px] text-dim">
                  <span
                    className={cn(
                      emphasiseDone && finished && "font-semibold text-critical",
                    )}
                  >
                    {statusLabel(t.status)}
                  </span>
                  <span aria-hidden> · </span>
                  {t.assignees.length ? t.assignees.join(", ") : "unassigned"}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      {footer && <div className="mt-auto pt-3">{footer}</div>}
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

  const people = impact.resources_hit.length;

  return (
    <section className="flex flex-col gap-3">
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-[18px] font-semibold">
            If {impact.requirement_key} changes at all
          </h3>
          <p className="text-[14px]">
            <span
              className={cn(
                "font-semibold",
                impact.wasted_days > 0 ? "text-critical" : "text-dim",
              )}
            >
              {days(impact.wasted_days)}
            </span>{" "}
            <span className="text-dim">
              of finished work invalidated · {people}{" "}
              {people === 1 ? "person" : "people"} affected
            </span>
          </p>
        </div>

        {/* The panel's caveat: where the reach starts, and what it is not. */}
        <p className="mt-1 text-[14px] text-dim">
          Consumed directly by{" "}
          {impact.directly_consumed_by.length > 0
            ? impact.directly_consumed_by.join(", ")
            : "nothing"}
          . Everything below is reachability over the dependency graph from
          there: nothing reads the wording, and a new wording is assumed to be
          material until you say otherwise in the composer above.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <StalenessColumn
          title="Must redo"
          note="Consumed the requirement, directly or through work that did. If the requirement is wrong, this work is wrong."
          rows={impact.must_redo}
          tone="text-critical"
          emphasiseDone
          footer={
            impact.resources_hit.length > 0 ? (
              <p className="border-t border-line pt-2 text-[12px] text-dim">
                Owners of work that must be redone:{" "}
                {impact.resources_hit.join(", ")}.
              </p>
            ) : undefined
          }
        />
        <StalenessColumn
          title="Must recheck"
          note="Downstream in time only. Nothing it consumed is known to be wrong, so it is listed and not costed."
          rows={impact.must_recheck}
          tone="text-severity-medium"
        />
      </div>
    </section>
  );
}
