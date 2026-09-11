"use client";

/**
 * A timestamp the way the brief wants it: relative in the text ("3 days
 * ago"), the precise UTC instant on hover and in the `dateTime` attribute.
 * `precise` shows the full instant inline as well, for the one panel whose
 * job is provenance (History, D-127). Never a raw ISO string.
 */

import { absoluteUTC, parseInstant, relativeTime } from "@/lib/display";

export default function When({
  iso,
  precise = false,
  className = "",
}: {
  iso: string | null | undefined;
  precise?: boolean;
  className?: string;
}) {
  const instant = parseInstant(iso);
  if (!instant) return <span className={className}>—</span>;

  const relative = relativeTime(iso) ?? "";
  const absolute = absoluteUTC(iso, true) ?? "";

  return (
    <time dateTime={instant.toISOString()} title={absolute} className={className}>
      {precise ? `${relative} · ${absoluteUTC(iso) ?? ""}` : relative}
    </time>
  );
}
