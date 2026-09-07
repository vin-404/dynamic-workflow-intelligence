"use client";

import { useCallback, useMemo } from "react";
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

  const bgColor = d.status === "done"
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
        minWidth: 160,
        fontSize: 12,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: "#4c9aff" }} />
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
            background: DEPT_COLORS[d.department] + "22",
            color: DEPT_COLORS[d.department] || "#8b98a5",
          }}
        >
          {d.department}
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
          {d.critical ? "critical" : `slack ${d.slack}d`}
        </span>
      </div>
      <Handle type="source" position={Position.Right} style={{ background: "#4c9aff" }} />
    </div>
  );
}

const nodeTypes = { task: TaskNode };

export default function DependencyGraph({ state }: { state: ProjectState }) {
  // Layout: group by department (horizontal lanes)
  const departments = Object.keys(state.departments);

  const { nodes: initialNodes, edges: initialEdges } = useMemo(() => {
    const LANE_HEIGHT = 120;
    const X_SCALE = 120;
    const X_OFFSET = 50;
    const Y_OFFSET = 40;

    const nodes: Node[] = state.tasks.map((t) => {
      const laneIdx = departments.indexOf(t.department);
      return {
        id: t.task_code,
        type: "task",
        position: {
          x: X_OFFSET + t.es * X_SCALE / 3,
          y: Y_OFFSET + laneIdx * LANE_HEIGHT,
        },
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
      };
    });

    const edges: Edge[] = state.edges.map((e, i) => ({
      id: `e-${e.source}-${e.target}`,
      source: e.source,
      target: e.target,
      type: "default",
      animated: e.kind === "artifact",
      style: {
        stroke: e.kind === "artifact" ? "#4c9aff" : "#2a323d",
        strokeWidth: e.kind === "artifact" ? 1.5 : 1,
        strokeDasharray: e.kind === "temporal" ? "4 3" : undefined,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: e.kind === "artifact" ? "#4c9aff" : "#2a323d",
        width: 12,
        height: 12,
      },
      label: e.kind === "artifact" ? "" : "",
    }));

    return { nodes, edges };
  }, [state, departments]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  return (
    <Card className="h-[calc(100vh-220px)] min-h-[500px]">
      <CardTitle>
        Dependency Graph — departments as lanes, time flows left to right
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
              const dept = (n.data as Record<string, unknown>).department as string;
              return DEPT_COLORS[dept] || "#39424f";
            }}
            style={{ background: "#161b22" }}
          />
        </ReactFlow>
      </div>
      <div className="flex gap-4 mt-2 text-[11px] text-dim flex-wrap">
        <span>
          <span className="inline-block w-4 h-0.5 bg-accent mr-1 align-middle" />
          Artifact dependency (carries staleness)
        </span>
        <span>
          <span
            className="inline-block w-4 h-0.5 mr-1 align-middle"
            style={{ borderTop: "1px dashed #2a323d" }}
          />
          Temporal ordering only
        </span>
        <span className="text-red">Red border = critical path (zero slack)</span>
        <span className="text-green">Green border = done</span>
        <span className="text-amber">Amber border = in review</span>
      </div>
    </Card>
  );
}
