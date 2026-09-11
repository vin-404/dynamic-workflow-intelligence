/**
 * The display map: every enum and identifier the API sends, rendered in the
 * product's own words. Nothing else in `frontend/src` may put a raw
 * `snake_case` or `SCREAMING_CASE` value in front of a reader (design brief
 * §5). Every function falls back to `humanize()` for a value it has not seen,
 * so a new engine value shows up as readable words rather than a crash, and
 * the missing entry is a one-line fix here.
 *
 * These are labels only. No number, band, score or ranking is computed or
 * altered here; a band's *word* changes, its value does not.
 */

/** "some_snake_VALUE" → "Some snake value". The last resort, never the plan. */
export function humanize(raw: string | null | undefined): string {
  if (!raw) return "";
  const words = raw.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function lookup(map: Record<string, string>, raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  return map[raw] ?? map[raw.toLowerCase()] ?? humanize(raw);
}

/* ------------------------------------------------------------- statuses */

const STATUS: Record<string, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  blocked: "Blocked",
};

export function statusLabel(raw: string | null | undefined): string {
  return lookup(STATUS, raw);
}

/* ----------------------------------------------------------- constraints */

const CONSTRAINT_KIND: Record<string, string> = {
  MANDATORY_TASK: "Mandatory",
  IMMUTABLE_DEPENDENCY: "Cannot be removed",
  NON_DIVISIBLE_TASK: "Cannot be split",
  FIXED_ASSIGNMENT: "Fixed assignment",
  MIN_DURATION: "Minimum duration",
};

export function constraintKindLabel(raw: string | null | undefined): string {
  return lookup(CONSTRAINT_KIND, raw);
}

/* ---------------------------------------------------------------- tiers */

const TIER_BY_NUMBER = [
  "From the structure",
  "From current status",
  "From history",
  "From other projects",
];

const TIER_BY_NAME: Record<string, string> = {
  structural: TIER_BY_NUMBER[0],
  stateful: TIER_BY_NUMBER[1],
  historical: TIER_BY_NUMBER[2],
  "cross-project": TIER_BY_NUMBER[3],
  cross_project: TIER_BY_NUMBER[3],
};

/** Accepts the tier number or the engine's tier name. */
export function tierLabel(tier: number | string | null | undefined): string {
  if (tier === null || tier === undefined) return "";
  if (typeof tier === "number") return TIER_BY_NUMBER[tier] ?? `Tier ${tier}`;
  const asNumber = Number(tier);
  if (!Number.isNaN(asNumber) && tier.trim() !== "") return tierLabel(asNumber);
  return lookup(TIER_BY_NAME, tier);
}

/* ------------------------------------------------------- kinds of number */

const SCORE_KIND: Record<string, string> = {
  structural_estimate: "Structural exposure",
  monte_carlo_probability: "Simulated probability",
};

export function scoreKindLabel(raw: string | null | undefined): string {
  return lookup(SCORE_KIND, raw);
}

/* ---------------------------------------------------------------- edges */

export function edgeKindLabel(consumes: boolean | null | undefined): string {
  return consumes ? "Uses the output" : "Ordering only";
}

const DEP_TYPE: Record<string, string> = {
  artifact: "Uses the output",
  ordering: "Ordering only",
  finish_to_start: "Finish to start",
  start_to_start: "Start to start",
};

export function depTypeLabel(raw: string | null | undefined): string {
  return lookup(DEP_TYPE, raw);
}

/* ---------------------------------------------------------------- roles */

const ROLE: Record<string, string> = {
  read_only_guest: "Read-only guest",
  viewer: "Viewer",
  editor: "Editor",
  owner: "Owner",
  admin: "Administrator",
};

export function roleLabel(raw: string | null | undefined): string {
  return lookup(ROLE, raw);
}

/* ----------------------------------------------------------- AI provider */

