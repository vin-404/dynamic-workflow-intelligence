"use client";

/**
 * Version history.
 *
 * Applying a change never destroys the version it came from, and this is
 * where that is visible. Each version carries its content hash, its parent,
 * and the scenario it was applied from - so a change has provenance rather
 * than just a timestamp.
 *
 * Wave 2: a dense table rather than a stack of bordered tiles. Everything a
 * version knows about itself is on its row - number, when, state, note,
 * deadline, content hash, parent - because that is the evidence, and evidence
 * behind a click is evidence nobody reads. The known-faults list is likewise
 * open rather than folded away. The only colour is the accent on the version
 * being viewed.
 *
 * The timestamp reads "3 days ago · 8 Sep 2026, 05:12 UTC": the relative form
 * for orientation and, because this is the provenance panel, the precise UTC
 * instant inline as well, in words rather than as a raw ISO string (`When`
 * with `precise`; the D-127 rule that a suffix-less value is UTC lives in
 * `parseInstant`). Hover gives the instant to the second.
 *
 * **An author is still not on the row**, and not because it was dropped for
 * density. `WorkflowVersion` has no author column at all, so "who" needs a
 * schema migration rather than a projection - unlike `created_at`, which
 * always existed and merely was not exposed. Inventing a "who" from the
 * client would be a fabricated fact, so the column stays absent until the
 * database can answer it.
 */

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Accuracy, Version, getAccuracy, listVersions } from "@/lib/api";
import { severityText } from "@/lib/severity";
import { findingKindLabel } from "@/lib/display";
import When from "@/components/When";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default function VersionHistory({
  projectId,
  currentVersionId,
  onView,
}: {
  projectId: string;
  currentVersionId: string | null;
  onView: (versionId: string | null) => void;
}) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [accuracy, setAccuracy] = useState<Accuracy | null>(null);

  useEffect(() => {
    listVersions(projectId)
      .then(setVersions)
      .catch(() => setVersions([]));
    getAccuracy(projectId)
      .then(setAccuracy)
      .catch(() => setAccuracy(null));
  }, [projectId, currentVersionId]);

  if (!versions) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-3/4" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <section>
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h2 className="text-sm font-medium">
            Every version this workflow has had
          </h2>
          <span className="font-mono text-[12px] text-dim">
            {versions.length}
          </span>
        </div>

        {versions.length === 0 ? (
          <p className="max-w-2xl text-sm text-dim">
            No versions yet. A version is created when you start a project and
            whenever you apply a change.
          </p>
        ) : (
          <Table className="min-w-[920px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {[
                  ["Version", "w-20"],
                  ["When", "w-64"],
                  ["State", "w-24"],
                  ["Note", ""],
                  ["Deadline", "w-20"],
                  ["Content hash", "w-52"],
                  ["From", "w-16"],
                  ["", "w-24"],
                ].map(([label, width], i) => (
                  <TableHead
                    key={i}
                    className={cn(
                      "h-7 px-1.5 text-[12px] font-medium tracking-wider text-dim uppercase",
                      width,
                    )}
                  >
                    {label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...versions].reverse().map((v) => {
                const isCurrent = v.id === currentVersionId;
                const parent = versions.find(
                  (p) => p.id === v.parent_version_id,
                );
                return (
                  <TableRow
                    key={v.id}
                    className={cn(
                      "border-line/60",
                      isCurrent && "bg-accent/5 hover:bg-accent/10",
                    )}
                  >
                    <TableCell className="px-1.5 py-1 font-mono text-xs">
                      <span
                        className={cn(
                          isCurrent ? "text-accent" : "text-foreground",
                        )}
                      >
                        v{v.version_no}
                      </span>
                    </TableCell>
                    <TableCell className="px-1.5 py-1 text-[12px] text-dim">
                      <When iso={v.created_at} precise />
                    </TableCell>
                    <TableCell className="px-1.5 py-1 font-mono text-[12px] text-dim">
                      {v.is_draft ? "draft" : "sealed"}
                      {v.created_from_scenario_id ? " · applied" : ""}
                    </TableCell>
                    <TableCell className="px-1.5 py-1 text-xs whitespace-normal">
                      {v.note || <span className="text-dim">no note</span>}
                    </TableCell>
                    {/* The deadline this version was authored against, in
                        the day offset the engine works in. It moves between
                        versions, so it is provenance, not decoration. */}
                    <TableCell className="px-1.5 py-1 font-mono text-[12px] text-dim">
                      {v.deadline_day === null ? "none" : `d${v.deadline_day}`}
                    </TableCell>
                    <TableCell className="px-1.5 py-1 font-mono text-[12px] text-dim">
                      {v.content_hash.slice(0, 24)}…
                    </TableCell>
                    <TableCell className="px-1.5 py-1 font-mono text-[12px] text-dim">
                      {parent ? `v${parent.version_no}` : v.parent_version_id ? "v?" : "—"}
                    </TableCell>
                    <TableCell className="px-1.5 py-1 text-right">
                      <button
                        type="button"
                        onClick={() => onView(isCurrent ? null : v.id)}
                        className="text-xs text-accent hover:underline"
                      >
                        {isCurrent ? "viewing" : "view this one"}
                      </button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>

      {accuracy && (
        <section>
          <h2 className="mb-2 text-sm font-medium">
            Detector accuracy on this project
          </h2>
          {accuracy.has_labels ? (
            <>
              <dl className="mb-3 flex flex-wrap items-baseline gap-x-8 gap-y-1 text-sm">
                <div className="flex items-baseline gap-1.5">
                  <dt className="text-dim">recall</dt>
                  <dd className="font-mono">
                    {accuracy.recall !== null
                      ? `${Math.round(accuracy.recall * 100)}%`
                      : "—"}
                  </dd>
                </div>
                <div className="flex items-baseline gap-1.5">
                  <dt className="text-dim">precision</dt>
                  <dd className="font-mono">
                    {accuracy.precision !== null
                      ? `${Math.round(accuracy.precision * 100)}%`
                      : "—"}
                  </dd>
                </div>
                {accuracy.planted > 0 && (
                  <div className="flex items-baseline gap-1.5">
                    <dt className="text-dim">planted faults found</dt>
                    <dd className="font-mono">
                      {accuracy.planted_found.length}/{accuracy.planted}
                    </dd>
                  </div>
                )}
                <div className="flex items-baseline gap-1.5">
                  <dt className="text-dim">labelled · detected</dt>
                  <dd className="font-mono">
                    {accuracy.labelled} · {accuracy.detected}
                  </dd>
                </div>
              </dl>

              <h3 className="mb-1 text-[12px] tracking-wider text-dim uppercase">
                Every problem this fixture is known to contain
              </h3>
              <ul className="text-xs">
                {accuracy.labels.map((label, i) => (
                  <li
                    key={i}
                    className="flex items-baseline gap-2 border-b border-line/50 py-1"
                  >
                    <span
                      className={cn(
                        "w-14 shrink-0 font-mono",
                        label.detected ? "text-dim" : severityText("high"),
                      )}
                    >
                      {label.detected ? "found" : "missed"}
                    </span>
                    <span className="w-56 shrink-0 truncate text-dim">
                      {findingKindLabel(label.kind)} ·{" "}
                      <span className="font-mono">{label.root_cause}</span>
                    </span>
                    <span className="flex-1">{label.description}</span>
                    {label.planted && (
                      <span className="shrink-0 font-mono text-dim">
                        planted
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="max-w-2xl text-sm text-dim">{accuracy.note}</p>
          )}
        </section>
      )}
    </div>
  );
}
