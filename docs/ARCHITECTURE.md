# FlowTrace — Architecture Reset

Status: architecture proposal, pre-implementation.
Scope note: this analysis is grounded on the deterministic prototype engine
(`engine.py`, `scenario.py`, `demo.py`, `api.py`, `index.html`). The later
FastAPI/SQLAlchemy/Next.js layers were not inspected directly and are treated
structurally. Phase 0 of the Claude Code prompt performs the real inspection.

---

## SECTION A — PRODUCT ARCHITECTURE

### A.0 The one insight that determines whether you ship 4 capabilities or 2

The four capabilities are not four features. They are **one computation applied
four ways**:

| Capability | Expressed in one primitive |
|---|---|
| 1. Current bottlenecks | `evaluate(W)` |
| 2. Future bottlenecks | `evaluate(W)` projected forward under uncertainty |
| 3. What-if simulation | `evaluate(apply(W, Δ))` compared against `evaluate(W)` |
| 4. Optimization | `argmax over Δ` of `score(evaluate(apply(W, Δ)))` |

So the architecture is four primitives, not four features:

1. **`W`** — an immutable workflow snapshot
2. **`evaluate(W)`** — a pure function: schedule + findings + risk, no I/O
3. **`Δ`** — a closed, typed, validated mutation algebra
4. **`diff(evaluate(A), evaluate(B))`** — comparison

Get these right and Capability 4 costs you a search loop over machinery you
already have. Get them wrong — four separate implementations reaching into a
mutable database — and you will ship Capabilities 1 and 3 and fake the rest.
**Every architectural decision below serves those four primitives.**

### A.1 Layering, and the one invariant that matters

```
web/          Next.js. Renders workflow + findings + diffs. No logic.
api/          FastAPI routers. Thin: validate, delegate, serialize.
services/     Orchestration: versions, scenarios, analysis runs, optimization.
ai/           Provider boundary. Interpreter / Proposer / Narrator. Swappable.
core/         THE ENGINE. Pure. Zero framework, zero DB, zero I/O, zero domain.
db/           SQLAlchemy models + repositories.
```

**Invariant: `core/` imports nothing from `api/`, `db/`, `services/`, or `ai/`,
and performs no I/O.** Enforce it with an import-linter test in CI.

Three things depend on this invariant:
- The optimizer must run thousands of evaluations. Anything touching the DB per
  evaluation makes optimization infeasible inside a hackathon.
- Intelligence is testable without a database or an API key.
- What-if cannot accidentally mutate real state if the evaluator physically
  cannot write.

### A.2 Immutability is not a nice-to-have — it is forced by your own requirements

Three requirements demand the same thing:
- "The original workflow must remain unchanged" (Capability 3)
- Compare current vs N proposed workflows (Capability 4)
- "Choose whether to apply an improvement" (UX step 14)

Therefore:

- **`WorkflowVersion`** is an immutable snapshot of tasks/dependencies/
  assignments/constraints/requirements. A project points at a current version.
- **`Scenario`** = `base_version_id` + an ordered list of typed `Mutation` rows.
  Cheap, ephemeral, disposable. Never touches the base.
- **Evaluating a scenario** = materialize(base + mutations) into an in-memory
  graph → `evaluate()`. Nothing is written except the `AnalysisRun` record.
- **Applying** a scenario = materialize, then persist as a *new*
  `WorkflowVersion`, and move the project pointer. The old version survives.

This single decision gives you undo, comparison, provenance, and "apply the
improvement" for free. The alternative — copying rows into temp tables to
simulate — is where teams lose six hours and ship silent data corruption.

### A.3 Domain-agnosticism, made testable rather than aspirational

Domain must be **context for the LLM and defaults for the user**, never an input
to the engine.

- A `Domain` is a **database row, not an enum**: `{ name, description,
  vocabulary_hints, task_templates, duration_variance_prior, is_custom }`.
  Users create their own; the seeded ones are just rows.
- The engine's input schema has **no domain field at all**. Not "ignored" —
  absent.
- Domain feeds: (a) LLM prompt context, (b) template/vocabulary suggestions in
  the UI, (c) *optionally* a duration-variance prior for simulation, passed as a
  plain number, not as a domain identity.

**Test this, don't hope for it.** The *domain leak test*: build two projects with
identical structure and different domains; assert `evaluate()` returns byte-
identical output. Fails the moment someone writes `if domain == "software"`.

### A.4 What to preserve, refactor, remove, redesign

**Preserve — this is real, working intelligence:**

