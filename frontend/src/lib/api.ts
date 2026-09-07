const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8001";
const DEMO_PROJECT_ID = "00000000-0000-0000-0000-000000000001";

export { DEMO_PROJECT_ID };

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function getProjectState(projectId: string = DEMO_PROJECT_ID) {
  return apiFetch<ProjectState>(`/api/projects/${projectId}/state`);
}

export async function simulateDelay(
  projectId: string,
  taskCode: string,
  extraDays: number
) {
  return apiFetch<DelayResult>(
    `/api/projects/${projectId}/simulate/delay`,
    {
      method: "POST",
      body: JSON.stringify({ task_code: taskCode, extra_days: extraDays }),
    }
  );
}

export async function simulateRequirement(
  projectId: string,
  reqCode: string
) {
  return apiFetch<RequirementResult>(
    `/api/projects/${projectId}/simulate/requirement`,
    {
      method: "POST",
      body: JSON.stringify({ req_code: reqCode }),
    }
  );
}

export async function getAccuracy(projectId: string = DEMO_PROJECT_ID) {
  return apiFetch<AccuracyResult>(`/api/projects/${projectId}/accuracy`);
}

// Types
export interface TaskRow {
  task_code: string;
  name: string;
  department: string;
  owner: string;
  planned_duration: number;
  status: string;
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

export interface Edge {
  source: string;
  target: string;
  kind: string;
}

export interface Bottleneck {
  kind: string;
  tasks: string[];
  root_cause: string | null;
  evidence: Record<string, unknown>;
  attributed_delay_days: number;
  downstream_affected: string[];
  suggested_action: string;
  severity: string;
  impact_score: number;
}

export interface RequirementInfo {
  req_code: string;
  version: number;
  text: string;
  consumed_by: string[];
}

export interface ProjectState {
  project_id: string;
  project_name: string;
  project_start: string;
  today_day: number;
  planned_end: number;
  projected_end: number;
  planned_end_date: string;
  projected_end_date: string;
  slip_days: number;
  critical_path: string[];
  tasks: TaskRow[];
  edges: Edge[];
  departments: Record<string, number>;
  bottlenecks: Bottleneck[];
  requirements: RequirementInfo[];
}

export interface MovedTask {
  task_code: string;
  name: string;
  department: string;
  owner: string;
  delta: number;
  from_date: string;
  to_date: string;
}

export interface DelayResult {
  project_end_before: number;
  project_end_after: number;
  project_end_delta: number;
  end_date_before: string;
  end_date_after: string;
  tasks_moved: Record<string, { from: number; to: number; delta: number }>;
  critical_path_changed: boolean;
  newly_critical: string[];
  no_longer_critical: string[];
  slack_consumed: Record<string, number>;
  moved_detail: MovedTask[];
  notify: string[];
}

export interface AffectedTask {
  task_code: string;
  name: string;
  department: string;
  owner: string;
  status: string;
}

export interface RequirementResult {
  req_code: string;
  text: string;
  from_version: number;
  to_version: number;
  directly_consumed_by: string[];
  must_redo: AffectedTask[];
  must_recheck: AffectedTask[];
  departments_hit: string[];
  wasted_days: number;
}

export interface AccuracyResult {
  planted: number;
  detected: number;
  true_positives: string[];
  missed: string[];
  extra: string[];
  recall: number;
  precision_vs_planted: number;
  ground_truth: Record<string, string>;
}
