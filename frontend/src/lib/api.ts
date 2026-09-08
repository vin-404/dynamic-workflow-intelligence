/**
 * API client.
 *
 * Paths are relative, so `next.config.ts`'s rewrite proxies them to the
 * backend and there is no CORS story in development.
 *
 * Note what is absent from these types: no `department`, no `owner` string,
 * no domain on a task. A task is named, sized in effort, optionally
 * divisible, and assigned to resources by key. The domain lives on the
 * project, as context for the user - never in the analysis payload.
 */

/**
 * Always relative. Never configurable.
 *
 * Every request goes to this app's own origin, where `src/proxy.ts` verifies
 * the session and injects the identity headers the backend trusts. That makes
 * an absolute backend URL here actively dangerous rather than merely
 * redundant: pointing the browser at FastAPI directly would bypass the origin,
 * the session check and the injection in one step, and the app would look
 * signed-in while every request arrived anonymous. This used to read
 * `NEXT_PUBLIC_API_URL`, whose default in `docker-compose.yml` was exactly
 * that absolute URL - so the safe configuration depended on someone
 * remembering to blank a variable. It is not a variable any more.
 *
 * `API_REWRITE_URL` (server-side only) is where the backend URL is configured.
 */
const BASE = "";

export class ApiError extends Error {
  status: number;
  /** The structured reason a validation failed. These reasons are a feature. */
  detail: unknown;
  constructor(status: number, message: string, detail: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }

  /**
   * What to do about it, from the API's `hint`. Every 4xx and 5xx carries
   * one, because "422 Unprocessable Entity" is not something a person can
   * act on.
   */
  hint = "";

  /** The server's id for this request, for correlating with its logs. */
  requestId = "";

  /** A sentence a user can act on, dug out of whatever shape the detail is. */
  get userMessage(): string {
    const d = this.detail as
      | string
      | { message?: string; rejections?: { reason: string }[]; detail?: string }
      | undefined;
    if (typeof d === "string") return d;
    if (d?.rejections?.length) return d.rejections.map((r) => r.reason).join(" ");
    if (d?.message) return d.message;
    if (d?.detail) return d.detail;
    return this.message;
  }

  /** The cycle, when a dependency was refused for creating one. */
  get cycles(): string[][] | null {
    const d = this.detail as { cycles?: string[][] } | undefined;
    return d?.cycles ?? null;
  }

  /** The constraint that refused a mutation, when one did. */
  get constraint(): { constraint: string; constraint_reason: string } | null {
    const d = this.detail as
      | { rejections?: { constraint?: string; constraint_reason?: string }[] }
      | undefined;
    const first = d?.rejections?.find((r) => r.constraint);
    return first
      ? {
          constraint: first.constraint as string,
          constraint_reason: first.constraint_reason ?? "",
        }
      : null;
  }
}

