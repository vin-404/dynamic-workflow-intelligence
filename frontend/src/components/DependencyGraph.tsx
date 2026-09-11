"use client";

/**
 * The workflow as a timeline: days across, one swimlane per resource down.
 *
 * Everything drawn here comes from the analysis payload - `es`, `ef`, `lf`,
 * `slack`, `critical`, the assignee labels, `today_day` - so this is a
 * layout, not a computation (D-119). What this pass changed is legibility:
 * the chart takes the full width of the main column, bars are 28px tall,
 * every task's *name* is drawn - inside the bar when it fits, beside it when
 * it does not - and bars are packed into sub-rows on their visible footprint
 * (bar plus label) so no two ever overlap. The zero-slack chain is the one
 * warm colour on the page at full opacity; everything else steps back.
 */

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
import { statusLabel } from "@/lib/display";
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

/* ------------------------------------------------------------- geometry */

const DAY_W_DEFAULT = 30;
const DAY_W_MIN = 4;
const DAY_W_MAX = 56;

/** Room at the right edge for a label drawn beside the last bar. */
const RIGHT_PAD = 128;
const LANE_H = 40;
const BAR_H = 28;
const AXIS_H = 34;
const GUTTER = 188;

/** Gap between a bar and the label beside it, and after the label. */
const LABEL_GAP = 6;
const FOOTPRINT_GAP = 10;

/** Type is 12px throughout the chart; these are its average advances. */
const SANS_CHAR_W = 6.7;
const MONO_CHAR_W = 7.4;

const NICE_TICKS = [1, 2, 5, 7, 10, 14, 20, 30, 60, 90, 180, 365];
const TICK_LABEL_W = 92;

function tickEvery(dayWidth: number): number {
  return NICE_TICKS.find((n) => n * dayWidth >= TICK_LABEL_W) ?? 365;
}

function textWidth(text: string, charWidth: number): number {
  return Math.ceil(text.length * charWidth);
}

function useMeasuredWidth<T extends HTMLElement>(): [
  React.RefObject<T | null>,
  number,
] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    setWidth(element.clientWidth);

    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      setWidth((previous) => (Math.abs(previous - next) < 1 ? previous : next));
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function dateOfDay(projectStart: string, day: number): string {
  const base = Date.parse(`${projectStart}T00:00:00Z`);
  if (Number.isNaN(base)) return `day ${day}`;
  const date = new Date(base + day * 86_400_000);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/* ----------------------------------------------------------------- lanes */

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

/** Where the label goes, decided from the bar's width. */
type LabelMode = "inside" | "key-inside" | "outside";

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
  /** Width of bar + label + gap, the box no other bar may enter. */
  footprint: number;
  labelMode: LabelMode;
  flashSeverity: string | null;
  selected: boolean;
  dimmed: boolean;
  onSelect?: (taskKey: string) => void;
};

function labelLayout(
  taskKey: string,
  name: string,
  durationWidth: number,
): { mode: LabelMode; footprint: number } {
  // Room for the "✓ " a done task carries before its key.
  const keyW = textWidth(taskKey, MONO_CHAR_W) + 14;
  const nameW = textWidth(name, SANS_CHAR_W);
  const insideNeeds = keyW + nameW + 6 + 16;

  if (durationWidth >= insideNeeds) {
    return { mode: "inside", footprint: durationWidth + FOOTPRINT_GAP };
  }

  if (durationWidth >= keyW + 14) {
    return {
      mode: "key-inside",
      footprint: durationWidth + LABEL_GAP + nameW + FOOTPRINT_GAP,
    };
  }

  return {
    mode: "outside",
    footprint: durationWidth + LABEL_GAP + keyW + 6 + nameW + FOOTPRINT_GAP,
  };
}

function shellTone(data: BarData): string {
  if (data.critical) {
    return "border-critical bg-critical text-white";
  }
  if (data.status === "blocked") {
    return "border-foreground border-dashed bg-panel text-foreground";
  }
  if (data.status === "done") {
    return "border-line bg-panel2 text-dim";
  }
  return "border-line bg-panel text-foreground";
}

