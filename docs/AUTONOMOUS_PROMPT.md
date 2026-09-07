# Autonomous Claude Code Prompt — Dynamic Workflow Intelligence Platform

## How to run it

From the repo root, after committing your current work and creating a branch:

```bash
git add -A && git commit -m "checkpoint before autonomous refactor"
git checkout -b refactor/workflow-intelligence-v2
claude --permission-mode bypassPermissions
```

Then paste the prompt below.

`bypassPermissions` skips permission prompts for file edits, bash commands and
git operations. `--dangerously-skip-permissions` is the equivalent older
spelling. Run `claude --help` to confirm what your version supports — flag names
have shifted between releases, and the mode cannot be set from
`.claude/settings.json` (project settings ignore it); it must come from the CLI
flag or `~/.claude/settings.json`.

Two things worth knowing before you walk away: deny rules still apply in bypass
mode, and Claude Code does not auto-continue past a context limit — so the
prompt below is written to commit after every phase, which means a session that
dies at phase 4 still leaves you four phases of reviewable work.

---

## The prompt

````
You have FULL AUTONOMOUS AUTHORITY over this repository for this run.

I am not available. Do not ask me questions. Do not stop for approval. Do not
wait for confirmation at any point. Make the call yourself, write down why, and
keep going. I will review the complete result afterwards from your commits and
your report files.

Read `docs/ARCHITECTURE.md` in this repo before you begin. It is the
authoritative design and it contains a file-by-file disposition table based on
an inspection of this exact repository. This prompt tells you how to execute;
that document tells you what to build. Where they conflict, ARCHITECTURE.md
wins — note the conflict in `docs/DECISIONS.md` and proceed.

## WHAT THE PRODUCT IS

A user picks or defines a domain, creates a project, defines tasks,
dependencies, assignees, effort and deadlines with collaborators, then asks the
platform for intelligence about that workflow. Four capabilities and nothing
else:

  1. Detect current bottlenecks, explainably
  2. Predict future bottlenecks, explainably
  3. Simulate hypothetical changes without altering the real workflow
  4. Propose and evaluate better workflows

It must be domain-agnostic and workflow-centric. It must not become a
Jira/Trello clone or an analytics dashboard.

## THE ARCHITECTURAL SPINE — INTERNALIZE THIS FIRST

The four capabilities are one computation applied four ways:

  Capability 1 = evaluate(W)
  Capability 2 = evaluate(W) projected forward under uncertainty
  Capability 3 = evaluate(apply(W, Δ)) diffed against evaluate(W)
  Capability 4 = search over Δ, scoring each candidate with evaluate()

So build four primitives, not four features:

  W          — an immutable workflow snapshot
  evaluate() — a pure function: schedule + findings + risk. No I/O.
  Δ          — a closed, typed, validated mutation algebra
  diff()     — comparison of two evaluation results

If you ever find yourself writing a second scheduling implementation for
simulation, or a separate code path for optimization, stop and refactor back to
the spine. That duplication is the primary failure mode of this project.

## WHAT THIS REPOSITORY ACTUALLY CONTAINS

Verify all of this yourself in Phase 0, but this is what I found:

- `engine.py` at the repo root holds the correct CPM implementation, cycle
  detection, schedule diff, requirement staleness, and four bottleneck
  detectors. It has async tests in `backend/tests/test_engine.py`.
  **This is the crown jewel. It is not duplicated:**
  `backend/app/services/intelligence.py` does `import engine as E` and only
  adds DB adapters. Move the engine into `backend/app/core/engine/`; do not
  reimplement it.
- `backend/app/models/department.py` makes "Department" a first-class entity,
  and department/campus/sponsor vocabulary appears in ~42 places across 9
  backend and 6 frontend files. **This is the domain leak and it lives in the
  schema.** It must become a generic `Resource { kind, name, capacity, skills,
  calendar }` where `kind` is data.
