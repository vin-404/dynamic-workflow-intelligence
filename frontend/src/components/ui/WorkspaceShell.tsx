"use client";

import { ReactNode, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Project } from "@/lib/api";
import { IdentityBadge, useIdentity } from "@/components/Identity";

export type WorkspaceStage =
  | "build"
  | "live"
  | "bottlenecks"
  | "risk"
  | "requirements"
  | "whatif"
  | "optimize"
  | "history";

export const WORKSPACE_STAGES: {
  id: WorkspaceStage;
  label: string;
  description: string;
  icon: string;
}[] = [
  { id: "build", label: "Build", description: "Define the workflow", icon: "⌘" },
  { id: "live", label: "Live", description: "Watch it happen", icon: "◉" },
  { id: "bottlenecks", label: "Bottlenecks", description: "Find what's stuck", icon: "↗" },
  { id: "risk", label: "Risk & forecast", description: "See what's next", icon: "◌" },
  { id: "requirements", label: "Requirements", description: "Track changes", icon: "✦" },
  { id: "whatif", label: "What if", description: "Test a change", icon: "◇" },
  { id: "optimize", label: "Better workflows", description: "Improve the plan", icon: "↯" },
  { id: "history", label: "History", description: "Review versions", icon: "↺" },
];

function FlowLogo() {
  return (
    <div className="flex items-center gap-3">
      <div className="relative w-8 h-8 rounded-xl bg-gradient-to-br from-[#4164FA] to-[#795CF7] shadow-lg shadow-[#4164FA]/20">
        <span className="absolute left-[7px] top-[9px] w-2 h-2 rounded-full bg-white" />
        <span className="absolute right-[7px] bottom-[7px] w-2 h-2 rounded-full bg-white" />
        <span className="absolute left-[10px] top-[13px] w-[13px] h-[2px] rotate-[-28deg] bg-white/80" />
      </div>
      <div>
        <div className="text-[20px] font-semibold tracking-[-0.04em]">
          Flow<span className="text-[#4164FA]">Trace</span>
        </div>
        <div className="text-[8px] uppercase tracking-[0.2em] text-[#68677A]">
          Workflow Intelligence
        </div>
      </div>
    </div>
  );
}

export default function WorkspaceShell({
  project,
  stage,
  children,
}: {
  project: Project;
  stage: WorkspaceStage;
  children: ReactNode;
}) {
  const router = useRouter();
  const { person } = useIdentity();
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem("flowtrace-theme");
    const next = saved === "dark";
    setDarkMode(next);
    document.documentElement.style.colorScheme = next ? "dark" : "light";
    document.documentElement.classList.toggle("dark", next);
    document.documentElement.classList.toggle("flowtrace-dark", next);
  }, []);

  function toggleTheme() {
    const next = !darkMode;
    setDarkMode(next);
    document.documentElement.style.colorScheme = next ? "dark" : "light";
    document.documentElement.classList.toggle("dark", next);
    document.documentElement.classList.toggle("flowtrace-dark", next);
    window.localStorage.setItem("flowtrace-theme", next ? "dark" : "light");
    window.dispatchEvent(new CustomEvent("flowtrace-theme-toggle", { detail: next }));
  }

  function goToStage(next: WorkspaceStage) {
    router.push(`/workspace/${project.id}/${next}`);
  }

  return (
    <div
      className={
        darkMode
          ? "flowtrace-site min-h-screen bg-[#0B0E1B] text-white"
          : "flowtrace-site min-h-screen bg-[#F7F7FC] text-[#17172A]"
      }
    >
      <aside
        className={
          darkMode
            ? "fixed left-0 top-0 bottom-0 w-[285px] border-r border-[#2B3045] bg-[#0F1220] z-40"
            : "fixed left-0 top-0 bottom-0 w-[285px] border-r border-[#E2E1EC] bg-white z-40"
        }
      >
        <div className="h-[112px] flex items-center px-7 border-b border-[#E2E1EC] dark:border-[#2B3045]">
          <button onClick={() => router.push("/")} aria-label="Go to FlowTrace home">
            <FlowLogo />
          </button>
        </div>

        <div className="px-3 pt-8">
          <button
            onClick={() => router.push("/workspace")}
            className={
              darkMode
                ? "px-3 mb-7 text-sm font-semibold text-white/70 hover:text-white transition-colors"
                : "px-3 mb-7 text-sm font-semibold text-[#17172A] hover:text-[#4164FA] transition-colors"
            }
          >
            ← all workflows
          </button>

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
            {WORKSPACE_STAGES.map((item) => {
              const active = item.id === stage;
              return (
                <button
                  key={item.id}
                  onClick={() => goToStage(item.id)}
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
                    <div className="text-[13px] font-semibold">{item.label}</div>
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

        <div className="absolute left-0 right-0 bottom-0 p-5 border-t border-[#E2E1EC] dark:border-[#2B3045]">
          {person && <IdentityBadge person={person} />}
        </div>
      </aside>

      <div className="min-h-screen ml-[285px]">
        <header
          className={
            darkMode
              ? "sticky top-0 z-30 h-[112px] border-b border-[#2B3045] bg-[#0F1220]/95 backdrop-blur-xl"
              : "sticky top-0 z-30 h-[112px] border-b border-[#E2E1EC] bg-white/95 backdrop-blur-xl"
          }
        >
          <div className="h-full px-8 flex items-center justify-between">
            <div>
              <div className="text-[11px] uppercase tracking-[0.2em] text-[#68677A] font-semibold">
                {WORKSPACE_STAGES.find((item) => item.id === stage)?.label}
              </div>
              <div className="flex items-center gap-3 mt-2">
                <h1 className="text-2xl font-semibold tracking-[-0.04em]">
                  {project.name}
                </h1>
                <span className="rounded-xl border border-[#2B3045] bg-[#101620] px-3 py-2 text-xs text-white/50">
                  {project.name}
                </span>
                <span className="rounded-xl border border-[#2B3045] bg-[#101620] px-3 py-2 text-xs text-white/50">
                  v1 draft
                </span>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {person && <IdentityBadge person={person} />}
              <button
                onClick={toggleTheme}
                className="w-12 h-12 rounded-full border border-[#DAD9E7] dark:border-[#2B3045] flex items-center justify-center text-xl hover:shadow-md transition-all"
                aria-label="Toggle theme"
              >
                {darkMode ? "☀" : "☾"}
              </button>
            </div>
          </div>
        </header>

        <main className="min-h-[calc(100vh-112px)] px-8 py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
