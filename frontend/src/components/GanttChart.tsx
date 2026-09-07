"use client";

import { ProjectState, TaskRow } from "@/lib/api";

const STATUS_COLOR: Record<string, string> = {
  done: "#3fb950",
  in_progress: "#4c9aff",
  in_review: "#e3b341",
  not_started: "#39424f",
};

export default function GanttChart({ state }: { state: ProjectState }) {
  const maxDay = state.projected_end + 2;
  const todayDay = state.today_day;

  // Sort tasks by earliest start
  const tasks = [...state.tasks].sort((a, b) => a.es - b.es);

  return (
    <div className="overflow-x-auto">
      <div style={{ minWidth: 700 }}>
        {/* Day scale */}
        <div className="flex items-end mb-1 ml-[180px]">
          {Array.from({ length: Math.ceil(maxDay / 5) + 1 }, (_, i) => i * 5)
            .filter((d) => d <= maxDay)
            .map((d) => (
              <div
                key={d}
                className="text-[10px] text-dim"
                style={{
                  position: "absolute",
                  left: `${180 + (d / maxDay) * 520}px`,
                }}
              >
                {d}
              </div>
            ))}
        </div>

        <div className="relative" style={{ paddingTop: 16 }}>
          {/* Today marker */}
          <div
            className="absolute top-0 bottom-0 border-l border-accent/40 border-dashed"
            style={{
              left: `${180 + (todayDay / maxDay) * 520}px`,
            }}
          >
            <span className="absolute -top-0.5 -translate-x-1/2 text-[9px] text-accent bg-panel px-1 rounded">
              today
            </span>
          </div>

          {/* Planned end marker */}
          <div
            className="absolute top-0 bottom-0 border-l border-green/30 border-dashed"
            style={{
              left: `${180 + (state.planned_end / maxDay) * 520}px`,
            }}
          >
            <span className="absolute -top-0.5 -translate-x-1/2 text-[9px] text-green bg-panel px-1 rounded">
              plan
            </span>
          </div>

          {/* Projected end marker */}
          {state.projected_end !== state.planned_end && (
            <div
              className="absolute top-0 bottom-0 border-l border-red/30 border-dashed"
              style={{
                left: `${180 + (state.projected_end / maxDay) * 520}px`,
              }}
            >
              <span className="absolute -top-0.5 -translate-x-1/2 text-[9px] text-red bg-panel px-1 rounded">
                proj
              </span>
            </div>
          )}

          {/* Task bars */}
          {tasks.map((t) => (
            <div
              key={t.task_code}
              className="flex items-center mb-0.5"
              style={{ height: 22 }}
            >
              {/* Label */}
              <div className="w-[180px] shrink-0 flex items-center gap-1.5 pr-2">
                <code
                  className={`text-[10px] font-semibold ${
                    t.critical ? "text-red" : "text-accent"
                  }`}
                >
                  {t.task_code}
                </code>
                <span className="text-[10px] text-dim truncate">
                  {t.name}
                </span>
              </div>

              {/* Bar */}
              <div className="relative flex-1" style={{ width: 520 }}>
                {/* Slack area */}
                {t.slack > 0 && (
                  <div
                    className="absolute top-1 h-3 rounded-sm opacity-20"
                    style={{
                      left: `${(t.ef / maxDay) * 100}%`,
                      width: `${(t.slack / maxDay) * 100}%`,
                      background: "#8b98a5",
                    }}
                  />
                )}
                {/* Main bar */}
                <div
                  className="absolute top-1 h-3 rounded-sm transition-all"
                  style={{
                    left: `${(t.es / maxDay) * 100}%`,
                    width: `${((t.ef - t.es) / maxDay) * 100}%`,
                    background: STATUS_COLOR[t.status] || "#39424f",
                    border: t.critical
                      ? "1px solid #f85149"
                      : "1px solid transparent",
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex gap-4 mt-3 text-[10px] text-dim flex-wrap">
        {Object.entries(STATUS_COLOR).map(([status, color]) => (
          <span key={status} className="flex items-center gap-1">
            <span
              className="inline-block w-2.5 h-2 rounded-sm"
              style={{ background: color }}
            />
            {status.replace(/_/g, " ")}
          </span>
        ))}
        <span className="flex items-center gap-1">
          <span
            className="inline-block w-2.5 h-2 rounded-sm opacity-20"
            style={{ background: "#8b98a5" }}
          />
          slack
        </span>
      </div>
    </div>
  );
}
