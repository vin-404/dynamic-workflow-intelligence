# Migration Plan — Dynamic Workflow Intelligence v2

Written in Phase 0 from a first-hand inspection of the repository on branch
`refactor/workflow-intelligence-v2` at commit `4b0beec`. This plan is the
execution contract for Phases 1–8. `docs/ARCHITECTURE.md` remains the
authoritative design; where this plan interprets it, the interpretation is
recorded in `docs/DECISIONS.md`.

---

## 1 · Verified baseline (before any change)

**Environment**

| Item | Value |
|---|---|
| Python | 3.14.5, venv at `./.venv` (deps already installed) |
| Test command | `.venv/Scripts/python.exe -m pytest backend/tests -q` |
| **Baseline result** | **35 passed, 0 failed, 0 skipped — 0.33s** |
| Node | v22.18.0 / npm 10.9.3, `frontend/node_modules` present |
| Next.js | 16.3.4 (breaking changes vs. training data — read `frontend/node_modules/next/dist/docs/` before writing frontend code, per `frontend/AGENTS.md`) |
| DB | SQLite `dwi.db` via `sqlite+aiosqlite`; `DATABASE_URL` default in `backend/app/core/config.py` |
| Alembic | `backend/alembic.ini` + `env.py` + **empty `versions/`** — zero migrations ever generated |
| Tracked junk | none. `.gitignore` already covers `.venv`, `dwi.db`, `.env`, `node_modules`, `__pycache__`, `.next` |

Baseline is green, so **every** later failure is attributable to this refactor.

**Test inventory at baseline (35)**

- `backend/tests/test_engine.py` — 22 tests: CPM schedule (6), bottleneck
  detection (7), delay simulation (4), requirement staleness (4), cycle
  detection (2). Pure, no DB.
- `backend/tests/test_api.py` — 13 tests: FastAPI integration through
  `ASGITransport` against the real on-disk SQLite file, lifespan run once at
  import time.

**Baseline fragility found:** `test_api.py` runs the app lifespan at module
import and depends on the persistent `dwi.db` file, so the suite is not
hermetic. Phase 1 gives the API tests their own temporary database.

---

## 2 · What `engine.py` actually computes (inventory)

355 lines, one external dependency (`networkx`). Nothing here is duplicated
anywhere else in the repo — `backend/app/services/intelligence.py` does
`import engine as E` and only adapts the database to it.

| # | Symbol | Computes | Disposition |
|---|---|---|---|
| 1 | `CycleError(cycles)` | carries the actual `simple_cycles` list | PRESERVE verbatim |
| 2 | `build_graph(tasks, deps)` | `nx.DiGraph`; edge attr `kind ∈ {artifact, temporal}` | PRESERVE; `kind` → `consumes: bool` + `dep_type` |
| 3 | `schedule(G, durations)` | CPM forward/backward → `ES/EF/LS/LF`, `slack`, `critical`, `project_end` | PRESERVE verbatim — the crown jewel |
| 4 | `diff(before, after)` | `project_end_*`, `tasks_moved`, `critical_path_changed`, `newly_critical`, `no_longer_critical`, `slack_consumed` | PRESERVE; extend in Phase 3 |
| 5 | `apply_delay(durations, tid, extra)` | non-mutating duration override | PRESERVE; becomes the `TASK_DELAY_ADD` mutation's kernel |
| 6 | `stale_tasks(G, seeds)` | `must_redo` (artifact-edge closure) vs `must_recheck` (temporal descendants) | PRESERVE; drives `REQUIREMENT_VERSION_BUMP` |
| 7 | `Bottleneck` dataclass | kind, tasks, root_cause, evidence, attributed_delay_days, downstream_affected, suggested_action, severity | REFACTOR → `Finding` (+ `tier`, `impact` decomposition) |
| 8 | `Bottleneck.impact_score` | `attributed_delay_days × (1 + |downstream|)` — a visible formula | PRESERVE the formula, expose both operands |
| 9 | `_is_ready`, `_ready_since`, `root_blocker` | readiness; "day the last predecessor closed"; earliest incomplete zero-slack ancestor | PRESERVE — `root_blocker` is the root-cause walkback |
| 10 | `detect(...)` D1 | critical-path blocker + dedupe one finding per root cause | PORT to registry, Tier 1 |
| 11 | `detect(...)` D2 | resource contention: ready tasks per `dept` vs capacity | PORT to registry, Tier 1, keyed on `Resource` not `dept` |
| 12 | `detect(...)` D3 | stalled-in-review beyond `idle_threshold` | PORT to registry, Tier 2 (needs events) |
| 13 | `detect(...)` D4 | ready-but-idle **with contention-age suppression** | PORT to registry, Tier 2; keep the suppression, record the reason on the finding |
| 14 | `day_to_date(start, day)` | integer day → ISO date | MOVE to the API boundary (`core/calendar.py`, called only at the edge) |