function TaskBar({ data }: NodeProps) {
  const task = data as BarData;
  const outsideLeft = task.durationWidth + LABEL_GAP;

  return (
    <div
      className={cn(
        "relative transition-opacity",
        task.dimmed && !task.selected ? "opacity-60" : "",
      )}
      style={{
        width: Math.max(task.durationWidth + task.slackWidth, task.footprint),
        height: BAR_H,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent"
        style={{ left: -2 }}
      />

      {task.slackWidth > 0 && (
        <div
          className="absolute bottom-0 h-[5px] rounded-r-[2px] bg-line"
          title={`${task.slack}d of slack`}
          style={{ left: task.durationWidth - 1, width: task.slackWidth + 1 }}
        />
      )}

      {task.flashSeverity && (
        <div
          className={cn(
            "pointer-events-none absolute -inset-[3px] rounded-[8px] border-2 border-current",
            severityText(task.flashSeverity),
          )}
          style={{ width: task.durationWidth + 6 }}
        />
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-task={task.taskKey}
            aria-label={`${task.taskKey} ${task.name}`}
            aria-pressed={task.selected}
            onClick={() => task.onSelect?.(task.taskKey)}
            className="ft-node-hit absolute inset-y-0 left-0 block cursor-pointer text-left focus:outline-none"
            style={{
              width:
                task.labelMode === "inside"
                  ? task.durationWidth
                  : task.footprint - FOOTPRINT_GAP,
            }}
          >
            <span
              className={cn(
                "absolute inset-y-0 left-0 flex items-center gap-1.5 overflow-hidden rounded-[6px] border px-2 text-[12px] leading-none",
                shellTone(task),
                task.selected
                  ? "ring-2 ring-foreground ring-offset-1 ring-offset-background"
                  : "",
                !task.critical && task.status !== "done"
                  ? "shadow-[0_1px_2px_rgba(23,23,42,0.06)]"
                  : "",
              )}
              style={{ width: task.durationWidth }}
            >
              {task.labelMode !== "outside" && (
                <span
                  className={cn(
                    "shrink-0 font-mono text-[12px] font-semibold",
                    task.critical ? "text-white/85" : "text-dim",
                  )}
                >
                  {task.status === "done" ? "✓ " : ""}
                  {task.taskKey}
                </span>
              )}

              {task.labelMode === "inside" && (
                <span className="truncate font-medium">{task.name}</span>
              )}
            </span>

            {task.labelMode !== "inside" && (
              // On the canvas colour, so an edge passes behind the words
              // rather than striking them through (the D-123 reasoning).
              <span
                className={cn(
                  "absolute top-1/2 flex -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded bg-background px-1 py-0.5 text-[12px] leading-none",
                  task.critical ? "text-critical" : "text-foreground",
                )}
                style={{ left: outsideLeft - 4 }}
              >
                {task.labelMode === "outside" && (
                  <span className="font-mono font-semibold text-dim">
                    {task.status === "done" ? "✓ " : ""}
                    {task.taskKey}
                  </span>
                )}
                <span className="font-medium">{task.name}</span>
              </span>
            )}
          </button>
        </TooltipTrigger>

        <TooltipContent side="top" className="max-w-xs">
          <span className="flex flex-col gap-0.5 text-left">
            <span className="font-medium">
              <span className="font-mono">{task.taskKey}</span> {task.name}
            </span>
            <span className="opacity-80">
              {task.startDate} to {task.endDate} · {task.duration}d ·{" "}
              {statusLabel(task.status)}
            </span>
            <span className="opacity-80">
              {task.critical
                ? "Zero slack, on the critical path"
                : `${task.slack}d slack · day ${task.es} at the earliest, day ${task.lf} at the latest`}
            </span>
            <span className="opacity-80">{task.assignees || "Unassigned"}</span>
            {task.risk !== null && (
              <span className="opacity-80">Structural exposure {task.risk.toFixed(2)}</span>
            )}
          </span>
        </TooltipContent>
      </Tooltip>

      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent"
        style={{ left: task.durationWidth, right: "auto" }}
      />
    </div>
  );
}

const nodeTypes = { bar: TaskBar };

/* ---------------------------------------------------------------- chrome */

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
  for (let day = 0; day <= horizon; day += tickDays) ticks.push(day);

  const dayToScreen = (day: number) => x + (GUTTER + day * dayWidth) * zoom;
  const todayX = dayToScreen(todayDay);
  const todayText = `${markerLabel} · ${dateOfDay(projectStart, Math.floor(todayDay))} · day ${
    Math.round(todayDay * 10) / 10
  }`;
  // A tick whose label would sit under the today pill is left out; the pill
  // carries the date for that stretch of the axis.
  const pillHalf = (textWidth(todayText, MONO_CHAR_W) + 20) / 2;
  const hiddenByPill = (day: number) => {
    const left = dayToScreen(day);
    return left > todayX - pillHalf - TICK_LABEL_W && left < todayX + pillHalf + 4;
  };

  return (
    <div className="pointer-events-none absolute inset-0" style={{ zIndex: 5 }}>
      {/* Day axis */}
      <div
        className="absolute inset-x-0 top-0 overflow-hidden border-b border-line bg-panel"
        style={{ height: AXIS_H }}
      >
        {ticks.filter((day) => !hiddenByPill(day)).map((day) => (
          <span
            key={day}
            className="absolute top-2 whitespace-nowrap border-l border-line pl-1.5 text-[12px] leading-tight text-dim"
            style={{ left: dayToScreen(day), height: AXIS_H - 10 }}
          >
            {dateOfDay(projectStart, day)}
            <span className="ml-1.5 font-mono opacity-70">d{day}</span>
          </span>
        ))}

        {/* The today label lives at the top, on the axis, never clipped. */}
        <span
          className="absolute top-[5px] -translate-x-1/2 whitespace-nowrap rounded-full bg-foreground px-2 py-[3px] font-mono text-[12px] leading-none text-background"
          style={{ left: todayX }}
        >
          {todayText}
        </span>
      </div>

      {/* Today line */}
      <div
        className="absolute w-px bg-foreground/70"
        style={{ left: todayX, top: AXIS_H, bottom: 0 }}
      />

      {/* Lane gutter */}
      <div
        className="absolute bottom-0 left-0 overflow-hidden border-r border-line bg-panel"
        style={{ width: GUTTER, top: AXIS_H }}
      >
        {lanes.map((lane) => (
          <div
            key={lane.key}
            className="absolute left-0 flex w-full flex-col justify-center border-b border-line/60 pr-3 pl-4"
            style={{
              top: y + lane.rowOffset * LANE_H * zoom,
              height: lane.rows * LANE_H * zoom,
            }}
          >
            <span className="truncate text-[14px] font-medium leading-tight" title={lane.label}>
              {lane.label}
            </span>
            <span className="truncate text-[12px] leading-tight text-dim">
              {lane.taskCount} {lane.taskCount === 1 ? "task" : "tasks"} · {lane.bookedDays}d
              {lane.capacity !== null && lane.capacity !== 1 ? ` · capacity ${lane.capacity}` : ""}
              {lane.criticalCount > 0 ? (
                <>
                  {" · "}
                  <span className="text-critical">{lane.criticalCount} zero-slack</span>
                </>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- component */

export default function DependencyGraph({
  analysis: stored,
  live,
  selected = null,
  onSelect,
  title = "The workflow",
}: {
  analysis: Analysis;
  live?: LiveOverlay;
  /** The task the inspector is showing, if the stage has one. */
  selected?: string | null;
  /** Click a bar: the stage focuses that task. Click it again to clear. */
  onSelect?: (taskKey: string | null) => void;
  title?: string;
}) {
  const [boxRef, boxWidth] = useMeasuredWidth<HTMLDivElement>();

  const analysis = useMemo<Analysis>(() => {
    if (!live) return stored;
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
        ...analysis.tasks.map((task) => Math.ceil(task.lf)),
        Math.ceil(stored.projected_end),
        Math.ceil(analysis.projected_end),
        Math.ceil(analysis.today_day),
      ),
    [analysis, stored.projected_end],
  );

  const dayWidth = useMemo(() => {
    if (!boxWidth) return DAY_W_DEFAULT;
    const usable = Math.max(160, boxWidth - GUTTER - RIGHT_PAD);
    return Math.min(DAY_W_MAX, Math.max(DAY_W_MIN, usable / horizon));
  }, [boxWidth, horizon]);

  const tickDays = useMemo(() => tickEvery(dayWidth), [dayWidth]);

  const { nodes, edges, lanes, rows } = useMemo(() => {
    const riskByTask = new Map(
      analysis.risk.tasks.map((task) => [task.task_key, task.score]),
    );
    const resourceByLabel = new Map(
      analysis.resources.map((resource) => [resource.label, resource]),
    );

    const byLane = new Map<string, { label: string; tasks: Analysis["tasks"] }>();
    for (const task of analysis.tasks) {
      const labels = task.assignees.length ? task.assignees : [UNASSIGNED];
      for (const label of labels) {
        const bucket = byLane.get(label) ?? { label, tasks: [] };
        bucket.tasks.push(task);
        byLane.set(label, bucket);
      }
    }

    // Geometry per task, once, so packing and drawing agree.
    const geometry = new Map<
      string,
      { durationWidth: number; slackWidth: number; footprint: number; mode: LabelMode }
    >();
    for (const task of analysis.tasks) {
      const durationWidth = Math.max(8, task.duration * dayWidth);
      const slackWidth = Math.max(0, task.lf - task.ef) * dayWidth;
      const { mode, footprint } = labelLayout(task.key, task.name, durationWidth);
      geometry.set(task.key, { durationWidth, slackWidth, footprint, mode });
    }

    // Pack each lane into sub-rows on the *visible footprint* - the bar and
    // the label beside it - so a short bar's name never runs into the next
    // bar. The slack tail is deliberately not part of the footprint (D-121).
    const subRow = new Map<string, number>();
    const rowsOf = new Map<string, number>();

    for (const [key, bucket] of byLane) {
      const ends: number[] = [];
      const ordered = [...bucket.tasks].sort(
        (a, b) => a.es - b.es || b.duration - a.duration,
      );
      for (const task of ordered) {
        const startPx = task.es * dayWidth;
        const endPx = startPx + (geometry.get(task.key)?.footprint ?? 0);
        let row = ends.findIndex((end) => end <= startPx);
        if (row === -1) {
          row = ends.length;
          ends.push(endPx);
        } else {
          ends[row] = endPx;
        }
        subRow.set(`${key}|${task.key}`, row);
      }
      rowsOf.set(key, Math.max(1, ends.length));
    }

    const laneList: Lane[] = [...byLane.entries()]
      .map(([key, bucket]) => ({
        key,
        label: key === UNASSIGNED ? "Unassigned" : bucket.label,
        capacity: resourceByLabel.get(key)?.capacity ?? null,
        taskCount: bucket.tasks.length,
        bookedDays:
          Math.round(bucket.tasks.reduce((total, task) => total + task.duration, 0) * 10) / 10,
        criticalCount: bucket.tasks.filter((task) => task.critical).length,
        firstDay: Math.min(...bucket.tasks.map((task) => task.es)),
        rows: rowsOf.get(key) ?? 1,
        rowOffset: 0,
      }))
      .sort((a, b) => {
        if (a.key === UNASSIGNED) return 1;
        if (b.key === UNASSIGNED) return -1;
        return a.firstDay - b.firstDay || a.label.localeCompare(b.label);
      });

    let cursor = 0;
    for (const lane of laneList) {
      lane.rowOffset = cursor;
      cursor += lane.rows;
    }
    const totalRows = cursor;
    const laneOffset = new Map(laneList.map((lane) => [lane.key, lane.rowOffset]));

    const anchorOf = new Map<string, string>();
    const rawNodes: Node[] = [];

    for (const task of analysis.tasks) {
      const labels = task.assignees.length ? task.assignees : [UNASSIGNED];
      const geo = geometry.get(task.key)!;

      labels.forEach((label, index) => {
        const id = index === 0 ? task.key : `${task.key}@${label}`;
        if (index === 0) anchorOf.set(task.key, id);

        const row = (laneOffset.get(label) ?? 0) + (subRow.get(`${label}|${task.key}`) ?? 0);
        const isSelected = selected === task.key;

        rawNodes.push({
          id,
          type: "bar",
          draggable: false,
          selectable: false,
          zIndex: isSelected ? 20 : task.critical ? 10 : 1,
          position: {
            x: GUTTER + task.es * dayWidth,
            y: AXIS_H + row * LANE_H + (LANE_H - BAR_H) / 2,
          },
          width: Math.max(geo.durationWidth + geo.slackWidth, geo.footprint),
          height: BAR_H,
          data: {
            taskKey: task.key,
            name: task.name,
            assignees: task.assignees.join(", "),
            status: task.status,
            critical: task.critical,
            slack: Math.round(task.slack),
            duration: Math.round(task.duration * 10) / 10,
            startDate: task.start_date,
            endDate: task.end_date,
            es: Math.round(task.es),
            lf: Math.round(task.lf),
            risk: riskByTask.get(task.key) ?? null,
            durationWidth: geo.durationWidth,
            slackWidth: geo.slackWidth,
            footprint: geo.footprint,
            labelMode: geo.mode,
            flashSeverity: live?.flashTasks?.[task.key] ?? null,
            selected: isSelected,
            dimmed: !task.critical,
            onSelect: onSelect
              ? (key: string) => onSelect(selected === key ? null : key)
              : undefined,
          } satisfies BarData,
        });
      });
    }

    const criticalTasks = new Set(
      analysis.tasks.filter((task) => task.critical).map((task) => task.key),
    );

    const rawEdges: Edge[] = analysis.edges.map((edge) => {
      const onCritical = criticalTasks.has(edge.source) && criticalTasks.has(edge.target);
      const touchesSelected =
        selected !== null && (edge.source === selected || edge.target === selected);
      const stroke = onCritical
        ? "var(--critical)"
        : touchesSelected
          ? "var(--foreground)"
          : "var(--edge)";

      return {
        id: `${edge.source}-${edge.target}`,
        source: anchorOf.get(edge.source) ?? edge.source,
        target: anchorOf.get(edge.target) ?? edge.target,
        type: "smoothstep",
        pathOptions: { borderRadius: 8, offset: 10 },
        selectable: false,
        // Every edge stays beneath every bar; an opaque bar hides the
        // segment behind it, which is how a crossing reads as "behind".
        zIndex: 0,
        style: {
          stroke,
          strokeWidth: onCritical ? 2 : touchesSelected ? 1.5 : 1.25,
          strokeDasharray: edge.consumes ? undefined : "4 4",
          opacity: onCritical || touchesSelected ? 1 : 0.9,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 12,
          height: 12,
          color: stroke,
        },
      };
    });

    return { nodes: rawNodes, edges: rawEdges, lanes: laneList, rows: totalRows };
  }, [analysis, dayWidth, live, selected, onSelect]);

  if (analysis.tasks.length === 0) {
    return (
      <section>
        <h2 className="text-[18px] font-semibold">{title}</h2>
        <p className="mt-1 text-[14px] text-dim">
          Nothing to draw yet. Add tasks and dependencies in the builder.
        </p>
      </section>
    );
  }

  const height = Math.min(760, Math.max(240, AXIS_H + rows * LANE_H + 18));
  const criticalCount = analysis.tasks.filter((task) => task.critical).length;

  return (
    <section data-graph="workflow">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h2 className="text-[18px] font-semibold tracking-[-0.01em]">{title}</h2>
          <p className="text-[12px] text-dim">
            {analysis.tasks.length} tasks · {lanes.length} lanes · {horizon} days ·{" "}
            {criticalCount} on the zero-slack chain
          </p>
        </div>

        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-dim">
          <li className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-5 rounded-[3px] bg-critical" />
            zero-slack chain
          </li>
          <li className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-5 rounded-[3px] border border-line bg-panel" />
            has slack
          </li>
          <li className="flex items-center gap-1.5">
            <span className="inline-block h-[5px] w-5 rounded-r-[2px] bg-line" />
            slack tail
          </li>
          <li className="flex items-center gap-1.5">
            <span className="inline-block h-px w-5 bg-foreground/60" />
            uses the output
          </li>
          <li className="flex items-center gap-1.5">
            <span className="inline-block h-px w-5 border-t border-dashed border-foreground/60" />
            ordering only
          </li>
        </ul>
      </div>

      {live && (
        <p className="mb-3 text-[12px] text-dim">
          Bar positions and slack are the stored plan&rsquo;s schedule. What the replay moves
          is each task&rsquo;s status, the zero-slack chain and the marker line.
        </p>
      )}

      <div
        ref={boxRef}
        className="flowtrace-graph overflow-hidden rounded-xl border border-line bg-panel"
        style={{ height }}
      >
        <ReactFlow
          className="flowtrace-light"
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnScroll={false}
          panOnScroll={false}
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
          minZoom={0.4}
          maxZoom={1.6}
          onPaneClick={() => onSelect?.(null)}
        >
          <Background
            variant={BackgroundVariant.Lines}
            gap={[dayWidth * tickDays, LANE_H]}
            offset={[GUTTER, AXIS_H]}
            lineWidth={1}
            color="var(--grid)"
          />

          <Chrome
            lanes={lanes}
            horizon={horizon}
            todayDay={analysis.today_day}
            markerLabel={live ? "Now" : "Today"}
            projectStart={analysis.project_start}
            dayWidth={dayWidth}
            tickDays={tickDays}
          />

          <Controls
            showInteractive={false}
            position="bottom-right"
            fitViewOptions={{ padding: 0.05, maxZoom: 1 }}
          />
        </ReactFlow>
      </div>
    </section>
  );
}
