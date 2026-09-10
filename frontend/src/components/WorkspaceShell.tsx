
"use client";

import { ReactNode, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Project } from "@/lib/api";
import { IdentityBadge, useIdentity } from "@/components/Identity";
import { CapabilityDialog } from "@/components/CapabilityPanel";

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
  {
    id: "build",
    label: "Build",
    description: "Define the workflow",
    icon: "⌘",
  },
  {
    id: "live",
    label: "Live",
    description: "Watch it happen",
    icon: "◉",
  },
  {
    id: "bottlenecks",
    label: "Bottlenecks",
    description: "Find what's stuck",
    icon: "↗",
  },
  {
    id: "risk",
    label: "Risk & forecast",
    description: "See what's next",
    icon: "◌",
  },
  {
    id: "requirements",
    label: "Requirements",
    description: "Track changes",
    icon: "✦",
  },
  {
    id: "whatif",
    label: "What if",
    description: "Test a change",
    icon: "◇",
  },
  {
    id: "optimize",
    label: "Better workflows",
    description: "Improve the plan",
    icon: "↯",
  },
  {
    id: "history",
    label: "History",
    description: "Review versions",
    icon: "↺",
  },
];

function FlowLogo() {
  return (
    <div className="flex items-center gap-3">
      <div className="relative h-8 w-8 rounded-xl bg-gradient-to-br from-[#4164FA] to-[#795CF7] shadow-lg shadow-[#4164FA]/20">
        <span className="absolute left-[7px] top-[9px] h-2 w-2 rounded-full bg-white" />
        <span className="absolute bottom-[7px] right-[7px] h-2 w-2 rounded-full bg-white" />
        <span className="absolute left-[10px] top-[13px] h-[2px] w-[13px] rotate-[-28deg] bg-white/80" />
      </div>

      <div>
        <div className="text-[20px] font-semibold tracking-[-0.04em]">
          Flow<span className="text-[#4164FA]">Trace</span>
        </div>

        <div className="text-[8px] uppercase tracking-[0.2em] text-[#68677A]">
          FlowTrace
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
  const { person, isGuest } = useIdentity();
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

    window.localStorage.setItem(
      "flowtrace-theme",
      next ? "dark" : "light",
    );

    window.dispatchEvent(
      new CustomEvent("flowtrace-theme-toggle", {
        detail: next,
      }),
    );
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
            ? "fixed bottom-0 left-0 top-0 z-40 w-[285px] border-r border-[#2B3045] bg-[#0F1220]"
            : "fixed bottom-0 left-0 top-0 z-40 w-[285px] border-r border-[#E2E1EC] bg-white"
        }
      >
        <div className="flex h-[112px] items-center border-b border-[#E2E1EC] px-7 dark:border-[#2B3045]">
          <button
            type="button"
            onClick={() => router.push("/")}
            aria-label="Go to FlowTrace home"
          >
            <FlowLogo />
          </button>
        </div>

        <div className="px-3 pt-8">
          <button
            type="button"
            onClick={() => router.push("/workspace")}
            className={
              darkMode
                ? "mb-7 px-3 text-sm font-semibold text-white/70 transition-colors hover:text-white"
                : "mb-7 px-3 text-sm font-semibold text-[#17172A] transition-colors hover:text-[#4164FA]"
            }
          >
            ← all workflows
          </button>

          <div
            className={
              darkMode
                ? "mb-4 px-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/35"
                : "mb-4 px-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#68677A]"
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
                  type="button"
                  onClick={() => goToStage(item.id)}
                  className={
                    active
                      ? "group flex w-full items-center gap-3 rounded-xl bg-gradient-to-r from-[#EAF0FF] to-[#F0EBFF] px-3 py-3 text-left text-[#17172A] transition-all"
                      : darkMode
                        ? "group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-white/45 transition-all hover:bg-white/5 hover:text-white"
                        : "group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-[#68677A] transition-all hover:bg-[#F5F5FB] hover:text-[#17172A]"
                  }
                >
                  <span
                    className={
                      active
                        ? "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#4164FA] to-[#795CF7] text-white shadow-lg"
                        : "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#F1F0FA] text-[#68677A]"
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
                          ? "mt-0.5 text-[10px] text-[#68677A]"
                          : darkMode
                            ? "mt-0.5 text-[10px] text-white/30"
                            : "mt-0.5 text-[10px] text-[#68677A]"
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

        <div className="absolute bottom-0 left-0 right-0 border-t border-[#E2E1EC] p-5 dark:border-[#2B3045]">
          {person && <IdentityBadge person={person} />}
        </div>
      </aside>

      <div className="ml-[285px] min-h-screen">
        <header
          className={
            darkMode
              ? "sticky top-0 z-30 h-[112px] border-b border-[#2B3045] bg-[#0F1220]/95 backdrop-blur-xl"
              : "sticky top-0 z-30 h-[112px] border-b border-[#E2E1EC] bg-white/95 backdrop-blur-xl"
          }
        >
          <div className="flex h-full items-center justify-between px-8">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#68677A]">
                {
                  WORKSPACE_STAGES.find(
                    (item) => item.id === stage,
                  )?.label
                }
              </div>

              <div className="mt-2 flex items-center gap-3">
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
              {/* The honesty surface, one click from every stage: what this
                  build can and cannot do, read live from the API. */}
              <CapabilityDialog
                projectId={project.id}
                person={person}
                isGuest={isGuest}
              />

              {person && <IdentityBadge person={person} />}

              <button
                type="button"
                onClick={toggleTheme}
                className="flex h-12 w-12 items-center justify-center rounded-full border border-[#DAD9E7] text-xl transition-all hover:shadow-md dark:border-[#2B3045]"
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