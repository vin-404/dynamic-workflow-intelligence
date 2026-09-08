"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Edge,
  Handle,
  MarkerType,
  Node,
  NodeProps,
  Position,
  ReactFlow,
  useViewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { cn } from "@/lib/utils";
import { Analysis } from "@/lib/api";
import { severityText } from "@/lib/severity";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type LiveOverlay = {
  statuses: Record<string, string>;
  criticalPath: string[];
  simDay: number;
  projectedEndDay: number;
  flashTasks?: Record<string, string>;
};

const DAY_W_DEFAULT = 28;
const DAY_W_MIN = 3;
const DAY_W_MAX = 44;

const RIGHT_PAD = 46;
const LANE_H = 32;
const BAR_H = 20;
const AXIS_H = 28;
const GUTTER = 168;

const NICE_TICKS = [1, 2, 5, 7, 10, 14, 20, 30, 60, 90, 180, 365];
const TICK_LABEL_W = 78;

function tickEvery(dayWidth: number): number {
  return NICE_TICKS.find((n) => n * dayWidth >= TICK_LABEL_W) ?? 365;
}

function useMeasuredWidth<T extends HTMLElement>(): [
  React.RefObject<T | null>,
  number,
] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;

    if (!element) {
      return;
    }

    setWidth(element.clientWidth);

    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;

      setWidth((previous) =>
        Math.abs(previous - next) < 1 ? previous : next,
      );
    });

    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

