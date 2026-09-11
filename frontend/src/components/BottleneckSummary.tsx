"use client";

/**
 * The summary strip under the graph on the Bottlenecks stage: the three
 * figures the stage is about - projected slip, critical tasks, open findings
 * - and the one honesty line, "Evidence from history · 15 checks ran, 3
 * could not", with the full unavailable-checks disclosure behind it.
 *
 * Every figure and every word in the disclosure is the engine's. The
 * disclosure's text is the same text `TierBanner` used to show; it moved,
 * it did not change (design brief §2.2, §9).
 */

import { Analysis } from "@/lib/api";
import { calendarDate, findingKindLabel, tierLabel } from "@/lib/display";
import { cn } from "@/lib/utils";

function Figure({
  value,
  label,
  sub,
  tone = "",
}: {
  value: string;
  label: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="min-w-0 px-5 py-3 first:pl-0 last:pr-0">
      <div className={cn("text-[36px] font-semibold leading-none tracking-[-0.02em]", tone)}>
        {value}
      </div>
      <div className="mt-1.5 text-[14px] font-medium">{label}</div>
      {sub && <div className="mt-0.5 text-[12px] text-dim">{sub}</div>}
    </div>
  );
}

/** "chronic_underestimation: estimates that ..." → the kind as words, the rest verbatim. */
function checkLine(check: string): string {
  const colon = check.indexOf(":");
  if (colon === -1) return findingKindLabel(check);
  return `${findingKindLabel(check.slice(0, colon))}:${check.slice(colon + 1)}`;
}

export default function BottleneckSummary({ analysis }: { analysis: Analysis }) {
  const slip = analysis.slip_days;
  const slipText = `${slip > 0 ? "+" : ""}${Math.round(slip * 10) / 10}d`;
  const finish = calendarDate(analysis.projected_end_date);
  const couldNot = analysis.unavailable_checks.reduce((n, g) => n + g.checks.length, 0);
  const ran = analysis.checks_run.length;
  const causes = new Set(analysis.findings.map((f) => f.root_cause ?? f.kind)).size;
  const suppressed = analysis.suppressed_findings.length;

  return (
    <section
      data-panel="bottleneck-summary"
      className="rounded-xl border border-line bg-panel px-5 py-2"
    >
      <div className="grid grid-cols-1 divide-y divide-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <Figure
          value={slipText}
          label="projected slip"
          sub={`Projected finish day ${Math.round(analysis.projected_end)}${finish ? ` · ${finish}` : ""}`}
          tone={slip > 0 ? "text-critical" : ""}
        />
        <Figure
          value={String(analysis.critical_path.length)}
          label="critical tasks"
          sub={`of ${analysis.tasks.length} on the zero-slack chain`}
          tone="text-critical"
        />
        <Figure
          value={String(analysis.findings.length)}
          label="open findings"
          sub={`${causes} ${causes === 1 ? "root cause" : "root causes"}${
            suppressed ? ` · ${suppressed} suppressed` : ""
          }`}
        />
      </div>

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line py-3 text-[14px]">
        <span>
          <span className="font-medium">Evidence {tierLabel(analysis.tier_reached).toLowerCase()}</span>
          <span className="text-dim">
            {" · "}
            {ran} {ran === 1 ? "check" : "checks"} ran
            {couldNot > 0 ? `, ${couldNot} could not.` : "."}
          </span>
        </span>

        {analysis.unavailable_checks.length > 0 && (
          <details className="group min-w-0 flex-1 basis-full sm:basis-auto">
            <summary className="cursor-pointer list-none text-[14px] text-accent marker:content-none hover:underline [&::-webkit-details-marker]:hidden">
              <span className="inline-block w-3 group-open:hidden">▸</span>
              <span className="hidden w-3 group-open:inline-block">▾</span>
              What this analysis cannot assess yet, and why
            </summary>
            <div className="mt-2 space-y-3 border-l border-line pl-3 text-[12px]">
              {analysis.unavailable_checks.map((gap) => (
                <div key={gap.tier}>
                  <div className="font-medium text-foreground/90">
                    {tierLabel(gap.tier)} — needs {gap.requires}
                  </div>
                  <ul className="mt-1 space-y-0.5 text-dim">
                    {gap.checks.map((c) => (
                      <li key={c}>· {checkLine(c)}</li>
                    ))}
                  </ul>
                  <p className="mt-1 text-dim">{gap.why}</p>
                  <p className="mt-0.5 text-accent">{gap.unlocked_by}</p>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}
