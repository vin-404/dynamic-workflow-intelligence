"use client";

/**
 * The workflow, drawn.
 *
 * Refactored from the prototype's version: the node colouring keyed on a
 * hardcoded department palette, which was the domain leak in the frontend.
 * Colour now means *slack* - the thing that is actually true of every
 * workflow in every domain - and the resource is shown as text, taken from
 * the data.
 *
 * This is a view of the graph the builder edits, not a separate feature.
 */

import { useMemo } from "react";
import {
  Background,
  Controls,
  Edge,
  Handle,
  MarkerType,
  MiniMap,
  Node,
  NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import Dagre from "@dagrejs/dagre";
import { Analysis } from "@/lib/api";
import { Badge, Card, CardTitle } from "./ui";

const STATUS_LABEL: Record<string, string> = {
  done: "Done",
  in_progress: "In progress",
  in_review: "In review",
  blocked: "Blocked",
  not_started: "Not started",
};

type TaskNodeData = {
  label: string;
  taskKey: string;
  assignees: string;
  status: string;
  critical: boolean;
  slack: number;
  duration: number;
  startDate: string;
  endDate: string;
  risk: number | null;
};

function TaskNode({ data }: NodeProps) {
  const d = data as TaskNodeData;
  const background =
    d.status === "done"
      ? "rgba(63, 185, 80, 0.08)"
      : d.critical
        ? "rgba(248, 81, 73, 0.10)"
        : d.slack <= 2
          ? "rgba(227, 179, 65, 0.08)"
          : "rgba(28, 35, 44, 0.6)";
  const border = d.critical
    ? "#f85149"
    : d.slack <= 2
      ? "#e3b341"
      : "#2a323d";

  return (
    <div
      style={{ background, borderColor: border }}
      className="border rounded-md px-2.5 py-2 w-[200px] text-[11px]"
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center justify-between gap-1 mb-0.5">
        <span className="font-mono text-dim">{d.taskKey}</span>
        {d.critical && <span className="text-red text-[10px]">critical</span>}
        {!d.critical && (
          <span className="text-dim text-[10px]">{d.slack}d slack</span>
        )}
      </div>
      <div className="text-foreground leading-tight mb-1">{d.label}</div>
      <div className="text-dim text-[10px] truncate">
        {d.assignees || "unassigned"}
      </div>
      <div className="flex items-center justify-between text-[10px] text-dim mt-0.5">
        <span>{STATUS_LABEL[d.status] ?? d.status}</span>
        <span>{d.duration}d</span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { task: TaskNode };

function layout(nodes: Node[], edges: Edge[]) {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 90 });
  nodes.forEach((n) => g.setNode(n.id, { width: 200, height: 82 }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  Dagre.layout(g);
  return nodes.map((n) => {
    const pos = g.node(n.id);
    return { ...n, position: { x: pos.x - 100, y: pos.y - 41 } };
  });
}

export default function DependencyGraph({ analysis }: { analysis: Analysis }) {
  const { nodes, edges } = useMemo(() => {
    const riskByTask = new Map(
      analysis.risk.tasks.map((t) => [t.task_key, t.score]),
    );
    const rawNodes: Node[] = analysis.tasks.map((task) => ({
      id: task.key,
      type: "task",
      position: { x: 0, y: 0 },
      data: {
        label: task.name,
        taskKey: task.key,
        assignees: task.assignees.join(", "),
        status: task.status,
        critical: task.critical,
        slack: Math.round(task.slack),
        duration: Math.round(task.duration),
        startDate: task.start_date,
        endDate: task.end_date,
        risk: riskByTask.get(task.key) ?? null,
      } satisfies TaskNodeData,
    }));

    const rawEdges: Edge[] = analysis.edges.map((edge) => ({
      id: `${edge.source}-${edge.target}`,
      source: edge.source,
      target: edge.target,
      animated: edge.consumes,
      style: {
        stroke: edge.consumes ? "#4c9aff" : "#2a323d",
        strokeWidth: edge.consumes ? 1.6 : 1.2,
        strokeDasharray: edge.consumes ? undefined : "4 3",
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: edge.consumes ? "#4c9aff" : "#2a323d",
      },
    }));

    return { nodes: layout(rawNodes, rawEdges), edges: rawEdges };
  }, [analysis]);

  if (analysis.tasks.length === 0) {
    return (
      <Card>
        <CardTitle>The workflow</CardTitle>
        <p className="text-dim text-sm">
          Nothing to draw yet. Add tasks and dependencies in the builder.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-0 overflow-hidden">
      <div className="px-4 pt-4 pb-2">
        <CardTitle
          right={
            <div className="flex items-center gap-2">
              <Badge tone="red">critical</Badge>
              <Badge tone="amber">≤2d slack</Badge>
              <Badge tone="accent">artifact edge</Badge>
              <Badge tone="neutral">ordering only</Badge>
            </div>
          }
        >
          The workflow
        </CardTitle>
      </div>
      <div style={{ height: 520 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          proOptions={{ hideAttribution: true }}
          minZoom={0.2}
        >
          <Background gap={20} color="#1c232c" />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) =>
              (n.data as TaskNodeData).critical ? "#f85149" : "#2a323d"
            }
          />
        </ReactFlow>
      </div>
    </Card>
  );
}