- **The frontend has no workflow builder.** Every component is a read-only
  view. A user cannot create a project, add a task, or draw a dependency. For a
  "user-first" product this is the biggest gap in the repo. Fix it in Phase 6
  and do not add more read-only analysis surface before then.
- There is no `User`, `ProjectMember`, `Domain`, `WorkflowVersion`, `Scenario`,
  `Mutation`, `Constraint`, `Resource` or `Assignment` model. The immutability
  layer that Capabilities 3 and 4 require does not exist yet.
- `backend/alembic/versions/` is empty. Stay on `create_all` plus a
  reset-and-seed command. Do not spend hours on migrations.
- `config.py` defaults to SQLite (`dwi.db`); only `.env.example` mentions
  Postgres. **Stay on SQLite.** Do not migrate to Postgres. The engine cannot
  tell the difference and this is a time sink.

## AUTONOMY RULES

- **Never ask me anything.** No clarifying questions, no approval requests, no
  "should I proceed". If a decision is ambiguous, choose the option that is
  smaller, more reversible, and closer to ARCHITECTURE.md, record it in
  `docs/DECISIONS.md` with one line of reasoning, and continue.
- **Never stop between phases.** Verify, self-correct, append your phase report,
  commit, and immediately begin the next phase.
- **When something fails, fix it yourself.** Failing test, broken import, bad
  migration, dependency conflict: diagnose and repair. Only if you have tried
  three genuinely different approaches should you record the blocker in
  `docs/BLOCKED.md`, revert that specific change, and move on to work that does
  not depend on it. Never leave the repo in a non-running state to wait for me.
- **Do not gold-plate to fill time.** If you finish all phases, spend remaining
  effort on tests and on the demo path, not on new features.

## HARD STOP CONDITIONS — the only reasons to halt

Halt, write `docs/BLOCKED.md` explaining precisely what happened and what you
would need, and commit whatever is green:

  1. You cannot run the test suite at all after three different attempts
  2. A step requires a credential or secret that is not in the repo or the
     environment
  3. You would have to delete or overwrite user data that is not reproducible
     from seed code
  4. You detect that you are about to exceed your context and lose coherence —
     commit and summarize instead of continuing badly

Nothing else is a stop condition. In particular: uncertainty is not a stop
condition, design disagreement is not a stop condition, and a failing test you
introduced is not a stop condition — it is a bug to fix.

## GIT DISCIPLINE — this is what makes my review possible

- Work on the current branch. **Never commit to `main`. Never force-push. Never
  rewrite history. Never `git reset --hard` across a commit boundary.**
- Commit after every meaningful unit of work, and always at the end of a phase.
  Never leave a commit that fails the test suite.
- Tag each completed phase: `git tag phase-1-core`, `phase-2-detectors`, and so
  on, so I can diff phase by phase.
- Conventional commit messages, and reference the phase: `feat(core): move
  engine into core, phase 1`.
- Never commit secrets, `.env`, `dwi.db`, `node_modules`, `__pycache__`,
  `.venv`, or build output. Fix `.gitignore` if you find any of these tracked.
- Do not delete or rewrite `docs/ARCHITECTURE.md`. Append to it if you must.

## ENGINEERING RULES — these hold in every phase

- **Evolve, do not rewrite.** `engine.py` is correct and tested. Move and
  refactor it; never reimplement it. Keep its existing tests green through
  every move — they are your safety net.
- **Do not destroy working functionality.** If you remove something, either
  preserve its behaviour elsewhere or list it in the phase report as a
  deliberate deletion with a reason.
- **`core/` is pure.** It imports no web framework, no ORM, no AI client, and
  performs no I/O. Enforce it with a test that fails on a forbidden import.
  Every other layer may depend on `core/`; `core/` depends on nothing internal.
  This is what makes thousands of optimizer evaluations affordable.
- **`core/` is domain-agnostic.** Its input schema has no domain field at all —
  absent, not ignored. Never write `if domain == ...` in `core/`. Add a domain
  leak test: two workflows with identical structure and different domains must
  produce byte-identical evaluation output.