const PROVIDER: Record<string, string> = {
  null: "None configured",
  none: "None configured",
  "": "None configured",
  anthropic: "Anthropic",
  openai: "OpenAI",
  fallback: "Built-in fallback",
};

/** The AI provider the API reports; it sends the string "null" for none. */
export function providerLabel(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return PROVIDER.null;
  return lookup(PROVIDER, raw);
}

/* -------------------------------------------------------------- findings */

const FINDING_KIND: Record<string, string> = {
  dependency_cycle: "Circular dependency",
  deadline_infeasible: "Deadline cannot be met",
  single_point_of_failure: "Single point of failure",
  serial_chain_no_parallelism: "Serial chain, nothing in parallel",
  zero_slack_chain: "Zero-slack chain",
  critical_path_single_owner: "Critical path rests on one owner",
  resource_overallocated: "Resource over capacity",
  unassigned_critical_task: "Critical task has no owner",
  redundant_dependency: "Redundant dependency",
  isolated_task: "Isolated task",
  critical_path_blocker: "Critical path blocker",
  resource_contention: "Resource contention",
  projected_vs_planned_finish: "Projected finish differs from the plan",
  stalled_in_review: "Stalled in review",
  ready_but_idle: "Ready but idle",
  chronic_underestimation: "Chronic underestimation",
  per_resource_velocity: "Per-resource velocity",
  calibrated_duration_variance: "Calibrated duration variance",
};

export function findingKindLabel(raw: string | null | undefined): string {
  return lookup(FINDING_KIND, raw);
}

const SEVERITY: Record<string, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export function severityLabel(raw: string | null | undefined): string {
  return lookup(SEVERITY, raw);
}

/* ------------------------------------------------------- verdicts, bands */

const VERDICT: Record<string, string> = {
  feasible: "Feasible",
  infeasible: "Infeasible",
  at_risk: "At risk",
  on_track: "On track",
  unlikely: "Unlikely",
  unschedulable: "Cannot be scheduled",
  schedulable: "Can be scheduled",
  unchanged: "Unchanged",
  improved: "Improved",
  worsened: "Worsened",
};

export function verdictLabel(raw: string | null | undefined): string {
  return lookup(VERDICT, raw);
}

const BAND: Record<string, string> = {
  low: "Low",
  moderate: "Moderate",
  high: "High",
  on_track: "On track",
  at_risk: "At risk",
  unlikely: "Unlikely",
  optimistic: "Optimistic",
  likely: "Likely",
  pessimistic: "Pessimistic",
};

export function bandLabel(raw: string | null | undefined): string {
  return lookup(BAND, raw);
}

/* ------------------------------------------------------- forecast inputs */

const PROVENANCE: Record<string, string> = {
  default: "Assumed default spread",
  domain_prior: "Domain prior",
  three_point_estimate: "Task's own three-point estimate",
};

export function provenanceLabel(raw: string | null | undefined): string {
  return lookup(PROVENANCE, raw);
}

const DISTRIBUTION: Record<string, string> = {
  beta_pert: "Beta-PERT",
  triangular: "Triangular",
  pert: "PERT",
};

export function distributionLabel(raw: string | null | undefined): string {
  return lookup(DISTRIBUTION, raw);
}

/* ----------------------------------------------------------- risk factors */

const FACTOR: Record<string, string> = {
  slack_ratio: "Slack ratio",
  downstream_fan_out: "Downstream fan-out",
  criticality_proximity: "Criticality proximity",
  deadline_pressure: "Deadline pressure",
  resource_pressure: "Resource pressure",
  duration_uncertainty: "Duration uncertainty",
  predecessor_health: "Predecessor health",
  remaining_chain_depth: "Remaining chain depth",
  assignment_gap: "Assignment gap",
};

export function factorLabel(raw: string | null | undefined): string {
  return lookup(FACTOR, raw);
}

/** The order the nine factors are drawn in, so every bar reads the same. */
export const FACTOR_ORDER = Object.keys(FACTOR);

