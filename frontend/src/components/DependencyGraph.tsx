"use client";

import { useMemo } from "react";
import {
  ReactFlow,
  Node,
  Edge,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  MarkerType,
  Handle,
  Position,
  NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import Dagre from "@dagrejs/dagre";
import { ProjectState } from "@/lib/api";
import Card, { CardTitle } from "./Card";

// Department colors
const DEPT_COLORS: Record<string, string> = {
  ORG: "#4c9aff",
  FIN: "#e3b341",
  FAC: "#3fb950",
  MKT: "#a371f7",
  SPON: "#f0883e",
};

const STATUS_LABELS: Record<string, string> = {
  done: "Done",
  in_progress: "In Progress",
  in_review: "In Review",
  not_started: "Not Started",
};

function TaskNode({ data }: NodeProps) {
  const d = data as {
    label: string;
    taskCode: string;
    department: string;
    owner: string;
    status: string;
    critical: boolean;
    slack: number;
    startDate: string;
    endDate: string;
  };

  const bgColor =
    d.status === "done"
      ? "rgba(63, 185, 80, 0.08)"
      : d.status === "in_review"
        ? "rgba(227, 179, 65, 0.08)"
        : d.critical
          ? "rgba(248, 81, 73, 0.08)"
          : "rgba(28, 35, 44, 0.5)";

  const borderColor = d.critical
    ? "#f85149"
    : d.status === "done"
      ? "#3fb950"
      : d.status === "in_review"
        ? "#e3b341"
        : "#39424f";

  return (
    <div
      style={{
        background: bgColor,
        border: `${d.critical ? 2 : 1}px solid ${borderColor}`,
        borderRadius: 8,
        padding: "8px 12px",
        minWidth: 180,
        maxWidth: 220,
        fontSize: 12,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: "#4c9aff" }}
      />
      <div className="flex items-center gap-2 mb-1">
        <code
          style={{
            color: DEPT_COLORS[d.department] || "#8b98a5",
            fontWeight: 600,
            fontSize: 11,
          }}
        >
          {d.taskCode}
        </code>
        <span
          style={{
            fontSize: 9,
            padding: "1px 5px",
            borderRadius: 3,
            background: (DEPT_COLORS[d.department] || "#8b98a5") + "22",
            color: DEPT_COLORS[d.department] || "#8b98a5",
          }}
        >
          {d.department}
        </span>
        <span
          style={{
            fontSize: 9,
            padding: "1px 5px",
            borderRadius: 3,
            marginLeft: "auto",
            background:
              d.status === "done"
                ? "rgba(63,185,80,0.15)"
                : d.status === "in_review"
                  ? "rgba(227,179,65,0.15)"
                  : d.status === "in_progress"
                    ? "rgba(76,154,255,0.15)"
                    : "rgba(139,152,165,0.1)",
            color:
              d.status === "done"
                ? "#3fb950"
                : d.status === "in_review"
                  ? "#e3b341"
                  : d.status === "in_progress"
                    ? "#4c9aff"
                    : "#8b98a5",
          }}
        >
          {STATUS_LABELS[d.status] || d.status}
        </span>
      </div>
      <div style={{ color: "#e6edf3", fontSize: 11, lineHeight: 1.3 }}>
        {d.label}
      </div>
      <div
        style={{
          fontSize: 10,
          color: "#8b98a5",
          marginTop: 4,
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>{d.owner}</span>
        <span style={{ color: d.critical ? "#f85149" : undefined }}>
          {d.critical ? "CRITICAL" : `slack ${d.slack}d`}
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        style={{ background: "#4c9aff" }}
      />
    </div>
  );
}

const nodeTypes = { task: TaskNode };

function layoutGraph(
  nodes: Node[],
  edges: Edge[],
  direction: "LR" | "TB" = "LR"
): { nodes: Node[]; edges: Edge[] } {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    nodesep: 40,
    ranksep: 80,
    marginx: 30,
    marginy: 30,
  });

  for (const node of nodes) {
    g.setNode(node.id, { width: 200, height: 80 });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  Dagre.layout(g);

  const laidOut = nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: { x: pos.x - 100, y: pos.y - 40 },
    };
  });

  return { nodes: laidOut, edges };
}

export default function DependencyGraph({ state }: { state: ProjectState }) {
  const { nodes: initialNodes, edges: initialEdges } = useMemo(() => {
    const rawNodes: Node[] = state.tasks.map((t) => ({
      id: t.task_code,
      type: "task",
      position: { x: 0, y: 0 },
      data: {
        label: t.name,
        taskCode: t.task_code,
        department: t.department,
        owner: t.owner,
        status: t.status,
        critical: t.critical,
        slack: t.slack,
        startDate: t.start_date,
        endDate: t.end_date,
      },
    }));

    const criticalSet = new Set(state.critical_path);
    const criticalEdges = new Set<string>();
    for (let i = 0; i < state.critical_path.length - 1; i++) {
      criticalEdges.add(
        `${state.critical_path[i]}->${state.critical_path[i + 1]}`
      );
    }

    const rawEdges: Edge[] = state.edges.map((e) => {
      const isCritical = criticalEdges.has(`${e.source}->${e.target}`);
      return {
        id: `e-${e.source}-${e.target}`,
        source: e.source,
        target: e.target,
        type: "default",
        animated: isCritical,
        style: {
          stroke: isCritical
            ? "#f85149"
            : e.kind === "artifact"
              ? "#4c9aff"
              : "#2a323d",
          strokeWidth: isCritical ? 2 : e.kind === "artifact" ? 1.5 : 1,
          strokeDasharray: e.kind === "temporal" ? "4 3" : undefined,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isCritical
            ? "#f85149"
            : e.kind === "artifact"
              ? "#4c9aff"
              : "#2a323d",
          width: 12,
          height: 12,
        },
      };
    });

    return layoutGraph(rawNodes, rawEdges, "LR");
  }, [state]);

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);

  return (
    <Card className="h-[calc(100vh-220px)] min-h-[500px]">
      <CardTitle>
        Dependency Graph — time flows left to right, red edges = critical path
      </CardTitle>
      <div className="h-[calc(100%-40px)] rounded-md overflow-hidden border border-line">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.3}
          maxZoom={2}
          defaultEdgeOptions={{ type: "default" }}
        >
          <Background color="#1e252e" gap={20} />
          <Controls />
          <MiniMap
            nodeColor={(n) => {
              const dept = (n.data as Record<string, unknown>)
                .department as string;
              return DEPT_COLORS[dept] || "#39424f";
            }}
            style={{ background: "#161b22" }}
          />
        </ReactFlow>
      </div>
      <div className="flex gap-4 mt-2 text-[11px] text-dim flex-wrap">
        {Object.entries(DEPT_COLORS).map(([dept, color]) => (
          <span key={dept} className="flex items-center gap-1">
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm"
              style={{ background: color }}
            />
            {dept}
          </span>
        ))}
        <span className="ml-2">|</span>
        <span>
          <span className="inline-block w-4 h-0.5 bg-red mr-1 align-middle" />
          Critical path (animated)
        </span>
        <span>
          <span className="inline-block w-4 h-0.5 bg-accent mr-1 align-middle" />
          Artifact dependency
        </span>
        <span>
          <span
            className="inline-block w-4 h-0.5 mr-1 align-middle"
            style={{ borderTop: "1px dashed #2a323d" }}
          />
          Temporal ordering
        </span>
      </div>
    </Card>
  );
}