- **The LLM must never mutate the database.** Model output lands in a pending
  scenario/proposal record. Only an explicit, user-triggered `apply` writes
  workflow state. Add a test asserting no code path from the AI module reaches
  a workflow write.
- **The LLM is never the authority for numbers.** Schedules, dates, slack,
  completion, impact, probabilities and rankings come from `core/`. The AI may
  interpret intent, propose structures, and narrate results. Nothing else. Add
  a test asserting every numeric claim in narrated text appears in the input
  payload.
- **Structured model outputs only.** JSON schema or tool-calling, parsed and
  validated with Pydantic. On validation failure: exactly one repair attempt
  with the error appended, then reject with a user-visible reason. No unbounded
  retries, no parsing free text.
- **Every capability must work with the LLM disabled.** Implement `AIProvider`
  with a real provider and a `NullProvider`. Under `NullProvider`: intent comes
  from structured UI forms, proposals from deterministic heuristics,
  explanations from the engine's own templates. Add a test running the full P0
  feature set under `NullProvider`. If an API key is absent, default to
  `NullProvider` and keep building — do not block on it.
- **No overengineering.** Modular monolith. One process, one SQLite database,
  one frontend app. No microservices, no message queue, no Kubernetes, no
  Kafka, no caching tier, no SSO, no RBAC beyond three roles
  (owner/editor/viewer), no abstraction with exactly one implementation except
  the AI provider boundary.
- **No unrequested features.** No analytics dashboards, no extra charts, no
  notification system, no gamification, no localization, no translation, no
  mobile concerns, no generic AI chatbot.

## PHASE 0 — INSPECT AND PLAN (no file modifications except the plan itself)

1. Map the repository as it actually is: entry points, modules, models, routers,
   services, frontend components, tests.
2. Run the test suite and record the pass/fail baseline BEFORE any change, so
   regressions are attributable. Write it into the plan.
3. Read `engine.py` and inventory precisely what it computes.
4. Find every hardcoded domain-specific artefact (department, campus symposium,
   sponsor, signage, status vocabularies, task keys).
5. Find every place workflow state is mutable module-level global state.
6. Write `docs/MIGRATION_PLAN.md`: file-by-file PRESERVE/REFACTOR/REMOVE/
   REDESIGN with one-line reasons, the target module layout, the import rules,
   and your phase order.
7. Create `docs/PROGRESS.md` and `docs/DECISIONS.md`.
8. Commit, tag `phase-0-plan`, and **proceed immediately to Phase 1**.

## PHASE 1 — DOMAIN-AGNOSTIC CORE AND IMMUTABLE VERSIONS

- Move `engine.py` into `backend/app/core/engine/` with zero behaviour change.
  Get the existing tests green there first, then refactor.
- Replace mutable module-global workflow state with an explicit state object
  passed into functions. Global state makes concurrent candidate evaluation
  impossible, which blocks Phase 5.
- Implement the generic model from ARCHITECTURE.md Section C: User, Project,
  ProjectMember, Domain (a table, not an enum), WorkflowVersion (immutable),
  Task, Dependency (with `dep_type` and a `consumes` flag), Resource,
  Assignment, Requirement, Constraint, Calendar.
- Replace `Department` with `Resource`. Purge domain vocabulary from models,
  schemas and services.
- Tasks carry `effort` plus optional three-point estimates and a `divisible`
  flag. Keep integer working-day arithmetic inside `core/`; convert to calendar
  dates at the API boundary only, in one function.
- Preserve the artifact-vs-temporal dependency distinction as `consumes` — it
  is what makes requirement-change impact computable.
- Replace the hardcoded scenario with a seed loader producing at least two
  fixtures in genuinely different domains, one with event history and one
  without.
- Tests: existing engine tests still pass; domain leak test; `core/` purity
  import test; property tests (adding a dependency never shortens the project;
  removing a non-mandatory task never lengthens it; slack >= 0 everywhere;
  critical-path length equals project end).