/* ------------------------------------------------------------- optimizer */

const OBJECTIVE: Record<string, string> = {
  expected_completion: "Expected completion",
  feasibility_margin: "Feasibility margin",
  peak_resource_overload: "Peak resource overload",
  structural_risk: "Structural exposure",
  dependency_complexity: "Dependency complexity",
  parallelization: "Parallelisation",
};

export function objectiveLabel(raw: string | null | undefined): string {
  return lookup(OBJECTIVE, raw);
}

const GENERATOR: Record<string, string> = {
  adversarial: "Adversarial search",
  drop_bottleneck_tasks: "Drop bottleneck tasks",
  drop_soft_ordering: "Drop soft ordering",
  llm_proposer: "Model proposal",
  parallelize_zero_slack: "Parallelise the zero-slack chain",
  resequence_contended: "Resequence contended work",
  resource_levelling: "Resource levelling",
  transitive_reduction: "Remove implied dependencies",
};

export function generatorLabel(raw: string | null | undefined): string {
  return lookup(GENERATOR, raw);
}

/* ------------------------------------------------------------- scenarios */

const SCENARIO_STATUS: Record<string, string> = {
  validated: "Validated",
  applied: "Applied",
  rejected: "Refused",
  pending: "Pending",
  draft: "Draft",
};

export function scenarioStatusLabel(raw: string | null | undefined): string {
  return lookup(SCENARIO_STATUS, raw);
}

const ORIGIN: Record<string, string> = {
  user_whatif: "Authored what-if",
  heuristic_proposal: "Optimizer candidate",
  llm_proposal: "Model proposal",
  requirement_change: "Requirement change",
};

export function originLabel(raw: string | null | undefined): string {
  return lookup(ORIGIN, raw);
}

/* ------------------------------------------------------------- resources */

const RESOURCE_KIND: Record<string, string> = {
  person: "Person",
  team: "Team",
  equipment: "Equipment",
  room: "Room",
};

export function resourceKindLabel(raw: string | null | undefined): string {
  return lookup(RESOURCE_KIND, raw);
}

/* ------------------------------------------------------------- mutations */

export type MutationLike = {
  kind: string;
  payload?: Record<string, unknown> | null;
  describes?: string | null;
};

/** Optional key → name lookups so "T11" can read "Posters & social creatives". */
export type NameLookup = {
  tasks?: Record<string, string>;
  resources?: Record<string, string>;
};

const MUTATION_KIND: Record<string, string> = {
  TASK_ADD: "Add a task",
  TASK_REMOVE: "Remove a task",
  TASK_EFFORT_SET: "Change a task's effort",
  TASK_DELAY_ADD: "Delay a task",
  TASK_SPLIT: "Split a task",
  TASK_MERGE: "Merge tasks",
  TASK_STATUS_SET: "Change a task's status",
  TASK_PRIORITY_SET: "Change a task's priority",
  DEPENDENCY_ADD: "Add a dependency",
  DEPENDENCY_REMOVE: "Remove a dependency",
  DEPENDENCY_TYPE_CHANGE: "Change a dependency's type",
  ASSIGNMENT_ADD: "Assign a task",
  ASSIGNMENT_REMOVE: "Unassign a task",
  RESOURCE_CAPACITY_SET: "Change a resource's capacity",
  RESOURCE_UNAVAILABLE_WINDOW: "Mark a resource unavailable",
  DEADLINE_SET: "Set the deadline",
  REQUIREMENT_VERSION_BUMP: "Re-word a requirement",
};

