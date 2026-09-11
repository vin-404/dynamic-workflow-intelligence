"use client";

/**
 * The workspace chrome: sidebar with the eight stages, a two-row header,
 * the main column.
 *
 * Header row one is the stage name (meta size) and the project name (section
 * title, one line, ellipsis past its width). Row two is the version pill,
 * the capability button, the identity and the theme toggle. Nothing in it
 * wraps or truncates at 1024px and up (design brief §4, Header). Every
 * colour comes from the tokens in globals.css, so light and dark are the
 * same layout with different values and the landing, the workspace list and
 * the stages share one system (§6).
 */

import { ReactNode, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Project, Workflow } from "@/lib/api";
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
  { id: "build", label: "Build", description: "Define the workflow", icon: "⌘" },
  { id: "live", label: "Live", description: "Watch it happen", icon: "◉" },
  { id: "bottlenecks", label: "Bottlenecks", description: "Find what's stuck", icon: "↗" },
  { id: "risk", label: "Risk & forecast", description: "See what's next", icon: "◌" },
  { id: "requirements", label: "Requirements", description: "Track changes", icon: "✦" },
  { id: "whatif", label: "What if", description: "Test a change", icon: "◇" },
  { id: "optimize", label: "Better workflows", description: "Improve the plan", icon: "↯" },
  { id: "history", label: "History", description: "Review versions", icon: "↺" },
];

/** The same mark the landing page draws, at sidebar size. */
export function FlowLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <svg width={32} height={32} viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="flowtraceShellLogo" x1="5" y1="5" x2="43" y2="43" gradientUnits="userSpaceOnUse">
            <stop stopColor="var(--accent)" />
            <stop offset="1" stopColor="var(--violet)" />
          </linearGradient>
        </defs>
        <rect x="4" y="4" width="40" height="40" rx="12" fill="url(#flowtraceShellLogo)" />
        <path d="M14 16H22C25.314 16 28 18.686 28 22V26C28 29.314 30.686 32 34 32H35" stroke="white" strokeWidth="3" strokeLinecap="round" />
        <path d="M14 32H20C23.314 32 26 29.314 26 26V22C26 18.686 28.686 16 32 16H35" stroke="white" strokeWidth="3" strokeLinecap="round" />
        <circle cx="14" cy="16" r="3" fill="white" />
        <circle cx="14" cy="32" r="3" fill="white" />
        <circle cx="35" cy="16" r="3" fill="white" />
        <circle cx="35" cy="32" r="3" fill="white" />
      </svg>
      {!compact && (
        <div className="text-[20px] font-semibold tracking-[-0.04em]">
          Flow<span className="text-accent">Trace</span>
        </div>
      )}
    </div>
  );
}

/** Reads the saved theme, applies it to the document, and returns the toggle. */
export function useTheme(): [boolean, () => void] {
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem("flowtrace-theme");
    const next = saved === "dark";
    setDarkMode(next);
    applyTheme(next);
  }, []);

  function toggle() {
    const next = !darkMode;
    setDarkMode(next);
    applyTheme(next);
    window.localStorage.setItem("flowtrace-theme", next ? "dark" : "light");
    window.dispatchEvent(new CustomEvent("flowtrace-theme-toggle", { detail: next }));
  }

  return [darkMode, toggle];
}

function applyTheme(dark: boolean) {
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.classList.toggle("flowtrace-dark", dark);
  document.documentElement.classList.toggle("light", !dark);
}

export function ThemeButton({ dark, onToggle }: { dark: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-panel text-[16px] text-foreground transition-all hover:border-dim"
      aria-label="Toggle theme"
      title={dark ? "Switch to light" : "Switch to dark"}
    >
      {dark ? "☀" : "☾"}
    </button>
  );
}