Verify, append to PROGRESS.md, commit, tag `phase-1-core`, continue.

## PHASE 2 — CAPABILITY 1: EXPLAINABLE CURRENT BOTTLENECKS

- Convert detectors into a registry of pure functions
  `(graph, schedule, state, clock, config) -> Finding[]`, each declaring a data
  tier (ARCHITECTURE.md D.1: 0 structural, 1 stateful, 2 historical,
  3 cross-project).
- Implement the Tier-0 detectors, which are new and essential for cold start:
  zero-slack chains, high fan-out single points of failure, long serial chains
  with no parallelism, deadline infeasibility, over-assigned resources,
  redundant/transitive dependencies, cycles, unassigned critical tasks.
- Port the existing Tier-1/2 detectors into the registry with behaviour
  unchanged: critical-path blocker with root-cause walkback, resource
  contention, stalled-in-review, ready-but-idle. Keep the contention-age
  suppression logic — it is deliberate temporal reasoning, not a bug.
- Every Finding carries kind, tier, severity, task_ids, root_cause, evidence
  (the raw numbers and timestamps reasoned from), impact_score,
  downstream_affected, suggested_action, and a templated explanation. Never
  emit a bare numeric score.
- `evaluate()` reports `tier_reached` and an explicit list of checks it could
  not run and why. A workflow with no history must still return useful Tier-0
  findings plus an honest statement of what is missing.
- Persist AnalysisRun with `engine_version` and `input_hash`.
- Tests: detector precision/recall against labeled fixtures in both seed
  domains; a no-history fixture returns Tier-0 findings and declares the rest
  unavailable.

Verify, report, commit, tag `phase-2-detectors`, continue.

## PHASE 3 — CAPABILITY 3: MUTATIONS, SCENARIOS, SIMULATION

Build this before prediction and optimization; both depend on it.

- Implement the closed mutation algebra from ARCHITECTURE.md D.3. Each mutation
  type gets a typed payload, a semantic validator, and an inverse.
- Validation is semantic, not merely schema-shaped: reject cycles, missing
  references and constraint violations, each with a user-readable reason.
- Scenario = base_version_id + ordered mutations, materialized in memory and
  evaluated. **Add a test asserting the base version's hash is unchanged after
  evaluation.**
- Implement the honest effort model:
  `duration = effort / (1 + efficiency * (assignees - 1))`, efficiency
  configurable, default ~0.6, and `divisible = false` tasks cannot be
  parallelized at all. Return the model and its parameters in the response.
  **Do not implement `duration / n`.**
- Diff output: projected completion and delta, tasks moved with per-task
  deltas, slack consumed, critical path before/after, findings created and
  removed, resource overload before/after, feasibility vs deadline.
- Simulation is a separate, independently testable service inside `core/`, not
  logic embedded in an API handler.
- `apply` promotes a scenario to a new immutable WorkflowVersion and moves the
  project pointer, preserving history.
- Tests: every mutation type round-trips and validates; invalid mutations
  rejected with reasons; base immutability; non-divisible tasks cannot be
  split; apply creates a new version leaving the parent intact.

Verify, report, commit, tag `phase-3-simulation`, continue.

## PHASE 4 — CAPABILITY 2: EXPLAINABLE RISK PREDICTION

- Implement Layer A from ARCHITECTURE.md D.4: a transparent additive risk score
  per task over slack ratio, downstream fan-out, criticality proximity,
  deadline pressure, resource pressure in the task's window, duration
  uncertainty, predecessor health, remaining chain depth, and assignment gap.
- `risk = sum(w_i * f_i)`, and the API returns every factor, its weight, its
  value and its human-readable reason. Explanations are generated from the top
  contributing factors.
- Label Layer-A output a **structural estimate**, never a probability. Include
  an `assumptions` block naming the duration spread used and its provenance
  (historical / domain prior / default).
