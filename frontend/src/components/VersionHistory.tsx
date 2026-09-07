"use client";

/**
 * Version history.
 *
 * Applying a change never destroys the version it came from, and this is
 * where that is visible. Each version carries its content hash, its parent,
 * and the scenario it was applied from - so a change has provenance rather
 * than just a timestamp.
 */

import { useEffect, useState } from "react";
import { Accuracy, Version, getAccuracy, listVersions } from "@/lib/api";
import {
  Badge,
  Card,
  CardTitle,
  Disclose,
  EmptyState,
  Spinner,
} from "./ui";

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
    listVersions(projectId).then(setVersions).catch(() => setVersions([]));
    getAccuracy(projectId).then(setAccuracy).catch(() => setAccuracy(null));
  }, [projectId, currentVersionId]);

  if (!versions) return <Spinner label="Loading history…" />;

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle right={<span className="text-xs text-dim">{versions.length}</span>}>
          Every version this workflow has had
        </CardTitle>
        {versions.length === 0 ? (
          <EmptyState title="No versions yet">
            A version is created when you start a project and whenever you apply
            a change.
          </EmptyState>
        ) : (
          <ul className="space-y-1.5">
            {[...versions].reverse().map((v) => (
              <li
                key={v.id}
                className={`border rounded-md px-2.5 py-2 ${
                  v.id === currentVersionId
                    ? "border-accent/40 bg-accent/5"
                    : "border-line bg-panel2/40"
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-mono text-sm">v{v.version_no}</span>
                  {v.id === currentVersionId && (
                    <Badge tone="accent">current</Badge>
                  )}
                  {v.is_draft ? (
                    <Badge tone="neutral">draft</Badge>
                  ) : (
                    <Badge tone="green">sealed</Badge>
                  )}
                  {v.created_from_scenario_id && (
                    <Badge tone="violet" title="Applied from a scenario">
                      applied
                    </Badge>
                  )}
                  <span className="flex-1" />
                  <button
                    onClick={() =>
                      onView(v.id === currentVersionId ? null : v.id)
                    }
                    className="text-xs text-accent hover:underline"
                  >
                    {v.id === currentVersionId ? "viewing" : "view this one"}
                  </button>
                </div>
                {v.note && (
                  <p className="text-xs text-foreground/80">{v.note}</p>
                )}
                <p className="text-[11px] text-dim font-mono mt-0.5">
                  {v.content_hash.slice(0, 24)}…
                  {v.parent_version_id && (
                    <span className="ml-2">
                      parent v
                      {versions.find((p) => p.id === v.parent_version_id)
                        ?.version_no ?? "?"}
                    </span>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {accuracy && (
        <Card>
          <CardTitle>Detector accuracy on this project</CardTitle>
          {accuracy.has_labels ? (
            <>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm mb-3">
                <span>
                  <span className="text-dim">recall </span>
                  {accuracy.recall !== null
                    ? `${Math.round(accuracy.recall * 100)}%`
                    : "—"}
                </span>
                <span>
                  <span className="text-dim">precision </span>
                  {accuracy.precision !== null
                    ? `${Math.round(accuracy.precision * 100)}%`
                    : "—"}
                </span>
                {accuracy.planted > 0 && (
                  <span>
                    <span className="text-dim">planted faults found </span>
                    {accuracy.planted_found.length}/{accuracy.planted}
                  </span>
                )}
                <span className="text-dim">
                  {accuracy.labelled} labelled · {accuracy.detected} detected
                </span>
              </div>
              <Disclose summary="Every problem this fixture is known to contain">
                <ul className="text-xs space-y-1">
                  {accuracy.labels.map((label, i) => (
                    <li key={i} className="flex gap-2">
                      <Badge tone={label.detected ? "green" : "red"}>
                        {label.detected ? "found" : "missed"}
                      </Badge>
                      <span className="text-dim font-mono shrink-0">
                        {label.kind}@{label.root_cause}
                      </span>
                      <span className="text-foreground/80">
                        {label.description}
                      </span>
                      {label.planted && <Badge tone="violet">planted</Badge>}
                    </li>
                  ))}
                </ul>
              </Disclose>
            </>
          ) : (
            <p className="text-sm text-dim">{accuracy.note}</p>
          )}
        </Card>
      )}
    </div>
  );
}
