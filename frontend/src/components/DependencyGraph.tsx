"use client";

/**
 * The workflow, drawn as time x resource lanes.
 *
 * The brief for this panel is "time on the x-axis, resources as lanes, accent
 * for zero-slack, one marker line for today", and the data supports all four:
 * every analysis task carries `es`/`ef` (earliest start and finish, in days
 * from the project start), `lf` (latest finish, so `lf - ef` is the float),
 * `slack`, `critical`, and the assignee labels that name its lane.
 *
 * What this replaces: a dagre-laid-out node graph, which answered "what
 * depends on what" and nothing else. Nothing in it said *when* a task sits or
 * *who* is doubly booked, which are the two questions a workflow owner
 * actually has. Laid out on a time axis, contention is visible without a
 * finding having to name it: two bars overlapping in one lane is one person
 * in two places.
 *
 * What is kept from the node graph: React Flow, as the canvas. It renders the
 * dependency edges, the pan and zoom, and the day grid, and it is the only
 * part that was worth keeping. The layout engine (dagre) is gone; positions
 * are now arithmetic on `es` and the lane index.
 *
 * The scale is derived from the container, not fixed. A chart whose x-axis is
 * time has to show all of the time by default, and this panel is not
 * full-bleed - it sits in a main column with an inspector rail beside it, so
 * a fixed pixels-per-day clipped the projected end off the right edge at
 * common widths. Pixels per day is now `usable width / horizon`, re-derived
 * on resize, and the tick interval follows it so labels never collide.
 * Zooming is therefore opt-in rather than the price of reading the chart.
 *
 * Colour rules, deliberately narrow:
 *   - the accent is the zero-slack chain - bars and the edges between them -
 *     and nothing else;
 *   - `blocked` is the one severity state that appears, because it is the one
 *     task state that is a problem rather than a stage;
 *   - slack is drawn, not coloured: the faint tail after a bar is its float,
 *     so a task with room looks like a task with room;
 *   - every colour is a token (`var(--accent)`, `var(--line)`), never a hex.
 *     The previous version baked dark-mode hexes into JS, which is why the
 *     graph used to draw near-black edges on a white page in light mode.
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/* --------------------------------------------------------------- geometry */

/** Pixels per day before the container has been measured. */
const DAY_W_DEFAULT = 28;
/** Never squeeze a day below this, even on a very long project. */
const DAY_W_MIN = 3;
/** Never stretch one past this, or a four-task project looks like a poster. */
const DAY_W_MAX = 44;
/** Room kept at the right edge for the last arrowhead and its key label. */
const RIGHT_PAD = 46;
/** One resource lane. */
const LANE_H = 32;
/** The bar inside a lane. */
const BAR_H = 20;
/** The date ruler across the top of the canvas. */
const AXIS_H = 28;
/** The lane-label gutter, which stays put while the timeline pans. */
const GUTTER = 168;

/**
 * Tick intervals worth printing on a date axis, in days.
 *
 * The interval is the first of these that gives a label enough room, so the
 * ruler thins out as the project lengthens instead of overprinting itself.
 */
const NICE_TICKS = [1, 2, 5, 7, 10, 14, 20, 30, 60, 90, 180, 365];

/** Width a "16 Sep d15" label needs before the next tick starts. */
const TICK_LABEL_W = 78;

function tickEvery(dayWidth: number): number {
  return NICE_TICKS.find((n) => n * dayWidth >= TICK_LABEL_W) ?? 365;
}

/**
 * The element own width, tracked.
 *
 * `ResizeObserver` rather than a window listener: the panel width changes
 * when the inspector rail beside it appears or the column reflows, which no
 * window resize event announces.
 */
function useMeasuredWidth<T extends HTMLElement>(): [
  React.RefObject<T | null>,
  number,
] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      setWidth((prev) => (Math.abs(prev - next) < 1 ? prev : next));
    });
    observer.observe(el);
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

/**
 * The calendar date of day `n`.
 *
 * The engine's day numbers are calendar days from `project_start` - a task at
 * `es` 0 starts on the project start date and one at `es` 14 starts fourteen
 * days later - so this is the arithmetic the API already did for
 * `start_date`, done in UTC so a timezone cannot shift a label by a day.
 */
