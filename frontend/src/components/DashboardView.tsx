"use client";

import { ProjectState } from "@/lib/api";
import Card, { CardTitle } from "./Card";
import AccuracyPanel from "./AccuracyPanel";

function StatCard({
  value,
  label,
  detail,
  color = "text-foreground",
}: {
  value: string;
  label: string;
  detail?: string;
  color?: string;
}) {
  return (
    <Card className="flex-1 min-w-[200px]">
      <div className={`text-3xl font-bold tabular-nums ${color}`}>{value}</div>
      <div className="text-sm font-medium mt-1">{label}</div>
      {detail && <div className="text-xs text-dim mt-1">{detail}</div>}
    </Card>
  );
}

export default function DashboardView({
  state,
  onNavigate,
}: {
  state: ProjectState;
  onNavigate: (tab: string) => void;
}) {
  const slip = state.slip_days;
  const topBottleneck = state.bottlenecks[0];
  const criticalTasks = state.tasks.filter((t) => t.critical);
  const doneTasks = state.tasks.filter((t) => t.status === "done");
  const inProgressTasks = state.tasks.filter(
    (t) => t.status === "in_progress" || t.status === "in_review"
  );

  return (
    <div className="space-y-4">
      {/* KPI row */}
      <div className="flex gap-4 flex-wrap">
        <StatCard
          value={state.planned_end_date}
          label="Planned Finish"
          detail={`Day ${state.planned_end}`}
        />
        <StatCard
          value={state.projected_end_date}
          label="Projected Finish"
          detail={`Day ${state.projected_end}`}
          color={slip > 0 ? "text-red" : "text-green"}
        />
        <StatCard
          value={slip > 0 ? `+${slip} days` : "On track"}
          label="Schedule Slip"
          detail={
            slip > 0
              ? "Project is running behind schedule"
              : "Project is on track"
          }
          color={slip > 0 ? "text-red" : "text-green"}
        />
        <StatCard
          value={`${doneTasks.length}/${state.tasks.length}`}
          label="Tasks Complete"
          detail={`${inProgressTasks.length} in progress`}
          color="text-accent"
        />
      </div>

      <div className="flex gap-4 flex-wrap">
        {/* Critical path */}
        <Card className="flex-1 min-w-[400px]">
          <CardTitle>Critical Path</CardTitle>
          <div className="flex items-center gap-1 flex-wrap">
            {state.critical_path.map((tid, i) => {
              const task = state.tasks.find((t) => t.task_code === tid);
              return (
                <span key={tid} className="flex items-center gap-1">
                  {i > 0 && (
                    <span className="text-dim text-xs mx-1">&rarr;</span>
                  )}
                  <span
                    className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs ${
                      task?.status === "done"
                        ? "bg-green/10 text-green"
                        : task?.status === "in_review"
                        ? "bg-amber/10 text-amber"
                        : "bg-red/10 text-red"
                    }`}
                  >
                    <code className="font-mono text-[11px]">{tid}</code>
                    <span className="text-[11px]">{task?.name}</span>
                  </span>
                </span>
              );
            })}
          </div>
          <p className="text-xs text-dim mt-3">
            {criticalTasks.filter((t) => t.status !== "done").length} critical
            tasks remaining. Any delay on these tasks directly delays the
            project.
          </p>
        </Card>

        {/* Top bottleneck */}
        {topBottleneck && (
          <Card className="flex-1 min-w-[400px]">
            <CardTitle>Highest Priority Issue</CardTitle>
            <div className="flex items-center gap-2 mb-2">
              <span
                className={`text-xs px-2 py-0.5 rounded-full ${
                  topBottleneck.severity === "high"
                    ? "bg-red/15 text-red"
                    : "bg-amber/15 text-amber"
                }`}
              >
                {topBottleneck.severity}
              </span>
              <span className="text-xs bg-panel2 text-dim px-2 py-0.5 rounded-full">
                {topBottleneck.attributed_delay_days}d lost
              </span>
              <span className="text-xs bg-panel2 text-dim px-2 py-0.5 rounded-full">
                impact {topBottleneck.impact_score}
              </span>
            </div>
            <p className="text-sm">{topBottleneck.suggested_action}</p>
            <button
              onClick={() => onNavigate("bottlenecks")}
              className="text-xs text-accent mt-3 hover:underline"
            >
              View all {state.bottlenecks.length} bottlenecks &rarr;
            </button>
          </Card>
        )}
      </div>

      {/* Quick actions */}
      <div className="flex gap-4 flex-wrap">
        <Card className="flex-1 min-w-[250px]">
          <CardTitle>Quick Actions</CardTitle>
          <div className="space-y-2">
            <button
              onClick={() => onNavigate("why-late")}
              className="w-full text-left px-3 py-2 bg-panel2 rounded-md hover:bg-line/50 transition-colors text-sm"
            >
              &ldquo;Why are we late?&rdquo; &mdash; Get the full explanation
            </button>
            <button
              onClick={() => onNavigate("simulate")}
              className="w-full text-left px-3 py-2 bg-panel2 rounded-md hover:bg-line/50 transition-colors text-sm"
            >
              &ldquo;What if a task slips?&rdquo; &mdash; Simulate delay impact
            </button>
            <button
              onClick={() => onNavigate("simulate")}
              className="w-full text-left px-3 py-2 bg-panel2 rounded-md hover:bg-line/50 transition-colors text-sm"
            >
              &ldquo;What if a requirement changes?&rdquo; &mdash; Find
              affected work
            </button>
            <button
              onClick={() => onNavigate("graph")}
              className="w-full text-left px-3 py-2 bg-panel2 rounded-md hover:bg-line/50 transition-colors text-sm"
            >
              View dependency graph &mdash; See how work connects
            </button>
          </div>
        </Card>

        {/* Department summary */}
        <Card className="flex-1 min-w-[250px]">
          <CardTitle>Department Status</CardTitle>
          <div className="space-y-2">
            {Object.entries(state.departments).map(([dept, cap]) => {
              const deptTasks = state.tasks.filter(
                (t) => t.department === dept
              );
              const done = deptTasks.filter((t) => t.status === "done").length;
              const blocked = deptTasks.filter(
                (t) =>
                  t.status !== "done" &&
                  t.depends_on.some((d) => {
                    const dep = state.tasks.find(
                      (dt) => dt.task_code === d
                    );
                    return dep && dep.status !== "done";
                  })
              ).length;
              return (
                <div
                  key={dept}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="font-mono text-xs font-medium">{dept}</span>
                  <div className="flex gap-3 text-xs text-dim">
                    <span>
                      {done}/{deptTasks.length} done
                    </span>
                    {blocked > 0 && (
                      <span className="text-amber">{blocked} blocked</span>
                    )}
                    <span>cap {cap}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      {/* Engine accuracy verification */}
      <AccuracyPanel />
    </div>
  );
}
