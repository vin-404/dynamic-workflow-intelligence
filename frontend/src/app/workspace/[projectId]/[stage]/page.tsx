"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
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
import AskPanel from "@/components/AskPanel";
import Explainer from "@/components/Explainer";
import FindingsPanel from "@/components/FindingsPanel";
import OptimizePanel from "@/components/OptimizePanel";
import RiskPanel from "@/components/RiskPanel";
import VersionHistory from "@/components/VersionHistory";
import WhatIfPanel from "@/components/WhatIfPanel";
import WorkflowBuilder from "@/components/WorkflowBuilder";
import ForecastPanel from "@/components/ForecastPanel";
import LiveFeed from "@/components/LiveFeed";
import RequirementChange from "@/components/RequirementChange";
import { MemberList } from "@/components/SetupPanel";
import { Button, EmptyState, ErrorNote, Section, Spinner } from "@/components/ui";
import WorkspaceShell, { WorkspaceStage } from "@/components/WorkspaceShell";
import { DEMO_ANALYSIS, DEMO_DOMAIN, DEMO_FORECAST, DEMO_PROJECT, DEMO_WORKFLOW } from "@/lib/demo";

const VALID_STAGES: WorkspaceStage[] = [
  "build",
  "live",
  "bottlenecks",
  "risk",
  "requirements",
  "whatif",
  "optimize",
  "history",
];

