"use client";

/**
 * The requirement stage: pick a requirement, propose a new wording, read what
 * it would cost before committing to it.
 *
 * PLACEHOLDER — Phase 11 wave 3, Agent UI-REQUIRE. This component owns the
 * whole stage and composes `ImpactReport` and `RequirementHistory` itself, so
 * `page.tsx` has one mount point. Keep the prop signature.
 */
import { Workflow } from "@/lib/api";

export default function RequirementChange({
  projectId,
}: {
  projectId: string;
  workflow: Workflow;
}) {
  return (
    <p className="text-sm text-dim">
      Requirement change is not built yet ({projectId}).
    </p>
  );
}