- For P0 feasibility do NOT emit a percentage. Emit a verdict and margin
  ("infeasible by 4 days") plus a deterministic three-point range from running
  the schedule at optimistic/likely/pessimistic durations. Monte Carlo and true
  P(deadline) are P1: leave a clean seam, implement nothing fake.
- Tests: factor decomposition sums to the reported score; a tight-slack
  high-fan-out task outranks an abundant-slack one; no probability language
  appears anywhere in P0 output.

Verify, report, commit, tag `phase-4-prediction`, continue.

## PHASE 5 — CAPABILITY 4: OPTIMIZATION AS GENERATE-AND-VERIFY

Implement this WITHOUT the LLM. The LLM becomes a third candidate source in
Phase 7.

- Deterministic candidate generators: transitive reduction (remove
  dependencies implied by other paths), parallelize divisible zero-slack tasks,
  resource levelling to idle resources with matching skills, drop unprotected
  `consumes = false` ordering edges, resequence independent chains.
- Every candidate is a real Scenario, scored by `core/`. The scorer never calls
  the AI module.
- Multi-objective scoring, decomposed and returned per criterion: expected
  completion, feasibility margin, peak resource overload, dependency
  complexity, structural risk, parallelization achieved. Weights are inputs and
  are echoed in the response. Never return a single blended number alone.
- **Hard constraint gates before scoring.** Reject any candidate that removes a
  MANDATORY_TASK, drops an IMMUTABLE_DEPENDENCY, splits a NON_DIVISIBLE_TASK,
  breaks a skill requirement, or reduces total effort without justification.
  Return rejections with the constraint cited — they are a feature. Without
  these gates the optimizer's best move is always "delete the slow task".
- Bounded search: `max_candidates` and `max_seconds`. Never unbounded.
- Tests: transitive reduction never changes project end when the removed edge
  is genuinely redundant; a candidate deleting a mandatory task is rejected
  with the constraint named; optimization respects its budget; the recommended
  candidate genuinely scores best under the given weights.

Verify, report, commit, tag `phase-5-optimization`, continue.

## PHASE 6 — FRONTEND: BUILD THE AUTHORING EXPERIENCE FIRST

The workflow is the centre of the experience. Not cards, not KPI tiles. **The
repo currently has no way to author a workflow — fix that before touching any
existing view.**

- Build first: project creation with domain selection or definition, member
  add/assign, task create/edit, dependency create/delete with cycle feedback,
  effort and deadline entry. Until a user can build a workflow from an empty
  state, nothing else in the frontend matters.
- Then: findings panel with evidence and root cause, risk panel with factor
  decomposition, what-if panel with before/after diff, comparison table for
  current vs candidates, version history.
- Refactor `BottleneckInbox`, `SimulationPanel` and `DependencyGraph`; remove
  domain vocabulary from them. Demote `DashboardView`, `GanttChart`,
  `AccuracyPanel` and `DemoWalkthrough` — they are the dashboard drift being
  corrected. Keep an accuracy view accessible but not on the landing surface.
- Journey: what are you accomplishing -> choose or define a domain -> create
  project -> add members -> define tasks and dependencies -> build the workflow
  -> analyze -> current bottlenecks -> predicted risks -> what-if -> optimize
  -> compare -> apply.
- Show `tier_reached` and unavailable checks in the analysis UI. Show the
  assumptions block wherever an estimate appears.
- Do not add charts that do not change a decision. No dashboard home page.

Verify by completing the full journey in a browser for both seed domains.
Report, commit, tag `phase-6-frontend`, continue.

## PHASE 7 — AI BEHIND A SERVICE BOUNDARY

- `ai/` exposes exactly three roles, each with its own prompt and output schema:
  Interpreter (natural language -> mutation list), Proposer (workflow +
  findings + domain context -> candidate mutation lists), Narrator (engine
  result -> prose).
- All three go through `AIProvider`. Keep `NullProvider` and keep the
  full-feature-set-under-NullProvider test green.