function dateOfDay(projectStart: string, day: number): string {
  const base = Date.parse(`${projectStart}T00:00:00Z`);
  if (Number.isNaN(base)) return `d${day}`;
  const d = new Date(base + day * 86_400_000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/* ------------------------------------------------------------------ lanes */

type Lane = {
  /** The assignee label as the analysis reports it, or the unassigned bucket. */
  key: string;
  label: string;
  capacity: number | null;
  taskCount: number;
  bookedDays: number;
  criticalCount: number;
  firstDay: number;
  /**
   * How many sub-rows this lane needs.
   *
   * More than one means the schedule has this resource doing two things in
   * the same window. Bars stacked in a lane are how that is shown: drawing
   * them at the same height made them overlap into illegible mush on the
   * pilot-line fixture, which is exactly the workflow where contention is
   * the point.
   */
  rows: number;
  /** This lane's first sub-row, counted in rows from the top of the canvas. */
  rowOffset: number;
};

/** Leading space keeps it out of the way of any real resource label. */
const UNASSIGNED = " unassigned";

/* ------------------------------------------------------------------- node */

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
  /** Width of the solid bar; the node is wider than this by the float. */
  durationWidth: number;
  slackWidth: number;
};

/** The bar's border and text: state, in three colours and no more. */
function barTone(d: BarData): string {
  if (d.status === "blocked") return "border-severity-high text-foreground";
  if (d.critical) return "border-accent text-foreground";
  if (d.status === "done") return "border-line text-dim";
  return "border-line text-foreground";
}

/** The tint inside the bar, painted over the opaque shell. */
function barFill(d: BarData): string {
  if (d.status === "blocked") return "bg-severity-high/15";
  if (d.critical) return "bg-accent/15";
  if (d.status === "done") return "bg-muted";
  return "bg-panel2";
}

function TaskBar({ data }: NodeProps) {
  const d = data as BarData;
  const wide = d.durationWidth >= 74;
  const narrow = d.durationWidth < 36;

  return (
    <div
      className="relative"
      style={{ width: d.durationWidth + d.slackWidth, height: BAR_H }}
    >
      {/* Pulled a few pixels clear of the bar so the arrowhead lands beside
          the bar rather than on top of its first character. */}
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent"
        style={{ left: -3 }}
      />
      {/* The float: the room this bar could still slide into, drawn on the
          bar's baseline. Opaque and attached to the bar, so it reads as this
          task's slack rather than as a dependency edge crossing the lane. */}
      {d.slackWidth > 0 && (
        <div
          className="absolute bottom-0 h-[5px] rounded-r-[2px] bg-line"
          style={{ left: d.durationWidth, width: d.slackWidth }}
        />
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Two layers on purpose: an opaque `bg-panel` shell so dependency
              edges pass *behind* a bar instead of showing through a tinted
              one and appearing to strike out its label, and a tinted inner
              fill for the state. */}
          <div
            className={cn(
              "absolute inset-y-0 left-0 overflow-hidden rounded-[3px] border bg-panel",
              barTone(d),
            )}
            style={{ width: d.durationWidth }}
          >
            <div
              className={cn(
                "flex h-full items-center gap-1 px-1",
                barFill(d),
              )}
            >
              {!narrow && (
                <span className="shrink-0 font-mono text-[10px] leading-none opacity-80">
                  {d.taskKey}
                </span>
              )}
              {wide && (
                <span className="truncate text-[10px] leading-none">
                  {d.name}
                </span>
              )}
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <span className="flex flex-col gap-0.5 text-left">
            <span className="font-mono">
              {d.taskKey} {d.name}
            </span>
            <span className="opacity-80">
              {d.startDate} to {d.endDate} · {d.duration}d ·{" "}
              {STATUS_LABEL[d.status] ?? d.status}
            </span>
            <span className="opacity-80">
              {d.critical
                ? "zero slack, on the critical path"
                : `${d.slack}d slack · day ${d.es} at the earliest, day ${d.lf} at the latest`}
            </span>
            <span className="opacity-80">{d.assignees || "unassigned"}</span>
            {d.risk !== null && (
              <span className="opacity-80">risk {d.risk.toFixed(2)}</span>
            )}
          </span>
        </TooltipContent>
      </Tooltip>
      {narrow && (
        <span
          className="pointer-events-none absolute top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[10px] text-dim"
          style={{ left: d.durationWidth + d.slackWidth + 4 }}
        >
          {d.taskKey}
        </span>
      )}
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent"
        style={{ left: d.durationWidth, right: "auto" }}
      />
    </div>
  );
}

const nodeTypes = { bar: TaskBar };

/* --------------------------------------------------------------- overlays */

/**
 * The gutter, the date ruler and the today marker.
 *
 * These track the viewport rather than sit inside it: the lane names have to
 * stay readable when the timeline is panned sideways, and the ruler has to
 * stay readable when it is panned vertically. `useViewport` re-renders this
 * on every pan and zoom, which is exactly the coupling a sticky axis needs.
 */
function Chrome({
  lanes,
  horizon,
  todayDay,
  projectStart,
  dayWidth,
  tickDays,
}: {
  lanes: Lane[];
  horizon: number;
  todayDay: number;
  projectStart: string;
  dayWidth: number;
  tickDays: number;
}) {
  const { x, y, zoom } = useViewport();
  const ticks: number[] = [];
  for (let d = 0; d <= horizon; d += tickDays) ticks.push(d);

  const dayToScreen = (day: number) => x + (GUTTER + day * dayWidth) * zoom;

  return (
    <div className="pointer-events-none absolute inset-0" style={{ zIndex: 5 }}>
      {/* The date ruler. */}
      <div
        className="absolute inset-x-0 top-0 overflow-hidden border-b border-line bg-panel"
        style={{ height: AXIS_H }}
      >
        {ticks.map((day) => (
          <span
            key={day}
            className="absolute top-1 whitespace-nowrap border-l border-line pt-0.5 pl-1 text-[10px] leading-tight text-dim"
            style={{ left: dayToScreen(day), height: AXIS_H - 8 }}
          >
            {dateOfDay(projectStart, day)}
            <span className="ml-1 font-mono opacity-70">d{day}</span>
          </span>
        ))}
      </div>

      {/* Today. One line, labelled at the foot so it never lands on a bar. */}
      <div
        className="absolute border-l border-dashed border-foreground/45"
        style={{ left: dayToScreen(todayDay), top: AXIS_H, bottom: 0 }}
      >
        <span className="absolute bottom-0.5 left-1 whitespace-nowrap font-mono text-[10px] text-foreground/70">
          today d{todayDay}
        </span>
      </div>

      {/* The lane gutter. Opaque, so bars pass behind it, not through it. */}
      <div
        className="absolute bottom-0 left-0 overflow-hidden border-r border-line bg-panel"
        style={{ width: GUTTER, top: AXIS_H }}
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

/* ------------------------------------------------------------------- main */

export default function DependencyGraph({ analysis }: { analysis: Analysis }) {
  const [boxRef, boxWidth] = useMeasuredWidth<HTMLDivElement>();

  /* The horizon is whatever has to fit: the latest late finish, the projected
     end, and today, whichever runs furthest. It does not depend on the scale,
     because the scale is derived from it. */
  const horizon = useMemo(
    () =>
      Math.max(
        1,
        ...analysis.tasks.map((t) => Math.ceil(t.lf)),
        Math.ceil(analysis.projected_end),
        Math.ceil(analysis.today_day),
      ),
    [analysis],
  );

  /* Pixels per day: the whole project, in the width there is. Clamped at both
     ends - a very long project stays pannable rather than becoming a hairline,
     and a very short one does not blow up into a poster. */
  const dayWidth = useMemo(() => {
    if (!boxWidth) return DAY_W_DEFAULT;
    const usable = Math.max(120, boxWidth - GUTTER - RIGHT_PAD);
    return Math.min(DAY_W_MAX, Math.max(DAY_W_MIN, usable / horizon));
  }, [boxWidth, horizon]);

  const tickDays = useMemo(() => tickEvery(dayWidth), [dayWidth]);

  const { nodes, edges, lanes, rows } = useMemo(() => {
    const riskByTask = new Map(
      analysis.risk.tasks.map((t) => [t.task_key, t.score]),
    );
    const metaByLabel = new Map(analysis.resources.map((r) => [r.label, r]));

    /* Lanes: one per resource that actually has work, ordered so the timeline
       reads as a cascade - earliest work at the top - with the unassigned
       bucket last. A resource with nothing on it gets no lane; an empty row
       is a row that says nothing. */
    const byLane = new Map<
      string,
      { label: string; tasks: Analysis["tasks"] }
    >();
    for (const task of analysis.tasks) {
      const labels = task.assignees.length ? task.assignees : [UNASSIGNED];
      for (const label of labels) {
        const bucket = byLane.get(label) ?? { label, tasks: [] };
        bucket.tasks.push(task);
        byLane.set(label, bucket);
      }
    }

    /* Sub-rows, by greedy interval packing on the work window (`es` to `ef`).
       A task goes in the first sub-row whose last task has already finished,
       so a lane is one row deep until the schedule genuinely asks a resource
       for two things at once, and then it is two. */
    const subRow = new Map<string, number>();
    const rowsOf = new Map<string, number>();
    for (const [key, bucket] of byLane) {
      const ends: number[] = [];
      for (const task of [...bucket.tasks].sort((x, y) => x.es - y.es)) {
        let row = ends.findIndex((end) => end <= task.es);
        if (row === -1) {
          row = ends.length;
          ends.push(task.ef);
        } else {
          ends[row] = task.ef;
        }
        subRow.set(`${key}|${task.key}`, row);
      }
      rowsOf.set(key, Math.max(1, ends.length));
    }

    const laneList: Lane[] = [...byLane.entries()]
      .map(([key, bucket]) => ({
        key,
        label: key === UNASSIGNED ? "unassigned" : bucket.label,
        capacity: metaByLabel.get(key)?.capacity ?? null,
        taskCount: bucket.tasks.length,
        bookedDays:
          Math.round(bucket.tasks.reduce((n, t) => n + t.duration, 0) * 10) /
          10,
        criticalCount: bucket.tasks.filter((t) => t.critical).length,
        firstDay: Math.min(...bucket.tasks.map((t) => t.es)),
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
    const laneOffset = new Map(laneList.map((l) => [l.key, l.rowOffset]));

    /* One node per (task, lane). A task assigned to two people occupies both
       lanes, because both people are busy - that is the point of a lane view.
       Only the first is the anchor the dependency edges attach to, so an edge
       is drawn once rather than once per assignee. */
    const anchorOf = new Map<string, string>();
    const rawNodes: Node[] = [];
    for (const task of analysis.tasks) {
      const labels = task.assignees.length ? task.assignees : [UNASSIGNED];
      const durationWidth = Math.max(6, task.duration * dayWidth);
      const slackWidth = Math.max(0, task.lf - task.ef) * dayWidth;
      labels.forEach((label, i) => {
        const id = i === 0 ? task.key : `${task.key}@${label}`;
        if (i === 0) anchorOf.set(task.key, id);
        const row =
          (laneOffset.get(label) ?? 0) + (subRow.get(`${label}|${task.key}`) ?? 0);
        rawNodes.push({
          id,
          type: "bar",
          draggable: false,
          selectable: false,
          position: {
            x: GUTTER + task.es * dayWidth,
            y: AXIS_H + row * LANE_H + (LANE_H - BAR_H) / 2,
          },
          width: durationWidth + slackWidth,
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
            durationWidth,
            slackWidth,
          } satisfies BarData,
        });
      });
    }

    const criticalTasks = new Set(
      analysis.tasks.filter((t) => t.critical).map((t) => t.key),
    );

    const rawEdges: Edge[] = analysis.edges.map((edge) => {
      const onCritical =
        criticalTasks.has(edge.source) && criticalTasks.has(edge.target);
      const stroke = onCritical ? "var(--accent)" : "var(--line)";
      return {
        id: `${edge.source}-${edge.target}`,
        source: anchorOf.get(edge.source) ?? edge.source,
        target: anchorOf.get(edge.target) ?? edge.target,
        type: "smoothstep",
        pathOptions: { borderRadius: 6 },
        selectable: false,
        style: {
          stroke,
          strokeWidth: onCritical ? 1.6 : 1,
          strokeDasharray: edge.consumes ? undefined : "3 3",
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
  }, [analysis, dayWidth]);

  if (analysis.tasks.length === 0) {
    return (
      <section>
        <h2 className="text-sm font-medium">The workflow</h2>
        <p className="mt-1 text-sm text-dim">
          Nothing to draw yet. Add tasks and dependencies in the builder.
        </p>
      </section>
    );
  }

  /* Tall enough for every lane up to a point, then it pans. The trailing
     room is where the today label and the zoom controls sit. */
  const height = Math.min(560, Math.max(200, AXIS_H + rows * LANE_H + 36));

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h2 className="text-sm font-medium">The workflow</h2>
          <p className="font-mono text-[11px] text-dim">
            {analysis.tasks.length} tasks · {lanes.length} lanes · day 0-
            {horizon} · today d{analysis.today_day} · projected end d
            {analysis.projected_end}
          </p>
        </div>
        <p className="text-[11px] text-dim">
          <span className="text-accent">accent</span> is the zero-slack chain ·
          the faint tail after a bar is its slack · solid edges carry an
          artifact, dashed edges are ordering only
        </p>
      </div>

      <div
        ref={boxRef}
        className="overflow-hidden rounded-lg border border-line bg-panel"
        style={{ height }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
          minZoom={0.25}
          maxZoom={1.5}
        >
          {/* A gridline per tick and one per lane row. Both read the tokens,
              so both follow light and dark. */}
          <Background
            variant={BackgroundVariant.Lines}
            gap={[dayWidth * tickDays, LANE_H]}
            offset={[GUTTER, AXIS_H]}
            lineWidth={1}
            color="var(--line)"
          />
          <Chrome
            lanes={lanes}
            horizon={horizon}
            todayDay={analysis.today_day}
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
