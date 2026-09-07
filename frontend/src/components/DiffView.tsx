"use client";

/**
 * The before/after diff.
 *
 * Used by both the what-if panel and the optimizer, because a hand-written
 * hypothetical and an optimizer candidate produce the same comparison payload
 * from the same engine - so they get the same view.
 *
 * The immutability proof is at the bottom on purpose: it is not decoration.
 * "The original workflow remains unchanged" is a product claim, and this is
 * where a sceptical reader checks it.
 */

import { Comparison, SimulationResponse } from "@/lib/api";
import {
  Badge,
  Card,
  CardTitle,
  Disclose,
  Stat,
  days,
} from "./ui";

export default function DiffView({
  result,
}: {
  result: SimulationResponse;
}) {
  const c = result.comparison;
  const completion = c.projected_completion;
  const later = completion.delta_days > 0;
  const earlier = completion.delta_days < 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle right={<Badge tone="neutral">{result.origin}</Badge>}>
          What this would do
        </CardTitle>
        <p className="text-sm mb-3">{result.summary}</p>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat
            label="Finish before"
            value={`day ${Math.round(completion.before_day)}`}
            sub={result.projected_end_date_before}
          />
          <Stat
            label="Finish after"
            value={`day ${Math.round(completion.after_day)}`}
            sub={result.projected_end_date_after}
            tone={later ? "red" : earlier ? "green" : undefined}
          />
          <Stat
            label="Change"
            value={days(completion.delta_days, true)}
            sub={completion.direction}
            tone={later ? "red" : earlier ? "green" : undefined}
          />
          <Stat
            label="Tasks moved"
            value={c.tasks_moved_count}
            sub={
              c.slack_consumed_total_days
                ? `${days(c.slack_consumed_total_days)} of slack used`
                : "no slack consumed"
            }
          />
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <FeasibilityCompare comparison={c} />
        <FindingsCompare comparison={c} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CriticalPathCompare comparison={c} />
        <StructureCompare comparison={c} />
      </div>

      {c.tasks_moved.length > 0 && (
        <Card>
          <CardTitle>Which tasks move, and by how much</CardTitle>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-dim">
                <th className="font-medium py-1">Task</th>
                <th className="font-medium py-1">Name</th>
                <th className="font-medium py-1 text-right w-20">From</th>
                <th className="font-medium py-1 text-right w-20">To</th>
                <th className="font-medium py-1 text-right w-20">Change</th>
              </tr>
            </thead>
            <tbody>
              {c.tasks_moved.map((m) => (
                <tr key={m.task} className="border-t border-line/60">
                  <td className="py-1 font-mono text-xs text-dim">{m.task}</td>
                  <td className="py-1">{m.name}</td>
                  <td className="py-1 text-right font-mono text-xs">
                    day {Math.round(m.from_day)}
                  </td>
                  <td className="py-1 text-right font-mono text-xs">
                    day {Math.round(m.to_day)}
                  </td>
                  <td
                    className={`py-1 text-right font-mono text-xs ${
                      m.delta_days > 0 ? "text-red" : "text-green"
                    }`}
                  >
                    {days(m.delta_days, true)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {result.after.resource_unavailability?.is_approximation && (
        <Card>
          <CardTitle>How unavailability was modelled</CardTitle>
          <p className="text-xs text-dim mb-2">
            {result.after.resource_unavailability.method}
          </p>
          <ul className="text-xs space-y-0.5">
            {result.after.resource_unavailability.adjustments?.map((a) => (
              <li key={a.task}>
                <span className="font-mono text-dim">{a.task}</span>{" "}
                {a.task_name} — {days(a.days_added)} added because{" "}
                {a.resource_name} is away during its window
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className={result.base_unchanged ? "border-green/30" : "border-red/40"}>
        <CardTitle>Is the original workflow untouched?</CardTitle>
        <div className="flex items-center gap-2 mb-2">
          <Badge tone={result.base_unchanged ? "green" : "red"}>
            {result.base_unchanged ? "unchanged" : "CHANGED"}
          </Badge>
          <span className="text-sm text-dim">
            The base version&apos;s content hash, before and after this
            evaluation.
          </span>
        </div>
        <div className="font-mono text-[11px] space-y-0.5">
          <div>
            <span className="text-dim">before </span>
            {result.base_version_hash.slice(0, 32)}…
          </div>
          <div>
            <span className="text-dim">after&nbsp;&nbsp;</span>
            {result.base_version_hash_after_evaluation.slice(0, 32)}…
          </div>
          <div className="text-dim">
            <span>this scenario </span>
            {result.scenario_hash.slice(0, 32)}…
          </div>
        </div>
        <Disclose summary="The mutations that would undo this">
          <ul className="text-xs font-mono space-y-0.5">
            {result.inverse_mutations.map((m, i) => (
              <li key={i} className="text-dim">
                {m.kind} {JSON.stringify(m.payload)}
              </li>
            ))}
          </ul>
        </Disclose>
      </Card>
    </div>
  );
}

function FeasibilityCompare({ comparison }: { comparison: Comparison }) {
  const f = comparison.feasibility;
  return (
    <Card>
      <CardTitle>Against the deadline</CardTitle>
      <div className="space-y-2 text-sm">
        <Row
          label="Before"
          value={
            <>
              <Badge tone={f.before.verdict === "feasible" ? "green" : "red"}>
                {f.before.verdict.replace(/_/g, " ")}
              </Badge>{" "}
              <span className="text-dim">{days(f.before.margin_days, true)}</span>
            </>
          }
        />
        <Row
          label="After"
          value={
            <>
              <Badge tone={f.after.verdict === "feasible" ? "green" : "red"}>
                {f.after.verdict.replace(/_/g, " ")}
              </Badge>{" "}
              <span className="text-dim">{days(f.after.margin_days, true)}</span>
            </>
          }
        />
        {f.margin_delta_days !== null && (
          <Row
            label="Margin change"
            value={
              <span
                className={f.margin_delta_days >= 0 ? "text-green" : "text-red"}
              >
                {days(f.margin_delta_days, true)}
              </span>
            }
          />
        )}
        {f.verdict_changed && (
          <p className="text-xs text-amber">
            This changes the verdict, not just the margin.
          </p>
        )}
      </div>
    </Card>
  );
}

function FindingsCompare({ comparison }: { comparison: Comparison }) {
  const f = comparison.findings;
  return (
    <Card>
      <CardTitle>Findings</CardTitle>
      <div className="space-y-2 text-sm">
        <Row
          label="Count"
          value={`${f.before_count} → ${f.after_count}`}
        />
        {f.removed.length > 0 && (
          <div>
            <div className="text-xs text-green mb-1">
              {f.removed.length} resolved
            </div>
            <ul className="text-xs space-y-0.5">
              {f.removed.map((x, i) => (
                <li key={i} className="text-dim">
                  · {x.kind.replace(/_/g, " ")} on{" "}
                  <span className="font-mono">{x.root_cause}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {f.created.length > 0 && (
          <div>
            <div className="text-xs text-red mb-1">
              {f.created.length} newly appearing
            </div>
            <ul className="text-xs space-y-0.5">
              {f.created.map((x, i) => (
                <li key={i} className="text-dim">
                  · {x.kind.replace(/_/g, " ")} on{" "}
                  <span className="font-mono">{x.root_cause}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!f.removed.length && !f.created.length && (
          <p className="text-xs text-dim">
            The same problems, before and after.
          </p>
        )}
      </div>
    </Card>
  );
}

function CriticalPathCompare({ comparison }: { comparison: Comparison }) {
  const cp = comparison.critical_path;
  return (
    <Card>
      <CardTitle>Critical path</CardTitle>
      {cp.changed ? (
        <div className="space-y-2 text-xs">
          <div>
            <span className="text-dim">before </span>
            <span className="font-mono">{cp.before.join(" → ")}</span>
          </div>
          <div>
            <span className="text-dim">after&nbsp;&nbsp;</span>
            <span className="font-mono">{cp.after.join(" → ")}</span>
          </div>
          {cp.newly_critical.length > 0 && (
            <p className="text-amber">
              newly critical: {cp.newly_critical.join(", ")}
            </p>
          )}
          {cp.no_longer_critical.length > 0 && (
            <p className="text-green">
              no longer critical: {cp.no_longer_critical.join(", ")}
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-dim">
          Unchanged: <span className="font-mono">{cp.before.join(" → ")}</span>
        </p>
      )}
    </Card>
  );
}

function StructureCompare({ comparison }: { comparison: Comparison }) {
  const s = comparison.structure;
  const scope = Math.abs(s.total_effort_delta) > 1e-9;
  return (
    <Card className={scope ? "border-amber/40" : ""}>
      <CardTitle>Structure and scope</CardTitle>
      <div className="space-y-1.5 text-sm">
        <Row
          label="Total effort"
          value={
            <>
              {days(s.total_effort_before)} → {days(s.total_effort_after)}{" "}
              {scope && (
                <span className="text-amber">
                  ({days(s.total_effort_delta, true)})
                </span>
              )}
            </>
          }
        />
        {s.tasks_added.length > 0 && (
          <Row label="Tasks added" value={s.tasks_added.join(", ")} />
        )}
        {s.tasks_removed.length > 0 && (
          <Row label="Tasks removed" value={s.tasks_removed.join(", ")} />
        )}
        {s.dependencies_removed.length > 0 && (
          <Row
            label="Dependencies removed"
            value={s.dependencies_removed
              .map(([a, b]) => `${a}→${b}`)
              .join(", ")}
          />
        )}
        {s.dependencies_added.length > 0 && (
          <Row
            label="Dependencies added"
            value={s.dependencies_added.map(([a, b]) => `${a}→${b}`).join(", ")}
          />
        )}
        {scope && (
          <p className="text-xs text-amber pt-1">
            This changes how much work there is, not just how it is arranged.
            That is a scope decision.
          </p>
        )}
      </div>
    </Card>
  );
}

function Row({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-xs text-dim w-32 shrink-0">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  );
}
