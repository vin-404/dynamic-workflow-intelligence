"use client";

/**
 * Capability 1 - current bottlenecks, explainably.
 *
 * A finding is never shown as a bare score. Each one shows its root cause
 * (not the symptom), the evidence it reasoned from, the impact with both
 * operands and the worked arithmetic, and the action it suggests.
 *
 * Findings are grouped by root cause, because three true findings about the
 * same stalled approval is one problem, not three.
 *
 * The row *is* the finding. There is no card around it: a group is a
 * hairline-ruled heading and its findings are rows under it, so eleven
 * findings read as eleven facts rather than eleven boxes. The only thing
 * behind a click is the evidence dump - the keys, the arithmetic, the tier
 * and the action all sit on the row.
 */

import { useMemo, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { Analysis, Finding } from "@/lib/api";
import { cn } from "@/lib/utils";
import { severityClasses, severityFill, severityText } from "@/lib/severity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TierBanner, Worked } from "./ui";

/** Chrome hides the default marker only if all three of these are set. */
const SUMMARY =
  "flex cursor-pointer list-none items-center gap-1 marker:content-none " +
  "[&::-webkit-details-marker]:hidden";

function prettyKind(kind: string): string {
  return kind.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export default function FindingsPanel({ analysis }: { analysis: Analysis }) {
  const [tierFilter, setTierFilter] = useState<number | null>(null);

  /** The one legitimate accent in this panel: a finding on the critical path. */
  const criticalPath = useMemo(
    () => new Set(analysis.critical_path),
    [analysis.critical_path],
  );

  const groups = useMemo(() => {
    const byCause = new Map<string, Finding[]>();
    for (const finding of analysis.findings) {
      if (tierFilter !== null && finding.tier !== tierFilter) continue;
      const key = finding.root_cause ?? finding.kind;
      byCause.set(key, [...(byCause.get(key) ?? []), finding]);
    }
    return [...byCause.entries()].sort(
      (a, b) =>
        Math.max(...b[1].map((f) => f.impact_score)) -
        Math.max(...a[1].map((f) => f.impact_score)),
    );
  }, [analysis.findings, tierFilter]);

  const tiers = Object.keys(analysis.finding_counts_by_tier)
    .map(Number)
    .sort();

  return (
    <div className="flex flex-col gap-4">
      <TierBanner
        tier={analysis.tier_reached}
        checksRun={analysis.checks_run}
        unavailable={analysis.unavailable_checks}
      />

      {!analysis.schedulable && (
        <div className="border-l-2 border-severity-high bg-severity-high/5 py-2 pl-3">
          <p className="text-sm font-semibold text-severity-high">
            This workflow cannot be scheduled
          </p>
          <p className="text-sm">
            It contains a circular dependency, so it has no finish date at all.
          </p>
          {analysis.cycles.map((cycle, i) => (
            <p
              key={i}
              className="mt-1 font-mono text-xs text-severity-medium"
            >
              {cycle.join(" → ")} → {cycle[0]}
            </p>
          ))}
        </div>
      )}

      {analysis.findings.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
          <p className="text-sm font-medium">
            Nothing found at this evidence tier
          </p>
          <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
            {analysis.tier_reached === 0
              ? "The structural checks ran and found nothing wrong with the shape of this plan. Set statuses on your tasks to unlock the checks that need to know what is actually happening."
              : "Every check that could run came back clean."}
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="text-sm">
              <span className="font-semibold">
                {analysis.findings.length} finding
                {analysis.findings.length === 1 ? "" : "s"}
              </span>
              <span className="text-muted-foreground">
                {" "}
                across {groups.length} cause
                {groups.length === 1 ? "" : "s"}
              </span>
            </h3>
            <div className="ml-auto flex flex-wrap items-center gap-1">
              <Button
                size="xs"
                variant={tierFilter === null ? "secondary" : "ghost"}
                aria-pressed={tierFilter === null}
                onClick={() => setTierFilter(null)}
              >
                all tiers
              </Button>
              {tiers.map((tier) => (
                <Button
                  key={tier}
                  size="xs"
                  variant={tierFilter === tier ? "secondary" : "ghost"}
                  aria-pressed={tierFilter === tier}
                  onClick={() => setTierFilter(tier === tierFilter ? null : tier)}
                >
                  tier {tier} ({analysis.finding_counts_by_tier[String(tier)]})
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-5">
            {groups.map(([cause, findings]) => (
              <CauseGroup
                key={cause}
                cause={cause}
                findings={findings}
                criticalPath={criticalPath}
              />
            ))}
          </div>
        </>
      )}

      {analysis.suppressed_findings.length > 0 && (
        <details className="group">
          <summary
            className={cn(SUMMARY, "text-xs text-muted-foreground hover:text-foreground")}
          >
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 transition-transform group-open:rotate-90"
            />
            {analysis.suppressed_findings.length} finding(s) suppressed by
            another — kept, with the reason
          </summary>
          <div className="mt-2 flex flex-col gap-2 border-l border-border pl-3">
            {analysis.suppressed_findings.map((f, i) => (
              <div key={i} className="text-xs">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono">{f.root_cause}</span>
                  <span className="text-muted-foreground">
                    {prettyKind(f.kind)}
                  </span>
                  <span className="text-muted-foreground">
                    suppressed by {f.suppressed?.by}
                  </span>
                </div>
                <p className="text-foreground/90">{f.suppressed?.reason}</p>
              </div>
            ))}
            <p className="text-[11px] text-muted-foreground">
              One detector may silence another only with a stated reason, and
              the silenced finding is kept rather than dropped — so you can
              audit the judgement instead of trusting it.
            </p>
          </div>
        </details>
      )}
    </div>
  );
}

function CauseGroup({
  cause,
  findings,
  criticalPath,
}: {
  cause: string;
  findings: Finding[];
  criticalPath: Set<string>;
}) {
  const worst = findings.reduce((a, b) =>
    a.impact_score >= b.impact_score ? a : b,
  );
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-border pb-1">
        <span className="font-mono text-[13px] font-semibold">{cause}</span>
        <Badge variant="outline" className={severityClasses(worst.severity)}>
          {worst.severity}
        </Badge>
        {findings.length > 1 && (
          <span className="text-[11px] text-muted-foreground">
            {findings.length} findings, same cause
          </span>
        )}
        <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">
          impact
        </span>
        <span className="text-base font-semibold leading-none">
          {Math.round(worst.impact_score)}
        </span>
      </div>

      <div className="divide-y divide-border/60">
        {findings.map((finding, i) => (
          <FindingRow key={i} finding={finding} criticalPath={criticalPath} />
        ))}
      </div>
    </div>
  );
}

function FindingRow({
  finding,
  criticalPath,
}: {
  finding: Finding;
  criticalPath: Set<string>;
}) {
  const onCriticalPath = finding.task_ids.some((k) => criticalPath.has(k));
  return (
    <div className="flex gap-2.5 py-2">
      {/* Severity as a rule rather than a border-and-box: three states, no card. */}
      <span
        aria-hidden
        className={cn(
          "w-0.5 shrink-0 self-stretch rounded-full",
          severityFill(finding.severity),
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-mono text-xs">
            {finding.task_ids.join(" ")}
          </span>
          <span className="text-[13px] font-medium">
            {prettyKind(finding.kind)}
          </span>
          <span className={cn("text-[11px]", severityText(finding.severity))}>
            {finding.severity}
          </span>
          {onCriticalPath && (
            <span className="text-[11px] text-accent">critical path</span>
          )}
          <span className="text-[11px] text-muted-foreground">
            tier {finding.tier} · {finding.tier_name}
          </span>
          <span className="ml-auto flex items-baseline gap-2">
            <Worked>{finding.impact.worked}</Worked>
            <span className="text-[13px] font-semibold">
              {Math.round(finding.impact_score)}
            </span>
          </span>
        </div>

        <p className="mt-1 text-[13px] leading-snug text-foreground/90">
          {finding.explanation}
        </p>
        <p className="mt-0.5 text-[13px] leading-snug">
          <span className="text-muted-foreground">Do this: </span>
          {finding.suggested_action}
        </p>

        <details className="group mt-1">
          <summary
            className={cn(
              SUMMARY,
              "text-[11px] text-muted-foreground hover:text-foreground",
            )}
          >
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 transition-transform group-open:rotate-90"
            />
            The evidence this reasoned from
            <span className="ml-1 font-mono">{finding.impact.formula}</span>
          </summary>
          <dl className="mt-1.5 grid grid-cols-1 gap-x-6 gap-y-0.5 border-l border-border pl-2.5 text-[11px] sm:grid-cols-2">
            {Object.entries(finding.evidence).map(([k, v]) => (
              <div key={k} className="flex gap-1.5">
                <dt className="shrink-0 text-muted-foreground">
                  {k.replace(/_/g, " ")}:
                </dt>
                <dd className="min-w-0 break-words font-mono">
                  {Array.isArray(v) ? v.join(", ") : String(v)}
                </dd>
              </div>
            ))}
          </dl>
          {finding.downstream_affected.length > 0 && (
            <p className="mt-1.5 border-l border-border pl-2.5 text-[11px] text-muted-foreground">
              Blocks {finding.downstream_affected.length} task(s):{" "}
              <span className="font-mono">
                {finding.downstream_affected.join(", ")}
              </span>
            </p>
          )}
        </details>
      </div>
    </div>
  );
}