**Domain leaks inside `engine.py` itself (11 occurrences):** `detect()` takes a
`depts` mapping, reads `G.nodes[t]["dept"]` in D2's filter, and interpolates
`dept` / `owner` into three `suggested_action` strings. These must become
generic `Resource` lookups; the engine's input schema must have no `dept` and
no `domain` field at all.

---

## 3 · Domain-specific artefacts to purge (167 occurrences, 24 files)

Counted with `department|dept|campus|symposium|sponsor|signage|auditorium|catering|SPON|MKT`
over project files only (venv/node_modules excluded).

| File | Hits | Action |
|---|---|---|
| `backend/app/services/seed.py` | 47 | REDESIGN → seed loader with ≥2 domain fixtures |
| `scenario.py` (root) | 39 | REMOVE — superseded by the seed loader |
| `backend/app/services/intelligence.py` | 34 | REFACTOR → DB↔engine adapter, resource-generic |
| `index.html` (root) | 23 | REMOVE — Next.js supersedes; do not port its dashboard |
| `frontend/src/components/DependencyGraph.tsx` | 22 | REFACTOR — de-domain, subordinate to the builder |
| `backend/tests/test_engine.py` | 17 | REFACTOR — retarget at fixtures, keep every assertion |
| `demo.py` (root) | 13 | REFACTOR → dev CLI over the new core |
| `frontend/src/components/DashboardView.tsx` | 12 | DEMOTE |
| `engine.py` (root) | 11 | PRESERVE logic, purge vocabulary (see §2) |
| `api.py` (root) | 10 | REMOVE — module-level mutable `G`/`PLANNED`/`OBSERVED`; superseded |
| `frontend/src/components/SimulationPanel.tsx` | 9 | REFACTOR |
| `backend/tests/test_api.py` | 8 | REFACTOR |
| `backend/app/schemas/{project,task,simulation}.py` | 9 | REDESIGN |
| `backend/app/models/department.py` | 4 | REDESIGN → `resource.py` |
| `backend/app/models/{project,task,__init__}.py` | 7 | REFACTOR |
| `backend/tests/conftest.py` | 3 | REFACTOR |
| `frontend/src/components/{TasksView,DemoWalkthrough}.tsx` | 4 | DEMOTE / de-domain |
| `backend/app/main.py` | 1 | REFACTOR |

Status vocabulary in use (`not_started`, `in_progress`, `in_review`, `done`) is
**generic and stays**, but becomes an explicit enum in `core/` rather than bare
strings scattered across detectors. `DONE = {"done"}` in `engine.py` and the
literal `"in_review"` in D3 become `TaskStatus` members.

---

## 4 · Mutable module-level workflow state (must all go)

| Location | State | Fix |
|---|---|---|
| `scenario.py` | `TASKS`, `DEPS`, `STATUS`, `EVENTS`, `REQUIREMENTS`, `DEPT_CAPACITY`, `TODAY_DAY`, `PROJECT_START` as module globals | file removed; data becomes seed fixtures |
| `backend/app/services/seed.py` | the same eight globals, re-declared | becomes fixture data returned by a loader function |
| `api.py` (root) | `G = build_graph(...)`, `PLANNED, OBSERVED = observed_durations()` at import — one shared graph for the whole process | file removed |
| `backend/tests/conftest.py` | fixtures import the seed module's globals | fixtures build snapshots from fixture builders |
| `engine.py` `DONE = {"done"}` | module constant (a mutable `set`) | `frozenset` on `TaskStatus` |