/** The kind alone, as a short noun phrase, for vocabularies and pickers. */
export function mutationKindLabel(raw: string | null | undefined): string {
  return lookup(MUTATION_KIND, raw);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function dayWord(n: number): string {
  return `${n} ${n === 1 ? "day" : "days"}`;
}

function taskRef(key: string | null, names?: NameLookup): string {
  if (!key) return "a task";
  const name = names?.tasks?.[key];
  return name ? `${key} ${name}` : key;
}

function resourceRef(key: string | null, names?: NameLookup): string {
  if (!key) return "a resource";
  return names?.resources?.[key] ?? key;
}

/**
 * One mutation as a verb phrase: "Slip T03 by 5 days", "Reassign T11 to
 * Arjun". Built from the kind and payload the engine recorded; when a
 * payload lacks the field the phrase needs, the engine's own `describes`
 * sentence is used, and failing that the kind's noun phrase. No value is
 * invented: a missing number is left out of the sentence, never guessed.
 */
export function describeMutation(m: MutationLike, names?: NameLookup): string {
  const p = m.payload ?? {};
  const fallback = () => str(m.describes) ?? mutationKindLabel(m.kind);

  switch (m.kind) {
    case "TASK_ADD": {
      const key = str(p.key);
      const name = str(p.name);
      const effort = num(p.effort);
      return `Add ${key ?? "a task"}${name ? ` ${name}` : ""}${effort !== null ? ` (${dayWord(effort)})` : ""}`;
    }
    case "TASK_REMOVE":
      return `Remove ${taskRef(str(p.key), names)}`;
    case "TASK_EFFORT_SET": {
      const effort = num(p.effort);
      return effort === null
        ? fallback()
        : `Set ${taskRef(str(p.key), names)} to ${dayWord(effort)} of effort`;
    }
    case "TASK_DELAY_ADD": {
      const extra = num(p.extra_days);
      const total = num(p.total_delay_days);
      if (extra !== null) return `Slip ${taskRef(str(p.key), names)} by ${dayWord(extra)}`;
      if (total !== null) return `Delay ${taskRef(str(p.key), names)} to ${dayWord(total)} in total`;
      return `Delay ${taskRef(str(p.key), names)}`;
    }
    case "TASK_SPLIT": {
      const parts = num(p.parts);
      return `Split ${taskRef(str(p.key), names)}${parts !== null ? ` into ${parts} parts` : ""}`;
    }
    case "TASK_MERGE": {
      const keys = Array.isArray(p.keys) ? (p.keys as unknown[]).map(String) : [];
      const into = str(p.into_key);
      return `Merge ${keys.length ? keys.join(", ") : "tasks"}${into ? ` into ${into}` : ""}`;
    }
    case "TASK_STATUS_SET": {
      const status = str(p.status);
      return status
        ? `Mark ${taskRef(str(p.key), names)} as ${statusLabel(status).toLowerCase()}`
        : fallback();
    }
    case "TASK_PRIORITY_SET": {
      const priority = p.priority;
      return priority === undefined || priority === null
        ? fallback()
        : `Set ${taskRef(str(p.key), names)} to priority ${String(priority)}`;
    }
    case "DEPENDENCY_ADD":
      return `Make ${taskRef(str(p.to_task), names)} wait for ${taskRef(str(p.from_task), names)}`;
    case "DEPENDENCY_REMOVE":
      return `Stop ${taskRef(str(p.to_task), names)} waiting for ${taskRef(str(p.from_task), names)}`;
    case "DEPENDENCY_TYPE_CHANGE": {
      const consumes = typeof p.consumes === "boolean" ? (p.consumes as boolean) : null;
      const type = str(p.dep_type);
      const what = consumes !== null ? edgeKindLabel(consumes).toLowerCase() : type ? depTypeLabel(type).toLowerCase() : null;
      return `Change ${taskRef(str(p.from_task), names)} → ${taskRef(str(p.to_task), names)}${what ? ` to "${what}"` : ""}`;
    }
    case "ASSIGNMENT_ADD":
      return `Assign ${taskRef(str(p.task_key), names)} to ${resourceRef(str(p.resource_key), names)}`;
    case "ASSIGNMENT_REMOVE":
      return `Take ${taskRef(str(p.task_key), names)} off ${resourceRef(str(p.resource_key), names)}`;
    case "RESOURCE_CAPACITY_SET": {
      const capacity = num(p.capacity);
      return capacity === null
        ? fallback()
        : `Set ${resourceRef(str(p.resource_key), names)} to capacity ${capacity}`;
    }
    case "RESOURCE_UNAVAILABLE_WINDOW": {
      const from = num(p.from_day);
      const to = num(p.to_day);
      const who = resourceRef(str(p.resource_key), names);
      if (from !== null && to !== null) return `${who} unavailable day ${from} to day ${to}`;
      if (from !== null) return `${who} unavailable from day ${from}`;
      return `${who} unavailable`;
    }
    case "DEADLINE_SET": {
      const day = num(p.deadline_day);
      return day === null ? fallback() : `Set the deadline to day ${day}`;
    }
    case "REQUIREMENT_VERSION_BUMP": {
      const key = str(p.requirement_key);
      const version = num(p.version_no);
      return `Re-word ${key ?? "a requirement"}${version !== null ? ` to v${version}` : ""}`;
    }
    default:
      return fallback();
  }
}

/* ----------------------------------------------------------------- prose */

const PROSE_TOKENS: [RegExp, string][] = [
  [/\bnot_started\b/g, "not started"],
  [/\bin_progress\b/g, "in progress"],
  [/\bin_review\b/g, "in review"],
];

/**
 * Engine prose - an explanation, a suggested action, a factor's reason - with
 * the three status identifiers it sometimes embeds ("It is in_review") read
 * as words. Nothing else in the sentence is touched: no number, no name, no
 * softening. Presentation only.
 */
export function prose(text: string | null | undefined): string {
  if (!text) return "";
  const out = PROSE_TOKENS.reduce((acc, [re, word]) => acc.replace(re, word), text);
  return out;
}

/* ------------------------------------------------------------------ time */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Parse an API timestamp. SQLite returns the value with no offset even
 * though the column is timezone-aware, and the default is UTC, so a
 * suffix-less string is read as UTC (the D-127 rule, kept).
 */
export function parseInstant(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso);
  const t = Date.parse(zoned ? iso : `${iso}Z`);
  return Number.isNaN(t) ? null : new Date(t);
}

