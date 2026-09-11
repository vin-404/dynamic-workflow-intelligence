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
  getRisk,
  getWorkflow,
  listDomains,
  listProjects,
} from "@/lib/api";
import DependencyGraph from "@/components/DependencyGraph";
import ErrorBoundary from "@/components/ErrorBoundary";
import AskPanel from "@/components/AskPanel";
import Explainer from "@/components/Explainer";
import FindingsPanel from "@/components/FindingsPanel";
import BottleneckSummary from "@/components/BottleneckSummary";
import OptimizePanel from "@/components/OptimizePanel";
import RiskPanel from "@/components/RiskPanel";
import VersionHistory from "@/components/VersionHistory";
import WhatIfPanel from "@/components/WhatIfPanel";
import WorkflowBuilder from "@/components/WorkflowBuilder";
import ForecastPanel from "@/components/ForecastPanel";
import LiveFeed from "@/components/LiveFeed";
import RequirementChange from "@/components/RequirementChange";
import ScenarioList from "@/components/ScenarioList";
import ConstraintPanel from "@/components/ConstraintPanel";
import { MemberList } from "@/components/SetupPanel";
import { Button, EmptyState, ErrorNote, Section, Spinner } from "@/components/ui";
import { bandLabel, prose, statusLabel } from "@/lib/display";
import WorkspaceShell, { WorkspaceStage } from "@/components/WorkspaceShell";

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
  // The risk re-weight has its own in-flight and error state, separate from
  // the page's, so the panel can say "recomputing" over its own numbers and
  // show its own failure where the weights are - not in the page header.
  const [reweighting, setReweighting] = useState(false);
  const [reweightError, setReweightError] = useState<ApiError | null>(null);
  // Bumped whenever a panel on the what-if stage saves a scenario, so the
  // list below it re-reads without the panels knowing about each other.
  const [scenarioRefresh, setScenarioRefresh] = useState(0);
  // The task a reader clicked in the graph; the inspector in the rail shows
  // it. Null when nothing is focused.
  const [focusTask, setFocusTask] = useState<string | null>(null);

  const loadProject = useCallback(async () => {
    setBusy(true);
    setError(null);

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
    setReweightError(null);

    try {
      setAnalysis(await analyze(project.id));
    } catch (e) {
      setError(e instanceof ApiError ? e : String(e));
    } finally {
      setBusy(false);
    }
  }, [project]);

  /**
   * Re-score the risk with the reader's weights - on the engine.
   *
   * `POST /api/projects/{id}/risk` recomputes every factor contribution,
   * score and band and echoes the weights it used. Nothing is multiplied,
   * summed or banded here: the browser used to do that with its own copy of
   * the band thresholds, and the copy had drifted from `_band()` in the
   * engine, so one score could show two bands. The response replaces the
   * analysis's risk block wholesale, and on failure the previous ranking is
   * left on screen *with* the error beside it - never silently kept as if it
   * were the answer to the new weights.
   */
  const reweightRisk = useCallback(
    async (weights: Record<string, number>) => {
      if (!project || !analysis) return;
      setReweighting(true);
      setReweightError(null);
      try {
        const risk = await getRisk(project.id, weights, analysis.version_id);
        setAnalysis({
          ...analysis,
          risk: {
            tasks: risk.tasks,
            top: risk.top,
            band_counts: risk.band_counts,
            assumptions: risk.assumptions,
          },
        });
      } catch (e) {
        setReweightError(
          e instanceof ApiError ? e : new ApiError(0, String(e), String(e)),
        );
      } finally {
        setReweighting(false);
      }
    },
    [project, analysis],
  );

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
    <WorkspaceShell project={project} stage={stage} version={workflow?.version}>
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
              <MemberList projectId={project.id} />
            </div>
          </ErrorBoundary>
          <div className="mt-6 border-t border-line pt-6">
            <ErrorBoundary what="The constraints panel" resetKey={stage}>
              <ConstraintPanel
                workflow={workflow}
                onChange={(next) => {
                  setWorkflow(next);
                  setAnalysis(null);
                }}
              />
            </ErrorBoundary>
          </div>
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
            <div className="flex flex-col gap-6">
              {/* The graph takes the whole main column: it is the one thing on
                  this stage that needs the width (design brief §3). */}
              <ErrorBoundary what="The dependency graph" resetKey={stage}>
                <DependencyGraph
                  analysis={analysis}
                  selected={focusTask}
                  onSelect={setFocusTask}
                />
              </ErrorBoundary>

              {/* Three headline figures and the one honesty line (§4). */}
              <ErrorBoundary what="The summary" resetKey={stage}>
                <BottleneckSummary analysis={analysis} />
              </ErrorBoundary>

              <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
                <div className="flex min-w-0 flex-1 flex-col gap-5">
                  <ErrorBoundary what="The findings panel" resetKey={stage}>
                    <FindingsPanel analysis={analysis} onFocusTask={setFocusTask} />
                  </ErrorBoundary>
                </div>
                <aside className="flex w-full shrink-0 flex-col gap-5 lg:w-80">
                  <ErrorBoundary what="The task inspector" resetKey={stage}>
                    <TaskInspector
                      analysis={analysis}
                      taskKey={focusTask}
                      onClear={() => setFocusTask(null)}
                    />
                  </ErrorBoundary>
                  <ErrorBoundary what="The plain-language summary" resetKey={stage}>
                    <Explainer projectId={project.id} />
                  </ErrorBoundary>
                </aside>
              </div>
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
                busy={busy || reweighting}
                reweighting={reweighting}
                reweightError={reweightError}
                onReweight={reweightRisk}
                forecast={
                  /* The sampled forecast sits between the three-point range
                     and the exposure list, with its own band and label, so
                     the two kinds of number are never adjacent unnamed. */
                  <ErrorBoundary what="The forecast" resetKey={stage}>
                    <ForecastPanel projectId={project.id} />
                  </ErrorBoundary>
                }
              />
            </ErrorBoundary>
          )}
          {!analysis && !busy && (
            <div className="mt-6">
              <ErrorBoundary what="The forecast" resetKey={stage}>
                <ForecastPanel projectId={project.id} />
              </ErrorBoundary>
            </div>
          )}
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
              <AskPanel
                workflow={workflow}
                onScenarioCreated={() => setScenarioRefresh((n) => n + 1)}
              />
            </ErrorBoundary>
            <ErrorBoundary what="The what-if panel" resetKey={stage}>
              <WhatIfPanel
                workflow={workflow}
                onKept={() => setScenarioRefresh((n) => n + 1)}
              />
            </ErrorBoundary>
            <ErrorBoundary what="The saved scenarios" resetKey={stage}>
              <ScenarioList
                projectId={project.id}
                currentVersionId={workflow.version.id}
                refreshKey={scenarioRefresh}
              />
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
                // VersionHistory hands back `string | null`; getWorkflow's
                // second parameter is optional, so null has to become
                // undefined or it reads as "version null".
                const next = await getWorkflow(project.id, versionId ?? undefined);
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