| Asset | Why it survives |
|---|---|
| `schedule()` CPM forward/backward pass | Correct, tested, and the substrate for all four capabilities |
| `CycleError` reporting the actual cycle | Cheap robustness; judges ask about cycles |
| `diff()` | Already the shape Capability 3 and 4 need |
| Artifact-vs-temporal edge distinction | Generalizes to a `consumes` edge property; the basis of change-impact reasoning |
| Detector-with-structured-evidence pattern | This is what makes findings explainable rather than scored |
| Impact score as a visible **formula** | Recomputable by hand. Do not replace with a model. |
| `ready_since` / contention-age suppression | Genuine temporal reasoning; keep and generalize |
| The planted-fault accuracy harness | Becomes the regression suite for detectors |

**Refactor:**

- Detectors → a **registry** of pure functions with declared data requirements
  (see D.1 tiering). Currently a monolithic `detect()`.
- `scenario.py` → a **seed-data loader** producing ≥2 domain fixtures. Currently
  the campus symposium is hardcoded as module-level globals.
- `STATUS` / `EVENTS` module globals → an explicit `WorkflowState` passed in.
  Global state is incompatible with evaluating N candidates concurrently.
- `durations: dict[str, float]` → `effort` + optional distribution parameters +
  a `divisible` flag. Required before "add another person" can be honest.
- Integer day arithmetic → keep **integer working-days internally**, convert to
  calendar dates only at the API edge. Do not thread `datetime` through CPM;
  weekends and holidays belong in one boundary function.

**Remove or demote:**

- `demo.py` → a dev CLI and test fixture. Not a product surface.
- `index.html` → keep as an engine smoke-test harness; Next.js supersedes it.
  Do not port its dashboard aesthetic.
- The campus symposium as *the* product → becomes one seed fixture of several.
- The KPI-card header, the swimlane chart as a headline feature → these are the
  "dashboard drift" you are correcting. Visualization serves the workflow view;
  it is not the product.

**Redesign:**

- No persistence of analysis → `AnalysisRun` records with `engine_version` and
  `input_hash`, so results are reproducible and comparable.
- Single mutable global state → versions + scenarios (A.2).
- No resource model → `Resource`/`Assignment` with capacity and calendar.
- No constraints → an explicit `Constraint` set, without which the optimizer
  will cheat (see D.4).

### A.5 Minimum viable architecture

A **modular monolith**. One FastAPI process, one database, one Next.js app.
No microservices, no queue, no cache tier. If Postgres + SQLAlchemy already
works, keep it; if it is fighting you, SQLite is sufficient for the hackathon and
the engine cannot tell the difference.

The only boundaries that earn their complexity: `core/` (purity),
`ai/` (swappability + offline fallback), and `simulation` as a separately
testable service inside `core/`.

---

## SECTION B — AI ARCHITECTURE

### B.1 Three roles, three prompts, three schemas — never one mega-prompt

| Role | Input | Output (validated schema) | Never does |
|---|---|---|---|
| **Interpreter** | user NL + compact workflow projection | `MutationList` or `Intent` | compute anything |
| **Proposer** | workflow projection + current findings + domain context | `CandidateProposal[]` (each a `MutationList` + rationale) | score its own proposals |
| **Narrator** | engine result (findings, diff, scores) | prose explanation | introduce facts absent from the input |

Separate prompts because they fail differently and need different repair
strategies. One combined prompt makes every failure indistinguishable.

### B.2 The pipeline, with the guard rails made explicit

```
user NL
  → Interpreter (LLM)              → MutationList  [UNTRUSTED]
  → MutationValidator              → rejected | validated   ← schema + semantics + constraints
  → Scenario (base_version + mutations)                     ← still no write to workflow state
  → core.evaluate()                → Result       [AUTHORITATIVE]
  → diff() / score()               → Comparison   [AUTHORITATIVE]
  → Narrator (LLM)                 → prose        [PRESENTATION ONLY]
  → user decides
  → services.apply_scenario()      → new WorkflowVersion    ← the ONLY workflow write
```

Three hard rules:

1. **The LLM has no write path.** Proposals land in a `Proposal`/`Scenario` row
   with status `pending → validated → applied|rejected`. Only an explicit
   `apply` call, triggered by a human action, writes a `WorkflowVersion`.
2. **Numbers never come from the LLM.** Dates, slack, completion, probabilities,
   impact, rankings — all from `core/`. The Narrator receives them and may only
   rephrase. Add a test that strips numbers from Narrator output and asserts
   every remaining numeric claim appears in the input payload.
3. **Validation is semantic, not just schema-shaped.** A well-formed
   `DEPENDENCY_ADD` that creates a cycle, references a missing task, or violates
   a `Constraint` must be rejected with a user-visible reason.

### B.3 The requirement your brief omits: offline degradation

Venue wifi fails. API keys rate-limit. Demos happen anyway.

**Every P0 capability must work with the LLM disabled.** Implement
`AIProvider` as an interface with:

- `LLMProvider` — the real external API
- `NullProvider` — Interpreter falls back to structured UI forms; Proposer falls
  back to deterministic heuristics (D.4); Narrator falls back to the
  template-rendered explanations the engine already produces

