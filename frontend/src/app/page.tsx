"use client";

/**
 * The journey.
 *
 * Not a dashboard. The stages below are the order a person actually works in:
 * pick or define a domain, create a project, add who is doing the work,
 * define the tasks and what waits on what, then ask the platform for
 * intelligence about it.
 *
 * The analysis stages are deliberately locked until there is a workflow to
 * analyse - a KPI tile over an empty project is the drift this rewrite is
 * correcting.
 */

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
  Stat,
  days,
} from "@/components/ui";

type Stage =
  | "build"
  | "analyze"
  | "risk"
  | "whatif"
  | "optimize"
  | "history";

const STAGES: { id: Stage; label: string; needsWorkflow: boolean }[] = [
  { id: "build", label: "1 · Build", needsWorkflow: false },
  { id: "analyze", label: "2 · Bottlenecks", needsWorkflow: true },
  { id: "risk", label: "3 · Predicted risk", needsWorkflow: true },
  { id: "whatif", label: "4 · What if", needsWorkflow: true },
  { id: "optimize", label: "5 · Better workflows", needsWorkflow: true },
  { id: "history", label: "6 · History", needsWorkflow: false },
];

export default function Home() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [stage, setStage] = useState<Stage>("build");
  const [viewVersion, setViewVersion] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<ApiError | string | null>(null);
  const [busy, setBusy] = useState(false);
  // Who you are: the Google session, read once on mount. Not a choice made
  // here any more, and not something this client can influence - `proxy.ts`
  // derives the identity it sends upstream from the session cookie.
  const { person, failed: identityFailed } = useIdentity();
  // The hash is only ours to write once the initial restore has finished -
  // otherwise the sync effect fires first with no project and wipes the hash
  // we were about to read.
  const [booted, setBooted] = useState(false);

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
    Promise.all([listProjects(), listDomains()])
      .then(([p, d]) => {
        setProjects(p);
        setDomains(d);
        // The open project lives in the URL hash, so a refresh keeps your
        // place and a link opens on the same workflow. Without this, reloading
        // drops you back to the list - which the browser walkthrough found.
        const hash = new URLSearchParams(window.location.hash.slice(1));
        const wanted = hash.get("project");
        const stage = hash.get("stage") as Stage | null;
        const found = wanted ? p.find((x) => x.id === wanted) : undefined;
        if (found) {
          setProject(found);
          if (stage && STAGES.some((s) => s.id === stage)) setStage(stage);
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
    // `load` is stable (useCallback with no deps).
  }, [load]);

  // Keep the hash in step with where the user is, once boot has settled.
  useEffect(() => {
    if (!booted) return;
    const next = project ? `#project=${project.id}&stage=${stage}` : "";
    if (window.location.hash !== next) {
      window.history.replaceState(null, "", next || window.location.pathname);
    }
  }, [booted, project, stage]);

  async function open(p: Project) {
    setProject(p);
    setViewVersion(null);
    setStage("build");
    await load(p.id);
  }

  async function goTo(next: Stage) {
    setStage(next);
    if (
      project &&
      ["analyze", "risk"].includes(next) &&
      !analysis
    ) {
      await runAnalysis(project.id, viewVersion);
    }
  }

  const hasWorkflow = (workflow?.tasks.length ?? 0) > 0;

  /** One renderer, so the API's hint and request id are never dropped. */
  function renderError(onRetry?: () => void) {
    if (!error) return null;
    const api = error instanceof ApiError ? error : null;
    return (
      <div className="mb-4">
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

  /* --------------------------------------------------------- no project */

  const header = (
    <header className="mb-6">
      <h1 className="text-2xl font-semibold">Workflow Intelligence</h1>
      <p className="text-dim mt-1 max-w-2xl">
        Build a workflow, then ask it four things: where it is stuck now,
        where it is likely to get stuck, what a change would do, and whether
        there is a better arrangement of the same work.
      </p>
    </header>
  );

  /* ------------------------------------------------------- who are you */

  // The proxy has already redirected anyone without a session to /login, so
  // this is one round trip to /api/auth/session and not a sign-in screen.
  if (!person) {
    return (
      <main className="max-w-2xl w-full mx-auto p-6">
        {header}
        {identityFailed ? (
          <ErrorNote
            onRetry={() => location.reload()}
            hint={
              "Your session did not carry an account id, so every change you " +
              "made would be refused. Sign out and back in to rebuild it."
            }
          >
            You are signed in, but this session is not linked to an account on
            this instance.
          </ErrorNote>
        ) : (
          <Spinner label="Checking your session" />
        )}
      </main>
    );
  }

  if (!project) {
    return (
      <main className="max-w-4xl w-full mx-auto p-6">
        <div className="flex items-start justify-between gap-4">
          {header}
          <IdentityBadge person={person} />
        </div>

        {renderError(() => location.reload())}

        {creating ? (
          <ProjectCreate
            onCreated={async (p) => {
              setCreating(false);
              setProjects([...(projects ?? []), p]);
              await open(p);
            }}
            onCancel={() => setCreating(false)}
          />
        ) : (
          <Card>
            <CardTitle
              right={
                <Button variant="primary" onClick={() => setCreating(true)}>
                  New workflow
                </Button>
              }
            >
              Open a workflow
            </CardTitle>
            {projects === null ? (
              <Spinner label="Loading…" />
            ) : projects.length === 0 ? (
              <EmptyState
                title="Nothing here yet"
                action={
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    Create your first workflow
                  </Button>
                }
              >
                Start by describing what you are trying to accomplish. You can
                define your own kind of work — the analysis engine never sees
                it.
              </EmptyState>
            ) : (
              <ul className="space-y-1.5">
                {projects.map((p) => (
                  <li key={p.id}>
                    <button
                      onClick={() => open(p)}
                      className="w-full text-left border border-line rounded-md px-3 py-2 bg-panel2/40 hover:border-dim transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{p.name}</span>
                        <span className="flex-1" />
                        <span className="text-xs text-dim">
                          starts {p.start_date}
                        </span>
                        {p.deadline && (
                          <Badge tone="neutral">due {p.deadline}</Badge>
                        )}
                      </div>
                      {p.goal && (
                        <p className="text-sm text-dim mt-0.5">{p.goal}</p>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </main>
    );
  }

  /* ------------------------------------------------------- with a project */

  const domain = domains.find((d) => d.id === project.domain_id);

  return (
    <div className="flex flex-col min-h-screen">
      <header className="border-b border-line bg-panel/60 sticky top-0 z-10 backdrop-blur">
        <div className="max-w-6xl w-full mx-auto px-6 py-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <button
              onClick={() => {
                setProject(null);
                setWorkflow(null);
                setAnalysis(null);
              }}
              className="text-dim hover:text-foreground text-sm"
            >
              ← all workflows
            </button>
            <h1 className="text-lg font-semibold">{project.name}</h1>
            {domain && <Badge tone="neutral">{domain.name}</Badge>}
            {workflow && (
              <Badge tone={workflow.version.is_draft ? "neutral" : "green"}>
                v{workflow.version.version_no}
                {workflow.version.is_draft ? " draft" : ""}
              </Badge>
            )}
            {viewVersion && (
              <Badge tone="amber" title="Viewing an older version">
                historical view
              </Badge>
            )}
            <span className="flex-1" />
            <IdentityBadge person={person} />
          </div>
          {project.goal && (
            <p className="text-sm text-dim mt-0.5">{project.goal}</p>
          )}

          <nav className="flex flex-wrap gap-1 mt-3 -mb-px">
            {STAGES.map((s) => {
              const locked = s.needsWorkflow && !hasWorkflow;
              return (
                <button
                  key={s.id}
                  disabled={locked}
                  title={
                    locked ? "Add at least one task first" : undefined
                  }
                  onClick={() => goTo(s.id)}
                  className={`px-3 py-1.5 text-sm rounded-t-md border-b-2 transition-colors ${
                    stage === s.id
                      ? "border-accent text-foreground"
                      : locked
                        ? "border-transparent text-dim/40 cursor-not-allowed"
                        : "border-transparent text-dim hover:text-foreground"
                  }`}
                >
                  {s.label}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto p-6">
        {renderError(() => load(project.id, viewVersion))}

        {busy && !workflow && <Spinner label="Loading workflow…" />}

        {workflow && stage === "build" && (
          <Section
            title="Build the workflow"
            subtitle="Add who does the work, then the work, then what waits on what. Everything here writes to your draft version."
            right={
              hasWorkflow ? (
                <Button variant="primary" onClick={() => goTo("analyze")}>
                  Analyze this →
                </Button>
              ) : undefined
            }
          >
            <ErrorBoundary what="The workflow builder" resetKey={stage}>
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

        {stage === "analyze" && (
          <Section
            title="Where it is stuck now"
            subtitle="Each finding names the cause rather than the symptom, and shows the evidence it reasoned from."
            right={
              <Button
                onClick={() => runAnalysis(project.id, viewVersion)}
                disabled={busy}
              >
                Re-analyze
              </Button>
            }
          >
            {busy && !analysis && <Spinner label="Evaluating…" />}
            {!busy && !analysis && (
              <EmptyState
                title="Not analysed yet"
                action={
                  <Button
                    variant="primary"
                    onClick={() => runAnalysis(project.id, viewVersion)}
                  >
                    Analyze now
                  </Button>
                }
              >
                Nothing has been evaluated for this version yet. Analysis is a
                read — it never changes your workflow.
              </EmptyState>
            )}
            {analysis && (
              <div className="space-y-4">
                <ErrorBoundary what="The summary" resetKey={stage}>
                  <Headline analysis={analysis} />
                </ErrorBoundary>
                <ErrorBoundary what="The findings panel" resetKey={stage}>
                  <FindingsPanel analysis={analysis} />
                </ErrorBoundary>
                <ErrorBoundary what="The plain-language summary" resetKey={stage}>
                  <Explainer projectId={project.id} />
                </ErrorBoundary>
                {/* The graph is the most likely thing here to throw: it is the
                    only panel with a third-party layout engine under it. Its
                    own boundary means a layout bug costs the graph and not the
                    findings above it. */}
                <ErrorBoundary what="The dependency graph" resetKey={stage}>
                  <DependencyGraph analysis={analysis} />
                </ErrorBoundary>
              </div>
            )}
          </Section>
        )}

        {stage === "risk" && (
          <Section
            title="Where it is likely to get stuck"
            subtitle="A structural estimate, not a probability — with every factor, weight and reason on show."
          >
            {busy && !analysis && <Spinner label="Scoring…" />}
            {!busy && !analysis && (
              <EmptyState
                title="Nothing scored yet"
                action={
                  <Button
                    variant="primary"
                    onClick={() => runAnalysis(project.id, viewVersion)}
                  >
                    Score this workflow
                  </Button>
                }
              >
                Risk is computed from the same evaluation as the findings, so
                it arrives with them.
              </EmptyState>
            )}
            {analysis && (
              <ErrorBoundary what="The risk panel" resetKey={stage}>
              <RiskPanel
                analysis={analysis}
                busy={busy}
                onReweight={async (weights) => {
                  setBusy(true);
                  try {
                    const { getRisk } = await import("@/lib/api");
                    const next = await getRisk(project.id, weights);
                    setAnalysis({ ...analysis, risk: { ...analysis.risk, ...next } });
                  } finally {
                    setBusy(false);
                  }
                }}
              />
              </ErrorBoundary>
            )}
          </Section>
        )}

        {workflow && stage === "whatif" && (
          <Section
            title="What if something changes?"
            subtitle="Composed from a closed set of typed changes, evaluated against a copy. Your workflow is not touched, and the panel proves it."
          >
            <div className="space-y-6">
              <ErrorBoundary what="The sentence box" resetKey={stage}>
                <AskPanel workflow={workflow} />
              </ErrorBoundary>
              <ErrorBoundary what="The what-if panel" resetKey={stage}>
                <WhatIfPanel workflow={workflow} />
              </ErrorBoundary>
            </div>
          </Section>
        )}

        {stage === "optimize" && (
          <Section
            title="Is there a better arrangement?"
            subtitle="Candidates are generated, checked against your constraints, then scored by the same engine. Read the table, not the total."
          >
            <ErrorBoundary what="The optimizer" resetKey={stage}>
              <OptimizePanel
                projectId={project.id}
                onApplied={async () => {
                  const fresh = await getWorkflow(project.id);
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
            <ErrorBoundary what="The version history" resetKey={stage}>
              <VersionHistory
                projectId={project.id}
                currentVersionId={workflow?.version.id ?? null}
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
  );
}

function Headline({ analysis }: { analysis: Analysis }) {
  const f = analysis.feasibility;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      <Stat
        label="Planned finish"
        value={`day ${Math.round(analysis.planned_end)}`}
        sub={analysis.planned_end_date}
      />
      <Stat
        label="Projected finish"
        value={`day ${Math.round(analysis.projected_end)}`}
        sub={analysis.projected_end_date}
        tone={analysis.slip_days > 0 ? "red" : undefined}
      />
      <Stat
        label="Slip"
        value={days(analysis.slip_days, true)}
        sub={analysis.slip_days > 0 ? "later than planned" : "on plan"}
        tone={analysis.slip_days > 0 ? "red" : "green"}
      />
      <Stat
        label="Deadline"
        value={
          f.verdict === "no_deadline_set"
            ? "none set"
            : f.verdict === "feasible"
              ? "feasible"
              : f.verdict.replace(/_/g, " ")
        }
        sub={
          f.margin_days !== null ? `${days(f.margin_days, true)} margin` : undefined
        }
        tone={
          f.verdict === "feasible"
            ? "green"
            : f.verdict === "no_deadline_set"
              ? undefined
              : "red"
        }
      />
    </div>
  );
}