export default function WorkspaceStagePage() {
  const params = useParams<{ projectId: string; stage: string }>();
  const router = useRouter();
  const projectId = params.projectId;
  const requestedStage = params.stage as WorkspaceStage;
  const stage = VALID_STAGES.includes(requestedStage) ? requestedStage : "build";

  const [project, setProject] = useState<Project | null>(null);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [error, setError] = useState<ApiError | string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadProject = useCallback(async () => {
    setBusy(true);
    setError(null);

    if (projectId === DEMO_PROJECT.id) {
      setProject(DEMO_PROJECT);
      setWorkflow(DEMO_WORKFLOW);
      setDomains([DEMO_DOMAIN]);
      setBusy(false);
      return;
    }

    try {
      const [projects, domainList] = await Promise.all([listProjects(), listDomains()]);
      const found = projects.find((item) => item.id === projectId);
      if (!found) {
        setError("That workflow could not be found.");
        return;
      }
      setProject(found);
      setDomains(domainList);
      setWorkflow(await getWorkflow(found.id));
    } catch (e) {
      setError(e instanceof ApiError ? e : String(e));
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  const runAnalysis = useCallback(async () => {
    if (!project) return;
    setBusy(true);
    setError(null);

    try {
      if (project.id === DEMO_PROJECT.id) {
        setAnalysis(DEMO_ANALYSIS);
      } else {
        setAnalysis(await analyze(project.id));
      }
    } catch (e) {
      setError(e instanceof ApiError ? e : String(e));
    } finally {
      setBusy(false);
    }
  }, [project]);

  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  useEffect(() => {
    if (!project) return;
    if (stage === "bottlenecks" || stage === "risk") {
      void runAnalysis();
    }
  }, [project, stage, runAnalysis]);

  const domain = useMemo(
    () => domains.find((item) => item.id === project?.domain_id),
    [domains, project],
  );

  function renderError() {
    if (!error) return null;
    return (
      <div className="mb-6">
        <ErrorNote onRetry={() => void loadProject()}>
          {error instanceof ApiError ? error.userMessage : String(error)}
        </ErrorNote>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="min-h-screen bg-[#F7F7FC] px-8 py-12">
        <div className="max-w-3xl mx-auto">
          {busy && <Spinner label="Loading workflow…" />}
          {!busy && renderError()}
        </div>
      </div>
    );
  }

  return (
    <WorkspaceShell project={project} stage={stage}>
      {renderError()}

      {busy && !workflow && <Spinner label="Loading workflow…" />}

      {stage === "build" && workflow && (
        <Section
          title="Build the workflow"
          subtitle="Add who does the work, then the work, then what waits on what. Everything here writes to your draft version."
          right={
            workflow.tasks.length > 0 ? (
              <Button variant="primary" onClick={() => router.push(`/workspace/${project.id}/bottlenecks`)}>
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
              {project.id !== DEMO_PROJECT.id && <MemberList projectId={project.id} />}
            </div>
          </ErrorBoundary>
        </Section>
      )}

      {stage === "live" && workflow && (
        <Section
          title="Watch it happen"
          subtitle="The event log replayed in accelerated time. Findings appear and clear on their own, at the simulated day they would have."
        >
          <ErrorBoundary what="The live replay" resetKey={stage}>
            <LiveFeed projectId={project.id} workflow={workflow} analysis={analysis} />
          </ErrorBoundary>
        </Section>
      )}

      {stage === "bottlenecks" && (
        <Section
          title="Where it is stuck now"
          subtitle="Each finding names the cause rather than the symptom, and shows the evidence it reasoned from."
          right={
            !analysis ? (
              <Button variant="primary" onClick={() => void runAnalysis()}>
                Analyze this →
              </Button>
            ) : undefined
          }
        >
          {busy && !analysis && <Spinner label="Analyzing…" />}
          {!busy && !analysis && (
            <EmptyState title="Nothing has been evaluated for this version yet">
              Run the analysis to see dependencies, bottlenecks and findings.
            </EmptyState>
          )}
          {analysis && (
            <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
              <div className="flex min-w-0 flex-1 flex-col gap-5">
                <ErrorBoundary what="The dependency graph" resetKey={stage}>
                  <DependencyGraph analysis={analysis} />
                </ErrorBoundary>
                <ErrorBoundary what="The findings panel" resetKey={stage}>
                  <FindingsPanel analysis={analysis} />
                </ErrorBoundary>
              </div>
              <aside className="flex w-full shrink-0 flex-col gap-5 lg:w-72 lg:border-l lg:border-line lg:pl-5">
                <ErrorBoundary what="The summary" resetKey={stage}>
                  <Headline analysis={analysis} />
                </ErrorBoundary>
                <ErrorBoundary what="The plain-language summary" resetKey={stage}>
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
          {busy && !analysis && <Spinner label="Scoring…" />}
          {!busy && !analysis && (
            <EmptyState
              title="The structural score is not computed yet"
              action={<Button variant="primary" onClick={() => void runAnalysis()}>Score this workflow</Button>}
            >
              Risk is computed from the same evaluation as the findings.
            </EmptyState>
          )}
          {analysis && (
            <ErrorBoundary what="The risk panel" resetKey={stage}>
              <RiskPanel
                analysis={analysis}
                busy={busy}
                onReweight={async (weights) => {
                  if (project.id !== DEMO_PROJECT.id) return;
                  const nextTasks = analysis.risk.tasks.map((task) => {
                    const factors = task.factors.map((factor) => ({
                      ...factor,
                      weight: weights[factor.name] ?? factor.weight,
                      contribution: factor.value * (weights[factor.name] ?? factor.weight),
                    }));
                    const score = factors.reduce((sum, factor) => sum + factor.contribution, 0);
                    return {
                      ...task,
                      factors,
                      score,
                      band: score >= 0.6 ? "high" : score >= 0.35 ? "moderate" : "low",
                    };
                  });
                  setAnalysis({
                    ...analysis,
                    risk: {
                      ...analysis.risk,
                      tasks: nextTasks,
                      top: [...nextTasks].sort((a, b) => b.score - a.score),
                      band_counts: {
                        high: nextTasks.filter((t) => t.band === "high").length,
                        moderate: nextTasks.filter((t) => t.band === "moderate").length,
                        low: nextTasks.filter((t) => t.band === "low").length,
                      },
                      assumptions: {
                        ...analysis.risk.assumptions,
                        weights,
                        weights_total: Object.values(weights).reduce((a, b) => a + b, 0),
                      },
                    },
                  });
                }}
              />
            </ErrorBoundary>
          )}
          <div className="mt-6">
            <ErrorBoundary what="The forecast" resetKey={stage}>
              <ForecastPanel
                projectId={project.id}
                demoData={project.id === DEMO_PROJECT.id ? DEMO_FORECAST : undefined}
              />
            </ErrorBoundary>
          </div>
        </Section>
      )}

      {stage === "requirements" && workflow && (
        <Section
          title="When a requirement changes"
          subtitle="See what a new wording would invalidate, what it would cost, and who needs to know before anything is applied."
        >
          <ErrorBoundary what="The requirement panel" resetKey={stage}>
            <RequirementChange
              projectId={project.id}
              workflow={workflow}
              onApplied={() => {
                setAnalysis(null);
                void loadProject();
              }}
            />
          </ErrorBoundary>
        </Section>
      )}

      {stage === "whatif" && workflow && (
        <Section
          title="What if something changes?"
          subtitle="Test typed changes against a copy of the workflow. Your real workflow is not touched."
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
          subtitle="Candidates are generated, checked against your constraints, then scored by the same engine."
        >
          <ErrorBoundary what="The optimizer" resetKey={stage}>
            <OptimizePanel
              projectId={project.id}
              onApplied={async () => {
                await loadProject();
                router.push(`/workspace/${project.id}/history`);
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
                const next = await getWorkflow(project.id, versionId);
                setWorkflow(next);
                router.push(`/workspace/${project.id}/build`);
              }}
            />
          </ErrorBoundary>
        </Section>
      )}
    </WorkspaceShell>
  );
}

function Headline({ analysis }: { analysis: Analysis }) {
  return (
    <div className="rounded-2xl border border-[#E2E1EC] bg-white p-5">
      <div className="text-[11px] uppercase tracking-[0.18em] text-[#68677A] font-semibold">Summary</div>
      <div className="text-3xl font-semibold mt-3">{analysis.slip_days > 0 ? `+${analysis.slip_days}` : analysis.slip_days}d</div>
      <div className="text-sm text-[#68677A] mt-1">projected slip</div>
      <div className="grid grid-cols-2 gap-3 mt-5">
        <div className="rounded-xl bg-[#F7F7FC] p-3">
          <div className="text-lg font-semibold">{analysis.critical_path.length}</div>
          <div className="text-xs text-[#68677A]">critical tasks</div>
        </div>
        <div className="rounded-xl bg-[#F7F7FC] p-3">
          <div className="text-lg font-semibold">{analysis.findings.length}</div>
          <div className="text-xs text-[#68677A]">findings</div>
        </div>
      </div>
    </div>
  );
}
