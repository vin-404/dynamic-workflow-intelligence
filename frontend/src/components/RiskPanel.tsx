"use client";

/**
 * Capability 2 - predicted risk, with the factor decomposition visible.
 *
 * The score is never shown alone. Every task expands into its nine factors,
 * each with its value, its weight, the product, and a sentence explaining
 * what the number is reading. The weights are on screen and adjustable,
 * because "this task is riskier" means nothing if the weights are invisible.
 *
 * And it is labelled for what it is: a structural estimate, not a
 * probability. The three-point range is three deterministic schedule runs,
 * and the panel says so where the range appears.
 */

import { useState } from "react";
import { Analysis, RiskFactor, TaskRisk } from "@/lib/api";
import {
  Assumptions,
  Badge,
  Button,
  Card,
  CardTitle,
  Disclose,
  EmptyState,
  Field,
  Input,
  Stat,
  Worked,
  bandTone,
  days,
} from "./ui";

export default function RiskPanel({
  analysis,
  onReweight,
  busy,
}: {
  analysis: Analysis;
  onReweight: (weights: Record<string, number>) => void;
  busy: boolean;
}) {
  const risk = analysis.risk;
  const [weights, setWeights] = useState(risk.assumptions.weights);
  const [expanded, setExpanded] = useState<string | null>(
    risk.top[0]?.task_key ?? null,
  );

  if (risk.tasks.length === 0) {
    return (
      <EmptyState title="Nothing to score yet">
        Add some tasks and the risk panel will rank them by how exposed they
        are — with the arithmetic on show.
      </EmptyState>
    );
  }

  const tp = analysis.feasibility.three_point;

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>Feasibility</CardTitle>
        <p className="text-sm mb-3">{analysis.feasibility.statement}</p>
        {tp && (
          <>
            <div className="grid grid-cols-3 gap-2 mb-2">
              {(["optimistic", "likely", "pessimistic"] as const).map((band) => {
                const day = tp[`${band}_day` as const];
                const verdict = tp.verdicts[band];
                return (
                  <Stat
                    key={band}
                    label={band}
                    value={`day ${Math.round(day)}`}
                    sub={verdict === "feasible" ? "meets the deadline" : verdict.replace(/_/g, " ")}
                    tone={verdict === "feasible" ? "green" : "red"}
                  />
                );
              })}
            </div>
            <p className="text-xs text-dim">{tp.method}</p>
            <Disclose summary="Why there is no percentage here">
              <div className="text-xs space-y-1">
                <p className="text-foreground/90">{tp.monte_carlo.why}</p>
                <p className="text-dim">
                  It would report: {tp.monte_carlo.what_it_would_report}
                </p>
                <p className="text-amber">{tp.monte_carlo.why_not_faked}</p>
              </div>
            </Disclose>
          </>
        )}
      </Card>

      <Card>
        <CardTitle
          right={
            <span className="text-xs text-dim">
              {risk.band_counts.high} high · {risk.band_counts.moderate} moderate
              · {risk.band_counts.low} low
            </span>
          }
        >
          Per-task exposure
        </CardTitle>

        <p className="text-xs text-dim mb-3">{risk.assumptions.disclaimer}</p>

        <div className="space-y-1.5">
          {risk.tasks.map((task) => (
            <TaskRiskRow
              key={task.task_key}
              task={task}
              open={expanded === task.task_key}
              onToggle={() =>
                setExpanded(expanded === task.task_key ? null : task.task_key)
              }
            />
          ))}
        </div>

        <Assumptions
          disclaimer={risk.assumptions.what_would_make_this_a_probability}
          entries={[
            ["Score kind", risk.assumptions.score_kind.replace(/_/g, " ")],
            ["Formula", <code key="f">{risk.assumptions.formula}</code>],
            [
              "Duration spread",
              `${Math.round(risk.assumptions.duration_spread.relative_spread * 100)}% (${risk.assumptions.duration_spread.provenance})`,
            ],
            [
              "Tasks with a real estimate",
              risk.assumptions.duration_spread.tasks_with_three_point_estimate
                .length || "none",
            ],
            ["Rework modelled", risk.assumptions.rework_modelled ? "yes" : "no"],
            ["Monte Carlo run", risk.assumptions.monte_carlo_run ? "yes" : "no"],
            [
              "Factors unavailable",
              risk.assumptions.factors_unavailable.length
                ? risk.assumptions.factors_unavailable.join(", ")
                : "none",
            ],
          ]}
        />
        {risk.assumptions.factors_unavailable.length > 0 && (
          <p className="text-[11px] text-dim mt-2">
            {risk.assumptions.factors_unavailable_note}
          </p>
        )}
      </Card>

      <Card>
        <CardTitle>The weights are yours to move</CardTitle>
        <p className="text-xs text-dim mb-3">
          These are inputs, not findings. Change one and the ranking changes —
          which is the point of showing them instead of blending them away.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {Object.entries(weights).map(([name, value]) => (
            <Field key={name} label={name.replace(/_/g, " ")}>
              <Input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={value}
                onChange={(e) =>
                  setWeights({ ...weights, [name]: Number(e.target.value) })
                }
              />
            </Field>
          ))}
        </div>
        <div className="flex items-center gap-3 mt-3">
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => onReweight(weights)}
          >
            Re-rank with these weights
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setWeights(risk.assumptions.weights)}
          >
            Reset
          </Button>
          <span className="text-xs text-dim">
            total{" "}
            {Object.values(weights).reduce((a, b) => a + b, 0).toFixed(2)}
          </span>
        </div>
      </Card>
    </div>
  );
}

