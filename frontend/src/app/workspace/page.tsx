"use client";

/**
 * The workspace list: open a workflow, create one, or import one.
 *
 * Light, on the same tokens as the landing and the stages - one ground, one
 * surface, one accent - so moving between the three no longer feels like
 * changing products (design brief §1, §6). The theme toggle lives here too,
 * reading and writing the same saved preference as the workspace shell.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { listProjects, ApiError } from "@/lib/api";
import type { Project } from "@/lib/api";
import { FlowLogo, ThemeButton, useTheme } from "@/components/WorkspaceShell";

const CARD =
  "group rounded-xl border border-line bg-panel p-6 text-left transition hover:border-accent/40 hover:shadow-[0_8px_28px_rgba(28,32,60,0.06)]";

export default function WorkspacePage() {
  const router = useRouter();
  const [darkMode, toggleTheme] = useTheme();

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadProjects() {
      try {
        const data = await listProjects();
        if (cancelled) return;
        setProjects(data);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // No substitute data. If the engine cannot be reached there is
        // nothing true to show, and inventing something here would make an
        // outage indistinguishable from a healthy system.
        setProjects([]);
        setError(e instanceof ApiError ? e.message : "The API could not be reached.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadProjects();
    return () => {
      cancelled = true;
    };
  }, []);

  function openProject(project: Project) {
    router.push(`/workspace/${project.id}/build`);
  }

  return (
    <main className="flowtrace-site min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-6 py-6 lg:px-10">
        {/* Header */}
        <div className="mb-10 flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={() => router.push("/")}
            aria-label="Go to FlowTrace home"
            className="flex items-center gap-3"
          >
            <FlowLogo />
          </button>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => router.push("/workspace/new")}
              className="rounded-xl bg-gradient-to-r from-accent to-violet px-4 py-2 text-[14px] font-semibold text-white shadow-[0_8px_22px_rgba(65,100,250,0.18)] transition hover:-translate-y-0.5"
            >
              + New workflow
            </button>
            <ThemeButton dark={darkMode} onToggle={toggleTheme} />
          </div>
        </div>

        {/* Intro */}
        <section className="mb-8">
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.16em] text-dim">
            Workspace
          </p>
          <h1 className="text-[36px] font-semibold leading-none tracking-[-0.02em]">
            Choose a workflow
          </h1>
          <p className="mt-3 max-w-2xl text-[14px] leading-6 text-dim">
            Open an existing workflow, create a new one, or import a workflow from Jira.
          </p>
        </section>

        {/* Actions */}
        <section className="mb-10 grid gap-4 md:grid-cols-2">
          <button type="button" onClick={() => router.push("/workspace/new")} className={CARD}>
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-[18px] text-accent">
              +
            </div>
            <h2 className="text-[18px] font-semibold">Create a new workflow</h2>
            <p className="mt-1.5 text-[14px] leading-6 text-dim">
              Start from a blank workflow and define the work, dependencies, resources and
              deadlines.
            </p>
            <span className="mt-4 inline-block text-[14px] font-medium text-accent transition group-hover:translate-x-1">
              Create workflow →
            </span>
          </button>

          <button type="button" onClick={() => router.push("/workspace/import")} className={CARD}>
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-[18px] text-accent">
              ↗
            </div>
            <h2 className="text-[18px] font-semibold">Import from Jira</h2>
            <p className="mt-1.5 text-[14px] leading-6 text-dim">
              Bring an existing Jira workflow into FlowTrace and turn it into an intelligent
              project model.
            </p>
            <span className="mt-4 inline-block text-[14px] font-medium text-accent transition group-hover:translate-x-1">
              Import workflow →
            </span>
          </button>
        </section>

        {/* Existing workflows */}
        <section>
          <div className="mb-4">
            <h2 className="text-[18px] font-semibold">Your workflows</h2>
            <p className="mt-1 text-[12px] text-dim">Select a workflow to open its workspace.</p>
          </div>

          {loading ? (
            <div className="rounded-xl border border-line bg-panel p-8 text-[14px] text-dim">
              Loading workflows…
            </div>
          ) : error ? (
            <div className="rounded-xl border border-critical/30 bg-critical/5 p-8">
              <p className="text-[14px] font-medium text-critical">Could not reach the API</p>
              <p className="mt-2 text-[14px] leading-6 text-dim">{error}</p>
              <p className="mt-3 text-[12px] text-dim">
                Nothing is shown rather than something invented. Every number in FlowTrace comes
                from the engine, so there is nothing to display until the engine can be reached.
              </p>
            </div>
          ) : projects.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line bg-panel p-8">
              <p className="text-[14px] font-medium">No workflows yet</p>
              <p className="mt-2 max-w-xl text-[14px] leading-6 text-dim">
                Create one to get started. FlowTrace will schedule it, find the bottlenecks, and
                explain every number it shows you.
              </p>
              <button
                type="button"
                onClick={() => router.push("/workspace/new")}
                className="mt-5 rounded-xl bg-gradient-to-r from-accent to-violet px-4 py-2 text-[14px] font-semibold text-white"
              >
                + New workflow
              </button>
            </div>
          ) : (
            <div className="grid gap-3">
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => openProject(project)}
                  className={CARD}
                >
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <h3 className="truncate text-[18px] font-semibold">{project.name}</h3>
                      <p className="mt-1.5 max-w-2xl text-[14px] leading-6 text-dim">
                        {project.description || project.goal || "FlowTrace workflow"}
                      </p>
                    </div>
                    <div className="shrink-0 text-[14px] font-medium text-accent transition group-hover:translate-x-1">
                      Open workspace →
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
