"use client";

/**
 * Capability 1 - current bottlenecks, explainably.
 *
 * Findings are grouped by root cause so related signals read as one problem.
 * Each row keeps the cause, evidence, impact, and suggested action visible,
 * with the evidence details available on demand.
 */

import { useMemo, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { Analysis, Finding } from "@/lib/api";
import { cn } from "@/lib/utils";
import { severityClasses, severityFill, severityText } from "@/lib/severity";
import { findingKindLabel, humanize, prose, severityLabel, tierLabel } from "@/lib/display";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TierBanner, Worked } from "./ui";

const SUMMARY =
  "flex cursor-pointer list-none items-center gap-1 marker:content-none [&::-webkit-details-marker]:hidden";

export default function FindingsPanel({ analysis }: { analysis: Analysis }) {
  const [tierFilter, setTierFilter] = useState<number | null>(null);

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

  const shown = groups.reduce((n, [, findings]) => n + findings.length, 0);

  const tiers = Object.keys(analysis.finding_counts_by_tier)
    .map(Number)
    .sort();

  const criticalFindings = analysis.findings.filter((finding) =>
    finding.task_ids.some((taskId) => criticalPath.has(taskId)),
  ).length;

  const rootCauseCount = new Set(
    analysis.findings.map((finding) => finding.root_cause ?? finding.kind),
  ).size;

  return (
    <div className="flex flex-col gap-4">
      <TierBanner
        tier={analysis.tier_reached}
        checksRun={analysis.checks_run}
        unavailable={analysis.unavailable_checks}
      />

      {analysis.findings.length > 0 && (
        <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3">
          <Metric
            label="Open findings"
            value={analysis.findings.length}
            detail={
              analysis.findings.length === 1
                ? "issue detected"
                : "issues detected"
            }
          />
          <Metric
            label="Root causes"
            value={rootCauseCount}
            detail={
              rootCauseCount === 1 ? "underlying cause" : "underlying causes"
            }
          />
          <Metric
            label="Critical path"
            value={criticalFindings}
            detail={
              criticalFindings === 1
                ? "finding touches the path"
                : "findings touch the path"
            }
          />
        </div>
      )}

      {!analysis.schedulable && (
        <div className="border-l-2 border-severity-high bg-severity-high/5 py-3 pl-3 pr-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-severity-high">
              This workflow cannot be scheduled
            </p>
            <Badge variant="outline" className={severityClasses("high")}>
              circular dependency
            </Badge>
          </div>
          <p className="mt-1 text-sm text-foreground/80">
            It contains a circular dependency, so it has no finish date at all.
          </p>

          {analysis.cycles.map((cycle, i) => (
            <p
              key={i}
              className="mt-2 font-mono text-xs text-severity-medium"
            >
              {cycle.join(" → ")} → {cycle[0]}
            </p>
          ))}
        </div>
      )}

      {analysis.findings.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-panel px-4 py-10 text-center">
          <p className="text-sm font-semibold">
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
          <div className="flex flex-wrap items-end gap-3 border-b border-border pb-3">
            <div>
              <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Bottleneck register
              </p>
              <h3 className="mt-1 text-sm">
                <span className="font-semibold">
                  {shown} finding{shown === 1 ? "" : "s"}
                </span>
                <span className="text-muted-foreground">
                  {" "}
                  across {groups.length} cause
                  {groups.length === 1 ? "" : "s"}
                  {tierFilter !== null
                    ? ` · ${tierLabel(tierFilter)} (of ${analysis.findings.length})`
                    : ""}
                </span>
              </h3>
            </div>

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
                  onClick={() =>
                    setTierFilter(tier === tierFilter ? null : tier)
                  }
                >
                  {tierLabel(tier)} ({analysis.finding_counts_by_tier[String(tier)]})
                </Button>
              ))}
            </div>
          </div>

          {shown === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
              <p className="text-sm font-medium">
                No findings match this tier
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Switch back to all tiers to see the complete register.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {groups.map(([cause, findings]) => (
                <CauseGroup
                  key={cause}
                  cause={cause}
                  findings={findings}
                  criticalPath={criticalPath}
                />
              ))}
            </div>
          )}
        </>
      )}

      {analysis.suppressed_findings.length > 0 && (
        <details className="group border-t border-border pt-3">
          <summary
            className={cn(
              SUMMARY,
              "text-xs text-muted-foreground hover:text-foreground",
            )}
          >
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 transition-transform group-open:rotate-90"
            />
            {analysis.suppressed_findings.length} finding(s) suppressed by
            another — kept, with the reason
          </summary>

          <div className="mt-3 flex flex-col gap-3 border-l border-border pl-3">
            {analysis.suppressed_findings.map((finding, i) => (
              <div key={i} className="text-xs">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono">{finding.root_cause}</span>
                  <span className="text-muted-foreground">
                    {findingKindLabel(finding.kind)}
                  </span>
                  <span className="text-muted-foreground">
                    suppressed by {findingKindLabel(finding.suppressed?.by)}
                  </span>
                </div>
                <p className="mt-0.5 text-foreground/90">
                  {finding.suppressed?.reason}
                </p>
              </div>
            ))}

            <p className="text-[12px] leading-relaxed text-muted-foreground">
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

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <div className="bg-panel px-4 py-3">
      <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-xl font-semibold tracking-tight">{value}</span>
        <span className="text-[12px] text-muted-foreground">{detail}</span>
      </div>
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
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border pb-2">
        <span className="font-mono text-[13px] font-semibold">{cause}</span>

        <Badge
          variant="outline"
          className={severityClasses(worst.severity)}
        >
          {severityLabel(worst.severity)}
        </Badge>

        {findings.length > 1 && (
          <span className="text-[12px] text-muted-foreground">
            {findings.length} findings, same cause
          </span>
        )}

        <div className="ml-auto flex items-baseline gap-2">
          <span className="text-[12px] uppercase tracking-wider text-muted-foreground">
            max impact
          </span>
          <span className="text-base font-semibold leading-none">
            {Math.round(worst.impact_score)}
          </span>
        </div>
      </div>

      <div className="divide-y divide-border/60">
        {findings.map((finding, i) => (
          <FindingRow
            key={i}
            finding={finding}
            criticalPath={criticalPath}
          />
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
  const onCriticalPath = finding.task_ids.some((taskId) =>
    criticalPath.has(taskId),
  );

  return (
    <div className="flex gap-3 py-3">
      <span
        aria-hidden
        className={cn(
          "w-0.5 shrink-0 self-stretch rounded-full",
          severityFill(finding.severity),
        )}
      />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-mono text-xs text-foreground/80">
            {finding.task_ids.join(" ")}
          </span>

          <span className="text-[13px] font-medium">
            {findingKindLabel(finding.kind)}
          </span>

          <span
            className={cn(
              "text-[12px] font-medium",
              severityText(finding.severity),
            )}
          >
            {severityLabel(finding.severity)}
          </span>

          {onCriticalPath && (
            <span
              className="text-[12px] font-medium text-accent"
              title="Zero slack in today's deterministic schedule. The forecast stage reports the probabilistic form of this - the fraction of simulated runs in which the task lay on the critical path."
            >
              critical path
            </span>
          )}

          <span className="text-[12px] text-muted-foreground">
            {tierLabel(finding.tier)}
          </span>

          <span className="ml-auto flex items-baseline gap-2">
            <Worked>{finding.impact.worked}</Worked>
            <span className="text-[13px] font-semibold">
              {Math.round(finding.impact_score)}
            </span>
          </span>
        </div>

        <p className="mt-1.5 text-[13px] leading-relaxed text-foreground/90">
          {prose(finding.explanation)}
        </p>

        <p className="mt-1 text-[13px] leading-relaxed">
          <span className="text-muted-foreground">Do this: </span>
          {prose(finding.suggested_action)}
        </p>

        <details className="group mt-2">
          <summary
            className={cn(
              SUMMARY,
              "text-[12px] text-muted-foreground hover:text-foreground",
            )}
          >
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 transition-transform group-open:rotate-90"
            />
            The evidence this reasoned from
            <span className="ml-1 font-mono">{finding.impact.formula}</span>
          </summary>

          <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 border-l border-border pl-2.5 text-[12px] sm:grid-cols-2">
            {Object.entries(finding.evidence).map(([key, value]) => (
              <div key={key} className="flex gap-1.5">
                <dt className="shrink-0 text-muted-foreground">
                  {humanize(key)}:
                </dt>
                <dd className="min-w-0 break-words font-mono">
                  {Array.isArray(value) ? value.join(", ") : String(value)}
                </dd>
              </div>
            ))}
          </dl>

          {finding.downstream_affected.length > 0 && (
            <p className="mt-2 border-l border-border pl-2.5 text-[12px] text-muted-foreground">
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
