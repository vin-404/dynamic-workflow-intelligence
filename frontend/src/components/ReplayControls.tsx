"use client";

/**
 * Play, pause, speed, scrub, restart. PLACEHOLDER — Phase 11 wave 3,
 * Agent UI-LIVE. Mounted by `LiveFeed`, not by `page.tsx`.
 */
export default function ReplayControls({ projectId }: { projectId: string }) {
  return <span className="text-dim text-sm">{projectId}</span>;
}
