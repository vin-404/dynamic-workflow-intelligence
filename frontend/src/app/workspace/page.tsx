"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { listProjects, ApiError } from "@/lib/api";
import type { Project } from "@/lib/api";

const DEMO_PROJECT: Project = {
  id: "demo-product-launch",
  name: "Product Launch",
  description:
    "Demo workflow showing how FlowTrace connects work, dependencies, bottlenecks and downstream impact.",
  goal: "Launch the new product on schedule.",
  domain_id: "demo-product",
  start_date: "2026-09-01",
  deadline: "2026-09-30",
  today_day: 10,
  current_version_id: "demo-version-1",
};

export default function WorkspacePage() {
  const router = useRouter();

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadProjects() {
      try {
        const data = await listProjects();

        if (cancelled) return;

        setProjects(data.length > 0 ? data : [DEMO_PROJECT]);
        setError(null);
      } catch (e) {
        if (cancelled) return;

        setProjects([DEMO_PROJECT]);
        setError(
          e instanceof ApiError
            ? e.message
            : null,
        );
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
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
    <main className="min-h-screen bg-[#071019] text-white">
      <div className="mx-auto max-w-7xl px-6 py-8 lg:px-10">
        {/* Header */}
        <div className="mb-10 flex items-center justify-between">
          <button
            type="button"
            onClick={() => router.push("/")}
            className="text-sm text-white/60 transition hover:text-white"
          >
            ← Back to FlowTrace
          </button>

          <button
            type="button"
            onClick={() => router.push("/workspace/new")}
            className="rounded-xl bg-white px-5 py-3 text-sm font-semibold text-[#071019] transition hover:bg-white/90"
          >
            + New workflow
          </button>
        </div>

        {/* Intro */}
        <section className="mb-10">
          <p className="mb-3 text-sm font-medium uppercase tracking-[0.18em] text-cyan-300">
            Workspace
          </p>

          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            Choose a workflow
          </h1>

          <p className="mt-4 max-w-2xl text-base leading-7 text-white/60">
            Open an existing workflow, create a new one, or import a workflow
            from Jira.
          </p>
        </section>

        {/* Actions */}
        <section className="mb-10 grid gap-4 md:grid-cols-2">
          <button
            type="button"
            onClick={() => router.push("/workspace/new")}
            className="group rounded-2xl border border-white/10 bg-white/[0.04] p-6 text-left transition hover:border-white/20 hover:bg-white/[0.07]"
          >
            <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-white/10 text-xl">
              +
            </div>

            <h2 className="text-lg font-semibold">
              Create a new workflow
            </h2>

            <p className="mt-2 text-sm leading-6 text-white/55">
              Start from a blank workflow and define the work, dependencies,
              resources and deadlines.
            </p>

            <span className="mt-5 inline-block text-sm font-medium text-cyan-300 transition group-hover:translate-x-1">
              Create workflow →
            </span>
          </button>

          <button
            type="button"
            onClick={() => router.push("/workspace/import")}
            className="group rounded-2xl border border-white/10 bg-white/[0.04] p-6 text-left transition hover:border-white/20 hover:bg-white/[0.07]"
          >
            <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-white/10 text-xl">
              ↗
            </div>

            <h2 className="text-lg font-semibold">
              Import from Jira
            </h2>

            <p className="mt-2 text-sm leading-6 text-white/55">
              Bring an existing Jira workflow into FlowTrace and turn it into
              an intelligent project model.
            </p>

            <span className="mt-5 inline-block text-sm font-medium text-cyan-300 transition group-hover:translate-x-1">
              Import workflow →
            </span>
          </button>
        </section>

        {/* Existing workflows */}
        <section>
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold">
                Your workflows
              </h2>

              <p className="mt-1 text-sm text-white/45">
                Select a workflow to open its workspace.
              </p>
            </div>
          </div>

          {loading ? (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-sm text-white/50">
              Loading workflows…
            </div>
          ) : (
            <div className="grid gap-4">
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => openProject(project)}
                  className="group rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-left transition hover:border-white/20 hover:bg-white/[0.06]"
                >
                  <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-3">
                        <h3 className="truncate text-lg font-semibold">
                          {project.name}
                        </h3>

                        {project.id === DEMO_PROJECT.id && (
                          <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2.5 py-1 text-[11px] font-medium text-cyan-200">
                            Demo
                          </span>
                        )}
                      </div>

                      <p className="mt-2 max-w-2xl text-sm leading-6 text-white/50">
                        {project.description ||
                          project.goal ||
                          "FlowTrace workflow"}
                      </p>
                    </div>

                    <div className="shrink-0 text-sm font-medium text-cyan-300 transition group-hover:translate-x-1">
                      Open workspace →
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {error && projects.length > 0 && (
            <p className="mt-4 text-xs text-white/35">
              Showing the frontend demo workflow while the API is unavailable.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}