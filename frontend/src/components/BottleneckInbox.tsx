"use client";

import { ProjectState, Bottleneck } from "@/lib/api";
import Card, { CardTitle } from "./Card";

function kindLabel(kind: string): string {
  return kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function SeverityBadge({ severity }: { severity: string }) {
  const cls =
    severity === "high"
      ? "bg-red/15 text-red"
      : "bg-amber/15 text-amber";
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full ${cls}`}>
      {severity}
    </span>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] px-2 py-0.5 rounded-full bg-panel2 text-dim">
      {children}
    </span>
  );
}

function BottleneckCard({ b }: { b: Bottleneck }) {
  return (
    <div
      className={`border-l-[3px] p-4 bg-panel2 rounded-r-md mb-3 ${
        b.severity === "high" ? "border-red" : "border-amber"
      }`}
    >
      <div className="flex items-baseline gap-2 flex-wrap">
        <strong className="text-[13px] tracking-wide">
          {kindLabel(b.kind)}
        </strong>
        <SeverityBadge severity={b.severity} />
        <Pill>{b.attributed_delay_days}d lost</Pill>
        <Pill>impact {b.impact_score}</Pill>
        <Pill>{b.downstream_affected.length} downstream</Pill>
      </div>

      <div className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-[12.5px] mt-3">
        <dt className="text-dim">Tasks</dt>
        <dd>
          {b.tasks.map((t) => (
            <code
              key={t}
              className="bg-background px-1.5 py-0.5 rounded text-xs text-accent mr-1"
            >
              {t}
            </code>
          ))}
        </dd>
        <dt className="text-dim">Root cause</dt>
        <dd>
          <code className="bg-background px-1.5 py-0.5 rounded text-xs text-accent">
            {b.root_cause}
          </code>
        </dd>
        <dt className="text-dim">Evidence</dt>
        <dd>
          {Object.entries(b.evidence).map(([k, v]) => (
            <span key={k} className="mr-3">
              {k.replace(/_/g, " ")}:{" "}
              <strong>
                {Array.isArray(v) ? (v as string[]).join(", ") : String(v)}
              </strong>
            </span>
          ))}
        </dd>
        <dt className="text-dim">Blocked work</dt>
        <dd>
          {b.downstream_affected.map((t) => (
            <code
              key={t}
              className="bg-background px-1 py-0.5 rounded text-[11px] text-dim mr-1"
            >
              {t}
            </code>
          ))}
          {b.downstream_affected.length === 0 && (
            <span className="text-dim">&mdash;</span>
          )}
        </dd>
      </div>

      <div className="mt-3 p-2.5 bg-accent/5 rounded text-[12.5px] text-accent/80">
        &rarr; {b.suggested_action}
      </div>
    </div>
  );
}

export default function BottleneckInbox({ state }: { state: ProjectState }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>
          Bottlenecks — Ranked by Impact (days lost x work stuck behind it)
        </CardTitle>
        {state.bottlenecks.map((b, i) => (
          <BottleneckCard key={`${b.kind}-${b.root_cause}-${i}`} b={b} />
        ))}
        <p className="text-xs text-dim mt-3 leading-relaxed">
          Impact score = attributed delay x (1 + downstream tasks). It is a
          formula, not a model — every number above is recomputable by hand from
          the event log.
        </p>
      </Card>
    </div>
  );
}
