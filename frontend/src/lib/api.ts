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
