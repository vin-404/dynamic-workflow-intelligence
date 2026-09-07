"use client";

/**
 * Capability 4 - propose and evaluate better workflows.
 *
 * The per-criterion table is the result. The blended total is shown as a
 * ranking aid and labelled as one, because a single number with invisible
 * weights is the thing this design is written against - so the weights are on
 * screen and adjustable.
 *
 * Refused candidates are shown, not hidden. A system that declines to delete
 * the safety certification and cites the reason on record is worth more than
 * one that reports a miraculous improvement.
 */

import { useState } from "react";
import {
  ApiError,
  OptimizeCandidate,
  OptimizeResponse,
  applyScenario,
  optimize,
} from "@/lib/api";
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Disclose,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Spinner,
  Stat,
  Worked,
  days,
} from "./ui";

export default function OptimizePanel({
  projectId,
  onApplied,
}: {
  projectId: string;
  onApplied: () => void;
}) {
  const [result, setResult] = useState<OptimizeResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [aggressive, setAggressive] = useState(false);
  const [maxCandidates, setMaxCandidates] = useState(40);
  const [maxSeconds, setMaxSeconds] = useState(5);
  const [weights, setWeights] = useState<Record<string, number> | null>(null);
  const [applying, setApplying] = useState<string | null>(null);

  async function run(withAggressive = aggressive) {
    setBusy(true);
    setError(null);
    try {
      const response = await optimize(projectId, {
        aggressive: withAggressive,
        budget: { max_candidates: maxCandidates, max_seconds: maxSeconds },
        objectives: weights ?? undefined,
      });
      setResult(response);
      setWeights(response.weights);
    } catch (e) {
      if (e instanceof ApiError) setError(e);
      else throw e;
    } finally {
      setBusy(false);
    }
  }

  async function apply(candidate: OptimizeCandidate) {
    if (!candidate.scenario_id) return;
    setApplying(candidate.scenario_id);
    setError(null);
    try {
      await applyScenario(
        candidate.scenario_id,
        `Applied from optimizer: ${candidate.name}`,
      );
      setResult(null);
      onApplied();
    } catch (e) {
      if (e instanceof ApiError) setError(e);
      else throw e;
    } finally {
      setApplying(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>Search for a better workflow</CardTitle>
        <p className="text-sm text-dim mb-3">
          Every candidate is a real list of typed changes, scored by the same
          engine that produced the numbers you have already seen. Nothing here
          involves a language model.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 items-end">
          <Field label="Max candidates" hint="the search is never unbounded">
            <Input
              type="number"
              min={1}
              max={500}
              value={maxCandidates}
              onChange={(e) => setMaxCandidates(Number(e.target.value))}
            />
          </Field>
          <Field label="Max seconds">
            <Input
              type="number"
              min={1}
              max={60}
              value={maxSeconds}
              onChange={(e) => setMaxSeconds(Number(e.target.value))}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm pb-1.5">
            <input
              type="checkbox"
              checked={aggressive}
              onChange={(e) => setAggressive(e.target.checked)}
            />
            <span>
              No limits
              <span className="block text-[11px] text-dim">
                also propose cutting scope
              </span>
            </span>
          </label>
          <Button variant="primary" onClick={() => run()} disabled={busy}>
            {result ? "Search again" : "Find better workflows"}
          </Button>
        </div>
      </Card>

      {busy && <Spinner label="Generating, gating and scoring candidates…" />}
      {error && <ErrorNote>{error.userMessage}</ErrorNote>}

      {result && (
        <>
          <Card>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-dim">
              <span>
                {result.generated} generated · {result.evaluated} evaluated ·{" "}
                {result.rejected.length} refused
              </span>
              <span>{result.elapsed_seconds}s</span>
              <span>
                {result.stopped_early ? (
                  <Badge tone="amber">{result.stop_reason}</Badge>
                ) : (
                  <Badge tone="green">search completed</Badge>
                )}
              </span>
            </div>
          </Card>

          {result.rejected.length > 0 && (
            <Card className="border-violet/40">
              <CardTitle>Refused — and this is the point</CardTitle>
              <p className="text-xs text-dim mb-3">
                These candidates were generated and then declined before they
                were scored, because they break something you declared
                inviolable.
              </p>
              <div className="space-y-2">
                {result.rejected.map((candidate, i) => (
                  <div
                    key={i}
                    className="border border-line rounded-md p-2.5 bg-panel2/40"
                  >
                    <div className="text-sm font-medium mb-1">
                      {candidate.name}
                    </div>
                    {candidate.constraint_violations.map((v, j) => (
                      <div key={j} className="text-xs">
                        <p className="text-foreground/90">{v.reason}</p>
                        {v.constraint && (
                          <p className="mt-1">
                            <Badge tone="violet">{v.constraint}</Badge>{" "}
                            <span className="text-dim">
                              {v.constraint_reason}
                            </span>
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {result.recommended ? (
            <>
              <Card className="border-accent/40">
                <CardTitle right={<Badge tone="accent">recommended</Badge>}>
                  {result.recommended.name}
                </CardTitle>
                <p className="text-sm mb-3">
                  {result.recommendation_reason}
                </p>
                <CandidateBody
                  candidate={result.recommended}
                  onApply={() => apply(result.recommended!)}
                  applying={applying === result.recommended.scenario_id}
                />
              </Card>

              {result.recommended_same_scope &&
                result.recommended_same_scope.name !==
                  result.recommended.name && (
                  <Card className="border-green/30">
                    <CardTitle right={<Badge tone="green">same scope</Badge>}>
                      {result.recommended_same_scope.name}
                    </CardTitle>
                    <p className="text-xs text-dim mb-3">
                      {result.recommended_same_scope_note}
                    </p>
                    <CandidateBody
                      candidate={result.recommended_same_scope}
                      onApply={() => apply(result.recommended_same_scope!)}
                      applying={
                        applying === result.recommended_same_scope.scenario_id
                      }
                    />
                  </Card>
                )}
            </>
          ) : (
            <EmptyState title="No candidate improved on what you have">
              {result.recommendation_reason}
            </EmptyState>
          )}

          {result.candidates.length > 1 && (
            <Card>
              <CardTitle
                right={
                  <span className="text-xs text-dim">
                    weights total {result.weights_total.toFixed(2)}
                  </span>
                }
              >
                Current vs every candidate
              </CardTitle>
              <ComparisonTable result={result} />
            </Card>
          )}

          <Card>
            <CardTitle>The weights that produced this ranking</CardTitle>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {Object.entries(weights ?? result.weights).map(([name, value]) => (
                <Field key={name} label={name.replace(/_/g, " ")}>
                  <Input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={value}
                    onChange={(e) =>
                      setWeights({
                        ...(weights ?? result.weights),
                        [name]: Number(e.target.value),
                      })
                    }
                  />
                </Field>
              ))}
            </div>
            <div className="flex gap-2 mt-3">
              <Button onClick={() => run()} disabled={busy}>
                Re-rank with these weights
              </Button>
              <Button
                variant="ghost"
                onClick={() => setWeights(result.weights)}
              >
                Reset
              </Button>
            </div>
            <p className="text-[11px] text-dim mt-2">{result.note}</p>
          </Card>
        </>
      )}
    </div>
  );
}

function CandidateBody({
  candidate,
  onApply,
  applying,
}: {
  candidate: OptimizeCandidate;
  onApply: () => void;
  applying: boolean;
}) {
  const completion = candidate.scores?.criteria.find(
    (c) => c.name === "expected_completion",
  );
  return (
    <div>
      <p className="text-sm text-foreground/90 mb-3">{candidate.rationale}</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <Stat
          label="Finish"
          value={
            completion
              ? `day ${Math.round(completion.before)} → ${Math.round(completion.after)}`
              : "—"
          }
          sub={completion ? days(completion.delta, true) : undefined}
          tone={
            completion && completion.delta < 0
              ? "green"
              : completion && completion.delta > 0
                ? "red"
                : undefined
          }
        />
        <Stat
          label="Ranking total"
          value={candidate.scores?.total.toFixed(3) ?? "—"}
          sub="a ranking aid, not a measurement"
        />
        <Stat
          label="Scope"
          value={candidate.scope_change ? "changes" : "unchanged"}
          sub={
            candidate.scope_change
              ? `${days(candidate.effort_delta_days, true)} of work`
              : "same work, arranged differently"
          }
          tone={candidate.scope_change ? "amber" : "green"}
        />
        <Stat
          label="Changes"
          value={candidate.mutations.length}
          sub={candidate.generator.replace(/_/g, " ")}
        />
      </div>

      {candidate.scope_change_note && (
        <p className="text-xs text-amber mb-3">{candidate.scope_change_note}</p>
      )}

      <div className="mb-3">
        <div className="text-xs text-dim mb-1">The exact changes:</div>
        <ol className="text-xs space-y-0.5">
          {candidate.mutation_summary.map((m, i) => (
            <li key={i} className="font-mono text-foreground/80">
              {i + 1}. {m}
            </li>
          ))}
        </ol>
      </div>

      {candidate.scores && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[560px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-dim">
                <th className="font-medium py-1">Criterion</th>
                <th className="font-medium py-1 text-right w-16">Before</th>
                <th className="font-medium py-1 text-right w-16">After</th>
                <th className="font-medium py-1 text-right w-16">Delta</th>
                <th className="font-medium py-1 text-right w-14">Weight</th>
                <th className="font-medium py-1 text-right w-16">Contrib.</th>
                <th className="font-medium py-1">Unit</th>
              </tr>
            </thead>
            <tbody>
              {candidate.scores.criteria.map((c) => (
                <tr key={c.name} className="border-t border-line/60">
                  <td className="py-1">{c.name.replace(/_/g, " ")}</td>
                  <td className="py-1 text-right font-mono">
                    {c.before.toFixed(2)}
                  </td>
                  <td className="py-1 text-right font-mono">
                    {c.after.toFixed(2)}
                  </td>
                  <td
                    className={`py-1 text-right font-mono ${
                      c.improvement > 0
                        ? "text-green"
                        : c.improvement < 0
                          ? "text-red"
                          : "text-dim"
                    }`}
                  >
                    {c.delta > 0 ? "+" : ""}
                    {c.delta.toFixed(2)}
                  </td>
                  <td className="py-1 text-right font-mono text-dim">
                    {c.weight.toFixed(2)}
                  </td>
                  <td className="py-1 text-right font-mono">
                    {c.contribution >= 0 ? "+" : ""}
                    {c.contribution.toFixed(3)}
                  </td>
                  <td className="py-1 text-dim">{c.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[11px] text-dim mt-1.5">
            <Worked>{candidate.scores.formula}</Worked>{" "}
            {candidate.scores.note}
          </p>
        </div>
      )}

      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-line">
        <Button variant="primary" onClick={onApply} disabled={applying}>
          {applying ? "Applying…" : "Apply this"}
        </Button>
        <span className="text-xs text-dim">
          Creates a new version. The current one stays in history, unchanged.
        </span>
      </div>
    </div>
  );
}

function ComparisonTable({ result }: { result: OptimizeResponse }) {
  const criteria = result.candidates[0]?.scores?.criteria ?? [];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs min-w-[720px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-dim">
            <th className="font-medium py-1.5">Option</th>
            {criteria.map((c) => (
              <th key={c.name} className="font-medium py-1.5 text-right">
                {c.name.replace(/_/g, " ")}
                <span className="block font-normal normal-case text-[9px]">
                  {c.better} is better
                </span>
              </th>
            ))}
            <th className="font-medium py-1.5 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-line bg-panel2/40">
            <td className="py-1.5 font-medium">Current workflow</td>
            {criteria.map((c) => (
              <td key={c.name} className="py-1.5 text-right font-mono">
                {c.before.toFixed(2)}
              </td>
            ))}
            <td className="py-1.5 text-right font-mono text-dim">—</td>
          </tr>
          {result.candidates.map((candidate) => (
            <tr key={candidate.name} className="border-t border-line/60">
              <td className="py-1.5">
                {candidate.name}
                {candidate.scope_change && (
                  <Badge tone="amber" title="Changes how much work there is">
                    scope
                  </Badge>
                )}
              </td>
              {candidate.scores?.criteria.map((c) => (
                <td
                  key={c.name}
                  className={`py-1.5 text-right font-mono ${
                    c.improvement > 0
                      ? "text-green"
                      : c.improvement < 0
                        ? "text-red"
                        : ""
                  }`}
                >
                  {c.after.toFixed(2)}
                </td>
              ))}
              <td className="py-1.5 text-right font-mono font-semibold">
                {candidate.scores?.total.toFixed(3)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Disclose summary="Why the total is not the answer">
        <p className="text-xs text-dim">
          {result.candidates[0]?.scores?.note} Read across a row, not down the
          Total column: a candidate can win on completion and lose on resource
          overload, and which of those you care about is not something the
          optimizer can know.
        </p>
      </Disclose>
    </div>
  );
}