The LLM adds *language and creative proposals*. It must not add *capability*.
If the LLM being down breaks your demo, the architecture is wrong.

### B.4 Practical LLM discipline

- **Structured output** via JSON schema / tool-calling; parse with Pydantic. On
  validation failure: exactly one repair attempt with the validation error
  appended, then reject. No unbounded retry loops.
- **Compact projection, not the whole workflow.** Send task ids, names, effort,
  dependencies, assignees, slack, deadline, and the current findings. Reference
  tasks by id only. A 200-task project must not blow the context window.
- **Cache by prompt hash.** Makes the demo fast, reproducible, and free. Also
  means a rehearsed demo path cannot fail live.
- **Log every LLM interaction** (prompt hash, schema, validation outcome). This
  is your evidence that the LLM never had authority.

---

## SECTION C — DATA MODEL

Entities, minimal but sufficient. `*` = belongs to a WorkflowVersion snapshot.

**Identity & access (deliberately thin)**
- `User { id, email, name }`
- `Project { id, name, description, domain_id, goal, deadline, current_version_id, created_by }`
- `ProjectMember { project_id, user_id, role }` — three roles: owner, editor,
  viewer. No RBAC, no permission matrix.

**Domain context**
- `Domain { id, name, description, vocabulary_hints, task_templates,
  duration_variance_prior, is_custom, created_by }`

**Workflow (immutable snapshots)**
- `WorkflowVersion { id, project_id, version_no, parent_version_id, created_from_scenario_id, created_at, note }`
- `Task* { id, version_id, key, name, description, status, effort, effort_unit,
  optimistic, likely, pessimistic, divisible, priority, actual_start, actual_end,
  required_skills }`
- `Dependency* { id, version_id, from_task, to_task, dep_type, consumes }`
  — `dep_type ∈ {FS, SS, FF}`; `consumes = true` marks an artifact dependency
  (carries requirement invalidation), `false` is ordering only.
- `Assignment* { version_id, task_id, resource_id, allocation }`
- `Resource* { id, version_id, kind, name, user_id?, capacity, calendar_id, skills }`
  — `kind ∈ {person, equipment, budget, ...}`; keep it generic.
- `Requirement* { id, version_id, key, version_no, text, consumed_by_task_ids }`
- `Constraint* { id, version_id, kind, target, reason }`
  — `kind ∈ {IMMUTABLE_DEPENDENCY, NON_DIVISIBLE_TASK, FIXED_ASSIGNMENT,
  MANDATORY_TASK, MIN_DURATION}`. **Without this table the optimizer cheats.**
- `Calendar { id, working_days, holidays }`

**Change & analysis**
- `Scenario { id, project_id, base_version_id, name, origin, status }`
  — `origin ∈ {user_whatif, llm_proposal, heuristic_proposal}`
- `Mutation { id, scenario_id, seq, kind, payload, created_by }` — the closed
  algebra (D.3). Each has a validator and an inverse.
- `AnalysisRun { id, project_id, subject_type, subject_id, engine_version,
  input_hash, params, schedule_json, risk_json, scores_json, created_at }`
- `Finding { id, analysis_run_id, kind, tier, severity, task_ids, root_cause,
  evidence_json, impact_score, explanation }`
- `Event { id, project_id, task_key, actor, from_status, to_status, at }`
  — append-only. Feeds the Tier-2 detectors. This is what makes findings
  evidential rather than inferred.
- `AIInteraction { id, role, prompt_hash, schema_name, valid, rejection_reason }`

**Two normalization calls, stated deliberately**
- **Full row copy on version bump**, not base+delta. Simpler, correct, and
  workflow sizes here are tiny. Deltas are for `Scenario` only, which is
  ephemeral.
- `evidence_json` / `payload` stay JSON. Findings and mutations are open-ended;
  normalizing them buys nothing and costs migrations you do not have time for.

---

## SECTION D — INTELLIGENCE ENGINE DESIGN

### D.1 The problem your brief does not address: cold start

You are building a domain-agnostic platform where users create their own
projects. A brand-new project has **no statuses, no event history, no actuals,
no historical variance**. Most of your Capability-1 factor list (task age,
stalled tasks, resource availability over time) is *unavailable* at that moment.

If you ignore this, the first thing a judge does — "let me make my own
project" — produces an empty analysis, and the demo dies.

**Solution: tier every detector by its data requirement, and surface the tier.**

| Tier | Requires | Can detect |
|---|---|---|
| **0 — Structural** | tasks + dependencies + effort only | zero-slack chains, single points of failure (high fan-out), long serial chains with no parallelism, deadline infeasibility, over-assigned resources, redundant/transitive dependencies, cycles, orphan/unreachable tasks, unassigned critical tasks |
| **1 — Stateful** | + statuses, dates, assignments | critical-path blockers, ready-but-idle, resource contention now, projected vs planned finish |
| **2 — Historical** | + event log | stalled-in-review, handoff latency, rework loops, aging |
| **3 — Cross-project** | + actuals across past projects | chronic underestimation, per-resource velocity, calibrated duration variance |