/** "8 Sep 2026, 05:12 UTC" — the precise instant, in words, for hover text. */
export function absoluteUTC(iso: string | null | undefined, seconds = false): string | null {
  const d = parseInstant(iso);
  if (!d) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${seconds ? `:${pad(d.getUTCSeconds())}` : ""}`;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${time} UTC`;
}

/** "3 days ago", "in 2 hours", "just now". */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string | null {
  const d = parseInstant(iso);
  if (!d) return null;
  const diff = now - d.getTime();
  const past = diff >= 0;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  let text: string;
  if (abs < minute) return "just now";
  else if (abs < hour) {
    const n = Math.round(abs / minute);
    text = `${n} ${n === 1 ? "minute" : "minutes"}`;
  } else if (abs < day) {
    const n = Math.round(abs / hour);
    text = `${n} ${n === 1 ? "hour" : "hours"}`;
  } else if (abs < 30 * day) {
    const n = Math.round(abs / day);
    text = `${n} ${n === 1 ? "day" : "days"}`;
  } else if (abs < 365 * day) {
    const n = Math.round(abs / (30 * day));
    text = `${n} ${n === 1 ? "month" : "months"}`;
  } else {
    const n = Math.round(abs / (365 * day));
    text = `${n} ${n === 1 ? "year" : "years"}`;
  }
  return past ? `${text} ago` : `in ${text}`;
}

/** "8 Sep 2026" — a calendar date from an ISO date or timestamp. */
export function calendarDate(iso: string | null | undefined): string | null {
  const d = parseInstant(iso) ?? (iso ? parseInstant(`${iso}T00:00:00`) : null);
  if (!d) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