- Interpreter output becomes a pending scenario, never applied automatically.
- Proposer becomes a third candidate source in Phase 5's search, subject to the
  same validation, the same constraint gates and the same deterministic
  scoring.
- Narrator receives only engine output.
- Send a compact workflow projection, not the full graph. Reference tasks by id.
- Cache responses by prompt hash. Log every interaction: role, prompt hash,
  schema, validation outcome, rejection reason.
- Tests: contract tests against recorded responses, never a live API in CI;
  malformed output repaired once then rejected; an LLM proposal violating a
  constraint is rejected with the constraint cited.

Verify, report, commit, tag `phase-7-ai`.

## PHASE 8 — DEMO PATH AND FINAL REPORT

- Make the demo flow in ARCHITECTURE.md Section I work end to end, twice in a
  row, from a clean database, with the LLM disabled and then enabled.
- Add a single command that resets the database and loads both seed domains.
- Write `docs/FINAL_REPORT.md` (see format below) and `docs/HOW_TO_DEMO.md`
  with exact commands.
- Commit, tag `phase-8-demo`.

## REPORTING — APPEND TO docs/PROGRESS.md AFTER EVERY PHASE

For each phase, in this order:

  1. CHANGED     — files added, modified, deleted, and why
  2. PRESERVED   — existing functionality kept, and where it now lives
  3. REMOVED     — anything deleted, with justification
  4. TESTS       — added, passing, failing; before/after comparison
  5. HOW TO TEST — exact commands and what I should see
  6. DECISIONS   — judgement calls you made, and your reasoning
  7. DEVIATIONS  — anything done differently from this brief, and why
  8. RISKS       — anything you found that worries you

`docs/FINAL_REPORT.md` at the end must contain: what the four capabilities can
and cannot do now; every deliberate deletion; the full test inventory with
pass/fail; every decision from DECISIONS.md; everything in BLOCKED.md; what I
should look at first when I review; and the honest limitations list for the
pitch.

## BEGIN

Start with Phase 0 now. Inspect, run the tests, write the plan, commit, and
continue straight into Phase 1 without stopping. Work through every phase in
order. Do not ask me anything.
````


---

## PHASE 9 — PRODUCTION HARDENING AND DEPLOYMENT

The goal is a deployed, shareable, resilient product — not an enterprise
feature set. Judge every item by "would a user notice this in five minutes of
use". If not, do not build it.

### 9.1 — Deployment artifacts must actually work

- Fix `backend/Dockerfile`: correct file layout after the refactor, bind
  `0.0.0.0`, read `--port ${PORT:-8000}` so a PaaS can inject the port. Verify
  with a real `docker build` and a container that answers `/health`.
- Fix `frontend/Dockerfile` and `docker-compose.yml` the same way.
- Pin Python 3.12 in the backend image (the local venv is 3.14; the image must
  not depend on that).
- Add a `.dockerignore` excluding `.venv`, `node_modules`, `dwi.db`,
  `__pycache__`, `.next`, `.git`.
- **Add a CI-less smoke check**: a single script
  (`scripts/smoke.sh` / `.ps1`) that builds, starts, waits for `/health`,
  runs the seed reset, calls `/analyze` on both seed domains, and exits
  non-zero on any failure. This is what gets run before every demo.

### 9.2 — Postgres compatibility without abandoning SQLite

- Everything already reads `DATABASE_URL` from the environment. Keep SQLite as
  the local default; make Postgres work by configuration alone.
- Re-enable `asyncpg` in `backend/requirements.txt` (it is commented out).
  Keep `psycopg2-binary` out unless something genuinely needs sync access.
- `create_all` on startup stays (decision D-03) — it works on Postgres too.
  Do not introduce Alembic migrations now.
- Verify against a real Postgres (docker-compose already defines one) that the
  full test suite and both seed fixtures work unchanged.
- Guard the startup seed so it is idempotent: seeding must not duplicate rows
  when the container restarts against an existing database.

### 9.3 — Configuration and CORS