Each detector **declares** its tier. `evaluate()` reports
`analysis_tier_reached` and, critically, **what it cannot yet assess**. A fresh
workflow gets a genuinely useful Tier-0 analysis plus an honest
"add task statuses to unlock delay detection."

This is both the correct engineering answer and a strong demo beat: it shows the
system knows the limits of its own evidence.

### D.2 Capability 1 — current bottleneck detection

Preserve the existing pattern; formalize it.

- A detector is a pure function `(graph, schedule, state, clock, config) -> Finding[]`,
  registered by name with a declared tier.
- Every `Finding` carries: `kind`, `tier`, `severity`, `task_ids`, `root_cause`,
  `evidence` (the raw numbers and timestamps it reasoned from),
  `impact_score`, `downstream_affected`, `suggested_action`, `explanation`.
- **Root cause, not symptom.** Keep the "walk back to the earliest incomplete
  zero-slack ancestor" logic. A board shows you the blocked task; you name the
  blocker.
- **Impact is a formula, always decomposed:**
  `impact = days_lost × (1 + |downstream|)`, with both operands displayed.
  Weights may be configurable; the decomposition must always be visible. Never
  emit a bare score.
- **Explanations are templated from evidence.** The Narrator may rephrase for
  the user; it may not originate the finding.
- Keep the contention-age suppression insight (contention that began yesterday
  does not explain ten days of idleness). Generalize: a detector may suppress
  another's finding only with a stated reason recorded on the finding.

### D.3 Capability 3 — what-if simulation (build this before Capability 2 or 4)

Both prediction and optimization consume this machinery, so it comes first.

**The mutation algebra — closed, typed, validated, invertible.** This is the
single most important contract in the system, because it is also the *only*
thing the LLM is permitted to emit.

```
TASK_ADD              TASK_REMOVE           TASK_EFFORT_SET
TASK_DELAY_ADD        TASK_SPLIT            TASK_MERGE
TASK_STATUS_SET       TASK_PRIORITY_SET
DEPENDENCY_ADD        DEPENDENCY_REMOVE     DEPENDENCY_TYPE_CHANGE
ASSIGNMENT_ADD        ASSIGNMENT_REMOVE
RESOURCE_CAPACITY_SET RESOURCE_UNAVAILABLE_WINDOW
DEADLINE_SET          REQUIREMENT_VERSION_BUMP
```

Anything a user or the LLM wants to express must decompose into these. "Do these
two tasks in parallel" = `DEPENDENCY_REMOVE` (+ validation that no `consumes`
edge or `IMMUTABLE_DEPENDENCY` constraint forbids it). "Restructure the
project" is not expressible, which is the point.

**The honest effort model — where naive implementations get caught.**

Adding a second person does *not* halve duration. Model it explicitly:

```
duration = effort / (1 + efficiency × (assignees − 1))     efficiency ≈ 0.6 default
```

and respect `divisible = false` (an approval, a single-signature review, a
one-oven bake cannot be parallelized at all). **Print the model and its
efficiency factor in the result.** A judge who asks "so two people halve it?"
should get a confident answer, not a shrug.

**Simulation output** (all from `core/`, all diffable):
projected completion, delta vs base, tasks moved with per-task deltas, slack
consumed, critical path before/after, findings created, findings removed,
resource overload before/after, feasibility vs deadline, and — once Monte Carlo
exists — P(deadline).

**Invariant to test:** evaluating a scenario must leave the base version's hash
unchanged. Assert it.

### D.4 Capability 2 — future bottleneck prediction, without pretending

Two layers, shipped in order.

**Layer A (P0) — transparent additive risk score.** Not ML. For each task,
compute normalized factors, each with a weight and a human-readable reason:

| Factor | Signal |
|---|---|
| slack ratio | `slack / max(effort, 1)` — low means fragile |
| downstream fan-out | `|descendants| / |tasks|` |
| criticality proximity | slack rank; near-zero slack that is not yet zero |
| deadline pressure | `(deadline − projected_finish)` at this task's chain |
| resource pressure | assignee's committed load during this task's window |
| duration uncertainty | spread width, if known; else the domain prior |
| predecessor health | age/staleness of incomplete predecessors |
| remaining chain depth | how much unstarted work sits behind it |
| assignment gap | on critical path but unassigned |

`risk = Σ wᵢ · fᵢ`, and the API returns **every `fᵢ`, `wᵢ`, and its reason**.
The explanation is generated from the top contributing factors:

> "T14 is at high risk: 1 day of slack against 4 days of effort (slack ratio
> 0.25), blocks 3 downstream tasks, and its scheduled window overlaps Priya's
> existing commitment on T11."

