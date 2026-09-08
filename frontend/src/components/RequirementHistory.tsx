"use client";

/**
 * Requirement versions, who changed what and when. PLACEHOLDER — Phase 11
 * wave 3, Agent UI-REQUIRE. Mounted by `RequirementChange`.
 */
export default function RequirementHistory({
  projectId,
  requirementKey,
}: {
  projectId: string;
  requirementKey: string;
}) {
  return (
    <p className="text-sm text-dim">
      {projectId} / {requirementKey}
    </p>
  );
}
