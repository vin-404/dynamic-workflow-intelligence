"use client";

import { useState } from "react";
import { ProjectState } from "@/lib/api";

interface Step {
  title: string;
  description: string;
  tab: string;
  highlight?: string;
}

const STEPS: Step[] = [
  {
    title: "The Project Is Late",
    description:
      "This campus tech symposium is 4 days behind schedule. The dashboard shows planned finish vs projected finish, and 4 detected bottlenecks. No one told the system it's late — it computed the delay from the event log.",
    tab: "dashboard",
  },
  {
    title: "Why Are We Late?",
    description:
      "The engine traced the delay to its root cause: T03 (budget approval) has been stalled in review for 9 days on the critical path. It ranks all bottlenecks by impact score — a formula (days lost x downstream tasks), not AI guesswork.",
    tab: "why-late",
  },
  {
    title: "Bottleneck Inbox",
    description:
      "Four bottlenecks detected with 100% precision: a critical path blocker, a stalled review, resource contention in marketing (2 tasks, 1 person), and an idle task. Each has evidence, root cause, and a suggested action.",
    tab: "bottlenecks",
  },
  {
    title: "What If T03 Slips 5 More Days?",
    description:
      "Select T03 and add 5 days. The engine propagates the delay through the dependency graph: 7 downstream tasks move, the project finish shifts from day 26 to day 31, and it tells you exactly who to notify.",
    tab: "simulate",
    highlight: "delay",
  },
  {
    title: "What If a Requirement Changes?",
    description:
      "Select R2 (venue layout spec). The engine traces which tasks consumed this artifact and which are merely downstream. 4 tasks must be redone, 1 needs re-checking. 2 days of completed work are invalidated. A task board cannot do this.",
    tab: "simulate",
    highlight: "requirement",
  },
  {
    title: "Dependency Graph",
    description:
      "The full dependency graph with 17 tasks. Red edges highlight the critical path. Blue edges carry artifact dependencies (which propagate staleness). Dashed edges are temporal ordering only.",
    tab: "graph",
  },
  {
    title: "All Tasks",
    description:
      "Every task with its computed schedule (ES, EF, LS, LF), slack, and dependencies. Critical path tasks are highlighted in red with zero slack — any delay on these directly delays the project.",
    tab: "tasks",
  },
];

export default function DemoWalkthrough({
  currentTab,
  onNavigate,
  visible,
  onToggle,
}: {
  currentTab: string;
  onNavigate: (tab: string) => void;
  visible: boolean;
  onToggle: () => void;
}) {
  const [stepIdx, setStepIdx] = useState(0);
  const step = STEPS[stepIdx];

  if (!visible) {
    return (
      <button
        onClick={onToggle}
        className="fixed bottom-5 right-5 px-4 py-2.5 bg-accent text-background rounded-lg text-sm font-semibold shadow-lg hover:opacity-90 transition-opacity z-50"
      >
        Start Guided Demo
      </button>
    );
  }

  function goTo(idx: number) {
    setStepIdx(idx);
    onNavigate(STEPS[idx].tab);
  }

  return (
    <div className="fixed bottom-5 right-5 w-[420px] bg-panel border border-line rounded-xl shadow-2xl z-50 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-panel2 border-b border-line">
        <span className="text-xs font-semibold text-accent tracking-wide uppercase">
          Guided Demo
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-dim">
            {stepIdx + 1} / {STEPS.length}
          </span>
          <button
            onClick={onToggle}
            className="text-dim hover:text-foreground text-lg leading-none"
          >
            x
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-0.5 bg-line">
        <div
          className="h-full bg-accent transition-all duration-300"
          style={{ width: `${((stepIdx + 1) / STEPS.length) * 100}%` }}
        />
      </div>

      {/* Content */}
      <div className="p-4">
        <h3 className="text-sm font-semibold mb-2">{step.title}</h3>
        <p className="text-[13px] text-dim leading-relaxed">
          {step.description}
        </p>
      </div>

      {/* Step dots */}
      <div className="flex justify-center gap-1.5 pb-2">
        {STEPS.map((_, i) => (
          <button
            key={i}
            onClick={() => goTo(i)}
            className={`w-1.5 h-1.5 rounded-full transition-colors ${
              i === stepIdx
                ? "bg-accent"
                : i < stepIdx
                  ? "bg-accent/40"
                  : "bg-line"
            }`}
          />
        ))}
      </div>

      {/* Navigation */}
      <div className="flex gap-2 px-4 pb-4">
        <button
          onClick={() => goTo(Math.max(0, stepIdx - 1))}
          disabled={stepIdx === 0}
          className="flex-1 px-3 py-2 text-sm bg-panel2 rounded-md hover:bg-line/50 disabled:opacity-30 transition-colors"
        >
          Back
        </button>
        {stepIdx < STEPS.length - 1 ? (
          <button
            onClick={() => goTo(stepIdx + 1)}
            className="flex-1 px-3 py-2 text-sm bg-accent text-background rounded-md font-semibold hover:opacity-90 transition-colors"
          >
            Next
          </button>
        ) : (
          <button
            onClick={onToggle}
            className="flex-1 px-3 py-2 text-sm bg-green text-background rounded-md font-semibold hover:opacity-90 transition-colors"
          >
            Finish
          </button>
        )}
      </div>
    </div>
  );
}