**Layer B (P1) — Monte Carlo, which gives you the rigorous metric.** Sample task
durations from distributions, run N iterations, and report the
**criticality index**: the fraction of runs in which a task lies on the critical
path. That is the defensible definition of "at risk of becoming a bottleneck" —
far stronger than any heuristic, and it is a standard, citable technique.

**Cold-start honesty (non-negotiable).** With no historical variance, the
distribution is an *assumption*. State it in the response payload and in the UI:
distribution family, spread, its source (`historical | domain_prior | default`),
run count, and whether resource contention and rework were modeled. Label
Layer-A output as *structural estimate*, never as probability.

### D.5 Capability 4 — optimization as generate-and-verify search

This is the capability most likely to be hand-waved. Make it a search loop.

**Step 1 — Generate candidates from three sources.**

*Deterministic heuristics (always available, no LLM):*
- **Transitive reduction** — remove dependencies implied by other paths. A real,
  computable, provably safe win, and a satisfying demo.
- **Parallelize divisible zero-slack tasks** — split effort where `divisible`
  and skills allow.
- **Resource levelling** — move work from an overloaded resource to an idle one
  with matching skills.
- **Convert soft ordering to parallel** — drop `consumes = false` edges that no
  constraint protects.
- **Resequence independent chains** to reduce peak load.

*LLM proposals (Proposer role):* domain-aware restructurings the heuristics
cannot see — but emitted strictly as `MutationList`s, validated, and rejected if
invalid.

*Local search:* combine and perturb the above within a fixed evaluation budget.

**Step 2 — Score every candidate with `core/`, never with the LLM.**

**Step 3 — Multi-objective scoring, decomposed and never hidden.**

```
expected_completion · P(deadline) · peak_resource_overload
dependency_complexity (edges/tasks) · structural_risk (Σ task risk)
parallelization_achieved · constraint_violations (hard gate)
```

Return the **per-criterion table** for current vs each candidate. A single
blended number with invisible weights is exactly the kind of thing this reset is
meant to eliminate; expose the weights and let the user move them.

**Step 4 — Guardrails, or the optimizer will cheat.**

An unconstrained optimizer's best move is always *delete the slow task*. Hard
gates before any candidate is scored:
- `MANDATORY_TASK` cannot be removed
- `IMMUTABLE_DEPENDENCY` cannot be dropped (approvals, compliance gates,
  physical prerequisites)
- `NON_DIVISIBLE_TASK` cannot be split
- Skill requirements must be satisfied by any reassignment
- Total effort may not decrease unless the mutation explicitly justifies it —
  a *restructuring* changes sequence and allocation, not the work itself

**Make this a demo beat**: ask the platform to optimize freely and show it
*refusing* to delete the budget approval, with the constraint cited. That single
moment separates you from every team whose optimizer "found a 40% improvement."

**Step 5 — Recommend with reasons.** "Candidate B reduces expected completion
from 27 to 22 days (−18%) by removing 2 redundant dependencies and splitting
T12 across Arjun and Priya. Peak overload unchanged. 0 constraints violated."
Then: apply, discard, or edit.

### D.6 Workflow success rate — defined rigorously (your Section 10)

**Definition (P1, once Monte Carlo exists):**

> The proportion of simulation runs in which the materialized workflow reaches
> completion of all mandatory tasks on or before the project deadline, given the
> stated task-duration distributions, resource capacities, and working calendar,
> assuming no scope change.

Every reported value must be accompanied by:
- distribution family and spread, and **its provenance** (`historical`,
  `domain_prior`, `default`)
- iteration count and random seed
- whether resource contention was simulated
- whether rework/failure was modeled (initially: **no**)
- the independence assumption — durations sampled independently, **which is
  optimistic**, because real delays correlate

**P0 fallback — no percentage at all.** Report a **feasibility verdict and
margin** instead: "projected finish 27 Sep, deadline 23 Sep — infeasible by
4 days without change," plus a deterministic three-point range (run the schedule
at optimistic / likely / pessimistic durations). Do not display a probability
until the simulation that produces it exists. An invented percentage is the
single fastest way to lose a technical judge.

---

## SECTION E — API DESIGN

Resource-oriented REST. **Contract rule: analysis endpoints are pure reads over
an immutable snapshot; `apply` is the only endpoint that writes workflow state.**

**Domains & projects**
```
GET    /domains                          list (seeded + custom)
POST   /domains                          create custom domain
POST   /projects                          {name, domain_id, goal, deadline}
GET    /projects/{id}                     project + current version summary
GET    /projects/{id}/members
POST   /projects/{id}/members             {email, role}
```