function TaskRiskRow({
  task,
  open,
  onToggle,
}: {
  task: TaskRisk;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border border-line/60 rounded-md bg-panel2/40">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-2.5 py-2 text-left"
      >
        <span className="font-mono text-xs text-dim w-12">{task.task_key}</span>
        <span className="flex-1 text-sm truncate">{task.task_name}</span>
        <span className="w-28 h-1.5 bg-line rounded overflow-hidden hidden sm:block">
          <span
            className="block h-full bg-accent"
            style={{ width: `${Math.min(task.score * 100, 100)}%` }}
          />
        </span>
        <span className="text-sm font-semibold w-12 text-right">
          {task.score.toFixed(2)}
        </span>
        <Badge tone={bandTone(task.band)}>{task.band}</Badge>
        <span className="text-dim text-xs w-3">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="px-2.5 pb-2.5">
          <p className="text-xs text-foreground/90 mb-2">{task.explanation}</p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-dim">
                <th className="font-medium py-1">Factor</th>
                <th className="font-medium py-1 w-14 text-right">Value</th>
                <th className="font-medium py-1 w-14 text-right">Weight</th>
                <th className="font-medium py-1 w-16 text-right">Contrib.</th>
                <th className="font-medium py-1">Reading</th>
              </tr>
            </thead>
            <tbody>
              {[...task.factors]
                .sort((a, b) => b.contribution - a.contribution)
                .map((factor) => (
                  <FactorRow key={factor.name} factor={factor} />
                ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-line">
                <td className="py-1 text-dim">total</td>
                <td />
                <td />
                <td className="py-1 text-right font-semibold">
                  {task.score.toFixed(3)}
                </td>
                <td className="py-1">
                  <Worked>{task.formula}</Worked>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

function FactorRow({ factor }: { factor: RiskFactor }) {
  return (
    <tr className={factor.available ? "" : "opacity-60"}>
      <td className="py-1 pr-2">
        {factor.name.replace(/_/g, " ")}
        {!factor.available && (
          <Badge tone="neutral" title="Could not be measured, so it contributes 0">
            n/a
          </Badge>
        )}
      </td>
      <td className="py-1 text-right font-mono">{factor.value.toFixed(2)}</td>
      <td className="py-1 text-right font-mono text-dim">
        {factor.weight.toFixed(2)}
      </td>
      <td className="py-1 text-right font-mono">
        {factor.contribution.toFixed(3)}
      </td>
      <td className="py-1 pl-2 text-dim">{factor.reason}</td>
    </tr>
  );
}
