"use client";

/**
 * The live stage: a running clock, events arriving, findings appearing and
 * clearing on their own.
 *
 * PLACEHOLDER — Phase 11 wave 3, Agent UI-LIVE. This component owns the whole
 * live stage and composes `Clock`, `ReplayControls` and `DependencyGraph`
 * itself, so `page.tsx` has exactly one mount point and the internal
 * arrangement stays inside the agent's own file ownership. The prop signature
 * below is the contract `page.tsx` mounts against; keep it.
 */
import { Analysis, Workflow } from "@/lib/api";

export default function LiveFeed({
  projectId,
}: {
  projectId: string;
  workflow: Workflow;
  analysis: Analysis | null;
}) {
  return (
    <p className="text-sm text-dim">
      Live replay is not built yet ({projectId}).
    </p>
  );
}