export default function WorkspaceShell({
  project,
  stage,
  version,
  children,
}: {
  project: Project;
  stage: WorkspaceStage;
  /**
   * The workflow version on screen, from the API. When the workflow has not
   * loaded yet nothing is shown rather than a guess.
   */
  version?: Workflow["version"] | null;
  children: ReactNode;
}) {
  const router = useRouter();
  const { person, isGuest } = useIdentity();
  const [darkMode, toggleTheme] = useTheme();

  const stageLabel = WORKSPACE_STAGES.find((item) => item.id === stage)?.label;

  return (
    <div className="flowtrace-site min-h-screen bg-background text-foreground">
      <aside className="fixed bottom-0 left-0 top-0 z-40 flex w-[272px] flex-col border-r border-line bg-panel">
        <div className="flex h-[72px] shrink-0 items-center border-b border-line px-6">
          <button type="button" onClick={() => router.push("/")} aria-label="Go to FlowTrace home">
            <FlowLogo />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-5">
          <button
            type="button"
            onClick={() => router.push("/workspace")}
            className="mb-4 px-3 text-[14px] font-medium text-foreground transition-colors hover:text-accent"
          >
            ← All workflows
          </button>

          <div className="mb-2 px-3 text-[12px] font-semibold uppercase tracking-[0.16em] text-dim">
            Workspace
          </div>

          <nav className="space-y-1">
            {WORKSPACE_STAGES.map((item) => {
              const active = item.id === stage;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => router.push(`/workspace/${project.id}/${item.id}`)}
                  aria-current={active ? "page" : undefined}
                  className={
                    active
                      ? "group flex w-full items-center gap-3 rounded-xl bg-accent/10 px-3 py-2 text-left text-foreground transition-all"
                      : "group flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-dim transition-all hover:bg-panel2 hover:text-foreground"
                  }
                >
                  <span
                    className={
                      active
                        ? "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-violet text-white shadow-md shadow-accent/25"
                        : "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-panel2 text-dim"
                    }
                  >
                    {item.icon}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[14px] font-semibold leading-tight">{item.label}</div>
                    <div className="mt-0.5 text-[12px] leading-tight text-dim">{item.description}</div>
                  </div>
                </button>
              );
            })}
          </nav>
        </div>

        <div className="shrink-0 border-t border-line px-6 py-4">
          {/* The whole identity, on as many lines as it needs - never clipped. */}
          {person && <IdentityBadge person={person} stacked />}
        </div>
      </aside>

      <div className="ml-[272px] min-h-screen">
        <header className="sticky top-0 z-30 border-b border-line bg-panel/95 backdrop-blur-xl">
          <div className="flex flex-col gap-2 px-8 pb-3 pt-3">
            <div className="min-w-0">
              <div className="text-[12px] font-semibold uppercase tracking-[0.16em] text-dim">
                {stageLabel}
              </div>
              <h1
                className="mt-0.5 truncate text-[20px] font-semibold tracking-[-0.02em]"
                title={project.name}
              >
                {project.name}
              </h1>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {version && (
                <span
                  className="whitespace-nowrap rounded-lg border border-line bg-panel2 px-2.5 py-1 text-[12px] text-dim"
                  title={
                    version.note
                      ? `${version.note} · hash ${version.content_hash.slice(0, 12)}…`
                      : `hash ${version.content_hash.slice(0, 12)}…`
                  }
                >
                  Version {version.version_no} · {version.is_draft ? "draft" : "sealed"}
                </span>
              )}

              {/* The honesty surface, one click from every stage: what this
                  build can and cannot do, read live from the API. */}
              <CapabilityDialog projectId={project.id} person={person} isGuest={isGuest} />

              <div className="ml-auto flex items-center gap-3">
                {person && <IdentityBadge person={person} />}
                <ThemeButton dark={darkMode} onToggle={toggleTheme} />
              </div>
            </div>
          </div>
        </header>

        <main className="min-h-[calc(100vh-96px)] px-8 py-6">{children}</main>
      </div>
    </div>
  );
}
