"use client";

import { ProjectState } from "@/lib/api";
import Card, { CardTitle } from "./Card";

function statusColor(status: string): string {
  switch (status) {
    case "done":
      return "text-green";
    case "in_progress":
      return "text-accent";
    case "in_review":
      return "text-amber";
    default:
      return "text-dim";
  }
}

export default function TasksView({ state }: { state: ProjectState }) {
  return (
    <Card>
      <CardTitle>
        All Tasks — Critical path: {state.critical_path.join(" \u2192 ")}
      </CardTitle>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-line">
              <th className="text-left text-dim font-medium px-2 py-2 text-[11px] uppercase tracking-wider">
                ID
              </th>
              <th className="text-left text-dim font-medium px-2 py-2 text-[11px] uppercase tracking-wider">
                Task
              </th>
              <th className="text-left text-dim font-medium px-2 py-2 text-[11px] uppercase tracking-wider">
                Dept
              </th>
              <th className="text-left text-dim font-medium px-2 py-2 text-[11px] uppercase tracking-wider">
                Owner
              </th>
              <th className="text-left text-dim font-medium px-2 py-2 text-[11px] uppercase tracking-wider">
                Status
              </th>
              <th className="text-left text-dim font-medium px-2 py-2 text-[11px] uppercase tracking-wider">
                Start
              </th>
              <th className="text-left text-dim font-medium px-2 py-2 text-[11px] uppercase tracking-wider">
                End
              </th>
              <th className="text-right text-dim font-medium px-2 py-2 text-[11px] uppercase tracking-wider">
                Duration
              </th>
              <th className="text-right text-dim font-medium px-2 py-2 text-[11px] uppercase tracking-wider">
                Slack
              </th>
              <th className="text-left text-dim font-medium px-2 py-2 text-[11px] uppercase tracking-wider">
                Dependencies
              </th>
            </tr>
          </thead>
          <tbody>
            {state.tasks.map((t) => (
              <tr
                key={t.task_code}
                className={`border-b border-line/50 ${
                  t.critical ? "bg-red/[0.03]" : ""
                }`}
              >
                <td className="px-2 py-2">
                  <code
                    className={`text-xs ${
                      t.critical ? "text-red font-semibold" : "text-accent"
                    }`}
                  >
                    {t.task_code}
                  </code>
                </td>
                <td className="px-2 py-2">{t.name}</td>
                <td className="px-2 py-2 font-mono text-xs">{t.department}</td>
                <td className="px-2 py-2">{t.owner}</td>
                <td className={`px-2 py-2 ${statusColor(t.status)}`}>
                  {t.status.replace(/_/g, " ")}
                </td>
                <td className="px-2 py-2 tabular-nums">{t.start_date}</td>
                <td className="px-2 py-2 tabular-nums">{t.end_date}</td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {t.planned_duration}d
                </td>
                <td
                  className={`px-2 py-2 text-right tabular-nums font-medium ${
                    t.critical ? "text-red" : ""
                  }`}
                >
                  {t.critical ? "0 (critical)" : `${t.slack}d`}
                </td>
                <td className="px-2 py-2">
                  {t.depends_on.map((d) => (
                    <code
                      key={d}
                      className="bg-panel2 px-1 py-0.5 rounded text-[11px] text-dim mr-1"
                    >
                      {d}
                    </code>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