Nothing in `core/` after Phase 1 may hold workflow state at module scope. All
of it moves into an explicit, frozen `WorkflowSnapshot` + `WorkflowState`
passed into functions — this is the precondition for evaluating N optimizer
candidates in one process (Phase 5).

---

## 5 · Target module layout

```
backend/app/
  settings.py              ← moved from core/config.py   (pydantic-settings; NOT pure)
  db.py                    ← moved from core/database.py (SQLAlchemy engine/session/Base)
  core/                    PURE: no fastapi, no sqlalchemy, no pydantic-settings, no AI client, no I/O
    engine/
      __init__.py          public surface re-exports
      graph.py             build_graph, CycleError, ancestors/descendants, transitive reduction
      cpm.py               schedule(), diff()                       ← verbatim from engine.py
      staleness.py         stale_tasks()                            ← verbatim
      effort.py            duration = effort / (1 + eff*(n-1)); divisible gate
      status.py            TaskStatus, DONE
      findings.py          Finding, Severity, Tier, impact decomposition
      detectors/
        registry.py        register(tier=…); run_all(ctx) -> Finding[]
        tier0.py           structural detectors (new, cold-start)
        tier1.py           critical_path_blocker, resource_contention, ready_but_idle
        tier2.py           stalled_in_review, contention-age suppression
      risk.py              Layer-A additive risk with per-factor decomposition
      feasibility.py       verdict + margin + three-point range (no probabilities)
      evaluate.py          evaluate(W, state, clock, config) -> EvaluationResult
    workflow.py            WorkflowSnapshot, TaskSpec, DependencySpec, ResourceSpec,
                           AssignmentSpec, ConstraintSpec, RequirementSpec, WorkflowState  (all frozen)
    mutations.py           the closed Δ algebra: kinds, payloads, validate(), apply(), inverse()
    simulation.py          simulate(W, Δ[]) -> SimulationResult (uses cpm.diff)
    optimization.py        candidate generators, constraint gates, multi-objective scoring
    calendar_.py           working-day ↔ calendar date (pure; called only at the API edge)
  models/                  SQLAlchemy: user, project, member, domain, version, task, dependency,
                           resource, assignment, requirement, constraint, calendar, scenario,
                           mutation, analysis_run, finding, event, ai_interaction
  schemas/                 Pydantic request/response DTOs
  services/                versions, analysis, scenarios, optimization, seed  (DB ↔ core adapters)
  ai/                      provider.py (AIProvider, NullProvider, LLMProvider),
                           interpreter.py, proposer.py, narrator.py, schemas.py
  api/routers/             projects, workflow, tasks, dependencies, analysis, scenarios,
                           optimize, domains, members, interpret, seed
```

### Import rules (enforced by test)

1. `backend/app/core/**` may import only: stdlib, `networkx`, and other
   `backend.app.core` modules. Forbidden anywhere under `core/`: `fastapi`,
   `starlette`, `sqlalchemy`, `pydantic`, `pydantic_settings`, `httpx`,
   `anthropic`/`openai`, `backend.app.models`, `backend.app.services`,
   `backend.app.api`, `backend.app.ai`, `backend.app.db`, `backend.app.settings`.
2. `core/` performs no I/O: no `open`, no `os.environ`, no `requests`, no
   `datetime.now()` — the clock is an argument.
3. `core/` has no `domain` field anywhere in its input types.
4. `ai/` may import `core/` types but nothing may import `ai/` from `core/`.
5. `models/` may not import `services/` or `api/`.

The purity test walks every `.py` under `backend/app/core/`, parses it with
`ast`, and asserts no forbidden module appears in any `import` node. It fails
on a *source-level* import, so it catches violations without executing them.

---

## 6 · File-by-file disposition

Legend: **P**RESERVE · **R**EFACTOR · **X** REMOVE · **D**EDESIGN · **DM** DEMOTE · **B**UILD

### Backend

