"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Analysis,
  ApiError,
  Domain,
  Project,
  Workflow,
  analyze,
  getWorkflow,
  listDomains,
  listProjects,
} from "@/lib/api";

import DependencyGraph from "@/components/DependencyGraph";
import ErrorBoundary from "@/components/ErrorBoundary";
import { IdentityBadge, useIdentity } from "@/components/Identity";
import AskPanel from "@/components/AskPanel";
import Explainer from "@/components/Explainer";
import FindingsPanel from "@/components/FindingsPanel";
import OptimizePanel from "@/components/OptimizePanel";
import RiskPanel from "@/components/RiskPanel";
import VersionHistory from "@/components/VersionHistory";
import WhatIfPanel from "@/components/WhatIfPanel";
import WorkflowBuilder from "@/components/WorkflowBuilder";
import ForecastPanel from "@/components/ForecastPanel";
import ImportPanel from "@/components/ImportPanel";
import LiveFeed from "@/components/LiveFeed";
import RequirementChange from "@/components/RequirementChange";
import { MemberList, ProjectCreate } from "@/components/SetupPanel";

import {
  Badge,
  Button,
  Card,
  CardTitle,
  EmptyState,
  ErrorNote,
  Section,
  Spinner,
  days,
} from "@/components/ui";

type Stage =
  | "build"
  | "live"
  | "analyze"
  | "risk"
  | "requirements"
  | "whatif"
  | "optimize"
  | "history";

const STAGES: {
  id: Stage;
  label: string;
  description: string;
  icon: string;
  needsWorkflow: boolean;
}[] = [
  {
    id: "build",
    label: "Build",
    description: "Define the workflow",
    icon: "⌘",
    needsWorkflow: false,
  },
  {
    id: "live",
    label: "Live",
    description: "Watch it happen",
    icon: "◉",
    needsWorkflow: true,
  },
  {
    id: "analyze",
    label: "Bottlenecks",
    description: "Find what's stuck",
    icon: "↗",
    needsWorkflow: true,
  },
  {
    id: "risk",
    label: "Risk & forecast",
    description: "See what's next",
    icon: "◌",
    needsWorkflow: true,
  },
  {
    id: "requirements",
    label: "Requirements",
    description: "Track changes",
    icon: "✦",
    needsWorkflow: true,
  },
  {
    id: "whatif",
    label: "What if",
    description: "Test a change",
    icon: "◇",
    needsWorkflow: true,
  },
  {
    id: "optimize",
    label: "Better workflows",
    description: "Improve the plan",
    icon: "↯",
    needsWorkflow: true,
  },
  {
    id: "history",
    label: "History",
    description: "Review versions",
    icon: "↺",
    needsWorkflow: false,
  },
];

const QUESTION_STAGES: Stage[] = [
  "analyze",
  "analyze",
  "risk",
  "whatif",
  "analyze",
  "build",
];

const STORY_QUESTIONS = [
  {
    number: "01",
    title: "Why are we late?",
    description:
      "Trace delays back to the work and dependencies causing them.",
  },
  {
    number: "02",
    title: "What's blocking the project?",
    description:
      "Find the work holding back the most downstream activity.",
  },
  {
    number: "03",
    title: "What could go wrong next?",
    description:
      "Surface emerging risks from the current workflow state.",
  },
  {
    number: "04",
    title: "What happens if something changes?",
    description:
      "Test delays and requirement changes before making the decision.",
  },
  {
    number: "05",
    title: "What does this task affect?",
    description:
      "Follow dependencies and see the downstream impact.",
  },
  {
    number: "06",
    title: "What work exists?",
    description:
      "Inspect tasks, ownership, progress, and critical work.",
  },
];

const WALKTHROUGH = [
  ["01", "Build", "Define the work and who owns it."],
  ["02", "Live", "Watch the workflow move through time."],
  ["03", "Bottlenecks", "Find what's holding everything up."],
  ["04", "Risk & forecast", "See what could become a problem."],
  ["05", "What if", "Change something and see the impact."],
  ["06", "Better workflows", "Explore a stronger arrangement."],
];

function FlowLogo({
  compact = false,
}: {
  compact?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <svg
        width={compact ? 42 : 48}
        height={compact ? 42 : 48}
        viewBox="0 0 48 48"
        fill="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient
            id="flowtraceLogoGradient"
            x1="5"
            y1="5"
            x2="43"
            y2="43"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#4164FA" />
            <stop offset="1" stopColor="#795CF7" />
          </linearGradient>
        </defs>

        <rect
          x="4"
          y="4"
          width="40"
          height="40"
          rx="12"
          fill="url(#flowtraceLogoGradient)"
        />

        <path
          d="M14 16H22C25.314 16 28 18.686 28 22V26C28 29.314 30.686 32 34 32H35"
          stroke="white"
          strokeWidth="3"
          strokeLinecap="round"
        />

        <path
          d="M14 32H20C23.314 32 26 29.314 26 26V22C26 18.686 28.686 16 32 16H35"
          stroke="white"
          strokeWidth="3"
          strokeLinecap="round"
        />

        <circle cx="14" cy="16" r="3" fill="white" />
        <circle cx="14" cy="32" r="3" fill="white" />
        <circle cx="35" cy="16" r="3" fill="white" />
        <circle cx="35" cy="32" r="3" fill="white" />
      </svg>

      {!compact && (
        <div>
          <div className="text-[20px] font-semibold tracking-[-0.04em]">
            Flow<span className="text-[#4164FA]">Trace</span>
          </div>
          <div className="text-[8px] uppercase tracking-[0.2em] text-[#68677A]">
            Workflow Intelligence
          </div>
        </div>
      )}
    </div>
  );
}

