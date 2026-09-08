"use client";

/**
 * Import a Jira CSV: preview what would be created, then commit it as a new
 * project.
 *
 * PLACEHOLDER — Phase 11 wave 3, Agent UI-CHANGE. `onImported` hands the new
 * project id back to `page.tsx`, which selects it. Keep the prop signature.
 */
export default function ImportPanel({
  onImported,
}: {
  onImported: (projectId: string) => void;
}) {
  return (
    <p className="text-sm text-dim">
      Import is not built yet.
      <button hidden onClick={() => onImported("")} />
    </p>
  );
}