| Path | Action | Reason |
|---|---|---|
| `engine.py` (root) | **P → move** `core/engine/{cpm,graph,staleness}.py` | Correct CPM + detectors + diff; the asset. Move first, tests green, then refactor. |
| `scenario.py` (root) | **X** | Hardcoded single-domain globals; replaced by the seed loader with ≥2 fixtures. |
| `api.py` (root) | **X** | Prototype FastAPI with module-level mutable graph; `backend/app/main.py` supersedes it. |
| `demo.py` (root) | **R** → `backend/scripts/demo.py` | Keep as a dev CLI / smoke test over the new core, per ARCHITECTURE A.4. |
| `index.html` (root) | **X** | Prototype dashboard; explicitly not to be ported. |
| `requirements.txt` (root) | **R** | Root copy pins different versions than `backend/requirements.txt`; make root a pointer. |
| `backend/app/core/config.py` | **R → move** `backend/app/settings.py` | Imports `pydantic_settings`; cannot live under a pure `core/`. |
| `backend/app/core/database.py` | **R → move** `backend/app/db.py` | Imports SQLAlchemy; same reason. |
| `backend/app/models/department.py` | **D** → `resource.py` | *The* domain leak, in the schema. `Resource {kind, name, capacity, skills, calendar}`. |
| `backend/app/models/task.py` | **D** | Add `version_id`, `key`, `effort`, three-point estimates, `divisible`, `priority`, `required_skills`; drop `department`/`owner` (→ `Assignment` + `Resource`). |
| `backend/app/models/dependency.py` | **D** | Add `version_id`, `dep_type ∈ {FS,SS,FF}`, `consumes: bool` (replaces `kind`). |
| `backend/app/models/project.py` | **D** | Add `domain_id`, `goal`, `deadline`, `current_version_id`, `created_by`; drop `dept_capacities`. |
| `backend/app/models/requirement.py` | **R** | Version-scope it; keep the consumer join. |
| `backend/app/models/event.py` | **P** | Already the append-only log Tier-2 needs; scope to project (not version). |
| `backend/app/models/` — missing | **B** | `user`, `project_member`, `domain`, `workflow_version`, `assignment`, `constraint`, `calendar`, `scenario`, `mutation`, `analysis_run`, `finding`, `ai_interaction`. |
| `backend/app/services/intelligence.py` | **R** | Survives as the DB↔engine adapter; `_compute_dept_capacity` becomes resource-generic; `_compute_observed_durations` stays (it is the Tier-2 observed-duration bridge). |
| `backend/app/services/seed.py` | **D** | → `seed/` package: two fixtures in genuinely different domains, one with event history, one without. |
| `backend/app/api/routers/projects.py` | **R** | Reshape to Section E; `/state` → `/workflow` + `/analyze`. |
| `backend/app/api/routers/tasks.py` | **R** | Read-only today; add create/patch/delete for the builder. |
| `backend/app/api/routers/simulate.py` | **R** | Becomes `scenarios.py` (mutations/evaluate/diff/apply); keep delay + requirement as mutation shortcuts. |
| `backend/app/api/routers/seed.py` | **R** | Reset-and-seed both domains. |
| `backend/app/api/routers/` — missing | **B** | `domains`, `members`, `dependencies`, `analysis`, `scenarios`, `optimize`, `interpret`, `versions`. |
| `backend/app/schemas/*` | **D** | Regenerate against the Section E contract; drop `department`/`owner` fields. |
| `backend/tests/test_engine.py` | **P (assertions) / R (imports)** | The regression net. Every number in it must still hold after the move. |
| `backend/tests/test_api.py` | **R** | Retarget at the new contract; give it a temp DB so the suite is hermetic. |
| `backend/tests/` — missing | **B** | purity, domain-leak, property, mutation round-trip, base-immutability, detector precision/recall, guardrail, risk-decomposition, no-probability-language, NullProvider-full-feature, AI-no-write-path, narrator-numbers tests. |
| `backend/alembic/**` | **DECIDED: leave inert** | `versions/` is empty; stay on `create_all` + reset-and-seed. Do not sink hours into migrations (prompt + ARCHITECTURE agree). |
| `.env.example` (Postgres) | **R** | Align to SQLite so it stops contradicting `settings.py`. |
| `docker-compose.yml` | **R** | Drop the Postgres service if present; keep it consistent with SQLite. |

