"use client";

import { useState } from "react";
import {
  ProjectState,
  DelayResult,
  RequirementResult,
  simulateDelay,
  simulateRequirement,
} from "@/lib/api";
import Card, { CardTitle } from "./Card";

export default function SimulationPanel({ state }: { state: ProjectState }) {
  return (
    <div className="space-y-4">
      <div className="p-3 bg-accent/5 border border-accent/20 rounded-md text-[13px] text-accent/80">
        <strong>Change Simulator</strong> — these simulations are read-only.
        They compute what <em>would</em> happen without modifying the actual
        project data. Every number is derived from a deterministic formula you
        can verify by hand.
      </div>
      <div className="flex gap-4 flex-wrap">
        <div className="flex-1 min-w-[400px]">
          <DelaySim state={state} />
        </div>
        <div className="flex-1 min-w-[400px]">
          <RequirementSim state={state} />
        </div>
      </div>
    </div>
  );
}

function DelaySim({ state }: { state: ProjectState }) {
  const [taskCode, setTaskCode] = useState(
    state.tasks.find((t) => t.critical && t.status !== "done")?.task_code ||
      state.tasks[0]?.task_code ||
      ""
  );
  const [days, setDays] = useState(5);
  const [result, setResult] = useState<DelayResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    try {
      const res = await simulateDelay(state.project_id, taskCode, days);
      setResult(res);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardTitle>What if a task slips?</CardTitle>
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <select
          value={taskCode}
          onChange={(e) => setTaskCode(e.target.value)}
          className="bg-panel2 border border-line text-foreground px-3 py-2 rounded-md text-sm"
        >
          {state.tasks.map((t) => (
            <option key={t.task_code} value={t.task_code}>
              {t.task_code} — {t.name}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={1}
          max={30}
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="bg-panel2 border border-line text-foreground px-3 py-2 rounded-md text-sm w-20"
        />
        <span className="text-sm text-dim">days</span>
        <button
          onClick={run}
          disabled={loading}
          className="px-4 py-2 bg-accent text-background rounded-md text-sm font-semibold hover:opacity-90 disabled:opacity-50"
        >
          {loading ? "Simulating..." : "Propagate"}
        </button>
      </div>

      {!result && (
        <p className="text-xs text-dim">
          Try it: Select T03 (budget approval) + 5 days to see how the
          critical path delay propagates to 7 downstream tasks. Or select T12
          (registration site) + 1 day to see the delay absorbed by slack.
        </p>
      )}

      {result && (
        <div>
          <div
            className={`border-l-[3px] p-4 bg-panel2 rounded-r-md mb-3 ${
              result.project_end_delta > 0 ? "border-red" : "border-green"
            }`}
          >
            <div className="flex items-baseline gap-3 flex-wrap">
              <strong className="text-sm">
                Project finish {result.end_date_before} &rarr;{" "}
                {result.end_date_after}
              </strong>
              <span
                className={`text-sm font-bold ${
                  result.project_end_delta > 0 ? "text-red" : "text-green"
                }`}
              >
                {result.project_end_delta > 0 ? "+" : ""}
                {result.project_end_delta}d
              </span>
            </div>

            <div className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-[12.5px] mt-3">
              <span className="text-dim">Tasks moved</span>
              <span>{result.moved_detail.length}</span>
              <span className="text-dim">Critical path</span>
              <span>
                {result.critical_path_changed ? (
                  <>
                    CHANGED — newly critical:{" "}
                    {result.newly_critical.join(", ") || "—"}
                  </>
                ) : (
                  "Unchanged"
                )}
              </span>
              <span className="text-dim">Notify</span>
              <span className="font-medium">
                {result.notify.join(", ") || "—"}
              </span>
            </div>
          </div>

          {result.moved_detail.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-line">
                    <th className="text-left text-dim font-medium px-2 py-1.5 text-[11px] uppercase tracking-wider">
                      ID
                    </th>
                    <th className="text-left text-dim font-medium px-2 py-1.5 text-[11px] uppercase tracking-wider">
                      Task
                    </th>
                    <th className="text-left text-dim font-medium px-2 py-1.5 text-[11px] uppercase tracking-wider">
                      Dept
                    </th>
                    <th className="text-left text-dim font-medium px-2 py-1.5 text-[11px] uppercase tracking-wider">
                      Owner
                    </th>
                    <th className="text-left text-dim font-medium px-2 py-1.5 text-[11px] uppercase tracking-wider">
                      Start Moves
                    </th>
                    <th className="text-right text-dim font-medium px-2 py-1.5 text-[11px] uppercase tracking-wider">
                      Delta
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {result.moved_detail.map((m) => (
                    <tr key={m.task_code} className="border-b border-line/50">
                      <td className="px-2 py-1.5">
                        <code className="text-accent">{m.task_code}</code>
                      </td>
                      <td className="px-2 py-1.5">{m.name}</td>
                      <td className="px-2 py-1.5">{m.department}</td>
                      <td className="px-2 py-1.5">{m.owner}</td>
                      <td className="px-2 py-1.5 tabular-nums">
                        {m.from_date} &rarr;{" "}
                        <strong>{m.to_date}</strong>
                      </td>
                      <td className="px-2 py-1.5 text-right text-red tabular-nums font-medium">
                        +{m.delta}d
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-dim mt-2">
              Absorbed entirely by slack — nothing downstream moves.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function RequirementSim({ state }: { state: ProjectState }) {
  const [reqCode, setReqCode] = useState(
    state.requirements[0]?.req_code || ""
  );
  const [result, setResult] = useState<RequirementResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    try {
      const res = await simulateRequirement(state.project_id, reqCode);
      setResult(res);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardTitle>What if a requirement changes?</CardTitle>
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <select
          value={reqCode}
          onChange={(e) => setReqCode(e.target.value)}
          className="bg-panel2 border border-line text-foreground px-3 py-2 rounded-md text-sm flex-1 min-w-[200px]"
        >
          {state.requirements.map((r) => (
            <option key={r.req_code} value={r.req_code}>
              {r.req_code} — {r.text}
            </option>
          ))}
        </select>
        <button
          onClick={run}
          disabled={loading}
          className="px-4 py-2 bg-violet text-background rounded-md text-sm font-semibold hover:opacity-90 disabled:opacity-50"
        >
          {loading ? "Analyzing..." : "Propagate"}
        </button>
      </div>

      {!result && (
        <p className="text-xs text-dim">
          Try it: Select R2 (venue layout spec) to see which tasks consumed
          this artifact directly (must redo) vs those merely downstream (must
          re-check). This distinction is impossible without a dependency model.
        </p>
      )}

      {result && (
        <div>
          <div className="border-l-[3px] border-red p-4 bg-panel2 rounded-r-md mb-3">
            <div className="flex items-baseline gap-2 flex-wrap">
              <strong className="text-sm">
                {result.req_code} v{result.from_version} &rarr; v
                {result.to_version}
              </strong>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-red/15 text-red">
                {result.must_redo.length} must redo
              </span>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber/15 text-amber">
                {result.must_recheck.length} re-check
              </span>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-panel text-dim">
                {result.departments_hit.length} departments
              </span>
              {result.wasted_days > 0 && (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-red/15 text-red">
                  {result.wasted_days}d of completed work invalidated
                </span>
              )}
            </div>

            <div className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-[12.5px] mt-3">
              <span className="text-dim">Was</span>
              <span>{result.text}</span>
              <span className="text-dim">Consumed by</span>
              <span>
                {result.directly_consumed_by.map((t) => (
                  <code
                    key={t}
                    className="bg-background px-1.5 py-0.5 rounded text-xs text-accent mr-1"
                  >
                    {t}
                  </code>
                ))}
              </span>
              <span className="text-dim">Departments</span>
              <span className="font-medium">
                {result.departments_hit.join(", ")}
              </span>
            </div>
          </div>

          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-line">
                <th className="text-left text-dim font-medium px-2 py-1.5 text-[11px] uppercase tracking-wider">
                  ID
                </th>
                <th className="text-left text-dim font-medium px-2 py-1.5 text-[11px] uppercase tracking-wider">
                  Task
                </th>
                <th className="text-left text-dim font-medium px-2 py-1.5 text-[11px] uppercase tracking-wider">
                  Dept
                </th>
                <th className="text-left text-dim font-medium px-2 py-1.5 text-[11px] uppercase tracking-wider">
                  Owner
                </th>
                <th className="text-left text-dim font-medium px-2 py-1.5 text-[11px] uppercase tracking-wider">
                  Status
                </th>
                <th className="text-left text-dim font-medium px-2 py-1.5 text-[11px] uppercase tracking-wider">
                  Impact
                </th>
              </tr>
            </thead>
            <tbody>
              {result.must_redo.map((t) => (
                <tr key={t.task_code} className="border-b border-line/50">
                  <td className="px-2 py-1.5">
                    <code className="text-accent">{t.task_code}</code>
                  </td>
                  <td className="px-2 py-1.5">{t.name}</td>
                  <td className="px-2 py-1.5">{t.department}</td>
                  <td className="px-2 py-1.5">{t.owner}</td>
                  <td className="px-2 py-1.5">
                    {t.status.replace(/_/g, " ")}
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-red/15 text-red">
                      must redo
                    </span>
                  </td>
                </tr>
              ))}
              {result.must_recheck.map((t) => (
                <tr key={t.task_code} className="border-b border-line/50">
                  <td className="px-2 py-1.5">
                    <code className="text-accent">{t.task_code}</code>
                  </td>
                  <td className="px-2 py-1.5">{t.name}</td>
                  <td className="px-2 py-1.5">{t.department}</td>
                  <td className="px-2 py-1.5">{t.owner}</td>
                  <td className="px-2 py-1.5">
                    {t.status.replace(/_/g, " ")}
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber/15 text-amber">
                      re-check
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="text-xs text-dim mt-3 leading-relaxed">
            This is what a task board cannot do. A board tracks dates; a changed
            spec invalidates finished work, and only a model that knows which
            task consumed which artifact can tell you which work is affected.
          </p>
        </div>
      )}
    </Card>
  );
}