**Workflow authoring (writes the project's draft version)**
```
GET    /projects/{id}/workflow                  current version, full graph
POST   /projects/{id}/tasks
PATCH  /tasks/{id}
DELETE /tasks/{id}
POST   /projects/{id}/dependencies              422 on cycle, with the cycle
DELETE /dependencies/{id}
POST   /tasks/{id}/assignments
GET    /projects/{id}/versions                  history
GET    /versions/{id}                           immutable snapshot
```

**Capability 1 & 2 — analysis**
```
POST   /projects/{id}/analyze
       -> { analysis_run_id, tier_reached, unavailable_checks[],
            schedule, findings[], risk: { tasks[]: {score, factors[]} },
            feasibility: { verdict, margin_days, three_point } }
GET    /analysis/{run_id}
POST   /analysis/{run_id}/explain               Narrator; presentation only
```

**Capability 3 — scenarios**
```
POST   /projects/{id}/scenarios                 {name, base_version_id?}
POST   /scenarios/{id}/mutations                typed mutation; 422 with reason
POST   /scenarios/{id}/evaluate                 -> AnalysisRun for the scenario
GET    /scenarios/{id}/diff?against=version_id  -> full comparison payload
POST   /scenarios/{id}/apply                    -> new WorkflowVersion  [ONLY WRITE]
DELETE /scenarios/{id}
```

**Capability 4 — optimization**
```
POST   /projects/{id}/optimize
       {objectives: {...weights}, budget: {max_candidates, max_seconds},
        sources: [heuristic, llm]}
       -> { candidates[]: { scenario_id, origin, mutations[], scores{},
                            deltas{}, constraint_violations[], rationale } ,
            recommended_scenario_id, current_scores{} }
```
Each candidate is a real `Scenario`, already evaluated — so the user can inspect
it, diff it, edit it, or apply it through the endpoints above. No special path.

**Natural language (never mutates)**
```
POST   /projects/{id}/interpret   {utterance}
       -> { intent, mutations[], validation: {valid, errors[]}, scenario_id? }
```
Returns a *pending* scenario. The user applies it explicitly or not at all.

**Conventions:** every analysis response carries `engine_version`,
`input_hash`, `assumptions{}`, and `tier_reached`. Validation failures return
422 with a structured, human-readable reason — those reasons are a feature.

---

## SECTION F — ROADMAP

### P0, ruthlessly ordered

Your list has twelve P0 items. Twelve is not a P0 list. This is the order to
build in, and the line below which you are still demoable:

| # | Item | Why here |
|---|---|---|
| 1 | Generic project/task/dependency model + immutable versions | Everything else sits on it |
| 2 | Domain as data + domain leak test | Cheap now, expensive to retrofit |
| 3 | `core.evaluate()` — schedule, Tier-0 + Tier-1 detectors, feasibility | Capability 1 |
| 4 | Mutation algebra + validator + `Scenario` evaluate/diff | Capability 3; prerequisite for 2 and 4 |
| 5 | Risk scoring (Layer A) with factor decomposition | Capability 2 |
| 6 | Heuristic candidate generation + multi-objective scoring + guardrails | Capability 4 **without any LLM** |
| 7 | Frontend: workflow builder, findings panel, what-if panel, comparison table | P0-K |
| 8 | Two seed domains + working demo path | P0-L |
| — | *demoable line — everything above is a complete product* | |
| 9 | AI service boundary + Narrator (explanations in prose) | Best LLM value per hour |
| 10 | Interpreter (NL → mutations) | Impressive, isolated, cuttable |
| 11 | LLM Proposer as a third candidate source | Slots into an existing search loop |
| 12 | Event log + Tier-2 detectors | Depth if time remains |

**Note what this ordering means:** Capability 4 exists at item 6 with no LLM at
all. The LLM then makes it conversational. If your API key dies at hour 30, you
still have four working capabilities. That is the whole point of B.3.

### P1
Monte Carlo + true P(deadline) + criticality index; historical calibration from
past projects; Tier-3 detectors; richer NL; audit history; real-time
collaboration; Pareto view for objectives.

### P2
Custom model fine-tuning; learned duration models; SSO/RBAC; external
integrations (Jira/GitHub adapters behind the existing ingest interface);
mobile; multi-tenancy.

### Testing intelligence — P0, not optional

- **Golden files**: fixed fixtures → asserted schedule output
- **Property tests**: adding a dependency never shortens the project; removing a
  non-mandatory task never lengthens it; `slack ≥ 0` for all tasks; critical path
  length equals project end
- **Purity/immutability**: base version hash unchanged after scenario evaluation
- **Domain leak**: identical structure + different domain → identical output
- **Import linter**: `core/` imports no framework, DB, or AI module
- **Detector precision/recall** on labeled fixtures (generalize the existing
  planted-fault harness across both seed domains)
- **Guardrail tests**: a candidate deleting a `MANDATORY_TASK` is rejected
- **LLM contract tests** against recorded responses — never a live API in CI
- **Seeded Monte Carlo determinism** once Layer B lands

---

## SECTION H — RISKS AND TECHNICAL TRADEOFFS

| # | Risk | Why it bites | Mitigation |
|---|---|---|---|
| 1 | **Cold start** — user-created projects have no history | The first thing a judge does is make their own project, and most detectors need data | Detector tiering (D.1); Tier-0 structural analysis always works; templates; state what is unavailable |
| 2 | **Resource-constrained scheduling is NP-hard (RCPSP)** | Any claim of an optimal resource-constrained schedule is false | Compute CPM (resource-blind) **and separately report resource overload**. Say plainly: we level heuristically, we do not solve RCPSP optimally. Naming this earns credibility |
| 3 | **Optimization is a search problem; search costs time** | Naive implementations hang or return nothing | Hard budget: max candidates, max seconds, deterministic heuristics first. `core/` purity is what makes thousands of evaluations affordable |
| 4 | **The parallelization fallacy** | `duration/n` is wrong and a judge will catch it in one question | Explicit effort model with an efficiency factor and a `divisible` flag; print the model |
| 5 | **Multi-objective scoring hides arbitrary weights** | "18% better" is meaningless if the weights are invented | Expose weights, always show the per-criterion table, let the user adjust |
| 6 | **Monte Carlo with independent durations overstates confidence** | Real delays correlate; independence is optimistic | State the assumption alongside every probability |
| 7 | **LLM unavailability or latency** | Wifi and rate limits fail at the worst moment | `NullProvider`; every P0 capability works without the LLM; cache by prompt hash |
| 8 | **LLM proposes plausible nonsense** | Fluent output that violates reality | Closed mutation algebra + semantic validation + hard constraint gates; rejected proposals shown with reasons |
| 9 | **Immutable versioning adds schema weight** | More tables, more mapping | Accepted deliberately: it is strictly cheaper than temp-table simulation, and it is what makes "apply an improvement" trivial |
| 10 | **Domain-agnostic + genuinely useful pull in opposite directions** | Generic tools feel empty; specific tools are hardcoded | Domain lives in prompts and templates only; the engine never sees it; test the boundary |
| 11 | **Twelve P0 items in a hackathon** | Everything 60% done, nothing demoable | The ordering in Section F, with an explicit demoable line |
| 12 | **Rebuilding what already works** | The prototype engine is correct and tested | Evolve, don't rewrite (Phase 0 of the Claude Code prompt) |

**Tradeoffs accepted, explicitly:**
CPM over RCPSP (correct and fast, resource-blind — reported separately).
Full snapshot copies over deltas (simpler, negligible cost at this scale).
Additive risk scoring over a learned model (explainable, no training data,
honest). Modular monolith over services (one process, one deploy, no ceremony).
JSON columns for evidence and mutation payloads (open-ended by nature).

---

## SECTION I — HACKATHON DEMO FLOW

Eight minutes, two domains, one refusal. Rehearse it three times.

**1 · The problem (30s).** Named persona: a delivery lead running work across
five departments. Not "organizations".

**2 · Cold start, and honest limits (60s).** Create a project in a *custom*
domain, type four tasks and their dependencies. Analyze. Tier-0 findings appear
immediately — a serial chain with no parallelism, one person on three
zero-slack tasks, deadline infeasible by 4 days. The panel also says what it
*cannot* assess yet and why. **Beat: the system knows the limits of its own
evidence.**

**3 · Domain-agnosticism, proven not claimed (45s).** Switch to the second seed
domain — a completely different structure. Same engine, same findings format,
zero code paths differ. Mention the domain leak test.

**4 · Capability 1 (60s).** Load the seeded project that has history. Top
finding with root cause and evidence: the blocker, not the blocked task. Point
at the impact formula: "days lost × work stuck behind it — recompute it by hand
from these two numbers."

**5 · Capability 2 (60s).** Risk panel with the factor decomposition visible.
Read one explanation aloud. Say the honest part: structural estimate, not a
probability — here are the assumptions, and here is what unlocks a real
probability.

**6 · Capability 3 (75s).** "What if Deepa is unavailable next week?" Type it in
natural language → the Interpreter returns a *pending* mutation list → validate
→ evaluate → diff. Then show the base version is untouched. **Beat: the original
workflow is provably unchanged.**

**7 · Capability 4 (105s).** Ask for a better workflow. Candidates appear, each
already scored by the deterministic engine, with the per-criterion table and the
weights on screen. Recommended: −18% expected completion via two redundant
dependencies removed (transitive reduction) and one task split. Apply it → new
version, old version still in history.

**8 · The refusal (45s).** Ask it to optimize with no limits. It declines to
remove the budget approval and cites the `IMMUTABLE_DEPENDENCY` constraint.
**This is the moment that distinguishes you from every team whose optimizer
found a miraculous improvement.**

**9 · Evidence and limits (45s).** Test suite: property tests, domain leak test,
detector precision/recall across both domains, guardrail tests. Then the
limitations slide — RCPSP, independence assumption, cold start. Volunteering
your limits reads as confidence; being caught reads as the opposite.

**Rehearsal rules:** run it with the LLM disabled once, so you know the fallback
path works. Cache the LLM responses on the demo path. Freeze the seed data and
the demo script before the last six hours. Have a screen recording as backup.

---

## SECTION A.6 — ACTUAL REPOSITORY INVENTORY (inspected 2026-09-07)

`C:\Users\vinay\Downloads\dynamic-workflow-intelligence`, branch `main`,
8 commits, 4 uncommitted modified files. Python 3.14, SQLite (`dwi.db`) via
`sqlite+aiosqlite`, Next.js frontend, 8 alembic dirs but **zero migrations
generated**.

### Good news first

**`engine.py` is not duplicated.** `backend/app/services/intelligence.py`
does `import engine as E` and only adds two DB-adapter helpers
(`_compute_dept_capacity`, `_compute_observed_durations`). The CPM
implementation exists exactly once. This is the single most important thing the
refactor must not break: `engine.py` moves to `core/`, and
`intelligence.py` stays as the DB↔engine adapter that becomes the service layer.

### The three real problems

**1. `Department` is a first-class database model.** `backend/app/models/department.py`
plus 42 occurrences of department/campus/sponsor/signage vocabulary across
9 backend files and 6 frontend files. This is the domain leak, in the schema
itself. `Department` must become a generic `Resource { kind, name, capacity,
skills, calendar }` where `kind` is data. A campus event has departments; a
software project has teams; a factory has machines. The engine must see only
resources with capacity.

**2. There is no workflow builder in the frontend.** Every component is a
read-only view: `DashboardView`, `GanttChart`, `AccuracyPanel`, `TasksView`,
`WhyLateView`, `DemoWalkthrough`, `BottleneckInbox`, `SimulationPanel`,
`DependencyGraph`. **A user cannot create a project, add a task, or draw a
dependency.** For a product whose stated first principle is "user-first", this
is the largest gap in the repo — larger than any missing intelligence feature.
Authoring must be built before more analysis surface.

**3. The immutability layer does not exist.** No `User`, `ProjectMember`,
`Domain`, `WorkflowVersion`, `Scenario`, `Mutation`, `Constraint`, `Resource`,
or `Assignment` models. Present models are `project`, `task`, `dependency`,
`department`, `requirement`, `event`. So Capability 3's "original must remain
unchanged" and Capability 4's candidate comparison have no substrate yet, and
`simulate.py` currently has nowhere to put a scenario.

### File-level disposition

| Path | Action | Reason |
|---|---|---|
| `engine.py` | **PRESERVE**, move to `backend/app/core/engine/` | Correct CPM + detectors; the asset |
| `backend/app/services/intelligence.py` | **REFACTOR** | Keep as DB↔engine adapter; strip `_compute_dept_capacity` domain assumptions |
| `backend/app/models/department.py` | **REDESIGN** → `resource.py` | The domain leak, in schema |
| `backend/app/models/{project,task,dependency,requirement,event}.py` | **REFACTOR** | Add version scoping, effort/divisible, `dep_type`/`consumes`, constraints |
| `backend/app/api/routers/{projects,tasks,simulate,seed}.py` | **REFACTOR** | Reshape to the Section E contract; add scenarios/analyze/optimize |
| `backend/tests/test_engine.py`, `test_api.py` | **PRESERVE** (331 lines, async) | Regression baseline — must stay green through the move |
| `backend/alembic/versions/` (empty) | **DECIDE** | Stay on `create_all` + reset-and-seed for the hackathon; do not sink hours into migrations |
| `frontend/src/components/{DashboardView,GanttChart,AccuracyPanel,DemoWalkthrough}.tsx` | **DEMOTE** | The dashboard drift being corrected |
| `frontend/src/components/{BottleneckInbox,SimulationPanel,DependencyGraph}.tsx` | **REFACTOR** | Keep, de-domain, subordinate to the builder |
| `frontend/src/components/` — **missing** | **BUILD** | `WorkflowBuilder`, `ProjectCreate`, `TaskEditor`, `DependencyEditor`, `MemberList`, `ComparisonTable` |
| `engine.py`/`api.py`/`demo.py`/`index.html`/`scenario.py` at repo root | **DEMOTE** | Root-level duplicates of the prototype; keep `demo.py` as a dev CLI, retire the rest once `core/` lands |
| `.env.example` (Postgres) vs `config.py` (SQLite) | **RESOLVE** | Stay on SQLite for the hackathon; the engine cannot tell the difference |

### Two hygiene items before any autonomous run

- 4 modified files are uncommitted on `main`. Commit them, then branch.
- All work happens on a branch, never on `main`, so review is a single diff.