- `CORS_ORIGINS` must be settable from an environment variable as a
  comma-separated list, and must include the deployed frontend origin. A
  wildcard is not acceptable once credentials are allowed.
- The frontend's `NEXT_PUBLIC_API_URL` must come from the environment with the
  localhost default retained for development.
- Write `.env.example` to describe the deployed shape accurately — it currently
  describes a Postgres setup nobody uses. It should document every variable the
  app reads, with a comment on each.
- No secret, key or connection string is ever committed.

### 9.4 — Resilience a user can actually feel

- **Error boundaries** in the frontend so a thrown component never blanks the
  page. A failed request renders an actionable message and a retry, never a
  stack trace and never an infinite spinner.
- **Empty states** for every list and panel: no project, no tasks, no findings,
  no history. Each says what to do next. A new user's first screen is an empty
  state, so these are first-impression surfaces, not edge cases.
- **Loading states** on every async action. Any action over ~300ms shows
  progress; long operations (optimize) show what stage they are in.
- **Bounded work**: analyze, simulate and optimize all take an explicit
  timeout. Exceeding it returns a structured, explained error rather than
  hanging the request.
- **Structured API errors**: every 4xx/5xx returns `{error, detail, hint}`
  where `hint` tells the user what to do. Validation failures already produce
  human-readable reasons — surface them, do not swallow them.
- **Request logging** with a request id, method, path, status and duration.
  One line per request, structured. No log of request bodies.
- `/health` stays liveness-only. Add `/ready` which verifies the database
  answers a trivial query.

### 9.5 — Multi-user without authentication

Do NOT build login, passwords, sessions, OAuth, SSO or RBAC.

- A name-picker: the user chooses or creates a `User` on first visit, stored
  client-side. That identity is sent on requests and drives ownership and
  assignment.
- `ProjectMember` roles stay owner/editor/viewer and are advisory in the UI.
  Do not build a permission enforcement layer.
- Two browsers must be able to open the same project and both see a change
  after a refresh. Live sync is not required.

### 9.6 — A safe playground for judges

- A `POST /admin/reset-seed` endpoint (guarded by a token from the environment)
  that drops and reloads both seed domains. This is what makes the deployment
  safe to hand to a stranger.
- The demo path must be re-runnable from a cold database in one command.

### 9.7 — Performance floor

- `analyze` on a seed project returns in under one second, warm.
- `optimize` respects its candidate and time budget and returns partial ranked
  results rather than timing out.
- Measure all three endpoints and record the numbers in the phase report. If
  something is slow, profile it — do not add caching to hide it.

### 9.8 — Deployment handoff

The agent cannot create accounts or click through hosting dashboards. Prepare
everything else and write `docs/DEPLOY.md` containing:

- exact steps for the human: what accounts to create, what to click, in order
- the complete list of environment variables for each service, with example
  values, marked required or optional
- a first-deploy checklist and how to verify each service is healthy
- the rollback step if a deploy breaks
- how to re-point the frontend at a new backend URL

Target stack (do not substitute without recording a decision):
Vercel for the Next.js frontend, Render or Railway for the backend container,
Neon or Supabase for managed Postgres.

### 9.9 — Explicitly out of scope

Do not build, and do not suggest: authentication, SSO, OAuth, RBAC or
permission enforcement, multi-tenancy, organisation hierarchies, audit logging
beyond the existing analysis history, rate limiting, quota systems,
CI/CD pipelines, Kubernetes manifests, service meshes, message queues,
caching tiers, monitoring or APM stacks, feature flags, i18n, mobile apps,
or a status page.

If you finish 9.1–9.8 with time remaining, spend it on empty states, error
messages and the smoke script — not on anything in this list.

### Verification before the phase commit

Run the smoke script against a container built from scratch, on Postgres,
from an empty database. Record in `docs/PROGRESS.md`: the smoke output, the
three endpoint timings, and every environment variable required to deploy.
Tag `phase-9-deploy`.
