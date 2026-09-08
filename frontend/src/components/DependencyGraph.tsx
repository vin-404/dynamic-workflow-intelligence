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

import { useMemo } from "react";
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
import { cn } from "cn";
import { Analysis } from "@/lib/api";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/* --------------------------------------------------------------- geometry */

/** One day of the schedule, in canvas pixels. */
const DAY_W = 28;
/** One resource lane. */
const LANE_H = 32;
/** The bar inside a lane. */
const BAR_H = 20;
/** The date ruler across the top of the canvas. */
const AXIS_H = 28;
/** The lane-label gutter, which stays put while the timeline pans. */
const GUTTER = 168;
/** A tick every five days: enough to read, sparse enough not to stripe. */
const TICK_DAYS = 5;

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

function barTone(d: BarData): string {
  if (d.status === "blocked")
    return "border-severity-high bg-severity-high/15 text-foreground";
  if (d.critical) return "border-accent bg-accent/15 text-foreground";
  if (d.status === "done") return "border-line bg-muted text-dim";
  return "border-line bg-panel2 text-foreground";
}

function TaskBar({ data }: NodeProps) {
  const d = data as BarData;
  const wide = d.durationWidth >= 92;
  const narrow = d.durationWidth < 44;

  return (
    <div
      className="relative"
      style={{ width: d.durationWidth + d.slackWidth, height: BAR_H }}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent"
      />
      {/* The float, drawn as the room the bar could still slide into. A block
          rather than a rule, so it cannot be mistaken for a dependency edge
          crossing the lane. */}
      {d.slackWidth > 0 && (
        <div
          className="absolute inset-y-[3px] rounded-r-[3px] bg-line/60"
          style={{ left: d.durationWidth, width: d.slackWidth }}
        />
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "absolute inset-y-0 left-0 flex items-center gap-1 overflow-hidden rounded-[3px] border px-1",
              barTone(d),
            )}
            style={{ width: d.durationWidth }}
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
}: {
  lanes: Lane[];
  horizon: number;
  todayDay: number;
  projectStart: string;
}) {
  const { x, y, zoom } = useViewport();
  const ticks: number[] = [];
  for (let d = 0; d <= horizon; d += TICK_DAYS) ticks.push(d);

  const dayToScreen = (day: number) => x + (GUTTER + day * DAY_W) * zoom;

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
        {lanes.map((lane, i) => (
          <div
            key={lane.key}
            className="absolute left-0 flex w-full flex-col justify-center border-b border-line/50 pr-2 pl-3"
            style={{ top: y + i * LANE_H * zoom, height: LANE_H * zoom }}
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
  const { nodes, edges, lanes, horizon } = useMemo(() => {
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
      }))
      .sort((a, b) => {
        if (a.key === UNASSIGNED) return 1;
        if (b.key === UNASSIGNED) return -1;
        return a.firstDay - b.firstDay || a.label.localeCompare(b.label);
      });

    const laneIndex = new Map(laneList.map((l, i) => [l.key, i]));

    /* The horizon is whatever has to fit: the latest late finish, the
       projected end, and today, whichever runs furthest. */
    const horizonDays = Math.max(
      1,
      ...analysis.tasks.map((t) => Math.ceil(t.lf)),
      Math.ceil(analysis.projected_end),
      Math.ceil(analysis.today_day),
    );

    /* One node per (task, lane). A task assigned to two people occupies both
       lanes, because both people are busy - that is the point of a lane view.
       Only the first is the anchor the dependency edges attach to, so an edge
       is drawn once rather than once per assignee. */
    const anchorOf = new Map<string, string>();
    const rawNodes: Node[] = [];
    for (const task of analysis.tasks) {
      const labels = task.assignees.length ? task.assignees : [UNASSIGNED];
      const durationWidth = Math.max(6, task.duration * DAY_W);
      const slackWidth = Math.max(0, task.lf - task.ef) * DAY_W;
      labels.forEach((label, i) => {
        const id = i === 0 ? task.key : `${task.key}@${label}`;
        if (i === 0) anchorOf.set(task.key, id);
        const lane = laneIndex.get(label) ?? 0;
        rawNodes.push({
          id,
          type: "bar",
          draggable: false,
          selectable: false,
          position: {
            x: GUTTER + task.es * DAY_W,
            y: AXIS_H + lane * LANE_H + (LANE_H - BAR_H) / 2,
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
          width: 12,
          height: 12,
          color: stroke,
        },
      };
    });

    return {
      nodes: rawNodes,
      edges: rawEdges,
      lanes: laneList,
      horizon: horizonDays,
    };
  }, [analysis]);

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
  const height = Math.min(
    560,
    Math.max(200, AXIS_H + lanes.length * LANE_H + 36),
  );

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
          {/* A gridline every five days and one per lane. Both read the
              tokens, so both follow light and dark. */}
          <Background
            variant={BackgroundVariant.Lines}
            gap={[DAY_W * TICK_DAYS, LANE_H]}
            offset={[GUTTER, AXIS_H]}
            lineWidth={1}
            color="var(--line)"
          />
          <Chrome
            lanes={lanes}
            horizon={horizon}
            todayDay={analysis.today_day}
            projectStart={analysis.project_start}
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
