"use client";

import { ProjectState } from "@/lib/api";

function KPI({ value, label, className = "" }: { value: string; label: string; className?: string }) {
  return (
    <div className="text-right">
      <div className={`text-xl font-bold tabular-nums ${className}`}>{value}</div>
      <div className="text-[11px] text-dim uppercase tracking-wider">{label}</div>
    </div>
  );
}

export default function Header({ state }: { state: ProjectState }) {
  const slip = state.slip_days;
  const slipText = slip > 0 ? `+${slip}d` : slip === 0 ? "On track" : `${slip}d`;

  return (
    <header className="px-6 py-4 border-b border-line flex items-center gap-6 flex-wrap">
      <div>
        <h1 className="text-base font-semibold tracking-wide">
          Workflow Intelligence
        </h1>
        <p className="text-dim text-xs">
          {state.project_name} — {state.tasks.length} tasks — day{" "}
          {state.today_day} of the project
        </p>
      </div>
      <div className="flex gap-6 ml-auto flex-wrap">
        <KPI value={state.planned_end_date} label="Planned Finish" />
        <KPI value={state.projected_end_date} label="Projected Finish" />
        <KPI
          value={slipText}
          label="Schedule Slip"
          className={slip > 0 ? "text-red" : "text-green"}
        />
        <KPI
          value={String(state.bottlenecks.length)}
          label="Bottlenecks"
          className={state.bottlenecks.length > 0 ? "text-amber" : "text-green"}
        />
      </div>
    </header>
  );
}
