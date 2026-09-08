"use client";

/**
 * What a re-worded requirement would cost. PLACEHOLDER — Phase 11 wave 3,
 * Agent UI-REQUIRE. Mounted by `RequirementChange`, not by `page.tsx`.
 */
import { ImpactReport as Report } from "@/lib/api";

export default function ImpactReport({ report }: { report: Report }) {
  return <p className="text-sm text-dim">{report.requirement_key}</p>;
}