### Frontend

| Path | Action | Reason |
|---|---|---|
| `src/app/page.tsx` | **D** | Tab shell over a dashboard home. Becomes the journey: domain → project → build → analyze → predict → what-if → optimize → compare → apply. |
| `src/components/` — missing | **B first** | `ProjectCreate`, `WorkflowBuilder`, `TaskEditor`, `DependencyEditor`, `MemberList`, `ComparisonTable`, `RiskPanel`, `VersionHistory`. **Nothing else in the frontend matters until these exist.** |
| `BottleneckInbox.tsx` | **R** | Keep; show tier, evidence, root cause, impact decomposition; de-domain. |
| `SimulationPanel.tsx` | **R** | Rebuild on scenarios + mutations; before/after diff; de-domain. |
| `DependencyGraph.tsx` | **R** | Keep the dagre layout; make it the builder's canvas; de-domain (22 hits). |
| `DashboardView.tsx` | **DM** | Dashboard drift. Not the landing surface. |
| `GanttChart.tsx` | **DM** | Chart that does not change a decision on the landing surface. |
| `AccuracyPanel.tsx` | **DM** | Keep reachable (it is real evidence) but off the landing surface. |
| `DemoWalkthrough.tsx` | **DM** | Keep as an optional overlay; not a product surface. |
| `TasksView.tsx`, `WhyLateView.tsx` | **R** | Fold into the workflow view + findings panel; de-domain. |
| `Header.tsx`, `TabNav.tsx`, `Card.tsx` | **P** | Neutral primitives. |
| `src/lib/api.ts` | **D** | Regenerate types against the new contract; drop the hardcoded `DEMO_PROJECT_ID` default. |

---

## 7 · Phase order

Unchanged from `docs/AUTONOMOUS_PROMPT.md`, because it is already the
dependency order in ARCHITECTURE.md Section F: Capability 3 before 2 and 4,
frontend authoring before more analysis surface, AI last.

| Phase | Tag | Gate to pass before committing |
|---|---|---|
| 0 plan | `phase-0-plan` | baseline recorded; no source file modified |
| 1 core + versions | `phase-1-core` | 35 baseline tests green after the move; purity, domain-leak, property tests added |
| 2 detectors | `phase-2-detectors` | Tier-0 findings on a no-history fixture; ported detectors byte-identical on the seeded fixture |
| 3 mutations + simulation | `phase-3-simulation` | every mutation round-trips; base hash unchanged; non-divisible cannot split |
| 4 risk | `phase-4-prediction` | factors sum to score; no probability language in P0 output |
| 5 optimization | `phase-5-optimization` | mandatory-task deletion rejected with the constraint cited; budget respected |
| 6 frontend | `phase-6-frontend` | empty state → full journey completed in a browser, both domains |
| 7 AI | `phase-7-ai` | full P0 feature set green under `NullProvider`; no AI→write path |
| 8 demo | `phase-8-demo` | Section I flow twice from a clean DB, LLM off then on |

**Invariant for every phase:** the test suite is green at every commit, and the
count never drops below the previous phase's.

---

## 8 · Risks carried into Phase 1

1. `test_api.py` is not hermetic (shared on-disk `dwi.db`, lifespan at import).
   Fixing it changes the file that is also my regression net — so I fix the
   harness first, confirm 35/35 still passes, then touch the schema.
2. The engine's `detect()` signature carries `depts` and reads `dept` node
   attributes. Renaming to resources touches the detector assertions in
   `test_engine.py`. Mitigation: move verbatim first (green), then rename in a
   second commit whose only test changes are mechanical.
3. Next.js 16.3.4 differs from training data; `frontend/AGENTS.md` requires
   reading `node_modules/next/dist/docs/` before writing frontend code. Budget
   for that in Phase 6 rather than discovering it there.
4. The seeded fixture's numbers (planned 22, projected 26, slip 4, critical
   path of 7, 4 bottlenecks) are asserted in 12 places. They must survive the
   `duration` → `effort` rename unchanged, which means `effort == duration` and
   one assignee by default in the migrated fixture.
