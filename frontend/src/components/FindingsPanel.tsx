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
 */

import { useMemo, useState } from "react";
import { Analysis, Finding } from "@/lib/api";
import {
  Badge,
  Card,
  CardTitle,
  Disclose,
  EmptyState,
  TierBanner,
  Tone,
  Worked,
  severityTone,
} from "./ui";

const TIER_TONE: Tone[] = ["neutral", "accent", "violet", "amber"];

function prettyKind(kind: string): string {
  return kind.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export default function FindingsPanel({ analysis }: { analysis: Analysis }) {
  const [tierFilter, setTierFilter] = useState<number | null>(null);

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
    <div>
      <TierBanner
        tier={analysis.tier_reached}
        checksRun={analysis.checks_run}
        unavailable={analysis.unavailable_checks}
      />

      {!analysis.schedulable && (
        <Card className="mb-4 border-red/40">
          <CardTitle>This workflow cannot be scheduled</CardTitle>
          <p className="text-sm">
            It contains a circular dependency, so it has no finish date at all.
          </p>
          {analysis.cycles.map((cycle, i) => (
            <p key={i} className="font-mono text-xs text-amber mt-2">
              {cycle.join(" → ")} → {cycle[0]}
            </p>
          ))}
        </Card>
      )}

      {analysis.findings.length === 0 ? (
        <EmptyState title="Nothing found at this evidence tier">
          {analysis.tier_reached === 0
            ? "The structural checks ran and found nothing wrong with the shape of this plan. Set statuses on your tasks to unlock the checks that need to know what is actually happening."
            : "Every check that could run came back clean."}
        </EmptyState>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-3 text-xs">
            <span className="text-dim">
              {analysis.findings.length} finding
              {analysis.findings.length === 1 ? "" : "s"} across{" "}
              {groups.length} cause{groups.length === 1 ? "" : "s"}
            </span>
            <span className="flex-1" />
            <button
              onClick={() => setTierFilter(null)}
              className={
                tierFilter === null ? "text-accent" : "text-dim hover:text-foreground"
              }
            >
              all tiers
            </button>
            {tiers.map((tier) => (
              <button
                key={tier}
                onClick={() => setTierFilter(tier === tierFilter ? null : tier)}
                className={
                  tierFilter === tier
                    ? "text-accent"
                    : "text-dim hover:text-foreground"
                }
              >
                tier {tier} ({analysis.finding_counts_by_tier[String(tier)]})
              </button>
            ))}
          </div>

          <div className="space-y-3">
            {groups.map(([cause, findings]) => (
              <CauseGroup key={cause} cause={cause} findings={findings} />
            ))}
          </div>
        </>
      )}

      {analysis.suppressed_findings.length > 0 && (
        <div className="mt-4">
          <Disclose
            summary={`${analysis.suppressed_findings.length} finding(s) suppressed by another — kept, with the reason`}
          >
            <div className="space-y-2">
              {analysis.suppressed_findings.map((f, i) => (
                <div
                  key={i}
                  className="border border-line rounded-md p-2.5 text-xs bg-panel2/40"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-dim">{prettyKind(f.kind)}</span>
                    <span className="font-mono text-dim">{f.root_cause}</span>
                    <Badge tone="neutral">
                      suppressed by {f.suppressed?.by}
                    </Badge>
                  </div>
                  <p className="text-foreground/80">{f.suppressed?.reason}</p>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-dim mt-2">
              One detector may silence another only with a stated reason, and
              the silenced finding is kept rather than dropped — so you can
              audit the judgement instead of trusting it.
            </p>
          </Disclose>
        </div>
      )}
    </div>
  );
}

function CauseGroup({
  cause,
  findings,
}: {
  cause: string;
  findings: Finding[];
}) {
  const worst = findings.reduce((a, b) =>
    a.impact_score >= b.impact_score ? a : b,
  );
  return (
    <Card className={worst.severity === "high" ? "border-red/30" : ""}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-accent">{cause}</span>
            <Badge tone={severityTone(worst.severity)}>{worst.severity}</Badge>
            {findings.length > 1 && (
              <span className="text-[11px] text-dim">
                {findings.length} findings, same cause
              </span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-lg font-semibold">
            {Math.round(worst.impact_score)}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-dim">
            impact
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {findings.map((finding, i) => (
          <FindingBody key={i} finding={finding} />
        ))}
      </div>
    </Card>
  );
}

function FindingBody({ finding }: { finding: Finding }) {
  return (
    <div className="border-t border-line/60 pt-2.5 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-sm font-medium">{prettyKind(finding.kind)}</span>
        <Badge tone={TIER_TONE[finding.tier] ?? "neutral"}>
          tier {finding.tier} · {finding.tier_name}
        </Badge>
      </div>

      <p className="text-sm text-foreground/90 mb-2">{finding.explanation}</p>

      <div className="text-sm bg-panel2/50 border border-line/60 rounded p-2 mb-2">
        <span className="text-dim text-xs">Do this: </span>
        {finding.suggested_action}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs mb-2">
        <span>
          <span className="text-dim">Impact </span>
          <Worked>{finding.impact.worked}</Worked>
        </span>
        <span className="text-dim">{finding.impact.formula}</span>
      </div>

      <Disclose summary="The evidence this reasoned from">
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-0.5 text-xs">
          {Object.entries(finding.evidence).map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="text-dim shrink-0">{k.replace(/_/g, " ")}:</dt>
              <dd className="text-foreground/90 break-all">
                {Array.isArray(v) ? v.join(", ") : String(v)}
              </dd>
            </div>
          ))}
        </dl>
        {finding.downstream_affected.length > 0 && (
          <p className="text-xs text-dim mt-2">
            Blocks {finding.downstream_affected.length} task(s):{" "}
            <span className="font-mono">
              {finding.downstream_affected.join(", ")}
            </span>
          </p>
        )}
      </Disclose>
    </div>
  );
}
