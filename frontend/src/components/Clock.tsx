"use client";

/**
 * The simulated clock. PLACEHOLDER — Phase 11 wave 3, Agent UI-LIVE.
 * Mounted by `LiveFeed`, not by `page.tsx`.
 */
export default function Clock({ simDay }: { simDay: number; simDate?: string }) {
  return <span>{simDay}</span>;
}