/**
 * No identity is sent from here, deliberately.
 *
 * `src/proxy.ts` deletes any `X-User-Id` on an incoming request and sets the
 * one it derives from the verified session cookie. So a header set here would
 * be stripped before the backend saw it, and code that looked like it was
 * choosing an identity would in fact be choosing nothing - which is worse than
 * not having it. This module used to hold a `setCurrentUser`; the session
 * replaced it.
 */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    ...init,
  });
  if (!res.ok) {
    let detail: unknown = null;
    let hint = "";
    let requestId = res.headers.get("X-Request-ID") ?? "";
    try {
      const body = await res.json();
      detail = body.detail ?? body;
      hint = body.hint ?? "";
      requestId = body.request_id ?? requestId;
    } catch {
      detail = await res.text().catch(() => null);
    }
    const error = new ApiError(
      res.status, `${res.status} ${res.statusText}`, detail,
    );
    error.hint = hint;
    error.requestId = requestId;
    throw error;
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const post = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
const patch = <T>(path: string, body: unknown) =>
  call<T>(path, { method: "PATCH", body: JSON.stringify(body) });
const del = <T>(path: string) => call<T>(path, { method: "DELETE" });

/* ------------------------------------------------------------------ types */

export interface Domain {
  id: string;
  key: string;
  name: string;
  description: string;
  vocabulary_hints: string[];
  task_templates: { name: string; effort: number; divisible?: boolean }[];
  duration_variance_prior: number;
  is_custom: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  goal: string;
  domain_id: string | null;
  start_date: string;
  deadline: string | null;
  today_day: number;
  current_version_id: string | null;
}

export interface Member {
  user_id: string;
  email: string;
  name: string;
  role: string;
}

export interface Version {
  id: string;
  version_no: number;
  parent_version_id: string | null;
  created_from_scenario_id: string | null;
  note: string;
  content_hash: string;
  is_draft: boolean;
  deadline_day: number | null;
  /** ISO 8601 UTC, from `WorkflowVersion.created_at`. */
  created_at: string;
}

export interface WorkflowTask {
  key: string;
  name: string;
  description: string;
  effort: number;
  divisible: boolean;
  priority: number;
  optimistic: number | null;
  likely: number | null;
  pessimistic: number | null;
  required_skills: string[];
  status: string;
  assignees: { key: string; label: string }[];
}

export interface WorkflowDependency {
  from_task: string;
  to_task: string;
  dep_type: string;
  /** True marks an artifact dependency, which carries requirement invalidation. */
  consumes: boolean;
}

export interface WorkflowResource {
  key: string;
  name: string;
  kind: string;
  capacity: number;
  skills: string[];
  parent_key: string | null;
  label: string;
}

export interface Constraint {
  kind: string;
  target: string;
  reason: string;
  value: number | null;
}

export interface Workflow {
  project_id: string;
  project_name: string;
  goal: string;
  project_start: string;
  deadline: string | null;
  deadline_day: number | null;
  today_day: number;
  version: {
    id: string;
    version_no: number;
    parent_version_id: string | null;
    content_hash: string;
    is_draft: boolean;
    note: string;
    created_at: string;
  };
  tasks: WorkflowTask[];
  dependencies: WorkflowDependency[];
  resources: WorkflowResource[];
  requirements: {
    key: string;
    version_no: number;
    text: string;
    consumed_by: string[];
  }[];
  constraints: Constraint[];
}

export interface Impact {
  score: number;
  magnitude: number;
  magnitude_kind: string;
  magnitude_label: string;
  downstream_affected: number;
  formula: string;
  worked: string;
}

export interface Finding {
  kind: string;
  tier: number;
  tier_name: string;
  severity: string;
  task_ids: string[];
  root_cause: string | null;
  evidence: Record<string, unknown>;
  impact_score: number;
  impact: Impact;
  downstream_affected: string[];
  suggested_action: string;
  explanation: string;
  suppressed: { by: string; reason: string } | null;
}

export interface UnavailableCheck {
  tier: number;
  checks: string[];
  requires: string;
  why: string;
  unlocked_by: string;
}

export interface ThreePoint {
  optimistic_day: number;
  likely_day: number;
  pessimistic_day: number;
  spread_days: number;
  deadline_day: number | null;
  verdicts: Record<string, string>;
  assumptions: Record<string, unknown>;
  is_probability: false;
  method: string;
  monte_carlo: {
    available: false;
    why: string;
    what_it_would_report: string;
    why_not_faked: string;
  };
}

export interface Feasibility {
  verdict: string;
  deadline_day: number | null;
  projected_end_day: number;
  margin_days: number | null;
  statement: string;
  three_point: ThreePoint | null;
  is_probability: false;
}

export interface RiskFactor {
  name: string;
  value: number;
  weight: number;
  contribution: number;
  reason: string;
  evidence: Record<string, unknown>;
  tier: number;
  available: boolean;
}

export interface TaskRisk {
  task_key: string;
  task_name: string;
  score: number;
  band: string;
  score_kind: string;
  formula: string;
  factors: RiskFactor[];
  explanation: string;
  top_factors: string[];
}

export interface RiskBlock {
  tasks: TaskRisk[];
  top: TaskRisk[];
  band_counts: Record<string, number>;
  assumptions: {
    score_kind: string;
    disclaimer: string;
    formula: string;
    weights: Record<string, number>;
    weights_total: number;
    duration_spread: {
      relative_spread: number;
      provenance: string;
      tasks_with_three_point_estimate: string[];
      tasks_using_spread_prior: string[];
    };
    factors_unavailable: string[];
    factors_unavailable_note: string;
    rework_modelled: boolean;
    monte_carlo_run: boolean;
    what_would_make_this_a_probability: string;
  };
}

export interface AnalysisTaskRow {
  key: string;
  name: string;
  effort: number;
  duration: number;
  status: string;
  assignees: string[];
  es: number;
  ef: number;
  ls: number;
  lf: number;
  slack: number;
  critical: boolean;
  start_date: string;
  end_date: string;
  depends_on: string[];
}

export interface Analysis {
  analysis_run_id: string | null;
  engine_version: string;
  input_hash: string;
  schedulable: boolean;
  cycles: string[][];
  project_id: string;
  project_name: string;
  version_id: string;
  version_no: number;
  project_start: string;
  today_day: number;
  planned_end: number;
  projected_end: number;
  slip_days: number;
  planned_end_date: string;
  projected_end_date: string;
  deadline_date: string | null;
  critical_path: string[];
  tasks: AnalysisTaskRow[];
  resources: {
    key: string;
    name: string;
    label: string;
    kind: string;
    capacity: number;
    parent_key: string | null;
  }[];
  edges: {
    source: string;
    target: string;
    dep_type: string;
    consumes: boolean;
  }[];
  findings: Finding[];
  suppressed_findings: Finding[];
  finding_counts_by_tier: Record<string, number>;
  feasibility: Feasibility;
  effort_model: {
    formula: string;
    efficiency: number;
    non_divisible_tasks: string[];
    note: string;
  };
  config: Record<string, number | string>;
  tier_reached: number;
  checks_run: string[];
  unavailable_checks: UnavailableCheck[];
  resource_unavailability: {
    adjustments?: {
      task: string;
      task_name: string;
      resource_name: string;
      days_added: number;
    }[];
    total_days_added?: number;
    method?: string;
    is_approximation?: boolean;
  };
  risk: RiskBlock;
}

export interface MutationIn {
  kind: string;
  payload: Record<string, unknown>;
}

export interface MutationKindSpec {
  kind: string;
  required: string[];
  optional: string[];
}

export interface Scenario {
  id: string;
  project_id: string;
  base_version_id: string;
  name: string;
  origin: string;
  status: string;
  rationale: string;
  rejection_reason: string;
  created_at: string;
  mutations: {
    seq: number;
    kind: string;
    payload: Record<string, unknown>;
    created_by: string;
    describes: string;
  }[];
  discarded?: boolean;
}

export interface Comparison {
  projected_completion: {
    before_day: number;
    after_day: number;
    delta_days: number;
    direction: string;
  };
  tasks_moved: {
    task: string;
    name: string;
    from_day: number;
    to_day: number;
    delta_days: number;
  }[];
  tasks_moved_count: number;
  slack_consumed: Record<string, number>;
  slack_consumed_total_days: number;
  critical_path: {
    before: string[];
    after: string[];
    changed: boolean;
    newly_critical: string[];
    no_longer_critical: string[];
  };
  findings: {
    before_count: number;
    after_count: number;
    created: Finding[];
    removed: Finding[];
    unchanged: string[];
  };
  resource_overload: {
    before: Record<string, { capacity: number; peak_concurrent_tasks: number; overflow: number; resource_name: string }>;
    after: Record<string, { capacity: number; peak_concurrent_tasks: number; overflow: number; resource_name: string }>;
    resolved: string[];
    introduced: string[];
  };
  feasibility: {
    before: Feasibility;
    after: Feasibility;
    margin_delta_days: number | null;
    verdict_changed: boolean;
  };
  structure: {
    tasks_added: string[];
    tasks_removed: string[];
    dependencies_added: string[][];
    dependencies_removed: string[][];
    total_effort_before: number;
    total_effort_after: number;
    total_effort_delta: number;
  };
  effort_model: Record<string, unknown>;
}

export interface SimulationResponse {
  scenario_name: string;
  origin: string;
  validation: { valid: boolean; rejections: unknown[] };
  mutations: MutationIn[];
  inverse_mutations: MutationIn[];
  base_version_hash: string;
  base_version_hash_after_evaluation: string;
  base_unchanged: boolean;
  scenario_hash: string;
  base: Analysis;
  after: Analysis;
  comparison: Comparison;
  scenario: Scenario;
  analysis_run_id: string | null;
  summary: string;
  project_start: string;
  projected_end_date_before: string;
  projected_end_date_after: string;
}

export interface CriterionRow {
  name: string;
  before: number;
  after: number;
  delta: number;
  improvement: number;
  weight: number;
  contribution: number;
  better: string;
  unit: string;
  explanation: string;
}

export interface OptimizeCandidate {
  name: string;
  generator: string;
  origin: string;
  rationale: string;
  mutations: MutationIn[];
  mutation_summary: string[];
  rejected: boolean;
  scope_change: boolean;
  effort_delta_days: number;
  scope_change_note: string | null;
  constraint_violations: {
    mutation: string;
    reason: string;
    constraint: string | null;
    constraint_reason: string | null;
  }[];
  evaluated: boolean;
  scores: {
    total: number;
    formula: string;
    note: string;
    criteria: CriterionRow[];
  } | null;
  deltas: Record<string, number | string>;
  comparison: Comparison;
  scenario_id?: string;
}

export interface OptimizeResponse {
  current: {
    projected_end_day: number;
    projected_end_date: string;
    feasibility: Feasibility;
    scores: Record<string, number>;
    engine_version: string;
    input_hash: string;
  };
  weights: Record<string, number>;
  weights_total: number;
  budget: { max_candidates: number; max_seconds: number | null };
  generated: number;
  evaluated: number;
  stopped_early: boolean;
  stop_reason: string;
  aggressive: boolean;
  recommended: OptimizeCandidate | null;
  recommendation_reason: string;
  recommended_same_scope: OptimizeCandidate | null;
  recommended_same_scope_note: string;
  recommended_scenario_id: string | null;
  candidates: OptimizeCandidate[];
  rejected: OptimizeCandidate[];
  note: string;
  project_id: string;
  base_version_id: string;
  elapsed_seconds: number;
}

export interface Accuracy {
  project_id: string;
  has_labels: boolean;
  engine_version?: string;
  tier_reached?: number;
  checks_run?: string[];
  labelled: number;
  detected: number;
  true_positives: string[];
  missed: string[];
  unexpected: string[];
  recall: number | null;
  precision: number | null;
  planted: number;
  planted_found: string[];
  planted_recall: number | null;
  labels: {
    kind: string;
    root_cause: string;
    description: string;
    planted: boolean;
    detected: boolean;
  }[];
  note?: string;
}

/* ---------------------------------------------------------------- domains */

export const listDomains = () => call<Domain[]>("/api/domains");

export const createDomain = (body: {
  key: string;
  name: string;
  description?: string;
  vocabulary_hints?: string[];
}) => post<Domain>("/api/domains", body);

/* --------------------------------------------------------------- projects */

export const listProjects = () => call<Project[]>("/api/projects");

export const getProject = (id: string) => call<Project>(`/api/projects/${id}`);

export const createProject = (body: {
  name: string;
  goal?: string;
  description?: string;
  domain_id?: string | null;
  new_domain?: { key: string; name: string; description?: string };
  start_date: string;
  deadline?: string | null;
  today_day?: number;
  owner_email?: string;
}) => post<Project>("/api/projects", body);

export const listMembers = (id: string) =>
  call<Member[]>(`/api/projects/${id}/members`);

export const addMember = (
  id: string,
  body: { email: string; name?: string; role: string },
) => post<Member>(`/api/projects/${id}/members`, body);

export const removeMember = (id: string, userId: string) =>
  del<void>(`/api/projects/${id}/members/${userId}`);

export const listVersions = (id: string) =>
  call<Version[]>(`/api/projects/${id}/versions`);

export const seededProjects = () =>
  call<{ projects: Record<string, string>; demo_project_id: string }>(
    "/api/seed/projects",
  );

/* ---------------------------------------------------------- authoring */

export const getWorkflow = (id: string, versionId?: string) =>
  call<Workflow>(
    `/api/projects/${id}/workflow${versionId ? `?version_id=${versionId}` : ""}`,
  );

export const createTask = (
  id: string,
  body: {
    key: string;
    name: string;
    effort: number;
    description?: string;
    divisible?: boolean;
    status?: string;
    assignees?: string[];
    required_skills?: string[];
  },
) => post<Workflow>(`/api/projects/${id}/tasks`, body);

export const patchTask = (
  id: string,
  key: string,
  body: Partial<{
    name: string;
    effort: number;
    divisible: boolean;
    status: string;
    assignees: string[];
    description: string;
  }>,
) => patch<Workflow>(`/api/projects/${id}/tasks/${key}`, body);

export const deleteTask = (id: string, key: string) =>
  del<Workflow>(`/api/projects/${id}/tasks/${key}`);

export const createDependency = (
  id: string,
  body: { from_task: string; to_task: string; consumes?: boolean },
) => post<Workflow>(`/api/projects/${id}/dependencies`, body);

export const deleteDependency = (id: string, from: string, to: string) =>
  del<Workflow>(`/api/projects/${id}/dependencies/${from}/${to}`);

export const createResource = (
  id: string,
  body: {
    key: string;
    name: string;
    kind?: string;
    capacity?: number;
    parent_key?: string | null;
    skills?: string[];
  },
) => post<Workflow>(`/api/projects/${id}/resources`, body);

export const deleteResource = (id: string, key: string) =>
  del<Workflow>(`/api/projects/${id}/resources/${key}`);

export const addAssignment = (
  id: string,
  taskKey: string,
  resourceKey: string,
) =>
  post<Workflow>(`/api/projects/${id}/tasks/${taskKey}/assignments`, {
    resource_key: resourceKey,
  });

export const removeAssignment = (
  id: string,
  taskKey: string,
  resourceKey: string,
) =>
  del<Workflow>(
    `/api/projects/${id}/tasks/${taskKey}/assignments/${resourceKey}`,
  );

export const createConstraint = (
  id: string,
  body: { kind: string; target: string; reason?: string; value?: number },
) => post<Workflow>(`/api/projects/${id}/constraints`, body);

/* ---------------------------------------------------------- analysis */

export const analyze = (id: string, versionId?: string) =>
  post<Analysis>(`/api/projects/${id}/analyze`, { version_id: versionId });

export const getRisk = (id: string, weights?: Record<string, number>) =>
  post<RiskBlock & { tier_reached: number; feasibility: Feasibility }>(
    `/api/projects/${id}/risk`,
    weights ? { weights } : {},
  );

export const requirementImpact = (id: string, requirementKey: string) =>
  post<{
    requirement_key: string;
    text: string;
    from_version: number;
    to_version: number;
    directly_consumed_by: string[];
    must_redo: { key: string; name: string; status: string; assignees: string[] }[];
    must_recheck: { key: string; name: string; status: string; assignees: string[] }[];
    resources_hit: string[];
    wasted_days: number;
  }>(`/api/projects/${id}/requirement-impact`, {
    requirement_key: requirementKey,
  });

export const getAccuracy = (id: string) =>
  call<Accuracy>(`/api/projects/${id}/accuracy`);

/* --------------------------------------------------------- scenarios */

export const mutationKinds = () =>
  call<{ closed: boolean; note: string; kinds: MutationKindSpec[] }>(
    "/api/scenarios/mutation-kinds",
  );

export const whatIf = (
  id: string,
  mutations: MutationIn[],
  opts?: { name?: string; keep?: boolean },
) =>
  post<SimulationResponse>(`/api/projects/${id}/what-if`, {
    mutations,
    name: opts?.name ?? "What-if",
    keep: opts?.keep ?? false,
  });

export const listScenarios = (id: string) =>
  call<Scenario[]>(`/api/projects/${id}/scenarios`);

export const getScenario = (scenarioId: string) =>
  call<Scenario>(`/api/scenarios/${scenarioId}`);

export const evaluateScenario = (scenarioId: string) =>
  post<SimulationResponse>(`/api/scenarios/${scenarioId}/evaluate`);

export const applyScenario = (scenarioId: string, note?: string) =>
  post<{
    scenario_id: string;
    applied: boolean;
    new_version: {
      id: string;
      version_no: number;
      parent_version_id: string;
      content_hash: string;
      note: string;
    };
    parent_version: {
      id: string;
      version_no: number;
      content_hash: string;
      unchanged: boolean;
    };
    project_current_version_id: string;
  }>(`/api/scenarios/${scenarioId}/apply`, { note: note ?? "" });

export const deleteScenario = (scenarioId: string) =>
  del<void>(`/api/scenarios/${scenarioId}`);

/* ---------------------------------------------------------- optimize */

export const optimizeObjectives = (id: string) =>
  call<{
    weights: Record<string, number>;
    weights_total: number;
    criteria: {
      name: string;
      better: string;
      unit: string;
      describes: string;
    }[];
    note: string;
  }>(`/api/projects/${id}/optimize/objectives`);

export const optimize = (
  id: string,
  body?: {
    objectives?: Record<string, number>;
    budget?: { max_candidates: number; max_seconds: number };
    aggressive?: boolean;
    persist_candidates?: boolean;
  },
) => post<OptimizeResponse>(`/api/projects/${id}/optimize`, body ?? {});

/* ---------------------------------------------------------------- ai */

/**
 * The AI layer, which is a boundary rather than a brain.
 *
 * Two things the types are shaped to make visible in the UI: `applied` is
 * always false on an interpretation, and `method` says whether a model or the
 * deterministic fallback produced the result. Both are worth showing.
 */

export type AiStatus = {
  provider: string;
  available: boolean;
  model: string | null;
  roles: string[];
  cached_responses: number;
  degraded_behaviour: Record<string, string>;
  capabilities_without_model: Record<string, string>;
  guarantees: string[];
};

export type Interpretation = {
  understood: boolean;
  intent: string;
  method: string;
  mutations: MutationIn[];
  unsupported: string[];
  clarification_needed: string;
  confidence: string;
  project_id: string;
  base_version_id: string;
  /** Always false. Interpreting never writes; applying is a separate act. */
  applied: boolean;
  scenario_id: string | null;
  validation: {
    valid: boolean;
    rejections: {
      mutation: string;
      reason: string;
      constraint?: string;
      constraint_reason?: string;
    }[];
  };
};

export type Narration = {
  headline: string;
  explanation: string;
  /** "model" or "engine_template" - shown, not hidden. */
  method: string;
  rejected_reason: string;
  numbers_checked: string[];
  note: string;
};

export const aiStatus = () => call<AiStatus>(`/api/ai/status`);

export const interpret = (id: string, utterance: string, keep = true) =>
  post<Interpretation>(`/api/projects/${id}/interpret`, { utterance, keep });

export const explain = (id: string) =>
  post<Narration>(`/api/projects/${id}/explain`, {});

/* -------------------------------------------------------------- identity */

/**
 * A person, not an account. There is no password, no session and no
 * permission attached to any of this (Phase 9.5).
 */
export type Person = {
  id: string;
  email: string;
  name: string;
  project_count?: number;
};

export const listUsers = () => call<Person[]>(`/api/users`);

export const createUser = (name: string, email?: string) =>
  post<Person>(`/api/users`, { name, email });

export const getUser = (id: string) => call<Person>(`/api/users/${id}`);

export const userProjects = (id: string) =>
  call<{
    user_id: string;
    projects: { id: string; name: string; role: string }[];
    note: string;
  }>(`/api/users/${id}/projects`);

/* ==================================================================
 * Phase 11 — replay, forecast, requirement change, import.
 *
 * Written in one place, by the integrator, before the four wave-3 UI
 * agents started — for the same reason `main.py`'s router registration
 * was: every one of them needs this file, and four concurrent edits to a
 * shared client is how two panels end up calling the same endpoint two
 * different ways.
 *
 * Types here are shaped from real responses, captured against a running
 * backend rather than transcribed from a spec. Where a payload is deep
 * prose rather than data — every `assumptions` block — the type stops at
 * `AssumptionsBlock` and `assumptionSentences()` renders it, so a new
 * caveat added by the backend appears on screen without a frontend change.
 * That is deliberate: the honesty layer must not need a type update to be
 * visible, or the day someone adds a caveat is the day it stops showing.
 * ================================================================== */

/**
 * Every `assumptions` block in this API is a flat bag of prose keyed by a
 * short slug, sometimes with an `unavailable` list beside it. The UI never
 * hardcodes the keys.
 */
export type AssumptionsBlock = Record<string, unknown>;

export interface UnavailableEntry {
  /** What could not be assessed. */
  check?: string;
  name?: string;
  why?: string;
  would_unlock_it?: string;
  [k: string]: unknown;
}

/** The prose sentences in an assumptions block, in payload order. */
export function assumptionSentences(
  block: AssumptionsBlock | null | undefined,
): { key: string; text: string }[] {
  if (!block) return [];
  return Object.entries(block)
    .filter(([, v]) => typeof v === "string" && v.trim().length > 0)
    .map(([key, v]) => ({ key, text: v as string }));
}

/** The "could not assess" list, whatever key the payload used for it. */
export function unavailableEntries(
  block: AssumptionsBlock | null | undefined,
): UnavailableEntry[] {
  const raw = block?.unavailable;
  return Array.isArray(raw) ? (raw as UnavailableEntry[]) : [];
}

/** Turn `material_change_is_a_human_judgement` into a readable label. */
export function humanizeKey(key: string): string {
  const s = key.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ----------------------------------------------------------- replay */

export interface ReplayState {
  project_id: string;
  project_name: string;
  version_id: string;
  version_no: number;
  /** The stored version's content hash. It must not change while replaying. */
  base_content_hash: string;
  running: boolean;
  paused: boolean;
  finished: boolean;
  stopped: boolean;
  sim_day: number;
  sim_date: string;
  start_day: number;
  horizon_day: number;
  horizon_date: string;
  today_day: number;
  /** Simulated days per real minute. 60 means one day per second. */
  speed: number;
  simulated_days_per_minute: number;
  seconds_per_simulated_day: number;
  events_total: number;
  steps_total: number;
  subscribers: number;
  seq: number;
  writes_nothing: boolean;
  note: string;
}

export interface ReplayClock {
  sim_day: number;
  sim_date: string;
  start_day: number;
  horizon_day: number;
  horizon_date: string;
  project_start: string;
  percent_complete: number;
}

export interface ReplayEvent {
  day: number;
  date: string;
  task_key: string;
  task_name: string;
  actor: string;
  from_status: string;
  to_status: string;
}

export interface ClearedFinding {
  id: string;
  kind: string;
  root_cause: string;
  task_ids: string[];
  severity_was: string;
  explanation_was: string;
}

export interface SeverityChangedFinding {
  id: string;
  kind: string;
  root_cause: string;
  task_ids: string[];
  severity_from: string;
  severity_to: string;
  explanation: string;
}

export interface FindingDelta {
  /** Whole findings. Same shape the analysis panel already renders. */
  appeared: Finding[];
  cleared: ClearedFinding[];
  severity_changed: SeverityChangedFinding[];
  unchanged: number;
}

export interface ReplayProjection {
  planned_end_day: number;
  planned_end_date?: string;
  projected_end_day: number;
  projected_end_date: string;
  slip_days: number;
  deadline_day: number | null;
  deadline_date: string | null;
  margin_days: number | null;
  verdict: string;
  statement: string;
  is_probability: false;
}

/**
 * Why a frame's numbers are what they are. Never omit this from the UI: a
 * frame is what the engine *would have said on that simulated day*, computed
 * from the events known by then and deliberately not from the later ones.
 */
export interface ReplayDerived {
  computed_at_simulated_day: number;
  events_known: number;
  events_total: number;
  events_pending: number;
  is_reconstruction: boolean;
  caveats: string[];
}

export interface ReplayFrame {
  seq: number;
  /** `start` | `tick` | `seek` | `restart` */
  reason: string;
  clock: ReplayClock;
  events: ReplayEvent[];
  delta: FindingDelta;
  findings: Finding[];
  finding_counts_by_severity: { high: number; medium: number; low: number };
  projection: ReplayProjection;
  statuses: Record<string, string>;
  critical_path: string[];
  engine_version: string;
  input_hash: string;
  tier_reached: number;
  checks_run: string[];
  unavailable_checks: UnavailableCheck[];
  derived: ReplayDerived;
  /** Present only when this viewer's queue overflowed and frames were lost. */
  dropped_frames?: number;
}

export interface ReplayTimeline {
  project_id: string;
  start_day: number;
  horizon_day: number;
  /** Every simulated day the replay will stop on — the scrubber's ticks. */
  step_days: number[];
  events: ReplayEvent[];
  [k: string]: unknown;
}

export const startReplay = (
  id: string,
  body?: { speed?: number; start_day?: number; version_id?: string },
) => post<ReplayState>(`/api/projects/${id}/replay`, body ?? {});

export const getReplay = (id: string) =>
  call<ReplayState & { frame: ReplayFrame | null }>(
    `/api/projects/${id}/replay`,
  );

export const controlReplay = (
  id: string,
  body: {
    action: "pause" | "resume" | "seek" | "restart" | "speed";
    to_day?: number;
    speed?: number;
  },
) => post<ReplayState>(`/api/projects/${id}/replay/control`, body);

export const stopReplay = (id: string) =>
  del<{ stopped: boolean }>(`/api/projects/${id}/replay`);

export const getReplayTimeline = (id: string) =>
  call<ReplayTimeline>(`/api/projects/${id}/replay/timeline`);

/**
 * Subscribe to a replay's Server-Sent Events.
 *
 * `EventSource` rather than `fetch` + a reader: it is same-origin, so the
 * session cookie rides along on its own, and `src/proxy.ts` rewrites `/api/*`
 * through Next's streaming proxy without buffering. It also reconnects by
 * itself, which is the behaviour you want on a flaky network and the reason
 * not to hand-roll this.
 *
 * The first event on any connection is always `catchup`, carrying current
 * state — so a viewer arriving mid-replay sees the world, never an empty
 * screen. Returns a function that closes the connection; call it from an
 * effect's cleanup or the stream outlives the component.
 */
export function openReplayStream(
  projectId: string,
  handlers: {
    onCatchup?: (state: ReplayState, frame: ReplayFrame | null) => void;
    onFrame?: (frame: ReplayFrame) => void;
    onControl?: (action: string, state: ReplayState) => void;
    onEnd?: () => void;
    /** The replay is over for everyone: restarted, stopped, or expired. */
    onClosed?: (why: "restarted" | "stopped" | "expired") => void;
    onError?: (e: Event) => void;
  },
): () => void {
  const source = new EventSource(`/api/projects/${projectId}/stream`);

  const parse = <T,>(e: MessageEvent): T | null => {
    try {
      return JSON.parse(e.data) as T;
    } catch {
      return null;
    }
  };

  source.addEventListener("catchup", (e) => {
    const d = parse<{ replay: ReplayState; frame: ReplayFrame | null }>(
      e as MessageEvent,
    );
    if (d) handlers.onCatchup?.(d.replay, d.frame);
  });
  source.addEventListener("frame", (e) => {
    const d = parse<ReplayFrame>(e as MessageEvent);
    if (d) handlers.onFrame?.(d);
  });
  source.addEventListener("control", (e) => {
    const d = parse<{ action: string; replay: ReplayState }>(e as MessageEvent);
    if (d) handlers.onControl?.(d.action, d.replay);
  });
  source.addEventListener("end", () => handlers.onEnd?.());
  for (const why of ["restarted", "stopped", "expired"] as const) {
    source.addEventListener(why, () => {
      handlers.onClosed?.(why);
      source.close();
    });
  }
  source.onerror = (e) => handlers.onError?.(e);

  return () => source.close();
}

/* --------------------------------------------------------- forecast */

export interface ForecastCompletion {
  p50_day: number;
  p50_date: string;
  p80_day: number;
  p80_date: string;
  p90_day: number;
  p90_date: string;
  mean_day: number;
  mean_date: string;
  earliest_day: number;
  earliest_date: string;
  latest_day: number;
  latest_date: string;
}

export interface ForecastDeadline {
  deadline_day: number | null;
  deadline_date: string | null;
  /** A real probability, under a stated and uncalibrated model. */
  probability_of_meeting_deadline: number;
  iterations_meeting_deadline: number;
  band: string;
  /** "Band labels are cut points on a continuum" — always render with it. */
  band_note: string;
}

export interface HistogramBin {
  from_day: number;
  to_day: number;
  from_date: string;
  to_date: string;
  count: number;
  share: number;
  cumulative_share: number;
}

export interface ForecastHistogram {
  bins: HistogramBin[];
  bin_count: number;
  bin_width_days: number;
  method: string;
}

export interface TaskForecast {
  task_key: string;
  task_name: string;
  /** Fraction of iterations in which this task lay on the critical path. */
  criticality_index: number;
  iterations_on_critical_path: number;
  mean_duration_days: number;
  /** True when the spread came from the domain prior, not an estimate. */
  assumed: boolean;
  criticality_means: string;
  duration: {
    optimistic_days: number;
    likely_days: number;
    pessimistic_days: number;
    relative_spread: number;
    /** `three_point_estimate` | `spread_prior` | `measured_actual` */
    spread_provenance: string;
    assumed: boolean;
  };
}

export interface ForecastBlock {
  kind: string;
  available: boolean;
  is_probability: boolean;
  is_calibrated: boolean;
  disclaimer: string;
  what_would_calibrate_it: string;
  not_the_structural_estimate: string;
  iterations: number;
  seed: number;
  distribution: string;
  completion: ForecastCompletion;
  deadline: ForecastDeadline;
  histogram: ForecastHistogram;
  tasks: TaskForecast[];
  assumptions: AssumptionsBlock;
  unavailable_reason?: string;
  fall_back_to?: string;
}

export interface ForecastResponse {
  project_id: string;
  project_name: string;
  version_id: string;
  version_no: number;
  project_start: string;
  today_day: number;
  deadline_date: string | null;
  engine_version: string;
  input_hash: string;
  tier_reached: number;
  schedulable: boolean;
  /**
   * `monte_carlo_probability` or `structural_estimate`. The UI must say which
   * of the two it is showing — they are different numbers on different scales
   * and reading a band from one against a number from the other is a category
   * error the payload names explicitly.
   */
  answer_kind: "monte_carlo_probability" | "structural_estimate";
  answer_kind_note: string;
  forecast: ForecastBlock;
  structural_risk: {
    score_kind: string;
    is_probability: false;
    disclaimer: string;
    band_counts: Record<string, number>;
    top: { task_key: string; task_name: string; score: number; band: string }[];
    assumptions: AssumptionsBlock;
  };
  deterministic: {
    projected_end_day: number;
    projected_end_date: string;
    planned_end_day: number;
    slip_days: number;
    feasibility: Feasibility;
    note: string;
  };
}

export const getForecast = (
  id: string,
  body?: { iterations?: number; seed?: number; version_id?: string },
) => post<ForecastResponse>(`/api/projects/${id}/forecast`, body ?? {});

export const getForecastAssumptions = (id: string) =>
  call<AssumptionsBlock>(`/api/projects/${id}/forecast/assumptions`);

/* ----------------------------------------------------- requirements */

export interface RequirementSummary {
  key: string;
  version_no: number;
  text: string;
  consumed_by: string[];
  consumed_by_count: number;
  must_redo_count: number;
  must_recheck_count: number;
  completed_tasks_at_risk: string[];
  completed_days_at_risk: number;
  blast_radius_effort_days: number;
  owners_affected: string[];
  history: { revisions?: number; [k: string]: unknown };
  history_note: string;
}

export interface RequirementsList {
  project_id: string;
  project_name: string;
  version_id: string;
  version_no: number;
  content_hash: string;
  requirements: RequirementSummary[];
  count: number;
  note: string;
}

export interface AffectedTaskReason {
  /** `seed` | `consuming` | `downstream` */
  via: string;
  path: string[];
  hops: number;
  consumed_from?: string;
  follows?: string;
  final_edge_consumes?: boolean;
  /** A sentence saying why this task is in this list. Render it. */
  sentence: string;
}

export interface AffectedTask {
  key: string;
  name: string;
  status: string;
  effort_days: number;
  owners: { key: string; label: string }[];
  reason: AffectedTaskReason;
  /** must_redo only. */
  completed_and_lost?: boolean;
  wasted_days?: number;
  redo_days?: number;
}

export interface WastedEffortRow {
  key: string;
  name: string;
  counts_as_wasted: boolean;
  effort_days: number;
  wasted_days: number;
  redo_days: number;
  /** The arithmetic, worked out. Put it on the row. */
  arithmetic: string;
}

export interface WastedEffort {
  rows: WastedEffortRow[];
  completed_task_count: number;
  /** Days of finished work invalidated. This is the headline number. */
  wasted_days: number;
  redo_cost_days: number;
  additional_effort_days: number;
  in_flight_days: number;
  not_yet_started_days: number;
  blast_radius_effort_days: number;
  arithmetic: string;
}

/**
 * Note `rework_shows_as_calendar_slip` and `caveat`.
 *
 * `delta_days` is usually 0 and that is NOT the change being free: the
 * scheduler is status-blind, so completed work already occupies its full
 * duration and re-opening it cannot lengthen the critical path (D-157).
 * Lead the screen with `wasted_effort.wasted_days`, and never show
 * `delta_days` without `caveat` when `rework_shows_as_calendar_slip` is false.
 */
export interface ScheduleImpact {
  projected_end_day_before: number;
  projected_end_day_after: number;
  delta_days: number;
  direction: string;
  projected_end_date_before: string;
  projected_end_date_after: string;
  deadline_day: number | null;
  deadline_date: string | null;
  deadline_survives: boolean;
  margin_days_before: number | null;
  margin_days_after: number | null;
  verdict_before: string;
  verdict_after: string;
  verdict_changed: boolean;
  critical_path_changed: boolean;
  newly_critical: string[];
  tasks_moved_count: number;
  statement: string;
  is_probability: false;
  rework_shows_as_calendar_slip: boolean;
  caveat: string;
}

export interface OwnerImpact {
  resource_key: string;
  resource_name: string;
  label: string;
  kind: string;
  must_redo: string[];
  must_recheck: string[];
  completed_work_lost_days: number;
  redo_days: number;
  blast_radius_effort_days: number;
  /** A sentence naming what this person specifically loses. */
  what_they_lose: string;
}

export interface ReplanBlock {
  scenario_id: string;
  kept: boolean;
  status: string;
  applied: false;
  mutations: MutationIn[];
  inverse_mutations: MutationIn[];
  validation: Record<string, unknown>;
  /** Which of the seventeen kinds this replan is expressed in. */
  expressed_in: string;
  inspect: string;
  diff: string;
  apply: string;
  discard: string;
  kept_note: string;
}

export interface TextDiffSegment {
  kind?: string;
  text?: string;
  [k: string]: unknown;
}

export interface ImpactReport {
  project_id: string;
  project_name: string;
  version_id: string;
  version_no: number;
  engine_version: string;
  input_hash: string;
  requirement_key: string;
  current_text: string;
  proposed_text: string;
  from_version: number;
  to_version: number;
  text_changed: boolean;
  text_diff: {
    identical: boolean;
    before: string;
    after: string;
    removed_words: string[];
    added_words: string[];
    segments: TextDiffSegment[];
    similarity: number;
    /** Says no cost is derived from the text. Render it beside the diff. */
    note: string;
  };
  directly_consumed_by: string[];
  seeds_used: string[];
  scoped: boolean;
  scoped_out: string[];
  statuses_restored_by_scoping: string[];
  blast_radius: {
    must_redo_count: number;
    must_recheck_count: number;
    tasks_in_project: number;
    share_of_project: number;
    owners_affected: number;
  };
  must_redo: AffectedTask[];
  must_recheck: AffectedTask[];
  wasted_effort: WastedEffort;
  schedule_impact: ScheduleImpact;
  who_needs_to_know: {
    by_resource: OwnerImpact[];
    resource_count: number;
    unassigned: { must_redo: string[]; must_recheck: string[]; note: string };
  };
  findings: {
    created: Finding[];
    cleared: { kind: string; root_cause: string; task_ids: string[] }[];
    created_count: number;
    cleared_count: number;
    unchanged_count: number;
    before_count: number;
    after_count: number;
  };
  replan: ReplanBlock;
  analysis_run_id: string;
  summary: string;
  base_version_hash_before: string;
  base_version_hash_after: string;
  /** Proof on screen that asking cost nothing. */
  base_unchanged: boolean;
  applied: false;
  statement: string;
  /** True when the requirement is consumed by nothing. Not an error. */
  no_impact: boolean;
  assumptions: AssumptionsBlock;
}

/** One proposed wording. `invalidates` is what makes a comparison real. */
export interface WordingOption {
  text: string;
  label?: string;
  invalidates?: string[];
}

export interface RequirementComparison {
  requirement_key: string;
  options: {
    index: number;
    label: string;
    text: string;
    report: ImpactReport;
    [k: string]: unknown;
  }[];
  /**
   * `null` when the options are graph-identical — two plain wordings always
   * cost the same, because the blast radius comes from the dependency graph
   * and the graph does not change when the sentence does (D-158). Show the
   * tie and its explanation rather than picking one.
   */
  cheapest_option_index: number | null;
  statement: string;
  assumptions: AssumptionsBlock;
  [k: string]: unknown;
}

export interface RequirementRevision {
  version_no: number;
  text: string;
  changed_by: string;
  changed_at: string | null;
  note: string;
  backfilled: boolean;
  consumed_by_task_keys: string[];
  impact_summary: Record<string, unknown> | null;
  [k: string]: unknown;
}

export interface RequirementHistoryResponse {
  requirement_key: string;
  current_version_no: number;
  revisions: RequirementRevision[];
  count: number;
  note: string;
  [k: string]: unknown;
}

export interface RequirementDiffResponse {
  requirement_key: string;
  from_version: number;
  to_version: number;
  text_diff: ImpactReport["text_diff"];
  consumed_by_then: string[];
  consumed_by_now: string[];
  consumption_drifted: boolean;
  note: string;
  [k: string]: unknown;
}

export const listRequirements = (id: string) =>
  call<RequirementsList>(`/api/projects/${id}/requirements`);

export const changeRequirement = (
  id: string,
  key: string,
  body: { new_text: string; version_id?: string; invalidates?: string[] },
) =>
  post<ImpactReport>(
    `/api/projects/${id}/requirements/${encodeURIComponent(key)}/change`,
    body,
  );

export const compareRequirement = (
  id: string,
  key: string,
  body: { options: (string | WordingOption)[]; version_id?: string },
) =>
  post<RequirementComparison>(
    `/api/projects/${id}/requirements/${encodeURIComponent(key)}/compare`,
    body,
  );

export const applyRequirementChange = (
  id: string,
  key: string,
  body: { new_text: string; version_id?: string; invalidates?: string[] },
) =>
  post<{ version_id: string; version_no: number; [k: string]: unknown }>(
    `/api/projects/${id}/requirements/${encodeURIComponent(key)}/apply`,
    body,
  );

export const requirementHistory = (id: string, key: string) =>
  call<RequirementHistoryResponse>(
    `/api/projects/${id}/requirements/${encodeURIComponent(key)}/history`,
  );

export const requirementDiff = (
  id: string,
  key: string,
  fromVersion?: number,
  toVersion?: number,
) => {
  const q = new URLSearchParams();
  if (fromVersion != null) q.set("from_version", String(fromVersion));
  if (toVersion != null) q.set("to_version", String(toVersion));
  const suffix = q.toString() ? `?${q}` : "";
  return call<RequirementDiffResponse>(
    `/api/projects/${id}/requirements/${encodeURIComponent(key)}/diff${suffix}`,
  );
};

/* ----------------------------------------------------------- import */

export interface ImportSample {
  name: string;
  title: string;
  description: string;
  source: string;
  filename: string;
  bytes: number;
  lines: number;
  sha256: string;
  /** What this fixture is built to exercise. */
  demonstrates: string[];
  href: string;
  csv_href: string;
}

/** How one column of one row was read. Every inference is visible here. */
export interface RowInterpretation {
  value: unknown;
  raw: string;
  source: string;
  how: string;
  /** True when the value was defaulted or derived, not read. */
  assumed: boolean;
}

export interface PreviewRow {
  row: number;
  line: number;
  task_key: string;
  name: string;
  notes: string[];
  interpretation: Record<string, RowInterpretation>;
}

export interface RejectedRow {
  row: number;
  line: number;
  raw: [string, string][];
  reason: string;
}

export interface DroppedDependency {
  row: number;
  line: number;
  column: string;
  raw: string;
  task_key: string;
  reason: string;
}

export interface ImportCycle {
  path: string[];
  length: number;
  message: string;
  from_rows: number[];
  evidence: { row: number; column: string; raw: string; because: string }[];
}

export interface ImportCounts {
  tasks: number;
  dependencies: number;
  resources: number;
  assignments: number;
  rows_read: number;
  rows_rejected: number;
  dependencies_dropped: number;
}

export interface ImportPreview {
  source: string;
  csv_sha256: string;
  can_commit: boolean;
  blocking: string[];
  counts: ImportCounts;
  would_create: {
    project: { start_date: string; deadline: string | null; deadline_day: number | null };
    tasks: { key: string; name: string; description: string; effort: number; status: string }[];
    dependencies: { from_task: string; to_task: string; dep_type: string; consumes: boolean; because: string }[];
    resources: { key: string; name: string; kind: string; capacity: number; task_count: number }[];
    assignments: { task_key: string; resource_key: string; allocation: number }[];
  };
  rows: PreviewRow[];
  rejected_rows: RejectedRow[];
  dropped_dependencies: DroppedDependency[];
  unmapped_columns: { column: string; reason: string }[];
  cycles: ImportCycle[];
  assumptions: AssumptionsBlock;
  row_numbering: string;
}

export interface ImportCommitResult {
  project: {
    project_id: string;
    version_id: string;
    version_no: number;
    content_hash: string;
    is_draft: boolean;
    name: string;
    start_date: string;
    deadline: string | null;
    today_day: number;
    created_by: string | null;
    owner_email: string | null;
  };
  source: string;
  csv_sha256: string;
  counts: ImportCounts;
  rejected_rows: RejectedRow[];
  dropped_dependencies: DroppedDependency[];
  unmapped_columns: { column: string; reason: string }[];
  assumptions: AssumptionsBlock;
  next: string;
}

/** Shared by preview and commit. `commit` re-sends it, so preview is stateless. */
export interface ImportBody {
  source: "jira" | "csv";
  csv_text?: string;
  sample?: string;
  mapping?: Record<string, unknown>;
  delimiter?: string;
  story_point_days?: number;
  hours_per_day?: number;
  estimate_unit?: "seconds" | "hours" | "days";
  default_effort_days?: number;
  start_date?: string | null;
  deadline?: string | null;
}

export const listImportSamples = () =>
  call<{ samples: ImportSample[]; note: string }>("/api/import/samples");

export const getImportSample = (name: string) =>
  call<ImportSample & { suggested: ImportBody }>(
    `/api/import/samples/${encodeURIComponent(name)}`,
  );

export const importPreview = (body: ImportBody) =>
  post<ImportPreview>("/api/import/preview", body);

export const importCommit = (
  body: ImportBody & { name: string; description?: string; goal?: string; domain_id?: string },
) => post<ImportCommitResult>("/api/import/commit", body);