function LandingPage({
  darkMode,
  onOpenWorkspace,
  onHowItWorks,
  onQuestion,
}: {
  darkMode: boolean;
  onOpenWorkspace: () => void;
  onHowItWorks: () => void;
  onQuestion: (stage: Stage) => void;
}) {
  const [delay, setDelay] = useState(3);

  const impact =
    delay === 1
      ? { tasks: 4, teams: 1, days: 2 }
      : delay === 7
        ? { tasks: 12, teams: 3, days: 8 }
        : { tasks: 7, teams: 2, days: 4 };

  const text = darkMode ? "text-white" : "text-[#17172A]";
  const muted = darkMode ? "text-white/55" : "text-[#68677A]";

  return (
    <div
      className={
        darkMode
          ? "flowtrace-landing-dark bg-[#0B0E1B] text-white"
          : "flowtrace-landing bg-[#F7F7FC] text-[#17172A]"
      }
    >
      <section className="relative min-h-screen overflow-hidden flex flex-col">
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div className="absolute -top-40 -left-40 w-[650px] h-[650px] rounded-full bg-[#4164FA]/10 blur-[130px]" />
          <div className="absolute top-10 -right-40 w-[700px] h-[700px] rounded-full bg-[#795CF7]/10 blur-[140px]" />
          <div className="absolute bottom-[-300px] left-1/3 w-[650px] h-[650px] rounded-full bg-[#4164FA]/8 blur-[140px]" />
        </div>

        <div className="absolute inset-0 opacity-40 pointer-events-none">
          <div
            className="absolute inset-0"
            style={{
              backgroundImage:
                "linear-gradient(rgba(65,100,250,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(65,100,250,0.045) 1px, transparent 1px)",
              backgroundSize: "50px 50px",
            }}
          />
        </div>

        <header className="relative z-30 w-full px-5 md:px-8 lg:px-10 pt-6">
          <div className="max-w-[1450px] mx-auto flex items-center justify-between">
            <button
              onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
              className="group"
            >
              <FlowLogo />
            </button>

            <nav className="absolute left-1/2 -translate-x-1/2 hidden lg:flex items-center gap-1 px-2 py-2 rounded-full border border-white/80 bg-white/75 backdrop-blur-xl shadow-[0_14px_45px_rgba(31,35,70,0.10)]">
              <button
                onClick={onOpenWorkspace}
                className="px-5 py-2.5 rounded-full text-sm text-[#68677A] hover:text-[#17172A] hover:bg-white transition-all"
              >
                Product
              </button>
              <button
                onClick={onHowItWorks}
                className="px-5 py-2.5 rounded-full text-sm text-[#68677A] hover:text-[#17172A] hover:bg-white transition-all"
              >
                How It Works
              </button>
              <button
                onClick={onOpenWorkspace}
                className="px-5 py-2.5 rounded-full text-sm text-[#68677A] hover:text-[#17172A] hover:bg-white transition-all"
              >
                Features
              </button>
              <button
                onClick={onOpenWorkspace}
                className="px-5 py-2.5 rounded-full text-sm text-[#68677A] hover:text-[#17172A] hover:bg-white transition-all"
              >
                Use Cases
              </button>
            </nav>

            <div className="flex items-center gap-2 md:gap-3">
              <button
                type="button"
                onClick={() => {
                  const next = !darkMode;
                  window.dispatchEvent(
                    new CustomEvent("flowtrace-theme-toggle", {
                      detail: next,
                    }),
                  );
                }}
                className={
                  darkMode
                    ? "w-10 h-10 rounded-full border border-white/10 bg-white/5 text-white flex items-center justify-center transition-all hover:bg-white/10"
                    : "w-10 h-10 rounded-full border border-[#E2E1EC] bg-white text-[#68677A] flex items-center justify-center transition-all hover:border-[#4164FA]/30 hover:text-[#4164FA]"
                }
                title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
                aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"}
              >
                {darkMode ? "☀" : "☾"}
              </button>

              <button
                type="button"
                onClick={() => { window.location.href = "/login"; }}
                className="hidden sm:block px-4 py-2.5 text-sm font-medium text-[#68677A] hover:text-[#17172A]"
              >
                Log in
              </button>

              <button
                onClick={onOpenWorkspace}
                className="px-5 md:px-6 py-3 rounded-full text-sm font-semibold text-white bg-gradient-to-r from-[#4164FA] to-[#795CF7] shadow-lg shadow-[#4164FA]/20 hover:-translate-y-0.5 transition-all"
              >
                Open workspace
                <span className="ml-2">↗</span>
              </button>
            </div>
          </div>
        </header>

        <div className="relative z-10 flex-1 flex items-center px-6 md:px-10 lg:px-16 py-12">
          <div className="max-w-[1500px] w-full mx-auto">
            <div className="grid lg:grid-cols-[0.85fr_1.15fr] gap-12 xl:gap-20 items-center">
              <div className="max-w-2xl">
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-[#4164FA]/15 bg-white/70 text-xs font-medium text-[#4164FA] mb-7">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#4164FA] animate-pulse" />
                  Workflow intelligence
                </div>

                <h1 className="text-[56px] sm:text-[68px] lg:text-[76px] xl:text-[88px] leading-[0.94] tracking-[-0.055em] font-semibold">
                  See the flow.
                  <br />
                  <span className="bg-gradient-to-r from-[#4164FA] to-[#795CF7] bg-clip-text text-transparent">
                    Understand what's next.
                  </span>
                </h1>

                <p className={`mt-8 text-base md:text-lg leading-8 max-w-xl ${muted}`}>
                  FlowTrace turns complex workflows into an intelligent visual
                  map, helping teams understand dependencies, identify
                  bottlenecks, and anticipate what happens next.
                </p>

                <div className="flex flex-wrap gap-4 mt-9">
                  <button
                    onClick={onOpenWorkspace}
                    className="px-6 py-3.5 rounded-xl text-sm font-medium text-white bg-gradient-to-r from-[#4164FA] to-[#795CF7] shadow-xl shadow-[#4164FA]/20 hover:-translate-y-1 transition-all"
                  >
                    Explore FlowTrace →
                  </button>

                  <button
                    onClick={onHowItWorks}
                    className="px-6 py-3.5 rounded-xl text-sm font-medium border border-[#DAD9E7] bg-white/70 hover:bg-white hover:border-[#4164FA]/30 transition-all"
                  >
                    See how it works
                  </button>
                </div>

                <div className="flex items-center gap-7 mt-10">
                  <div>
                    <div className="text-sm font-semibold">Dependencies</div>
                    <div className={`text-xs mt-1 ${muted}`}>
                      mapped visually
                    </div>
                  </div>

                  <div className="w-px h-8 bg-[#E2E1EC]" />

                  <div>
                    <div className="text-sm font-semibold">Bottlenecks</div>
                    <div className={`text-xs mt-1 ${muted}`}>
                      surfaced early
                    </div>
                  </div>

                  <div className="w-px h-8 bg-[#E2E1EC]" />

                  <div>
                    <div className="text-sm font-semibold">Next steps</div>
                    <div className={`text-xs mt-1 ${muted}`}>
                      easier to understand
                    </div>
                  </div>
                </div>
              </div>

              <div className="relative h-[500px] flex items-center justify-center">
                <div className="absolute w-[450px] h-[450px] rounded-full bg-[#4164FA]/10 blur-[100px]" />

                <div className="relative w-full max-w-[700px] h-[480px] rounded-[32px] border border-white bg-white/75 backdrop-blur-xl shadow-[0_30px_100px_rgba(31,35,70,0.12)] overflow-hidden">
                  <div
                    className="absolute inset-0 opacity-50"
                    style={{
                      backgroundImage:
                        "radial-gradient(circle, rgba(65,100,250,0.15) 1px, transparent 1px)",
                      backgroundSize: "22px 22px",
                    }}
                  />

                  <div className="absolute top-6 left-6 right-6 flex justify-between items-center">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.18em] text-[#68677A]">
                        Live workflow
                      </div>
                      <div className="text-sm font-semibold mt-1">
                        Product Launch
                      </div>
                    </div>

                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#F0EBFF] text-[#795CF7] text-[10px] font-medium">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#795CF7] animate-pulse" />
                      Intelligence active
                    </div>
                  </div>

                  <svg
                    className="absolute inset-0 w-full h-full pointer-events-none"
                    viewBox="0 0 700 480"
                  >
                    <path
                      d="M145 190 C210 190 205 125 285 125"
                      stroke="#4164FA"
                      strokeWidth="2"
                      strokeDasharray="7 7"
                      fill="none"
                    />
                    <path
                      d="M145 190 C210 190 205 255 285 255"
                      stroke="#795CF7"
                      strokeWidth="2"
                      strokeDasharray="7 7"
                      fill="none"
                    />
                    <path
                      d="M365 125 C430 125 430 190 505 190"
                      stroke="#4164FA"
                      strokeWidth="2"
                      strokeDasharray="7 7"
                      fill="none"
                    />
                    <path
                      d="M365 255 C430 255 430 190 505 190"
                      stroke="#795CF7"
                      strokeWidth="2"
                      strokeDasharray="7 7"
                      fill="none"
                    />
                    <path
                      d="M580 190 C625 190 625 315 570 315"
                      stroke="#4164FA"
                      strokeWidth="2"
                      strokeDasharray="7 7"
                      fill="none"
                    />
                  </svg>

                  <LandingNode
                    className="left-[5%] top-[31%]"
                    accent="blue"
                    label="Research"
                    title="Market analysis"
                    footer="82% complete"
                  />

                  <LandingNode
                    className="left-[40%] top-[19%]"
                    accent="violet"
                    label="Design"
                    title="Product review"
                    footer="3 dependencies"
                  />

                  <LandingNode
                    className="left-[40%] top-[49%]"
                    accent="blue"
                    label="Development"
                    title="Build release"
                    footer="On critical path"
                  />

                  <LandingNode
                    className="right-[5%] top-[31%]"
                    accent="violet"
                    label="Review"
                    title="QA approval"
                    footer="Bottleneck"
                  />

                  <div className="absolute left-[50%] bottom-[8%] w-[220px] p-4 rounded-2xl bg-[#101522] text-white shadow-2xl">
                    <div className="text-[9px] uppercase tracking-[0.18em] text-white/50">
                      Predicted next
                    </div>
                    <div className="text-sm font-semibold mt-1">
                      Launch preparation
                    </div>
                    <div className="text-[10px] text-white/50 mt-2">
                      Based on connected workflow state
                    </div>
                  </div>

                  <div className="absolute right-5 bottom-5 px-3 py-2 rounded-xl bg-[#EAF0FF] text-[#4164FA] text-[10px] font-medium">
                    6 connected tasks
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <button
          onClick={onOpenWorkspace}
          className="relative z-20 mx-auto mb-7 flex flex-col items-center gap-2 text-[#68677A] hover:text-[#4164FA] transition-colors"
        >
          <span className="text-[9px] uppercase tracking-[0.22em]">
            Explore workspace
          </span>
          <span className="text-lg animate-bounce">↓</span>
        </button>
      </section>

      <section
        id="how-it-works"
        className={`px-6 md:px-10 lg:px-16 py-24 border-y ${
          darkMode
            ? "bg-[#0F1320] border-[#2B3045]"
            : "bg-white border-[#E2E1EC]"
        }`}
      >
        <div className="max-w-[1200px] mx-auto">
          <div className="max-w-2xl mb-16">
            <div className="text-xs uppercase tracking-[0.2em] text-[#4164FA] font-semibold">
              How FlowTrace thinks
            </div>

            <h2 className={`text-4xl md:text-5xl font-semibold tracking-tight mt-4 ${text}`}>
              From tasks to the bigger picture.
            </h2>

            <p className={`leading-7 mt-5 max-w-xl ${muted}`}>
              FlowTrace connects the pieces of your workflow so you can see
              what is happening now, what is causing friction, and what could
              happen next.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-10">
            <StoryStep number="01" title="See" color="blue">
              Visualize how tasks, milestones and dependencies connect.
            </StoryStep>

            <StoryStep number="02" title="Understand" color="violet">
              Surface bottlenecks and understand why work is slowing down.
            </StoryStep>

            <StoryStep number="03" title="Anticipate" color="blue">
              Understand what is likely to happen next before it happens.
            </StoryStep>
          </div>
        </div>
      </section>

      <section
        className={`px-6 md:px-10 lg:px-16 py-24 ${
          darkMode ? "bg-[#0D1120]" : "bg-[#F7F7FC]"
        }`}
      >
        <div className="max-w-[1200px] mx-auto">
          <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-8 mb-12">
            <div className="max-w-2xl">
              <div className="text-xs uppercase tracking-[0.2em] text-[#795CF7] font-semibold">
                Impact ripple
              </div>

              <h2 className={`text-4xl md:text-5xl font-semibold tracking-[-0.04em] mt-4 ${text}`}>
                See what happens when the plan changes.
              </h2>

              <p className={`mt-5 leading-7 ${muted}`}>
                Move one task and FlowTrace follows the dependency chain so you
                can see the likely downstream effect before making the call.
              </p>
            </div>

            <div
              className={`flex items-center gap-2 p-1.5 rounded-2xl border ${
                darkMode
                  ? "border-[#2B3045] bg-[#121729]"
                  : "border-[#E2E1EC] bg-white"
              }`}
            >
              {[1, 3, 7].map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setDelay(value)}
                  className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
                    delay === value
                      ? "bg-gradient-to-r from-[#4164FA] to-[#795CF7] text-white shadow-lg shadow-[#4164FA]/20"
                      : darkMode
                        ? "text-white/55 hover:text-white hover:bg-white/5"
                        : "text-[#68677A] hover:text-[#17172A] hover:bg-[#F7F7FC]"
                  }`}
                >
                  +{value} day{value === 1 ? "" : "s"}
                </button>
              ))}
            </div>
          </div>

          <div
            className={`rounded-[28px] border overflow-hidden ${
              darkMode
                ? "border-[#2B3045] bg-[#121729]"
                : "border-[#E2E1EC] bg-white"
            }`}
          >
            <div className="grid lg:grid-cols-[1.2fr_0.8fr]">
              <div className="relative min-h-[360px] p-8 md:p-12 overflow-hidden">
                <div className="absolute inset-0 opacity-60 pointer-events-none">
                  <div
                    className="absolute inset-0"
                    style={{
                      backgroundImage:
                        "radial-gradient(circle, rgba(65,100,250,0.09) 1px, transparent 1px)",
                      backgroundSize: "24px 24px",
                    }}
                  />
                </div>

                <div className="relative h-full min-h-[280px]">
                  <RippleNode
                    className="left-[8%] top-[40%]"
                    color="blue"
                    label="Changed"
                    title="Design review"
                    footer={`+${delay} days`}
                  />

                  <RippleNode
                    className="left-[39%] top-[20%]"
                    color="violet"
                    label="Affected"
                    title="Development"
                    footer="downstream"
                  />

                  <RippleNode
                    className="left-[39%] bottom-[8%]"
                    color="blue"
                    label="Affected"
                    title="QA approval"
                    footer="downstream"
                  />

                  <div className="absolute right-[7%] top-[40%] w-[170px] rounded-2xl bg-[#101522] text-white p-4 shadow-xl">
                    <div className="text-[10px] uppercase tracking-[0.16em] text-white/45">
                      Projected
                    </div>
                    <div className="text-sm font-semibold mt-2">Launch</div>
                    <div className="text-xs text-[#AFC0FF] mt-2">
                      +{impact.days} days
                    </div>
                  </div>

                  <svg
                    className="absolute inset-0 w-full h-full pointer-events-none"
                    viewBox="0 0 800 360"
                    preserveAspectRatio="none"
                  >
                    <path
                      d="M150 180 C245 180 250 90 330 90"
                      stroke="#4164FA"
                      strokeWidth="2"
                      strokeDasharray="7 7"
                      fill="none"
                    />
                    <path
                      d="M150 180 C245 180 250 280 330 280"
                      stroke="#795CF7"
                      strokeWidth="2"
                      strokeDasharray="7 7"
                      fill="none"
                    />
                    <path
                      d="M480 90 C560 90 585 180 635 180"
                      stroke="#795CF7"
                      strokeWidth="2"
                      strokeDasharray="7 7"
                      fill="none"
                    />
                    <path
                      d="M480 280 C560 280 585 180 635 180"
                      stroke="#4164FA"
                      strokeWidth="2"
                      strokeDasharray="7 7"
                      fill="none"
                    />
                  </svg>
                </div>
              </div>

              <div
                className={`border-t lg:border-t-0 lg:border-l p-8 md:p-10 flex flex-col justify-center ${
                  darkMode
                    ? "border-[#2B3045]"
                    : "border-[#E2E1EC]"
                }`}
              >
                <div className={`text-xs uppercase tracking-[0.18em] ${muted}`}>
                  Impact summary
                </div>

                <div className={`text-5xl font-semibold tracking-[-0.05em] mt-4 ${text}`}>
                  +{impact.days}d
                </div>

                <p className={`mt-2 text-sm ${muted}`}>
                  projected launch movement
                </p>

                <div className="grid grid-cols-2 gap-3 mt-8">
                  <ImpactMetric value={impact.tasks} label="downstream tasks" darkMode={darkMode} />
                  <ImpactMetric value={impact.teams} label="teams affected" darkMode={darkMode} />
                </div>

                <button
                  type="button"
                  onClick={() => onQuestion("whatif")}
                  className="mt-7 inline-flex items-center justify-center px-5 py-3 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-[#4164FA] to-[#795CF7] hover:-translate-y-0.5 transition-all"
                >
                  Try this in What if →
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section
        className={`px-6 md:px-10 lg:px-16 py-24 ${
          darkMode ? "bg-[#0B0E1B]" : "bg-white"
        }`}
      >
        <div className="max-w-[1400px] mx-auto">
          <div className="max-w-3xl">
            <div className="text-xs uppercase tracking-[0.2em] text-[#4164FA] font-semibold">
              Questions FlowTrace answers
            </div>

            <h2 className={`text-4xl md:text-6xl font-semibold tracking-[-0.05em] mt-4 leading-[0.98] ${text}`}>
              What do you want to understand?
            </h2>

            <p className={`text-lg leading-8 mt-6 max-w-2xl ${muted}`}>
              You do not need to know the system first. Start with the question
              you are trying to answer. The workspace is where you investigate
              it.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-5 mt-14">
            {STORY_QUESTIONS.map((question, index) => (
              <button
                key={question.number}
                type="button"
                onClick={() => onQuestion(QUESTION_STAGES[index])}
                className={`min-h-[190px] text-left rounded-[24px] border p-8 md:p-9 ${
                  darkMode
                    ? "border-[#2B3045] bg-[#111525]"
                    : "border-[#E2E1EC] bg-[#F9F9FD]"
                } hover:border-[#4164FA]/35 hover:-translate-y-0.5 transition-all group`}
              >
                <div className="flex items-start justify-between gap-6">
                  <span className="text-sm font-semibold text-[#4164FA]">
                    {question.number}
                  </span>

                  <span
                    className={`text-xl ${
                      darkMode ? "text-white/40" : "text-[#68677A]"
                    } group-hover:text-[#4164FA] transition-colors`}
                  >
                    →
                  </span>
                </div>

                <h3 className={`text-2xl md:text-[28px] font-semibold tracking-[-0.03em] mt-7 ${text}`}>
                  {question.title}
                </h3>

                <p className={`text-sm md:text-base leading-7 mt-4 max-w-xl ${muted}`}>
                  {question.description}
                </p>

                <div className="text-[10px] uppercase tracking-[0.18em] mt-7 text-[#4164FA] opacity-70 group-hover:opacity-100">
                  Open the answer →
                </div>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="relative overflow-hidden bg-[#0F1320] text-white px-6 md:px-10 lg:px-16 py-24">
        <div className="absolute inset-0 pointer-events-none opacity-60">
          <div className="absolute -top-40 -left-20 w-[500px] h-[500px] rounded-full bg-[#4164FA]/15 blur-[120px]" />
          <div className="absolute -bottom-40 right-0 w-[550px] h-[550px] rounded-full bg-[#795CF7]/15 blur-[130px]" />
        </div>

        <div className="relative max-w-[1350px] mx-auto grid lg:grid-cols-[0.75fr_1.25fr] gap-14 items-center">
          <div className="max-w-xl">
            <div className="text-xs uppercase tracking-[0.2em] text-[#8FA8FF] font-semibold">
              New to FlowTrace?
            </div>

            <h2 className="text-5xl md:text-6xl font-semibold tracking-[-0.05em] mt-5 leading-[0.96]">
              Try it in <span className="text-[#8FA8FF]">60 seconds.</span>
            </h2>

            <p className="text-white/55 text-lg leading-8 mt-7 max-w-lg">
              Follow this path and you will see the core idea of FlowTrace
              without needing to understand every screen first.
            </p>

            <button
              type="button"
              onClick={onOpenWorkspace}
              className="mt-9 px-6 py-3.5 rounded-xl bg-white text-[#17172A] text-sm font-semibold hover:-translate-y-0.5 transition-all"
            >
              Open the workspace →
            </button>
          </div>

          <div>
            <div className="relative">
              <div className="absolute left-[17px] top-5 bottom-5 w-px bg-gradient-to-b from-[#4164FA]/70 via-white/15 to-[#795CF7]/70" />

              <div className="space-y-3">
                {WALKTHROUGH.map(([number, title, description], index) => (
                  <div
                    key={number}
                    className="relative flex items-center gap-5 rounded-2xl border border-white/10 bg-white/[0.035] px-5 md:px-6 py-5"
                  >
                    <div className="relative z-10 w-9 h-9 shrink-0 rounded-full border border-[#8FA8FF]/30 bg-[#111525] flex items-center justify-center text-xs font-semibold text-[#8FA8FF]">
                      {number}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="text-lg font-semibold">{title}</span>

                        {index === 0 && (
                          <span className="text-[9px] uppercase tracking-[0.16em] text-[#8FA8FF] border border-[#8FA8FF]/20 rounded-full px-2 py-1">
                            Start here
                          </span>
                        )}
                      </div>

                      <span className="block text-sm text-white/45 mt-1">
                        {description}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-6">
              <button
                type="button"
                onClick={onOpenWorkspace}
                className="px-6 py-3.5 rounded-xl bg-white text-[#17172A] text-sm font-semibold hover:-translate-y-0.5 transition-all"
              >
                Open the workspace →
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function LandingNode({
  className,
  accent,
  label,
  title,
  footer,
}: {
  className: string;
  accent: "blue" | "violet";
  label: string;
  title: string;
  footer: string;
}) {
  const color = accent === "blue" ? "#4164FA" : "#795CF7";

  return (
    <div
      className={`absolute w-[165px] p-4 rounded-2xl bg-white border border-[#E2E1EC] shadow-xl ${className}`}
    >
      <div className="flex items-center gap-2">
        <span
          className="w-2 h-2 rounded-full"
          style={{ backgroundColor: color }}
        />
        <span className="text-[10px] uppercase tracking-wider text-[#68677A]">
          {label}
        </span>
      </div>

      <div className="text-sm font-semibold mt-2">{title}</div>

      {label === "Research" ? (
        <div className="mt-3 h-1.5 rounded-full bg-[#EAF0FF]">
          <div className="w-[82%] h-full rounded-full bg-[#4164FA]" />
        </div>
      ) : (
        <div
          className="text-[10px] mt-2 font-medium"
          style={{ color }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}

function StoryStep({
  number,
  title,
  color,
  children,
}: {
  number: string;
  title: string;
  color: "blue" | "violet";
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        className={
          color === "blue"
            ? "text-sm font-semibold text-[#4164FA]"
            : "text-sm font-semibold text-[#795CF7]"
        }
      >
        {number}
      </div>

      <h3 className="text-2xl font-semibold mt-3">{title}</h3>

      <p className="text-sm leading-7 text-[#68677A] mt-3">{children}</p>
    </div>
  );
}

function RippleNode({
  className,
  color,
  label,
  title,
  footer,
}: {
  className: string;
  color: "blue" | "violet";
  label: string;
  title: string;
  footer: string;
}) {
  const isBlue = color === "blue";

  return (
    <div
      className={`absolute w-[150px] rounded-2xl border p-4 ${
        isBlue
          ? "border-[#4164FA]/25 bg-[#4164FA]/[0.08]"
          : "border-[#795CF7]/25 bg-[#795CF7]/[0.08]"
      } ${className}`}
    >
      <div
        className={
          isBlue
            ? "text-[10px] uppercase tracking-[0.16em] text-[#4164FA]"
            : "text-[10px] uppercase tracking-[0.16em] text-[#795CF7]"
        }
      >
        {label}
      </div>

      <div className="text-sm font-semibold mt-2">{title}</div>

      <div
        className={
          isBlue
            ? "text-xs text-[#4164FA] mt-2 font-medium"
            : "text-xs text-[#795CF7] mt-2 font-medium"
        }
      >
        {footer}
      </div>
    </div>
  );
}

function ImpactMetric({
  value,
  label,
  darkMode,
}: {
  value: number;
  label: string;
  darkMode: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border p-4 ${
        darkMode
          ? "border-[#2B3045] bg-white/[0.03]"
          : "border-[#E2E1EC] bg-[#F7F7FC]"
      }`}
    >
      <div className="text-2xl font-semibold">{value}</div>
      <div
        className={`text-xs mt-1 ${
          darkMode ? "text-white/50" : "text-[#68677A]"
        }`}
      >
        {label}
      </div>
    </div>
  );
}

export default function Home() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [stage, setStage] = useState<Stage>("build");
  const [pendingStage, setPendingStage] = useState<Stage>("build");
  const [viewVersion, setViewVersion] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<ApiError | string | null>(null);
  const [busy, setBusy] = useState(false);
  const [booted, setBooted] = useState(false);
  const [darkMode, setDarkMode] = useState(false);

  const { person, failed: identityFailed } = useIdentity();

  const load = useCallback(
    async (projectId: string, versionId?: string | null) => {
      setBusy(true);
      setError(null);

      try {
        const wf = await getWorkflow(projectId, versionId ?? undefined);
        setWorkflow(wf);
        setAnalysis(null);
      } catch (e) {
        setError(e instanceof ApiError ? e : String(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const runAnalysis = useCallback(
    async (projectId: string, versionId?: string | null) => {
      setBusy(true);
      setError(null);

      try {
        setAnalysis(await analyze(projectId, versionId ?? undefined));
      } catch (e) {
        setError(e instanceof ApiError ? e : String(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("flowtrace-theme");
    setDarkMode(savedTheme === "dark");

    Promise.all([listProjects(), listDomains()])
      .then(([p, d]) => {
        setProjects(p);
        setDomains(d);

        const hash = new URLSearchParams(window.location.hash.slice(1));
        const wanted = hash.get("project");
        const savedStage = hash.get("stage") as Stage | null;
        const found = wanted
          ? p.find((item) => item.id === wanted)
          : undefined;

        if (found) {
          setProject(found);

          if (
            savedStage &&
            STAGES.some((item) => item.id === savedStage)
          ) {
            setStage(savedStage);
            setPendingStage(savedStage);
          }

          void load(found.id);
        }

        setBooted(true);
      })
      .catch((e) => {
        setBooted(true);
        setError(
          e instanceof ApiError
            ? e
            : "Could not reach the API. Is the backend running on port 8001?",
        );
      });
  }, [load]);

  useEffect(() => {
    document.documentElement.style.colorScheme = darkMode ? "dark" : "light";
    document.documentElement.classList.toggle("dark", darkMode);
    document.documentElement.classList.toggle("flowtrace-dark", darkMode);

    window.localStorage.setItem(
      "flowtrace-theme",
      darkMode ? "dark" : "light",
    );
  }, [darkMode]);

  useEffect(() => {
    const handleThemeToggle = (event: Event) => {
      const next = (event as CustomEvent<boolean>).detail;
      setDarkMode(Boolean(next));
    };

    window.addEventListener("flowtrace-theme-toggle", handleThemeToggle);
    return () =>
      window.removeEventListener("flowtrace-theme-toggle", handleThemeToggle);
  }, []);

  useEffect(() => {
    if (!booted) return;

    const next = project
      ? `#project=${project.id}&stage=${stage}`
      : "";

    if (window.location.hash !== next) {
      window.history.replaceState(
        null,
        "",
        next || window.location.pathname,
      );
    }
  }, [booted, project, stage]);

  function goToWorkspace() {
    document.getElementById("workspace")?.scrollIntoView({
      behavior: "smooth",
    });
  }

  function goToHowItWorks() {
    document.getElementById("how-it-works")?.scrollIntoView({
      behavior: "smooth",
    });
  }

  function navigate(next: Stage) {
    setPendingStage(next);

    if (!project) {
      goToWorkspace();
      return;
    }

    setStage(next);

    if (
      project &&
      ["analyze", "risk"].includes(next) &&
      !analysis
    ) {
      void runAnalysis(project.id, viewVersion);
    }
  }

  async function openProject(p: Project) {
    setProject(p);
    setViewVersion(null);

    const nextStage = pendingStage || "build";
    setStage(nextStage);

    await load(p.id);

    if (
      ["analyze", "risk"].includes(nextStage)
    ) {
      await runAnalysis(p.id);
    }

    setTimeout(() => {
      document.getElementById("workspace")?.scrollIntoView({
        behavior: "smooth",
      });
    }, 100);
  }

  const hasWorkflow = (workflow?.tasks.length ?? 0) > 0;
  const domain = domains.find((item) => item.id === project?.domain_id);

  function renderError(onRetry?: () => void) {
    if (!error) return null;

    const api = error instanceof ApiError ? error : null;

    return (
      <div className="mb-5">
        <ErrorNote
          onRetry={onRetry}
          hint={api?.hint}
          requestId={api?.requestId}
        >
          {api ? api.userMessage : String(error)}
        </ErrorNote>
      </div>
    );
  }

  if (!person) {
    return (
      <main className="min-h-screen bg-[#F7F7FC] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-[#E2E1EC] rounded-3xl p-8 text-center shadow-xl">
          <FlowLogo compact />

          <h1 className="text-xl font-semibold mt-6">
            Connecting to FlowTrace
          </h1>

          {identityFailed ? (
            <div className="mt-5">
              <ErrorNote onRetry={() => location.reload()}>
                You are signed in, but your session is not linked to an
                account on this instance.
              </ErrorNote>
            </div>
          ) : (
            <div className="mt-5">
              <Spinner label="Checking your session" />
            </div>
          )}
        </div>
      </main>
    );
  }

  return (
    <div
      className={
        darkMode
          ? "flowtrace-site min-h-screen bg-[#0B0E1B] text-white"
          : "flowtrace-site min-h-screen bg-[#F7F7FC] text-[#17172A]"
      }
    >
      <LandingPage
        darkMode={darkMode}
        onOpenWorkspace={goToWorkspace}
        onHowItWorks={goToHowItWorks}
        onQuestion={navigate}
      />

      <section
        id="workspace"
        className={
          darkMode
            ? "scroll-mt-20 bg-[#0B0E1B]"
            : "scroll-mt-20 bg-[#F7F7FC]"
        }
      >
        {!project ? (
          <div className="min-h-screen px-6 md:px-10 lg:px-16 py-20">
            <div className="max-w-[1100px] mx-auto">
              <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6 mb-10">
                <div>
                  <div className="text-xs uppercase tracking-[0.2em] text-[#4164FA] font-semibold">
                    Workspace
                  </div>

                  <h2
                    className={
                      darkMode
                        ? "text-4xl md:text-5xl font-semibold tracking-[-0.04em] mt-3 text-white"
                        : "text-4xl md:text-5xl font-semibold tracking-[-0.04em] mt-3"
                    }
                  >
                    Choose a workflow.
                  </h2>

                  <p
                    className={
                      darkMode
                        ? "text-white/50 mt-4 max-w-2xl leading-7"
                        : "text-[#68677A] mt-4 max-w-2xl leading-7"
                    }
                  >
                    Start with an existing project, create a workflow, or
                    import one to begin tracing how work moves.
                  </p>
                </div>

                <IdentityBadge person={person} />
              </div>

              {renderError(() => location.reload())}

              {creating ? (
                <ProjectCreate
                  onCreated={async (p) => {
                    setCreating(false);
                    setProjects([...(projects ?? []), p]);
                    await openProject(p);
                  }}
                  onCancel={() => setCreating(false)}
                />
              ) : importing ? (
                <ImportPanel
                  onImported={async (projectId) => {
                    setImporting(false);

                    const fresh = await listProjects();
                    setProjects(fresh);

                    const created = fresh.find(
                      (item) => item.id === projectId,
                    );

                    if (created) {
                      await openProject(created);
                    }
                  }}
                />
              ) : (
                <>
                  <div className="flex flex-wrap gap-3 mb-6">
                    <Button onClick={() => setImporting(true)}>
                      Import from Jira
                    </Button>

                    <Button
                      variant="primary"
                      onClick={() => setCreating(true)}
                    >
                      New workflow
                    </Button>
                  </div>

                  {projects === null ? (
                    <Spinner label="Loading workflows…" />
                  ) : projects.length === 0 ? (
                    <EmptyState
                      title="Nothing here yet"
                      action={
                        <Button
                          variant="primary"
                          onClick={() => setCreating(true)}
                        >
                          Create your first workflow
                        </Button>
                      }
                    >
                      Start by describing what you are trying to accomplish.
                    </EmptyState>
                  ) : (
                    <div className="grid md:grid-cols-2 gap-4">
                      {projects.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => openProject(p)}
                          className={
                            darkMode
                              ? "group text-left p-6 rounded-3xl border border-[#2B3045] bg-[#121729] hover:border-[#4164FA]/50 hover:-translate-y-1 transition-all"
                              : "group text-left p-6 rounded-3xl border border-[#E2E1EC] bg-white hover:border-[#4164FA]/40 hover:-translate-y-1 transition-all shadow-sm hover:shadow-xl"
                          }
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-gradient-to-r from-[#4164FA] to-[#795CF7]" />
                                <span
                                  className={
                                    darkMode
                                      ? "font-semibold text-white"
                                      : "font-semibold"
                                  }
                                >
                                  {p.name}
                                </span>
                              </div>

                              {p.goal && (
                                <p
                                  className={
                                    darkMode
                                      ? "text-sm text-white/50 mt-3 leading-6"
                                      : "text-sm text-[#68677A] mt-3 leading-6"
                                  }
                                >
                                  {p.goal}
                                </p>
                              )}
                            </div>

                            <span className="text-[#4164FA] group-hover:translate-x-1 transition-transform">
                              →
                            </span>
                          </div>

                          <div className="flex items-center gap-2 mt-6 text-[11px]">
                            <span
                              className={
                                darkMode
                                  ? "text-white/35"
                                  : "text-[#68677A]"
                              }
                            >
                              starts {p.start_date}
                            </span>

                            {p.deadline && (
                              <Badge tone="neutral">
                                due {p.deadline}
                              </Badge>
                            )}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="min-h-screen flex">
            <aside
              className={
                darkMode
                  ? "hidden md:flex flex-col w-[270px] shrink-0 border-r border-[#2B3045] bg-[#0F1320]"
                  : "hidden md:flex flex-col w-[270px] shrink-0 border-r border-[#E2E1EC] bg-white"
              }
            >
              <div className="h-[112px] flex items-center px-5 border-b border-[#E2E1EC] dark:border-[#2B3045]">
                <button
                  onClick={() => {
                    setProject(null);
                    setWorkflow(null);
                    setAnalysis(null);
                  }}
                >
                  <FlowLogo />
                </button>
              </div>

              <div className="px-3 pt-8">
                <div
                  className={
                    darkMode
                      ? "px-3 mb-4 text-[11px] uppercase tracking-[0.2em] font-semibold text-white/35"
                      : "px-3 mb-4 text-[11px] uppercase tracking-[0.2em] font-semibold text-[#68677A]"
                  }
                >
                  Workspace
                </div>

                <nav className="space-y-1.5">
                  {STAGES.map((item) => {
                    const active = stage === item.id;
                    const locked =
                      item.needsWorkflow && !hasWorkflow;

                    return (
                      <button
                        key={item.id}
                        disabled={locked}
                        onClick={() => navigate(item.id)}
                        title={
                          locked
                            ? "Add at least one task first"
                            : item.description
                        }
                        className={
                          active
                            ? "w-full group flex items-center gap-3 px-3 py-3 rounded-xl text-left bg-gradient-to-r from-[#EAF0FF] to-[#F0EBFF] text-[#17172A] transition-all"
                            : darkMode
                              ? "w-full group flex items-center gap-3 px-3 py-3 rounded-xl text-left text-white/45 hover:bg-white/5 hover:text-white transition-all"
                              : "w-full group flex items-center gap-3 px-3 py-3 rounded-xl text-left text-[#68677A] hover:bg-[#F5F5FB] hover:text-[#17172A] transition-all"
                        }
                      >
                        <span
                          className={
                            active
                              ? "w-9 h-9 flex items-center justify-center rounded-xl shrink-0 bg-gradient-to-br from-[#4164FA] to-[#795CF7] text-white shadow-lg"
                              : "w-9 h-9 flex items-center justify-center rounded-xl shrink-0 bg-[#F1F0FA] text-[#68677A]"
                          }
                        >
                          {item.icon}
                        </span>

                        <div className="min-w-0">
                          <div className="text-[13px] font-semibold">
                            {item.label}
                          </div>
                          <div
                            className={
                              active
                                ? "text-[10px] text-[#68677A] mt-0.5"
                                : darkMode
                                  ? "text-[10px] text-white/30 mt-0.5"
                                  : "text-[10px] text-[#68677A] mt-0.5"
                            }
                          >
                            {item.description}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </nav>
              </div>

              <div className="px-3 mt-9">
                <div
                  className={
                    darkMode
                      ? "px-3 mb-3 text-[11px] uppercase tracking-[0.2em] font-semibold text-white/35"
                      : "px-3 mb-3 text-[11px] uppercase tracking-[0.2em] font-semibold text-[#68677A]"
                  }
                >
                  Project
                </div>

                <div
                  className={
                    darkMode
                      ? "flex items-center gap-3 px-3 py-3 rounded-xl bg-[#121729] border border-[#2B3045]"
                      : "flex items-center gap-3 px-3 py-3 rounded-xl bg-[#F7F7FC] border border-[#E2E1EC]"
                  }
                >
                  <span className="w-2 h-2 rounded-full bg-gradient-to-r from-[#4164FA] to-[#795CF7]" />

                  <div className="min-w-0">
                    <div
                      className={
                        darkMode
                          ? "text-[12px] font-semibold truncate text-white"
                          : "text-[12px] font-semibold truncate"
                      }
                    >
                      {project.name}
                    </div>

                    <div
                      className={
                        darkMode
                          ? "text-[10px] text-white/35 mt-0.5"
                          : "text-[10px] text-[#68677A] mt-0.5"
                      }
                    >
                      {workflow?.tasks.length ?? 0} tasks
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-auto p-4">
                <div
                  className={
                    darkMode
                      ? "border-t border-[#2B3045] pt-4"
                      : "border-t border-[#E2E1EC] pt-4"
                  }
                >
                  <div className="flex items-center justify-between px-2">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-gradient-to-r from-[#4164FA] to-[#795CF7]" />
                      <span
                        className={
                          darkMode
                            ? "text-[11px] text-white/40"
                            : "text-[11px] text-[#68677A]"
                        }
                      >
                        Intelligence engine
                      </span>
                    </div>

                    <span className="text-[10px] text-[#4164FA] font-semibold">
                      LIVE
                    </span>
                  </div>
                </div>
              </div>
            </aside>

            <div className="flex-1 min-w-0 flex flex-col">
              <header
                className={
                  darkMode
                    ? "h-[82px] shrink-0 border-b border-[#2B3045] bg-[#0F1320]/90 backdrop-blur-xl flex items-center justify-between px-5 md:px-8 sticky top-0 z-30"
                    : "h-[82px] shrink-0 border-b border-[#E2E1EC] bg-white/85 backdrop-blur-xl flex items-center justify-between px-5 md:px-8 sticky top-0 z-30"
                }
              >
                <div className="flex items-center gap-4 min-w-0">
                  <button
                    onClick={() => {
                      setProject(null);
                      setWorkflow(null);
                      setAnalysis(null);
                    }}
                    className={
                      darkMode
                        ? "text-white/40 hover:text-white text-sm"
                        : "text-[#68677A] hover:text-[#17172A] text-sm"
                    }
                  >
                    ← all workflows
                  </button>

                  <div className="min-w-0">
                    <div
                      className={
                        darkMode
                          ? "text-[10px] uppercase tracking-[0.17em] text-white/35 mb-1"
                          : "text-[10px] uppercase tracking-[0.17em] text-[#68677A] mb-1"
                      }
                    >
                      {STAGES.find((item) => item.id === stage)?.label}
                    </div>

                    <h1
                      className={
                        darkMode
                          ? "text-[18px] font-semibold truncate text-white"
                          : "text-[18px] font-semibold truncate"
                      }
                    >
                      {project.name}
                    </h1>
                  </div>

                  {domain && (
                    <Badge tone="neutral">{domain.name}</Badge>
                  )}

                  {workflow && (
                    <Badge
                      tone={
                        workflow.version.is_draft
                          ? "neutral"
                          : "green"
                      }
                    >
                      v{workflow.version.version_no}
                      {workflow.version.is_draft ? " draft" : ""}
                    </Badge>
                  )}
                </div>

                <div className="flex items-center gap-3 md:gap-5">
                  <button
                    type="button"
                    onClick={() => setDarkMode((value) => !value)}
                    className={
                      darkMode
                        ? "w-10 h-10 rounded-full border border-white/10 bg-white/5 text-white flex items-center justify-center"
                        : "w-10 h-10 rounded-full border border-[#E2E1EC] bg-white text-[#68677A] flex items-center justify-center"
                    }
                    title={
                      darkMode
                        ? "Switch to light mode"
                        : "Switch to dark mode"
                    }
                  >
                    {darkMode ? "☀" : "☾"}
                  </button>

                  <IdentityBadge person={person} />
                </div>
              </header>

              <main className="flex-1 w-full max-w-[1700px] mx-auto px-5 md:px-8 py-8">
                {renderError(() =>
                  load(project.id, viewVersion),
                )}

                {busy && !workflow && (
                  <Spinner label="Loading workflow…" />
                )}

                {workflow && stage === "build" && (
                  <Section
                    title="Build the workflow"
                    subtitle="Add who does the work, then the work, then what waits on what. Everything here writes to your draft version."
                    right={
                      hasWorkflow ? (
                        <Button
                          variant="primary"
                          onClick={() => navigate("analyze")}
                        >
                          Analyze this →
                        </Button>
                      ) : undefined
                    }
                  >
                    <ErrorBoundary
                      what="The workflow builder"
                      resetKey={stage}
                    >
                      <div className="space-y-4">
                        <WorkflowBuilder
                          workflow={workflow}
                          templates={domain?.task_templates}
                          onChange={(next) => {
                            setWorkflow(next);
                            setAnalysis(null);
                          }}
                        />

                        <MemberList projectId={project.id} />
                      </div>
                    </ErrorBoundary>
                  </Section>
                )}

                {workflow && stage === "live" && (
                  <Section
                    title="Watch it happen"
                    subtitle="The event log replayed in accelerated time. Findings appear and clear on their own, at the simulated day they would have."
                  >
                    <ErrorBoundary
                      what="The live replay"
                      resetKey={stage}
                    >
                      <LiveFeed
                        projectId={project.id}
                        workflow={workflow}
                        analysis={analysis}
                      />
                    </ErrorBoundary>
                  </Section>
                )}

                {stage === "analyze" && (
                  <Section
                    title="Where it is stuck now"
                    subtitle="Each finding names the cause rather than the symptom, and shows the evidence it reasoned from."
                    right={
                      <Button
                        onClick={() =>
                          runAnalysis(project.id, viewVersion)
                        }
                        disabled={busy}
                      >
                        Re-analyze
                      </Button>
                    }
                  >
                    {busy && !analysis && (
                      <Spinner label="Evaluating…" />
                    )}

                    {!busy && !analysis && (
                      <EmptyState
                        title="Not analysed yet"
                        action={
                          <Button
                            variant="primary"
                            onClick={() =>
                              runAnalysis(
                                project.id,
                                viewVersion,
                              )
                            }
                          >
                            Analyze now
                          </Button>
                        }
                      >
                        Nothing has been evaluated for this version yet.
                      </EmptyState>
                    )}

                    {analysis && (
                      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
                        <div className="flex min-w-0 flex-1 flex-col gap-5">
                          <ErrorBoundary
                            what="The dependency graph"
                            resetKey={stage}
                          >
                            <DependencyGraph analysis={analysis} />
                          </ErrorBoundary>

                          <ErrorBoundary
                            what="The findings panel"
                            resetKey={stage}
                          >
                            <FindingsPanel analysis={analysis} />
                          </ErrorBoundary>
                        </div>

                        <aside className="flex w-full shrink-0 flex-col gap-5 lg:w-72 lg:border-l lg:border-line lg:pl-5">
                          <ErrorBoundary
                            what="The summary"
                            resetKey={stage}
                          >
                            <Headline analysis={analysis} />
                          </ErrorBoundary>

                          <ErrorBoundary
                            what="The plain-language summary"
                            resetKey={stage}
                          >
                            <Explainer projectId={project.id} />
                          </ErrorBoundary>
                        </aside>
                      </div>
                    )}
                  </Section>
                )}

                {stage === "risk" && (
                  <Section
                    title="Where it is likely to get stuck"
                    subtitle="Structural exposure and seeded forecast are shown separately so the numbers never pretend to be more certain than they are."
                  >
                    {busy && !analysis && (
                      <Spinner label="Scoring…" />
                    )}

                    {!busy && !analysis && (
                      <EmptyState
                        title="The structural score is not computed yet"
                        action={
                          <Button
                            variant="primary"
                            onClick={() =>
                              runAnalysis(
                                project.id,
                                viewVersion,
                              )
                            }
                          >
                            Score this workflow
                          </Button>
                        }
                      >
                        Risk is computed from the same evaluation as
                        the findings.
                      </EmptyState>
                    )}

                    {analysis && (
                      <ErrorBoundary
                        what="The risk panel"
                        resetKey={stage}
                      >
                        <RiskPanel
                          analysis={analysis}
                          busy={busy}
                          onReweight={async (weights) => {
                            setBusy(true);

                            try {
                              const { getRisk } =
                                await import("@/lib/api");

                              const next = await getRisk(
                                project.id,
                                weights,
                              );

                              setAnalysis({
                                ...analysis,
                                risk: {
                                  ...analysis.risk,
                                  ...next,
                                },
                              });
                            } finally {
                              setBusy(false);
                            }
                          }}
                        />
                      </ErrorBoundary>
                    )}

                    <div className="mt-6">
                      <ErrorBoundary
                        what="The forecast"
                        resetKey={stage}
                      >
                        <ForecastPanel
                          projectId={project.id}
                        />
                      </ErrorBoundary>
                    </div>
                  </Section>
                )}

                {workflow && stage === "requirements" && (
                  <Section
                    title="When a requirement changes"
                    subtitle="See what a new wording would invalidate, what it would cost, and who needs to know before anything is applied."
                  >
                    <ErrorBoundary
                      what="The requirement panel"
                      resetKey={stage}
                    >
                      <RequirementChange
                        projectId={project.id}
                        workflow={workflow}
                        onApplied={() => {
                          setAnalysis(null);
                          void load(project.id, null);
                        }}
                      />
                    </ErrorBoundary>
                  </Section>
                )}

                {workflow && stage === "whatif" && (
                  <Section
                    title="What if something changes?"
                    subtitle="Test typed changes against a copy of the workflow. Your real workflow is not touched."
                  >
                    <div className="space-y-6">
                      <ErrorBoundary
                        what="The sentence box"
                        resetKey={stage}
                      >
                        <AskPanel workflow={workflow} />
                      </ErrorBoundary>

                      <ErrorBoundary
                        what="The what-if panel"
                        resetKey={stage}
                      >
                        <WhatIfPanel workflow={workflow} />
                      </ErrorBoundary>
                    </div>
                  </Section>
                )}

                {stage === "optimize" && (
                  <Section
                    title="Is there a better arrangement?"
                    subtitle="Candidates are generated, checked against your constraints, then scored by the same engine."
                  >
                    <ErrorBoundary
                      what="The optimizer"
                      resetKey={stage}
                    >
                      <OptimizePanel
                        projectId={project.id}
                        onApplied={async () => {
                          const fresh = await getWorkflow(
                            project.id,
                          );

                          setWorkflow(fresh);
                          setAnalysis(null);
                          setStage("history");
                        }}
                      />
                    </ErrorBoundary>
                  </Section>
                )}

                {stage === "history" && (
                  <Section
                    title="History"
                    subtitle="Applying a change never destroys the version it came from."
                  >
                    <ErrorBoundary
                      what="The version history"
                      resetKey={stage}
                    >
                      <VersionHistory
                        projectId={project.id}
                        currentVersionId={
                          workflow?.version.id ?? null
                        }
                        onView={async (versionId) => {
                          setViewVersion(versionId);
                          await load(project.id, versionId);
                          setStage("build");
                        }}
                      />
                    </ErrorBoundary>
                  </Section>
                )}
              </main>
            </div>
          </div>
        )}
      </section>

      <footer
        className={
          darkMode
            ? "border-t border-white/10 bg-[#090B18] text-white"
            : "border-t border-[#E2E1EC] bg-[#F7F7FC] text-[#17172A]"
        }
      >
        <div className="max-w-[1400px] mx-auto px-6 md:px-10 lg:px-16 py-20">
          <div className="grid lg:grid-cols-[1.5fr_0.8fr_0.8fr_0.8fr] gap-12 lg:gap-16">
            <div className="max-w-md">
              <FlowLogo />

              <p
                className={
                  darkMode
                    ? "mt-8 text-base leading-7 text-white/50"
                    : "mt-8 text-base leading-7 text-[#68677A]"
                }
              >
                See the flow. Understand what's next. Intelligent workflow
                analysis for projects where one change can affect everything
                downstream.
              </p>
            </div>

            <FooterColumn
              title="Product"
              darkMode={darkMode}
              links={[
                ["Build", () => navigate("build")],
                ["Bottlenecks", () => navigate("analyze")],
                ["Risk & forecast", () => navigate("risk")],
                ["What if", () => navigate("whatif")],
              ]}
            />

            <FooterColumn
              title="Explore"
              darkMode={darkMode}
              links={[
                ["How it works", goToHowItWorks],
                ["Workspace", goToWorkspace],
                ["History", () => navigate("history")],
                ["Better workflows", () => navigate("optimize")],
              ]}
            />

            <FooterColumn
              title="FlowTrace"
              darkMode={darkMode}
              links={[
                ["Live replay", () => navigate("live")],
                ["Requirements", () => navigate("requirements")],
                ["Dependencies", () => navigate("analyze")],
                ["Back to top", () =>
                  window.scrollTo({
                    top: 0,
                    behavior: "smooth",
                  })
                ],
              ]}
            />
          </div>

          <div
            className={
              darkMode
                ? "mt-16 pt-8 border-t border-white/10 flex flex-col md:flex-row md:items-center md:justify-between gap-3 text-sm text-white/40"
                : "mt-16 pt-8 border-t border-[#E2E1EC] flex flex-col md:flex-row md:items-center md:justify-between gap-3 text-sm text-[#68677A]"
            }
          >
            <span>Built for Resonance · 2026</span>
            <span>
              Dynamic Workflow Intelligence Platform · © 2026 FlowTrace
            </span>
          </div>
        </div>
      </footer>

      <style jsx global>{`
        .flowtrace-landing-dark {
          background: #0b0e1b !important;
          color: #f5f5ff !important;
        }

        .flowtrace-landing-dark .bg-white,
        .flowtrace-landing-dark .bg-white\/70,
        .flowtrace-landing-dark .bg-white\/75 {
          background-color: #111525 !important;
        }

        .flowtrace-landing-dark .border-white\/80,
        .flowtrace-landing-dark .border-white\/90,
        .flowtrace-landing-dark .border-white {
          border-color: #2a2e42 !important;
        }

        .flowtrace-landing-dark [class*="text-[#68677A]"] {
          color: #a5a7b8 !important;
        }

        .flowtrace-landing-dark [class*="text-[#17172A]"] {
          color: #f5f5ff !important;
        }

        .flowtrace-landing-dark [class*="border-[#E2E1EC]"],
        .flowtrace-landing-dark [class*="border-[#DAD9E7]"] {
          border-color: #2a2e42 !important;
        }

        .flowtrace-landing-dark [class*="bg-[#F7F7FC]"] {
          background-color: #111525 !important;
        }

        .flowtrace-landing-dark [class*="bg-[#F0EBFF]"] {
          background-color: #211d3a !important;
        }

        .flowtrace-landing-dark [class*="bg-[#EAF0FF]"] {
          background-color: #17213f !important;
        }

        .flowtrace-dark {
          background: #0b0e1b;
          color: #f5f5ff;
        }

        .flowtrace-dark [class*="bg-panel"] {
          background-color: #111525 !important;
        }

        .flowtrace-dark [class*="bg-panel2"] {
          background-color: #181c2e !important;
        }

        .flowtrace-dark [class*="text-foreground"] {
          color: #f5f5ff !important;
        }

        .flowtrace-dark [class*="text-dim"] {
          color: #a5a7b8 !important;
        }

        .flowtrace-dark [class*="border-line"] {
          border-color: #2a2e42 !important;
        }

        .flowtrace-dark input,
        .flowtrace-dark select,
        .flowtrace-dark textarea {
          background-color: #111525 !important;
          color: #f5f5ff !important;
          border-color: #2a2e42 !important;
        }

        .flowtrace-dark ::placeholder {
          color: #777b91 !important;
        }

        .flowtrace-dark .react-flow__controls {
          background: #111525;
          border-color: #2a2e42;
        }

        .flowtrace-dark .react-flow__controls-button {
          background: #111525;
          border-color: #2a2e42;
          color: #f5f5ff;
        }

        .flowtrace-dark .react-flow__controls-button svg {
          fill: #f5f5ff;
        }

        @media (prefers-reduced-motion: reduce) {
          .flowtrace-site * {
            scroll-behavior: auto !important;
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
            transition-duration: 0.01ms !important;
          }
        }
      `}</style>
    </div>
  );
}

function FooterColumn({
  title,
  darkMode,
  links,
}: {
  title: string;
  darkMode: boolean;
  links: [string, () => void][];
}) {
  return (
    <div>
      <div
        className={
          darkMode
            ? "text-xs uppercase tracking-[0.2em] font-semibold text-white"
            : "text-xs uppercase tracking-[0.2em] font-semibold text-[#17172A]"
        }
      >
        {title}
      </div>

      <div
        className={
          darkMode
            ? "mt-7 space-y-4 text-sm text-white/50"
            : "mt-7 space-y-4 text-sm text-[#68677A]"
        }
      >
        {links.map(([label, action]) => (
          <button
            key={label}
            onClick={action}
            className="block hover:text-[#4164FA] transition-colors"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Headline({ analysis }: { analysis: Analysis }) {
  const f = analysis.feasibility;
  const slipped = analysis.slip_days > 0;

  const verdict =
    f.verdict === "no_deadline_set"
      ? "none set"
      : f.verdict === "feasible"
        ? "feasible"
        : f.verdict.replace(/_/g, " ");

  return (
    <div>
      <div className="text-[11px] tracking-wide text-muted-foreground uppercase">
        Projected finish
      </div>

      <div className="flex items-baseline gap-2">
        <span
          className={`text-2xl font-semibold ${
            slipped
              ? "text-severity-high"
              : "text-foreground"
          }`}
        >
          day {Math.round(analysis.projected_end)}
        </span>

        <span
          className={`text-sm font-medium ${
            slipped
              ? "text-severity-high"
              : "text-severity-low"
          }`}
        >
          {days(analysis.slip_days, true)}
        </span>
      </div>

      <div className="text-[11px] text-muted-foreground">
        {analysis.projected_end_date}
        {slipped ? " · later than planned" : " · on plan"}
      </div>

      <dl className="mt-3 flex flex-col gap-1 border-t border-line pt-2 text-[13px]">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">planned</dt>

          <dd className="text-right">
            <span className="font-medium">
              day {Math.round(analysis.planned_end)}
            </span>{" "}
            <span className="text-[11px] text-muted-foreground">
              {analysis.planned_end_date}
            </span>
          </dd>
        </div>

        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">deadline</dt>

          <dd className="text-right">
            <span
              className={`font-medium ${
                f.verdict === "feasible"
                  ? "text-severity-low"
                  : f.verdict === "no_deadline_set"
                    ? "text-foreground"
                    : "text-severity-high"
              }`}
            >
              {verdict}
            </span>

            {f.margin_days !== null && (
              <span className="text-[11px] text-muted-foreground">
                {" "}
                {days(f.margin_days, true)} margin
              </span>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}