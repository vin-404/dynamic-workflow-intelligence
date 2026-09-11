"use client";

/**
 * Version history.
 *
 * Applying a change never destroys the version it came from, and this is
 * where that is visible. Each version carries its content hash, its parent,
 * and the scenario it was applied from - so a change has provenance rather
 * than just a timestamp.
 *
 * Wave 3 (design brief §4, "History"): a vertical timeline rather than a
 * table. A rail with a dot per version, newest at the top; each row carries
 * the version number, the sealed/draft state as a chip, the note as body
 * text, and the when / deadline / parent / content hash as meta. Everything
 * the table showed is still on the row - nothing went behind a click - it
 * just reads top-to-bottom now instead of across eight columns that clipped
 * at 1280. The only colour is the accent on the version being viewed.
 *
 * Accuracy is one figure per project, not per version (`getAccuracy` takes
 * the project), so it is the headline of the "Detector accuracy" panel and
 * the rows have no headline of their own - one headline per panel or none.
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
 * database can answer it. The same paragraph is on the page, behind
 * "Why no author is shown", in words rather than identifiers.
 */

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Accuracy, Version, getAccuracy, listVersions } from "@/lib/api";
import { bandClasses } from "@/lib/severity";
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

/** A percentage from a 0..1 ratio, or the em dash when the API has none. */
function pct(ratio: number | null): string {
  return ratio !== null ? `${Math.round(ratio * 100)}%` : "—";
}

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
    <div className="flex flex-col gap-6">
      <section
        data-panel="versions"
        className="rounded-xl border border-line bg-panel p-5"
      >
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h2 className="text-[18px] font-semibold">
            Every version this workflow has had
          </h2>
          <span className="text-[12px] text-dim">
            {versions.length} {versions.length === 1 ? "version" : "versions"}
          </span>
        </div>

        {/* The panel's one caveat line, and the D-127 paragraph behind it. */}
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="text-[14px] text-dim">
            Every version is kept; applying a change creates a new one and never
            overwrites its parent.
          </p>
          <details className="group min-w-0 basis-full">
            <summary className={SUMMARY}>
              <Caret />
              Why no author is shown
            </summary>
            <div className="mt-2 max-w-2xl space-y-2 border-l border-line pl-3 text-[12px] text-dim">
              <p>
                An author is still not on the row, and not because it was
                dropped for density.
              </p>
              <p>
                The version record has no author column at all, so
                &ldquo;who&rdquo; needs a schema migration rather than a
                projection - unlike the creation time, which always existed and
                merely was not exposed.
              </p>
              <p>
                Inventing a &ldquo;who&rdquo; from the client would be a
                fabricated fact, so the column stays absent until the database
                can answer it.
              </p>
            </div>
          </details>
        </div>

        {versions.length === 0 ? (
          <p className="mt-4 max-w-2xl text-[14px] text-dim">
            No versions yet. A version is created when you start a project and
            whenever you apply a change.
          </p>
        ) : (
          <ol className="relative mt-5 ml-1.5 border-l border-line">
            {[...versions].reverse().map((v, i, all) => {
              const isCurrent = v.id === currentVersionId;
              const parent = versions.find(
                (p) => p.id === v.parent_version_id,
              );
              const last = i === all.length - 1;
              return (
                <li
                  key={v.id}
                  className={cn("relative pl-6", last ? "pb-0" : "pb-6")}
                >
                  {/* The dot on the rail: accent for the version being viewed. */}
                  <span
                    aria-hidden
                    className={cn(
                      "absolute top-[5px] -left-[6px] h-[11px] w-[11px] rounded-full border-2 border-panel",
                      isCurrent ? "bg-accent" : "bg-dim",
                    )}
                  />

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span
                      className={cn(
                        "text-[14px] font-semibold",
                        isCurrent ? "text-accent" : "text-foreground",
                      )}
                    >
                      v{v.version_no}
                    </span>
                    <span
                      className={cn(
                        CHIP,
                        v.is_draft
                          ? "border-accent text-accent"
                          : "border-line bg-panel2 text-dim",
                      )}
                    >
                      {v.is_draft ? "draft" : "sealed"}
                    </span>
                    {v.created_from_scenario_id && (
                      <span className="text-[12px] text-dim">applied</span>
                    )}
                    <button
                      type="button"
                      onClick={() => onView(isCurrent ? null : v.id)}
                      className="ml-auto text-[14px] text-accent hover:underline"
                    >
                      {isCurrent ? "viewing" : "view this one"}
                    </button>
                  </div>

                  <p className="mt-1 text-[14px]">
                    {v.note || <span className="text-dim">no note</span>}
                  </p>

                  {/* When, the deadline this version was authored against
                      (in the day offset the engine works in - it moves
                      between versions, so it is provenance, not decoration),
                      and the parent it was applied from. */}
                  <p className="mt-1 flex flex-wrap gap-x-2 text-[12px] text-dim">
                    <When iso={v.created_at} precise />
                    <span aria-hidden>·</span>
                    <span>
                      {v.deadline_day === null
                        ? "no deadline"
                        : `deadline day ${v.deadline_day}`}
                    </span>
                    <span aria-hidden>·</span>
                    <span>
                      {parent
                        ? `from v${parent.version_no}`
                        : v.parent_version_id
                          ? "from v?"
                          : "first version"}
                    </span>
                  </p>
                  <p className="mt-0.5 text-[12px] text-dim">
                    <span>content hash </span>
                    <span className="font-mono break-all">{v.content_hash}</span>
                  </p>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {accuracy && (
        <section
          data-panel="accuracy"
          className="rounded-xl border border-line bg-panel p-5"
        >
          <h2 className="text-[18px] font-semibold">
            Detector accuracy on this project
          </h2>
          {accuracy.has_labels ? (
            <>
              {/* One headline per panel: recall. The rest are body figures. */}
              <dl className="mt-3 flex flex-wrap items-end gap-x-8 gap-y-3">
                <div className="flex flex-col">
                  <dd className="text-[36px] leading-none font-semibold">
                    {pct(accuracy.recall)}
                  </dd>
                  <dt className="mt-1 text-[12px] text-dim">recall</dt>
                </div>
                <div className="flex flex-col">
                  <dd className="text-[14px] font-semibold">
                    {pct(accuracy.precision)}
                  </dd>
                  <dt className="text-[12px] text-dim">precision</dt>
                </div>
                {accuracy.planted > 0 && (
                  <div className="flex flex-col">
                    <dd className="text-[14px] font-semibold">
                      {accuracy.planted_found.length}/{accuracy.planted}
                    </dd>
                    <dt className="text-[12px] text-dim">planted faults found</dt>
                  </div>
                )}
                <div className="flex flex-col">
                  <dd className="text-[14px] font-semibold">
                    {accuracy.labelled} · {accuracy.detected}
                  </dd>
                  <dt className="text-[12px] text-dim">labelled · detected</dt>
                </div>
              </dl>

              <p className="mt-3 text-[14px] text-dim">
                Recall is the share of the labelled problems the detector found;
                precision is the share of what it found that was labelled.
              </p>

              <h3 className="mt-5 text-[14px] font-semibold">
                Every problem this fixture is known to contain
              </h3>
              <Table className="mt-2">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    {[
                      ["Result", "w-20"],
                      ["Kind", "w-56"],
                      ["Where", "w-24"],
                      ["Note", ""],
                      ["", "w-16"],
                    ].map(([label, width], i) => (
                      <TableHead
                        key={i}
                        className={cn(
                          "h-7 px-2 text-[12px] font-medium text-dim",
                          width,
                        )}
                      >
                        {label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accuracy.labels.map((label, i) => (
                    <TableRow key={i} className="border-line/60">
                      <TableCell className="px-2 py-1.5 align-top">
                        <span
                          className={cn(
                            CHIP,
                            label.detected
                              ? bandClasses("low")
                              : "border-critical/30 bg-critical/10 text-critical",
                          )}
                        >
                          {label.detected ? "found" : "missed"}
                        </span>
                      </TableCell>
                      <TableCell className="px-2 py-1.5 align-top text-[14px] whitespace-normal">
                        {findingKindLabel(label.kind)}
                      </TableCell>
                      <TableCell className="px-2 py-1.5 align-top font-mono text-[12px] text-dim whitespace-normal">
                        {label.root_cause}
                      </TableCell>
                      <TableCell className="px-2 py-1.5 align-top text-[14px] whitespace-normal">
                        {label.description}
                      </TableCell>
                      <TableCell className="px-2 py-1.5 align-top text-[12px] text-dim">
                        {label.planted ? "planted" : ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          ) : (
            <p className="mt-2 max-w-2xl text-[14px] text-dim">{accuracy.note}</p>
          )}
        </section>
      )}
    </div>
  );
}