/**
 * The task a reader clicked in the graph, with what the analysis already
 * says about it: its schedule, its slack, its structural exposure, and every
 * finding that names it. Nothing here is computed; every figure is the
 * engine's, read from the analysis on screen.
 */
function TaskInspector({
  analysis,
  taskKey,
  onClear,
}: {
  analysis: Analysis;
  taskKey: string | null;
  onClear: () => void;
}) {
  const task = taskKey ? analysis.tasks.find((t) => t.key === taskKey) : undefined;

  if (!task) {
    return (
      <div className="rounded-2xl border border-dashed border-line px-5 py-4 text-[12px] text-dim">
        Click a bar in the graph to inspect that task here.
      </div>
    );
  }

  const risk = analysis.risk.tasks.find((r) => r.task_key === task.key);
  const named = analysis.findings.filter((f) => f.task_ids.includes(task.key));

  return (
    <div className="rounded-2xl border border-line bg-panel p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[12px] text-dim">{task.key}</div>
          <div className="text-[18px] font-semibold leading-tight">{task.name}</div>
        </div>
        <button
          type="button"
          onClick={onClear}
          className="shrink-0 rounded-lg border border-line px-2 py-1 text-[12px] text-dim hover:text-foreground"
          aria-label="Clear the selected task"
        >
          Clear
        </button>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[14px]">
        <div>
          <dt className="text-[12px] text-dim">Owner</dt>
          <dd>{task.assignees.join(", ") || "Unassigned"}</dd>
        </div>
        <div>
          <dt className="text-[12px] text-dim">Status</dt>
          <dd>{statusLabel(task.status)}</dd>
        </div>
        <div>
          <dt className="text-[12px] text-dim">Runs</dt>
          <dd>
            {task.start_date} to {task.end_date}
          </dd>
        </div>
        <div>
          <dt className="text-[12px] text-dim">Duration</dt>
          <dd>{Math.round(task.duration * 10) / 10}d</dd>
        </div>
        <div>
          <dt className="text-[12px] text-dim">Slack</dt>
          <dd className={task.critical ? "font-semibold text-critical" : ""}>
            {task.critical ? "None, zero-slack chain" : `${Math.round(task.slack)}d`}
          </dd>
        </div>
        <div>
          <dt className="text-[12px] text-dim">Structural exposure</dt>
          <dd>{risk ? `${risk.score.toFixed(2)} · ${bandLabel(risk.band)}` : "Not scored"}</dd>
        </div>
      </dl>

      <div className="mt-4 border-t border-line pt-3">
        <div className="text-[12px] text-dim">
          {named.length === 0
            ? "No finding names this task."
            : `Named in ${named.length} ${named.length === 1 ? "finding" : "findings"}`}
        </div>
        {named.length > 0 && (
          <ul className="mt-2 space-y-2">
            {named.map((f) => (
              <li key={`${f.kind}-${f.task_ids.join(",")}`} className="text-[14px]">
                <span className="font-semibold">Do this:</span> {prose(f.suggested_action)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
