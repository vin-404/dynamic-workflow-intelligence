"use client";

/**
 * Capability 1 - current bottlenecks, explainably.
 *
 * One card per finding, sorted by impact. The action - "Do this: …" - is the
 * loudest line on every card; the cause supports it in one sentence, and the
 * evidence (the engine's full explanation, the worked impact arithmetic, the
 * formula, the evidence fields) sits behind one disclosure, verbatim. The
 * impact is a number with a bar proportional to the largest impact on the
 * page, so the eye can rank without reading (design brief §4, Bottlenecks).
 *
 * Nothing here is computed: every figure, sentence and formula is the
 * engine's. The summary figures and the honesty line moved to
 * `BottleneckSummary`, which sits above this on the stage.
 */

import { useMemo, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { Analysis, Finding } from "@/lib/api";
import { cn } from "@/lib/utils";
import { severityClasses } from "@/lib/severity";
import {
  findingKindLabel,
  humanize,
  prose,
  severityLabel,
  tierLabel,
} from "@/lib/display";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const SUMMARY =
  "flex cursor-pointer list-none items-center gap-1 marker:content-none [&::-webkit-details-marker]:hidden";

/** The first sentence of the engine's explanation; the rest waits in the disclosure. */
function firstSentence(text: string): string {
  const m = /^([\s\S]*?[.!?])(?:\s+(?=[A-Z0-9"(])|$)/.exec(text.trim());
  return m ? m[1] : text;
}

export default function FindingsPanel({
  analysis,
  onFocusTask,
}: {
  analysis: Analysis;
  /** Clicking a task key on a card focuses it in the graph and inspector. */
  onFocusTask?: (taskKey: string) => void;
}) {
  const [tierFilter, setTierFilter] = useState<number | null>(null);

  const criticalPath = useMemo(
    () => new Set(analysis.critical_path),
    [analysis.critical_path],
  );

  const taskName = useMemo(
    () => new Map(analysis.tasks.map((t) => [t.key, t.name])),
    [analysis.tasks],
  );

  const sorted = useMemo(
    () =>
      analysis.findings
        .filter((f) => tierFilter === null || f.tier === tierFilter)
        .slice()
        .sort((a, b) => b.impact_score - a.impact_score),
    [analysis.findings, tierFilter],
  );

  const maxImpact = useMemo(
    () => Math.max(1, ...analysis.findings.map((f) => f.impact_score)),
    [analysis.findings],
  );

  const tiers = Object.keys(analysis.finding_counts_by_tier)
    .map(Number)
    .sort();

  return (
    <div className="flex flex-col gap-4" data-panel="findings">
      {!analysis.schedulable && (
        <div className="border-l-2 border-severity-high bg-severity-high/5 py-3 pl-3 pr-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[14px] font-semibold text-severity-high">
              This workflow cannot be scheduled
            </p>
            <Badge variant="outline" className={severityClasses("high")}>
              circular dependency
            </Badge>
          </div>
          <p className="mt-1 text-[14px] text-foreground/80">
            It contains a circular dependency, so it has no finish date at all.
          </p>

          {analysis.cycles.map((cycle, i) => (
            <p key={i} className="mt-2 font-mono text-[12px] text-severity-medium">
              {cycle.join(" → ")} → {cycle[0]}
            </p>
          ))}
        </div>
      )}

      {analysis.findings.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-panel px-4 py-10 text-center">
          <p className="text-[14px] font-semibold">Nothing found at this evidence tier</p>
          <p className="mx-auto mt-1 max-w-lg text-[14px] text-muted-foreground">
            {analysis.tier_reached === 0
              ? "The structural checks ran and found nothing wrong with the shape of this plan. Set statuses on your tasks to unlock the checks that need to know what is actually happening."
              : "Every check that could run came back clean."}
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <h3 className="text-[18px] font-semibold">
              Findings
              <span className="ml-2 text-[14px] font-normal text-dim">
                {sorted.length === analysis.findings.length
                  ? `${sorted.length}, by impact`
                  : `${sorted.length} of ${analysis.findings.length}, by impact`}
              </span>
            </h3>

            {tiers.length > 1 && (
              <div className="ml-auto flex flex-wrap items-center gap-1">
                <Button
                  size="xs"
                  variant={tierFilter === null ? "secondary" : "ghost"}
                  aria-pressed={tierFilter === null}
                  onClick={() => setTierFilter(null)}
                >
                  All evidence
                </Button>

                {tiers.map((tier) => (
                  <Button
                    key={tier}
                    size="xs"
                    variant={tierFilter === tier ? "secondary" : "ghost"}
                    aria-pressed={tierFilter === tier}
                    onClick={() => setTierFilter(tier === tierFilter ? null : tier)}
                  >
                    {tierLabel(tier)} ({analysis.finding_counts_by_tier[String(tier)]})
                  </Button>
                ))}
              </div>
            )}
          </div>

          {sorted.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
              <p className="text-[14px] font-medium">No findings from this evidence</p>
              <p className="mt-1 text-[12px] text-muted-foreground">
                Switch back to all evidence to see the complete list.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {sorted.map((finding, i) => (
                <FindingCard
                  key={`${finding.kind}-${finding.task_ids.join(",")}-${i}`}
                  finding={finding}
                  criticalPath={criticalPath}
                  taskName={taskName}
                  maxImpact={maxImpact}
                  onFocusTask={onFocusTask}
                />
              ))}
            </div>
          )}
        </>
      )}

      {analysis.suppressed_findings.length > 0 && (
        <details className="group pt-1">
          <summary className={cn(SUMMARY, "text-[14px] text-accent hover:underline")}>
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 transition-transform group-open:rotate-90"
            />
            {analysis.suppressed_findings.length}{" "}
            {analysis.suppressed_findings.length === 1 ? "finding" : "findings"} suppressed — why
          </summary>

          <div className="mt-3 flex flex-col gap-3 border-l border-border pl-3">
            {analysis.suppressed_findings.map((finding, i) => (
              <div key={i} className="text-[12px]">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono">{finding.root_cause}</span>
                  <span className="text-muted-foreground">{findingKindLabel(finding.kind)}</span>
                  <span className="text-muted-foreground">
                    suppressed by {findingKindLabel(finding.suppressed?.by)}
                  </span>
                </div>
                <p className="mt-0.5 text-foreground/90">{finding.suppressed?.reason}</p>
              </div>
            ))}

            <p className="text-[12px] leading-relaxed text-muted-foreground">
              One detector may silence another only with a stated reason, and the silenced
              finding is kept rather than dropped — so you can audit the judgement instead
              of trusting it.
            </p>
          </div>
        </details>
      )}
    </div>
  );
}

function FindingCard({
  finding,
  criticalPath,
  taskName,
  maxImpact,
  onFocusTask,
}: {
  finding: Finding;
  criticalPath: Set<string>;
  taskName: Map<string, string>;
  maxImpact: number;
  onFocusTask?: (taskKey: string) => void;
}) {
  const onCriticalPath = finding.task_ids.some((taskId) => criticalPath.has(taskId));
  const impact = Math.round(finding.impact_score);
  const share = Math.max(0, Math.min(1, finding.impact_score / maxImpact));
  const explanation = prose(finding.explanation);
  const cause = firstSentence(explanation);
  const few = finding.task_ids.length <= 2;

  return (
    <article
      className={cn(
        "rounded-xl border bg-panel p-4",
        finding.severity === "high" ? "border-critical/40" : "border-line",
      )}
    >
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-dim">
            <Badge variant="outline" className={cn("text-[12px]", severityClasses(finding.severity))}>
              {severityLabel(finding.severity)}
            </Badge>

            <span className="font-medium text-foreground">{findingKindLabel(finding.kind)}</span>

            <span aria-hidden>·</span>

            {few ? (
              finding.task_ids.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => onFocusTask?.(key)}
                  className="inline-flex items-baseline gap-1 rounded hover:text-foreground hover:underline"
                  title="Show this task in the graph"
                >
                  <span className="font-mono">{key}</span>
                  {taskName.get(key) && <span>{taskName.get(key)}</span>}
                </button>
              ))
            ) : (
              <span>{finding.task_ids.length} tasks</span>
            )}

            <span aria-hidden>·</span>
            <span>{tierLabel(finding.tier)}</span>

            {onCriticalPath && (
              <span
                className="font-medium text-critical"
                title="Zero slack in today's deterministic schedule. The forecast stage reports the probabilistic form of this - the fraction of simulated runs in which the task lay on the critical path."
              >
                zero-slack chain
              </span>
            )}
          </div>

          <p className="mt-2 text-[14px] font-semibold leading-snug">
            <span>Do this: </span>
            {prose(finding.suggested_action)}
          </p>

          <p className="mt-1 text-[14px] leading-snug text-dim">{cause}</p>
        </div>

        <div className="w-24 shrink-0 text-right">
          <div className="text-[20px] font-semibold leading-none">{impact}</div>
          <div className="mt-0.5 text-[12px] text-dim">impact</div>
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-panel2">
            <div
              className={cn(
                "h-full rounded-full",
                finding.severity === "high" ? "bg-critical" : "bg-dim/60",
              )}
              style={{ width: `${Math.round(share * 100)}%` }}
            />
          </div>
        </div>
      </div>

      <details className="group mt-3">
        <summary className={cn(SUMMARY, "text-[12px] text-accent hover:underline")}>
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 transition-transform group-open:rotate-90"
          />
          Evidence
        </summary>

        <div className="mt-2 flex flex-col gap-2 border-l border-border pl-3 text-[12px]">
          {explanation !== cause && (
            <p className="leading-relaxed text-foreground/90">{explanation}</p>
          )}

          <p className="text-muted-foreground">
            <span className="font-medium text-foreground/90">Impact:</span>{" "}
            <span className="font-mono">{finding.impact.worked}</span>
            <span className="ml-2 font-mono">{finding.impact.formula}</span>
          </p>

          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
            {Object.entries(finding.evidence).map(([key, value]) => (
              <div key={key} className="flex gap-1.5">
                <dt className="shrink-0 text-muted-foreground">{humanize(key)}:</dt>
                <dd className="min-w-0 break-words font-mono">
                  {Array.isArray(value) ? value.join(", ") : String(value)}
                </dd>
              </div>
            ))}
          </dl>

          {!few && (
            <p className="text-muted-foreground">
              Tasks: <span className="font-mono">{finding.task_ids.join(", ")}</span>
            </p>
          )}

          {finding.downstream_affected.length > 0 && (
            <p className="text-muted-foreground">
              Blocks {finding.downstream_affected.length}{" "}
              {finding.downstream_affected.length === 1 ? "task" : "tasks"}:{" "}
              <span className="font-mono">{finding.downstream_affected.join(", ")}</span>
            </p>
          )}
        </div>
      </details>
    </article>
  );
}
