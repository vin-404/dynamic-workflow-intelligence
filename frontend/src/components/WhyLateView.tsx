"use client";

import { ProjectState, Bottleneck } from "@/lib/api";
import Card, { CardTitle } from "./Card";

function kindLabel(kind: string): string {
  return kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function BottleneckDetail({ b, rank }: { b: Bottleneck; rank: number }) {
  return (
    <div
      className={`border-l-[3px] p-4 rounded-r-md bg-panel2 ${
        b.severity === "high" ? "border-red" : "border-amber"
      }`}
    >
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span className="text-sm font-medium">
          #{rank} {kindLabel(b.kind)}
        </span>
        <span
          className={`text-[11px] px-2 py-0.5 rounded-full ${
            b.severity === "high"
              ? "bg-red/15 text-red"
              : "bg-amber/15 text-amber"
          }`}
        >
          {b.severity}
        </span>
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-panel text-dim">
          {b.attributed_delay_days}d lost
        </span>
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-panel text-dim">
          impact score: {b.impact_score}
        </span>
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-panel text-dim">
          {b.downstream_affected.length} downstream tasks blocked
        </span>
      </div>

      <div className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-[13px] mt-3">
        <span className="text-dim">Root cause</span>
        <span>
          <code className="bg-background px-1.5 py-0.5 rounded text-xs text-accent">
            {b.root_cause}
          </code>
        </span>
        <span className="text-dim">Evidence</span>
        <span>
          {Object.entries(b.evidence).map(([k, v]) => (
            <span key={k} className="inline-block mr-3">
              {k.replace(/_/g, " ")}:{" "}
              <strong>
                {Array.isArray(v) ? (v as string[]).join(", ") : String(v)}
              </strong>
            </span>
          ))}
        </span>
        <span className="text-dim">Blocked work</span>
        <span>
          {b.downstream_affected.slice(0, 8).map((t) => (
            <code
              key={t}
              className="bg-background px-1.5 py-0.5 rounded text-xs text-dim mr-1"
            >
              {t}
            </code>
          ))}
          {b.downstream_affected.length > 8 && (
            <span className="text-dim text-xs">
              +{b.downstream_affected.length - 8} more
            </span>
          )}
        </span>
      </div>

      <div className="mt-3 p-2 bg-accent/5 rounded text-[13px] text-accent/90">
        <strong>Recommended action:</strong> {b.suggested_action}
      </div>
    </div>
  );
}

export default function WhyLateView({ state }: { state: ProjectState }) {
  const slip = state.slip_days;
  const highSeverity = state.bottlenecks.filter((b) => b.severity === "high");
  const topCause = state.bottlenecks[0];

  // Find unique root causes on the critical path
  const criticalBlockers = state.bottlenecks.filter(
    (b) => b.kind === "critical_path_blocker"
  );

  return (
    <div className="space-y-4">
      {/* Summary */}
      <Card>
        <CardTitle>Schedule Analysis</CardTitle>
        <div className="flex gap-8 flex-wrap mb-4">
          <div>
            <div className="text-3xl font-bold text-red">
              +{slip} days behind
            </div>
            <div className="text-sm text-dim">
              Planned: {state.planned_end_date} (day {state.planned_end})
              &rarr; Projected: {state.projected_end_date} (day{" "}
              {state.projected_end})
            </div>
          </div>
        </div>

        {slip > 0 && topCause && (
          <div className="p-4 bg-red/5 border border-red/20 rounded-md">
            <h3 className="text-sm font-semibold mb-2">
              Why is this project late?
            </h3>
            <p className="text-sm">
              The primary cause is{" "}
              <code className="bg-background px-1.5 py-0.5 rounded text-accent">
                {topCause.root_cause}
              </code>{" "}
              ({kindLabel(topCause.kind).toLowerCase()}).{" "}
              {topCause.attributed_delay_days} days have been lost, blocking{" "}
              {topCause.downstream_affected.length} downstream tasks.
            </p>
            {criticalBlockers.length > 0 && (
              <p className="text-sm mt-2">
                The critical path runs through{" "}
                {state.critical_path.map((t, i) => (
                  <span key={t}>
                    {i > 0 && " \u2192 "}
                    <code className="bg-background px-1 py-0.5 rounded text-xs text-accent">
                      {t}
                    </code>
                  </span>
                ))}
                . Any delay on this chain directly extends the project finish
                date.
              </p>
            )}
            <p className="text-sm mt-2 font-medium">
              The most impactful action right now:{" "}
              {topCause.suggested_action}
            </p>
          </div>
        )}
      </Card>

      {/* Root causes ranked */}
      <Card>
        <CardTitle>
          Root Causes — Ranked by Impact ({state.bottlenecks.length} findings)
        </CardTitle>
        <div className="space-y-3">
          {state.bottlenecks.map((b, i) => (
            <BottleneckDetail key={`${b.kind}-${b.root_cause}`} b={b} rank={i + 1} />
          ))}
        </div>
      </Card>

      {/* What should the PM do first? */}
      <Card>
        <CardTitle>Recommended Priority Actions for Project Manager</CardTitle>
        <div className="space-y-2">
          {state.bottlenecks
            .filter((_, i) => i < 4)
            .map((b, i) => (
              <div
                key={`action-${i}`}
                className="flex items-start gap-3 p-3 bg-panel2 rounded-md"
              >
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                    i === 0
                      ? "bg-red/20 text-red"
                      : "bg-panel text-dim"
                  }`}
                >
                  {i + 1}
                </div>
                <div>
                  <p className="text-sm">{b.suggested_action}</p>
                  <p className="text-xs text-dim mt-0.5">
                    {b.attributed_delay_days}d lost | impact score{" "}
                    {b.impact_score} | {b.downstream_affected.length} tasks
                    waiting
                  </p>
                </div>
              </div>
            ))}
        </div>
        <p className="text-xs text-dim mt-3">
          Impact score = days lost x (1 + downstream tasks). Every number above
          is recomputable by hand from the event log. This is deterministic
          analysis, not AI guesswork.
        </p>
      </Card>
    </div>
  );
}