const STATUS_LABEL: Record<string, string> = {
  done: "Done",
  in_progress: "In progress",
  in_review: "In review",
  blocked: "Blocked",
  not_started: "Not started",
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function dateOfDay(projectStart: string, day: number): string {
  const base = Date.parse(`${projectStart}T00:00:00Z`);

  if (Number.isNaN(base)) {
    return `d${day}`;
  }

  const date = new Date(base + day * 86_400_000);

  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

type Lane = {
  key: string;
  label: string;
  capacity: number | null;
  taskCount: number;
  bookedDays: number;
  criticalCount: number;
  firstDay: number;
  rows: number;
  rowOffset: number;
};

const UNASSIGNED = " unassigned";

type BarData = {
  taskKey: string;
  name: string;
  assignees: string;
  status: string;
  critical: boolean;
  slack: number;
  duration: number;
  startDate: string;
  endDate: string;
  es: number;
  lf: number;
  risk: number | null;
  durationWidth: number;
  slackWidth: number;
  flashSeverity: string | null;
};

function barTone(data: BarData): string {
  if (data.status === "blocked") {
    return "border-severity-high text-foreground";
  }

  if (data.critical) {
    return "border-accent text-foreground";
  }

  if (data.status === "done") {
    return "border-line text-dim";
  }

  return "border-line text-foreground";
}

function barFill(data: BarData): string {
  if (data.status === "blocked") {
    return "bg-severity-high/15";
  }

  if (data.critical) {
    return "bg-accent/15";
  }

  if (data.status === "done") {
    return "bg-muted";
  }

  return "bg-panel2";
}

function TaskBar({ data }: NodeProps) {
  const task = data as BarData;

  const wide = task.durationWidth >= 74;
  const narrow = task.durationWidth < 36;

  return (
    <div
      className="relative"
      style={{
        width: task.durationWidth + task.slackWidth,
        height: BAR_H,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent"
        style={{ left: -3 }}
      />

      {task.slackWidth > 0 && (
        <div
          className="absolute bottom-0 h-[5px] rounded-r-[2px] bg-line"
          style={{
            left: task.durationWidth,
            width: task.slackWidth,
          }}
        />
      )}

      {task.flashSeverity && (
        <div
          className={cn(
            "pointer-events-none absolute -inset-[3px] rounded-[6px] border-2 border-current",
            severityText(task.flashSeverity),
          )}
          style={{
            width: task.durationWidth + 6,
          }}
        />
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "absolute inset-y-0 left-0 overflow-hidden rounded-[3px] border bg-panel",
              barTone(task),
            )}
            style={{
              width: task.durationWidth,
            }}
          >
            <div
              className={cn(
                "flex h-full items-center gap-1 px-1",
                barFill(task),
              )}
            >
              {!narrow && (
                <span className="shrink-0 font-mono text-[10px] leading-none opacity-80">
                  {task.taskKey}
                </span>
              )}

              {wide && (
                <span className="truncate text-[10px] leading-none">
                  {task.name}
                </span>
              )}
            </div>
          </div>
        </TooltipTrigger>

        <TooltipContent side="top" className="max-w-xs">
          <span className="flex flex-col gap-0.5 text-left">
            <span className="font-mono">
              {task.taskKey} {task.name}
            </span>

            <span className="opacity-80">
              {task.startDate} to {task.endDate} · {task.duration}d ·{" "}
              {STATUS_LABEL[task.status] ?? task.status}
            </span>

            <span className="opacity-80">
              {task.critical
                ? "zero slack, on the critical path"
                : `${task.slack}d slack · day ${task.es} at the earliest, day ${task.lf} at the latest`}
            </span>

            <span className="opacity-80">
              {task.assignees || "unassigned"}
            </span>

            {task.risk !== null && (
              <span className="opacity-80">
                risk {task.risk.toFixed(2)}
              </span>
            )}
          </span>
        </TooltipContent>
      </Tooltip>

      {narrow && (
        <span
          className="pointer-events-none absolute top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[10px] text-dim"
          style={{
            left: task.durationWidth + task.slackWidth + 4,
          }}
        >
          {task.taskKey}
        </span>
      )}

      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent"
        style={{
          left: task.durationWidth,
          right: "auto",
        }}
      />
    </div>
  );
}

const nodeTypes = {
  bar: TaskBar,
};

function Chrome({
  lanes,
  horizon,
  todayDay,
  markerLabel,
  projectStart,
  dayWidth,
  tickDays,
}: {
  lanes: Lane[];
  horizon: number;
  todayDay: number;
  markerLabel: string;
  projectStart: string;
  dayWidth: number;
  tickDays: number;
}) {
  const { x, y, zoom } = useViewport();

  const ticks: number[] = [];

  for (let day = 0; day <= horizon; day += tickDays) {
    ticks.push(day);
  }

  const dayToScreen = (day: number) =>
    x + (GUTTER + day * dayWidth) * zoom;

  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={{ zIndex: 5 }}
    >
      <div
        className="absolute inset-x-0 top-0 overflow-hidden border-b border-line bg-panel"
        style={{ height: AXIS_H }}
      >
        {ticks.map((day) => (
          <span
            key={day}
            className="absolute top-1 whitespace-nowrap border-l border-line pt-0.5 pl-1 text-[10px] leading-tight text-dim"
            style={{
              left: dayToScreen(day),
              height: AXIS_H - 8,
            }}
          >
            {dateOfDay(projectStart, day)}

            <span className="ml-1 font-mono opacity-70">
              d{day}
            </span>
          </span>
        ))}
      </div>

      <div
        className="absolute border-l border-dashed border-foreground/45"
        style={{
          left: dayToScreen(todayDay),
          top: AXIS_H,
          bottom: 0,
        }}
      >
        <span className="absolute bottom-0.5 left-1 whitespace-nowrap font-mono text-[10px] text-foreground/70">
          {markerLabel} d{Math.round(todayDay * 10) / 10}
        </span>
      </div>

      <div
        className="absolute bottom-0 left-0 overflow-hidden border-r border-line bg-panel"
        style={{
          width: GUTTER,
          top: AXIS_H,
        }}
      >
        {lanes.map((lane) => (
          <div
            key={lane.key}
            className="absolute left-0 flex w-full flex-col justify-center border-b border-line/50 pr-2 pl-3"
            style={{
              top: y + lane.rowOffset * LANE_H * zoom,
              height: lane.rows * LANE_H * zoom,
            }}
          >
            <span className="truncate text-[11px] leading-tight">
              {lane.label}
            </span>

            <span className="truncate font-mono text-[10px] leading-tight text-dim">
              {lane.taskCount} · {lane.bookedDays}d
              {lane.capacity !== null && lane.capacity !== 1
                ? ` · cap ${lane.capacity}`
                : ""}
              {lane.criticalCount > 0
                ? ` · ${lane.criticalCount} zero-slack`
                : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DependencyGraph({
  analysis: stored,
  live,
}: {
  analysis: Analysis;
  live?: LiveOverlay;
}) {
  const [boxRef, boxWidth] =
    useMeasuredWidth<HTMLDivElement>();

  const analysis = useMemo<Analysis>(() => {
    if (!live) {
      return stored;
    }

    const criticalPath = new Set(live.criticalPath);

    return {
      ...stored,
      today_day: live.simDay,
      projected_end: live.projectedEndDay,
      critical_path: live.criticalPath,

      tasks: stored.tasks.map((task) => ({
        ...task,
        status: live.statuses[task.key] ?? task.status,
        critical: criticalPath.has(task.key),
      })),
    };
  }, [stored, live]);

  const horizon = useMemo(
    () =>
      Math.max(
        1,
        ...analysis.tasks.map((task) =>
          Math.ceil(task.lf),
        ),
        Math.ceil(stored.projected_end),
        Math.ceil(analysis.projected_end),
        Math.ceil(analysis.today_day),
      ),
    [analysis, stored.projected_end],
  );

  const dayWidth = useMemo(() => {
    if (!boxWidth) {
      return DAY_W_DEFAULT;
    }

    const usable = Math.max(
      120,
      boxWidth - GUTTER - RIGHT_PAD,
    );

    return Math.min(
      DAY_W_MAX,
      Math.max(DAY_W_MIN, usable / horizon),
    );
  }, [boxWidth, horizon]);

  const tickDays = useMemo(
    () => tickEvery(dayWidth),
    [dayWidth],
  );

  const { nodes, edges, lanes, rows } = useMemo(() => {
    const riskByTask = new Map(
      analysis.risk.tasks.map((task) => [
        task.task_key,
        task.score,
      ]),
    );

    const resourceByLabel = new Map(
      analysis.resources.map((resource) => [
        resource.label,
        resource,
      ]),
    );

    const byLane = new Map<
      string,
      {
        label: string;
        tasks: Analysis["tasks"];
      }
    >();

    for (const task of analysis.tasks) {
      const labels = task.assignees.length
        ? task.assignees
        : [UNASSIGNED];

      for (const label of labels) {
        const bucket =
          byLane.get(label) ?? {
            label,
            tasks: [],
          };

        bucket.tasks.push(task);
        byLane.set(label, bucket);
      }
    }

    const subRow = new Map<string, number>();
    const rowsOf = new Map<string, number>();

    for (const [key, bucket] of byLane) {
      const ends: number[] = [];

      for (const task of [...bucket.tasks].sort(
        (a, b) => a.es - b.es,
      )) {
        let row = ends.findIndex(
          (end) => end <= task.es,
        );

        if (row === -1) {
          row = ends.length;
          ends.push(task.ef);
        } else {
          ends[row] = task.ef;
        }

        subRow.set(
          `${key}|${task.key}`,
          row,
        );
      }

      rowsOf.set(
        key,
        Math.max(1, ends.length),
      );
    }

    const laneList: Lane[] = [...byLane.entries()]
      .map(([key, bucket]) => ({
        key,
        label:
          key === UNASSIGNED
            ? "unassigned"
            : bucket.label,
        capacity:
          resourceByLabel.get(key)?.capacity ?? null,
        taskCount: bucket.tasks.length,
        bookedDays:
          Math.round(
            bucket.tasks.reduce(
              (total, task) =>
                total + task.duration,
              0,
            ) * 10,
          ) / 10,
        criticalCount:
          bucket.tasks.filter(
            (task) => task.critical,
          ).length,
        firstDay: Math.min(
          ...bucket.tasks.map(
            (task) => task.es,
          ),
        ),
        rows: rowsOf.get(key) ?? 1,
        rowOffset: 0,
      }))
      .sort((a, b) => {
        if (a.key === UNASSIGNED) {
          return 1;
        }

        if (b.key === UNASSIGNED) {
          return -1;
        }

        return (
          a.firstDay - b.firstDay ||
          a.label.localeCompare(b.label)
        );
      });

    let cursor = 0;

    for (const lane of laneList) {
      lane.rowOffset = cursor;
      cursor += lane.rows;
    }

    const totalRows = cursor;

    const laneOffset = new Map(
      laneList.map((lane) => [
        lane.key,
        lane.rowOffset,
      ]),
    );

    const anchorOf = new Map<string, string>();
    const rawNodes: Node[] = [];

    for (const task of analysis.tasks) {
      const labels = task.assignees.length
        ? task.assignees
        : [UNASSIGNED];

      const durationWidth = Math.max(
        6,
        task.duration * dayWidth,
      );

      const slackWidth = Math.max(
        0,
        task.lf - task.ef,
      ) * dayWidth;

      labels.forEach((label, index) => {
        const id =
          index === 0
            ? task.key
            : `${task.key}@${label}`;

        if (index === 0) {
          anchorOf.set(task.key, id);
        }

        const row =
          (laneOffset.get(label) ?? 0) +
          (subRow.get(
            `${label}|${task.key}`,
          ) ?? 0);

        rawNodes.push({
          id,
          type: "bar",
          draggable: false,
          selectable: false,

          position: {
            x:
              GUTTER +
              task.es * dayWidth,

            y:
              AXIS_H +
              row * LANE_H +
              (LANE_H - BAR_H) / 2,
          },

          width:
            durationWidth +
            slackWidth,

          height: BAR_H,

          data: {
            taskKey: task.key,
            name: task.name,
            assignees:
              task.assignees.join(", "),
            status: task.status,
            critical: task.critical,
            slack: Math.round(task.slack),
            duration:
              Math.round(
                task.duration * 10,
              ) / 10,
            startDate: task.start_date,
            endDate: task.end_date,
            es: Math.round(task.es),
            lf: Math.round(task.lf),
            risk:
              riskByTask.get(task.key) ??
              null,
            durationWidth,
            slackWidth,
            flashSeverity:
              live?.flashTasks?.[
                task.key
              ] ?? null,
          } satisfies BarData,
        });
      });
    }

    const criticalTasks = new Set(
      analysis.tasks
        .filter((task) => task.critical)
        .map((task) => task.key),
    );

    const rawEdges: Edge[] =
      analysis.edges.map((edge) => {
        const onCritical =
          criticalTasks.has(
            edge.source,
          ) &&
          criticalTasks.has(
            edge.target,
          );

        const stroke = onCritical
          ? "var(--accent)"
          : "var(--line)";

        return {
          id: `${edge.source}-${edge.target}`,

          source:
            anchorOf.get(edge.source) ??
            edge.source,

          target:
            anchorOf.get(edge.target) ??
            edge.target,

          type: "smoothstep",

          pathOptions: {
            borderRadius: 6,
          },

          selectable: false,

          style: {
            stroke,
            strokeWidth: onCritical
              ? 1.6
              : 1,

            strokeDasharray:
              edge.consumes
                ? undefined
                : "3 3",
          },

          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 10,
            height: 10,
            color: stroke,
          },
        };
      });

    return {
      nodes: rawNodes,
      edges: rawEdges,
      lanes: laneList,
      rows: totalRows,
    };
  }, [analysis, dayWidth, live]);

  if (analysis.tasks.length === 0) {
    return (
      <section>
        <h2 className="text-sm font-medium">
          The workflow
        </h2>

        <p className="mt-1 text-sm text-dim">
          Nothing to draw yet. Add tasks and
          dependencies in the builder.
        </p>
      </section>
    );
  }

  const height = Math.min(
    560,
    Math.max(
      200,
      AXIS_H + rows * LANE_H + 36,
    ),
  );

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h2 className="text-sm font-medium">
            The workflow
          </h2>

          <p className="font-mono text-[11px] text-dim">
            {analysis.tasks.length} tasks ·{" "}
            {lanes.length} lanes · day 0-
            {horizon} ·{" "}
            {live ? "sim" : "today"} d
            {Math.round(
              analysis.today_day,
            )}{" "}
            · projected end d
            {Math.round(
              analysis.projected_end,
            )}
          </p>
        </div>

        <p className="text-[11px] text-dim">
          <span className="text-accent">
            accent
          </span>{" "}
          is the zero-slack chain · the faint
          tail after a bar is its slack · solid
          edges carry an artifact, dashed edges
          are ordering only
        </p>
      </div>

      {live && (
        <p className="mb-2 text-[11px] text-muted-foreground">
          Bar positions and slack are the stored
          plan&rsquo;s schedule. What the replay
          moves is each task&rsquo;s status, the
          zero-slack chain, and the marker line —
          those are what a frame actually reports.
        </p>
      )}

      <div
        ref={boxRef}
        className="flowtrace-graph overflow-hidden rounded-lg border border-line bg-panel"
        style={{ height }}
      >
        <ReactFlow
          className="flowtrace-light"
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          defaultViewport={{
            x: 0,
            y: 0,
            zoom: 1,
          }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{
            hideAttribution: true,
          }}
          minZoom={0.25}
          maxZoom={1.5}
        >
          <Background
            variant={BackgroundVariant.Lines}
            gap={[
              dayWidth * tickDays,
              LANE_H,
            ]}
            offset={[
              GUTTER,
              AXIS_H,
            ]}
            lineWidth={1}
            color="var(--line)"
          />

          <Chrome
            lanes={lanes}
            horizon={horizon}
            todayDay={analysis.today_day}
            markerLabel={
              live ? "sim" : "today"
            }
            projectStart={
              analysis.project_start
            }
            dayWidth={dayWidth}
            tickDays={tickDays}
          />

          <Controls
            showInteractive={false}
            position="bottom-right"
            fitViewOptions={{
              padding: 0.05,
              maxZoom: 1,
            }}
          />
        </ReactFlow>
      </div>
    </section>
  );
}