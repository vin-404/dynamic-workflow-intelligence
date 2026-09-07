# Progress

One section per phase, in the order required by `docs/AUTONOMOUS_PROMPT.md`:
CHANGED · PRESERVED · REMOVED · TESTS · HOW TO TEST · DECISIONS · DEVIATIONS ·
RISKS.

---

# Phase 0 — Inspect and plan

## 1 · CHANGED

Documentation only. **No source file was modified in this phase**, by design.

| File | Change | Why |
|---|---|---|
| `docs/MIGRATION_PLAN.md` | added | File-by-file disposition, verified baseline, engine inventory, domain-leak census, global-state census, target layout, import rules, phase order |
| `docs/DECISIONS.md` | added | Nine Phase-0 judgement calls with reasoning |
| `docs/PROGRESS.md` | added | This file |

## 2 · PRESERVED

Everything. The tree is byte-identical to `4b0beec` apart from the three new
docs.

## 3 · REMOVED

Nothing.

## 4 · TESTS

**Baseline established before any change — this is the regression reference for
every later phase:**

```
.venv/Scripts/python.exe -m pytest backend/tests -q
35 passed in 0.33s
```

| Suite | Tests | Result |
|---|---|---|
| `backend/tests/test_engine.py` | 22 | pass |
| `backend/tests/test_api.py` | 13 | pass |
| **Total** | **35** | **35 pass / 0 fail / 0 skip** |

No tests were added in Phase 0.

## 5 · HOW TO TEST

```bash
# from the repo root
.venv/Scripts/python.exe -m pytest backend/tests -q     # expect: 35 passed
git show --stat phase-0-plan                            # expect: 3 docs added, 0 source files touched
```

## 6 · DECISIONS

D-01 … D-09 in `docs/DECISIONS.md`. The three that shape everything after:

- **D-02** — `core/config.py` and `core/database.py` move out of `core/` so the
  purity invariant can be enforced literally rather than exempted.
- **D-06** — the non-hermetic API test harness gets fixed first, in its own
  commit, because it is the regression net for the whole refactor.
- **D-07** — the seeded fixture migrates as `effort == duration` with one
  assignee, so the twelve assertions pinning its exact numbers survive.

## 7 · DEVIATIONS

None. Phase 0 executed as specified: map the repo, record the pass/fail
baseline before any change, inventory `engine.py`, census the domain leaks and
the mutable globals, write the plan, create `PROGRESS.md` and `DECISIONS.md`.

## 8 · RISKS

1. **`test_api.py` is not hermetic.** It runs the FastAPI lifespan at module
   import time and asserts against the persistent on-disk `dwi.db`. A stale
   `dwi.db` can make it pass or fail for reasons unrelated to the code. It is
   also the file I most need to trust. Addressed first in Phase 1 (D-06).
2. **The engine's own domain leak is in its detector signature**, not just in
   strings: `detect(..., depts, ...)` filters on the `dept` node attribute.
   Generalising to `Resource` necessarily edits detector assertions in the
   regression suite. Mitigated by splitting the move (verbatim, green) from the
   rename (mechanical test edits) into two commits.
3. **12 assertions pin the seeded fixture's exact arithmetic** (planned end 22,
   projected 26, slip 4, critical path of 7 tasks, exactly 4 bottlenecks,
   `wasted_days == 2.0`, `departments == {ORG:2, FIN:1, FAC:1, MKT:1, SPON:1}`).
   Any change to the effort model or the capacity derivation shows up here
   first. That is a feature, but it means the fixture must be migrated with
   arithmetic-preserving values (D-07).
4. **Next.js 16.3.4 diverges from training data**; `frontend/AGENTS.md`
   requires reading `frontend/node_modules/next/dist/docs/` before writing
   frontend code. Phase 6 must budget for that rather than discover it.
5. **Alembic is a decoy.** `alembic.ini`, `env.py` and `script.py.mako` exist
   with zero migrations, which invites someone to "just generate the initial
   migration" and lose hours. Left inert deliberately (D-03); the reset-and-seed
   command is the supported path.
6. **Root-level prototype duplicates** (`engine.py`, `api.py`, `scenario.py`,
   `demo.py`, `index.html`) currently sit next to the real backend, and
   `engine.py` is imported by the backend via a `sys.path` hack in
   `backend/tests/conftest.py`. Until Phase 1 lands, `import engine` resolves
   by path insertion — fragile, and the reason the move happens first.

---

# Phase 1 — Domain-agnostic core and immutable versions

## 1 · CHANGED

Delivered in three commits so the diff is reviewable one concern at a time.

### 1a · The regression net, first (decision D-06)

| File | Change | Why |
|---|---|---|
| `backend/tests/conftest.py` | redirects `DATABASE_URL` to a temp file before any app import | the suite was asserting against the developer's `dwi.db`, so results depended on leftover state |
| `backend/tests/test_api.py` | session-scoped `pytest-asyncio` client, lifespan entered once; every assertion unchanged | the lifespan ran at module import, which is why the old harness was unattributable |
| `pytest.ini` | added: `asyncio_mode=auto`, `testpaths` | there was no pytest config at all |

### 1b · The engine moved, not reimplemented

`engine.py` was split by responsibility with **the code unchanged**, and the
36-test net proved the move before anything was refactored:

| From | To | Contents |
|---|---|---|
| `engine.py` sec. 1 | `core/engine/graph.py` | `CycleError`, `build_graph` |
| `engine.py` sec. 1-2 | `core/engine/cpm.py` | `schedule`, `diff`, `apply_delay` |
| `engine.py` sec. 3 | `core/engine/staleness.py` | `stale_tasks` |
| `engine.py` sec. 4 | `core/engine/detectors.py` | `Bottleneck`, `root_blocker`, `detect` |
| `engine.py` sec. 5 | `core/engine/calendar_.py` | `day_to_date`, at the boundary only |

Two modules moved **out** of `core/` so the purity test could be literal
rather than exempted (D-02): `core/config.py` to `app/settings.py`,
`core/database.py` to `app/db.py`.

### 1c · The primitives

| File | What it is |
|---|---|
| `core/workflow.py` | **`W`** — `WorkflowSnapshot` and its members, all frozen, plus `WorkflowState`, `Clock`, `EngineConfig`. Tuples and `MappingProxyType` throughout, so immutability is a fact (D-12). `content_hash()` is order-independent. |
| `core/engine/effort.py` | The honest effort model: `duration = effort / (1 + efficiency x (assignees - 1))`, `divisible=false` refuses the speedup, `observed_durations` (moved out of the DB service), `three_point_durations` with an assumptions block. |
| `core/engine/evaluate.py` | **`evaluate(W)`** — the primitive all four capabilities are expressed through. Reports `engine_version`, `input_hash`, feasibility verdict plus margin, `tier_reached`, and `unavailable_checks`. |
| `core/engine/graph.py` | `build_graph_from_snapshot`, `find_cycles` (non-raising, for validators), `transitive_redundant_edges` (Phase 5's first candidate). |

### 1d · The generic data model

`Department` is gone from the schema. Every ARCHITECTURE C entity now exists:

- `models/identity.py` — `User`, `Domain` (**a table, not an enum**), `Project`, `ProjectMember` (owner/editor/viewer)
- `models/version.py` — `WorkflowVersion` (immutable), `Task` (effort + three-point + `divisible` + skills), `Dependency` (`dep_type` + **`consumes`**), **`Resource`** (`kind`, `capacity`, `skills`, `parent_key`), `Assignment`, `Requirement`, `Constraint`, `Calendar`, `Event`
- `models/analysis.py` — `Scenario`, `Mutation`, `AnalysisRun`, `Finding`, `AIInteraction`

18 tables, up from 6.

### 1e · Services, seed and API

| File | What it is |
|---|---|
| `services/versions.py` | the **only** module that knows both rows and snapshots. `load_snapshot`, `load_state`, `load_context`, `write_version`, `ensure_draft`, `seal_version`, and `day_to_date`/`date_to_day` — the single calendar boundary. |
| `services/intelligence.py` | refactored to the DB-to-engine adapter over `evaluate()`. `_compute_dept_capacity` deleted (capacity is now explicit, nothing to guess); `_compute_observed_durations` moved into `core/`. |
| `app/seed/fixtures.py` | **two** fixtures in genuinely different domains, as functions returning fresh snapshots — no module globals. |
| `app/seed/loader.py` | `seed_all`, `seed_one`, **`reset_and_seed`** (the one command Phase 8 needs). |
| `api/routers/{domains,projects,workflow,analysis,seed}.py` | reshaped to the Section E contract. **25 endpoints**, including the authoring writes the repo did not have. |
| `schemas/authoring.py` | input DTOs with no `department`, no `owner` string, no domain on a task. |
| `backend/scripts/demo.py` | the dev CLI, rebuilt over the new core and running both fixtures. |

## 2 · PRESERVED

| Prototype asset | Where it lives now |
|---|---|
| CPM forward/backward pass | `core/engine/cpm.py::schedule` — **byte-identical logic** |
| `CycleError` carrying the real cycle | `core/engine/graph.py`, plus a non-raising `find_cycles` for validators |
| `diff()` | `core/engine/cpm.py::diff`, unchanged |
| `apply_delay()` | `core/engine/cpm.py`, unchanged; becomes `TASK_DELAY_ADD`'s kernel in Phase 3 |
| `stale_tasks()` artifact/temporal split | `core/engine/staleness.py`, reading `consumes` instead of `kind == "artifact"` |
| Impact as a visible formula | `Bottleneck.impact_score`, unchanged, now printed decomposed in the CLI and asserted in tests |
| `root_blocker` walkback | `core/engine/detectors.py`, unchanged |
| `ready_since` / contention-age suppression | `core/engine/detectors.py` D4, unchanged — including the comparison of the two ages |
| All four detectors | same module, resource-generic |
| Planted-fault accuracy harness | `services/intelligence.py::get_accuracy`, now reading ground truth from the fixture that planted it, so it generalises to every domain |
| `demo.py`'s six verified sections | `backend/scripts/demo.py`, now eight sections across two domains |
| Every numeric assertion | `test_engine.py` and `test_api.py` — planned 22, projected 26, slip 4, seven-task critical path, four findings, `wasted_days == 2.0`, team capacities `{org:2, fin:1, fac:1, mkt:1, spon:1}` |

## 3 · REMOVED

Deliberate deletions, each with its behaviour accounted for:

| Removed | Why | Where the behaviour went |
|---|---|---|
| `scenario.py` | single-domain module-level globals; incompatible with evaluating N candidates | `app/seed/fixtures.py`, as one of two fixtures |
| `api.py` | prototype API holding a **module-level mutable graph** (`G`, `PLANNED`, `OBSERVED` built at import) | `backend/app/main.py`, which already superseded it |
| `index.html` | prototype dashboard; ARCHITECTURE A.4 says explicitly not to port its aesthetic | the Next.js app |
| root `demo.py` | walked the deleted `scenario.py` and read `dept`/`owner` node attributes | rewritten as `backend/scripts/demo.py` over the new core, covering strictly more |
| `models/department.py` | **the domain leak, in the schema** | `models/version.py::Resource`, `kind` as data |
| `models/{project,task,dependency,requirement,event}.py` | superseded by version-scoped equivalents | `models/{identity,version}.py` |
| `schemas/{project,task,simulation,bottleneck}.py` | carried `department`/`owner` fields | `schemas/authoring.py` for inputs; analysis responses are service-assembled dicts |
| `api/routers/{tasks,simulate}.py` | read-only task list; delay/requirement simulation without a scenario substrate | `routers/workflow.py` (full CRUD), `routers/analysis.py` (requirement impact). **Delay simulation returns in Phase 3 as a mutation**, which is where it belongs. |
| `intelligence._compute_dept_capacity` | guessed capacity from the count of distinct owners | `Resource.capacity`, explicit; nothing left to guess |
| `intelligence._compute_observed_durations` | engine arithmetic living in a DB service, untestable without a database | `core/engine/effort.py::observed_durations` |
| `GET /api/projects/{id}/state` | conflated "what I authored" with "what the engine concluded" | split into `GET /workflow` and `POST or GET /analyze` |

**Functionality gap I am carrying deliberately:** the `POST /simulate/delay`
and `POST /simulate/requirement` endpoints existed and now only the
requirement half does (as `/requirement-impact`). Delay simulation is Phase
3's `TASK_DELAY_ADD` mutation against a `Scenario`; building it twice is
exactly the duplication the brief warns about. It is listed here so it cannot
be mistaken for an oversight.

## 4 · TESTS

| Suite | Phase 0 | Phase 1 | What it covers |
|---|---|---|---|
| `test_engine.py` | 22 | **51** | every prototype assertion, plus effort model, evaluate(), cold start, transitive redundancy |
| `test_api.py` | 13 | **36** | the Section E contract, both seed domains, no-probability-language |
| `test_core_purity.py` | — | **24** | forbidden imports, no I/O, no clock, no domain field, no module-level state |
| `test_domain_leak.py` | — | **7** | byte-identical output for identical structure in different domains |
| `test_properties.py` | — | **168** | the 4 named properties plus immutability, over both fixtures and 25 seeded random DAGs |
| `test_authoring.py` | — | **25** | build a workflow from an empty database; every rejection reason |
| **Total** | **35 pass** | **309 pass / 0 fail** | |

Nothing is skipped and nothing is xfail. Every commit in this phase was green.

Notable: two assertions I wrote were **wrong and the code was right** — the
event fixture does contain two genuinely redundant edges (`T01->T04`,
`T01->T13`, both implied by `T01->T02->T03->...`), and `is_probability: false`
is a legitimate use of the word "probability". Both tests were corrected to
assert what is true, and the redundancy case became two stronger tests.

## 5 · HOW TO TEST

    # the whole suite -- expect 309 passed
    .venv/Scripts/python.exe -m pytest -q

    # the four things the brief asked for specifically
    .venv/Scripts/python.exe -m pytest backend/tests/test_engine.py -q       # regression net
    .venv/Scripts/python.exe -m pytest backend/tests/test_core_purity.py -q  # core/ is pure
    .venv/Scripts/python.exe -m pytest backend/tests/test_domain_leak.py -q  # no domain leak
    .venv/Scripts/python.exe -m pytest backend/tests/test_properties.py -q   # properties

    # see it work with no database and no API key, in both domains
    .venv/Scripts/python.exe -m backend.scripts.demo

    # see it work over HTTP
    .venv/Scripts/python.exe -m uvicorn backend.app.main:app --reload --port 8001
    curl -s localhost:8001/api/seed/projects
    curl -s -X POST localhost:8001/api/projects/00000000-0000-0000-0000-000000000001/analyze
    curl -s localhost:8001/api/projects/00000000-0000-0000-0000-000000000002/workflow

What you should see: the campus project projecting day 26 against a planned
22, four findings over three root causes with `tier_reached: 2`; the battery
project projecting day 31, **zero** findings, `tier_reached: 0`, and three
`unavailable_checks` entries explaining exactly what is missing and what
unlocks it.

## 6 · DECISIONS

D-10 through D-16 in `docs/DECISIONS.md`. The two that shaped the phase:

- **D-16 — `Resource.parent_key`.** The seeded fixture says Marketing has two
  people but capacity 1, and that gap *is* the planted contention bottleneck.
  Assigning tasks to people alone would have lost the finding; assigning to
  teams alone would have lost the owner names; assigning to both would have
  made every task look like it has two assignees and broken the effort model.
  A roll-up parent keeps all three correct: one assignment per task to a
  person, capacity measured on the team over its members' ready work.
- **D-11 — `consumes` replaces `kind`.** Carrying both would have been the
  duplication the brief warns about. Cost: one line in the cycle test.

## 7 · DEVIATIONS

1. **I built the authoring API in Phase 1, not Phase 6.** The brief puts the
   builder in Phase 6, but "the repo has no way to author a workflow" is a
   backend gap as much as a frontend one, and I could not test the new model
   without write endpoints. Phase 6 is now purely frontend work against a
   contract that is already covered by `test_authoring.py`. This reduces
   Phase 6 risk rather than expanding scope.
2. **`evaluate()` landed here rather than in Phase 2** (D-13). The
   domain-leak test the brief requires *in Phase 1* compares `evaluate()`
   output, so the function had to exist. Phase 2 enriches it with the
   detector registry and tiering; it does not introduce it.
3. **`Resource.parent_key` is not in ARCHITECTURE C's field list** (D-16).
   Reasoning above. It is generic structure, not a domain concept.
4. **Stateful detectors are gated behind `state.has_statuses`.** Not asked
   for, but running the Tier-1 blocker detector against an empty state
   reported the first task of the cold-start fixture as blocking its own
   successors with impact 0 — noise dressed as insight. Phase 2's registry
   makes this gating declarative per detector.

## 8 · RISKS

1. **`test_authoring.py` takes about 13s** because each test creates a project
   through the real API. Acceptable now; if the suite gets slow it should move
   to a module-scoped built project rather than lose the coverage.
2. **A draft version is edited in place.** That is what ARCHITECTURE E
   specifies ("authoring writes the project's draft version") and it avoids a
   version per keystroke, but it means the *draft* is the one mutable thing in
   the system. `ensure_draft` clones a sealed version before editing, and
   `test_authoring.py::TestVersionImmutability` pins that behaviour. Worth
   re-checking in Phase 3 when `apply` starts producing sealed versions.
3. **Event history is project-scoped, statuses are version-scoped.** Correct
   (history is about what happened; statuses are part of the snapshot), but it
   means a version clone copies statuses while events stay shared. If a future
   phase needs "the state as of version N", that asymmetry is where the bug
   will be.
4. **`transitive_redundant_edges` is O(E x (V+E))** — it copies the graph per
   edge. Fine at 17-23 edges; it needs replacing with a proper transitive
   reduction before the Phase 5 optimizer calls it inside a search loop.
5. **The frontend is now broken against the backend.**
   `frontend/src/lib/api.ts` still calls `/state` and expects `departments`,
   `task_code` and `owner`. This is expected — Phase 6 rewrites it — but
   between here and there the Next.js app will not load. Noted so it is not
   mistaken for a regression.
6. **`alembic/` still sits there with an empty `versions/`**, inviting someone
   to generate a migration against 18 new tables. Left inert deliberately
   (D-03); `POST /api/seed/reset` is the supported path.

---

# Phase 2 — Capability 1: explainable current bottlenecks

## 1 · CHANGED

### The detector registry

`core/engine/detectors.py` became a package. A detector is now a pure function
`(DetectorContext) -> Finding[]` registered by name with a **declared data
tier**, which is what lets `evaluate()` answer two questions instead of one:
what is wrong with this workflow, and what could it not yet assess.

| File | What it is |
|---|---|
| `core/engine/findings.py` | `Tier`, `Impact`, `Suppression`, `Finding`. A `Finding` refuses to be constructed without evidence, an explanation and a valid severity — "never a bare score" is enforced in `__post_init__`, not just intended. |
| `core/engine/detectors/context.py` | `DetectorContext` — graph, schedule, snapshot, state, clock, config, plus derived lookups computed once (`descendants`, `ancestors`, `last_event`, `resource_label`, `ready_since`). |
| `core/engine/detectors/__init__.py` | the registry: `all_detectors()` returns a tuple, `run_all()` executes those the evidence supports, `unavailable_checks()` describes the rest. |
| `core/engine/detectors/tier0.py` | **nine new structural detectors** |
| `core/engine/detectors/tier1.py` | ported `critical_path_blocker`, `resource_contention`, plus new `projected_vs_planned_finish` |
| `core/engine/detectors/tier2.py` | ported `stalled_in_review`, `ready_but_idle`, and the contention-age suppression |

The registry is assembled by a **function returning a tuple**, not by a
decorator writing into a module-level list, because `core/` holds no mutable
module state. The purity test caught three real violations while I was writing
this — `TIER_NAMES`, `TIER_REQUIRES`, `TIER_UNLOCKED_BY` and `_WHY` were plain
module dicts; they are `MappingProxyType` now, and `EMPTY_SCHEDULE` became a
function.

### The Tier-0 detectors (all nine ARCHITECTURE D.1 names)

| Detector | Fires when | Impact magnitude |
|---|---|---|
| `dependency_cycle` | the graph has a cycle, reported **with the cycle** | days in the loop |
| `deadline_infeasible` | the plan overruns the deadline on structure alone | overshoot days |
| `single_point_of_failure` | fan-out at or above the threshold | the task's duration |
| `serial_chain_no_parallelism` | a single-file run at or above the length threshold | the chain's duration |
| `zero_slack_chain` | the critical share exceeds `critical_share_threshold` | the critical chain's duration |
| `resource_overallocated` | the schedule needs a resource in more places at once than its capacity | days that must move |
| `unassigned_critical_task` | critical-path work with no assignee | the task's duration |
| `redundant_dependency` | an edge implied by a longer path | **0 days, honestly** |
| `isolated_task` | a task with no edges in an otherwise connected workflow | the task's duration |

### `evaluate()` rewired

- runs the registry, gated by declared tier
- reports `checks_run`, so **"checked and clean" is distinguishable from "never checked"**
- reports `unavailable_checks` generated *from the registry* rather than from a hand-maintained list, and including five `PLANNED_CHECKS` that are design commitments not yet built — marked `(not built yet)` so nothing can be mistaken for a check that ran and found nothing
- reports `suppressed_findings` separately
- **a cyclic workflow no longer raises.** It returns `schedulable=False`, the cycles, and a `dependency_cycle` finding. A bad graph cannot take a page down.

### `AnalysisRun` persistence

| File | What it is |
|---|---|
| `services/analysis_runs.py` | `record()` stores the evaluation with `engine_version` + `input_hash`, findings included; identical re-analysis reuses the existing row rather than writing a duplicate. `get()`, `list_for_project()`. |
| `api/routers/analysis_runs.py` | `GET /api/analysis/{run_id}` |
| `api/routers/analysis.py` | `GET /api/projects/{id}/analysis-runs` |

`analyze` now returns `analysis_run_id`. Writing that row is the only write an
analysis endpoint performs, and it touches no workflow state.

### Impact, decomposed and unit-named

`Impact` carries `magnitude`, `downstream_affected`, the `formula`, and a
`worked` string (`"9 days lost x (1 + 7 downstream) = 72"`). It also carries
`magnitude_kind`: at Tier 1+ the magnitude is **days already lost**, measured
from evidence; at Tier 0 there is no history, so it is **days of work
exposed**. Conflating those two would be exactly the quiet dishonesty this
project is trying to avoid, so the unit is named in the payload.

## 2 · PRESERVED

| Prototype behaviour | Where it is now, and proof |
|---|---|
| D1 critical-path blocker + root-cause walkback | `tier1.critical_path_blocker` / `tier1.root_blocker`. `test_root_cause_walkback_names_the_blocker_not_the_blocked` |
| D1 dedupe to one finding per root cause | same function, unchanged |
| D2 resource contention arithmetic | `tier1.resource_contention`. `test_contention_reports_capacity_not_headcount` still asserts capacity 1, 2 ready, queue `[T11, T12]` |
| D3 stalled-in-review | `tier2.stalled_in_review`, threshold behaviour unchanged |
| D4 ready-but-idle, aged from when the last predecessor closed | `tier2.ready_but_idle` |
| **D4 contention-age suppression** | `tier2.suppress_idle_explained_by_contention`. Kept exactly — the two ages are compared, not blanket-dropped — and now the suppressed finding **survives with its reason attached** (ARCHITECTURE D.2). New test builds the case where it fires. |
| Impact as a recomputable formula | `Impact`, with both operands and the worked arithmetic in the payload |
| Every prototype number | 22 / 26 / slip 4 / seven-task critical path / four stateful findings / three root causes. `test_the_original_four_detectors_still_find_exactly_four` |
| The planted-fault harness | generalised across both domains, `services/intelligence.get_accuracy` |

## 3 · REMOVED

| Removed | Why | Replacement |
|---|---|---|
| `detect(G, sched, snapshot, state, clock, config)` as the single entry point | a monolithic `detect()` cannot declare per-detector data requirements, which is what tiering needs | `run_all(ctx)` over the registry |
| `Bottleneck` | had no `tier`, no `explanation`, and let a caller construct a finding with empty evidence | `Finding`, which refuses to be built without them |
| `Finding.tasks` → `task_ids`, `attributed_delay_days` → `impact.magnitude` | the brief specifies `task_ids`; and `attributed_delay_days` is a lie at Tier 0, where nothing has been lost yet | `task_ids`, `impact.magnitude` + `impact.magnitude_kind` |
| `accuracy.precision_vs_planted` | **it punished the detectors for being right.** With three planted faults labelled and eleven real findings, "precision" would have read 33% while every one of the eleven was correct and expected | `recall`, `precision` against fully labelled fixtures, plus `planted_recall` as the headline |
| `ProjectFixture.ground_truth: dict[str, str]` | keyed by root cause only, so two different findings on one task collided | `labelled: tuple[LabelledFinding, ...]`, keyed by `(kind, root_cause)` with a description and a `planted` flag |
| `evaluate()` raising `CycleError` | an exception is a worse answer than a finding for a UI | `schedulable=False` + a `dependency_cycle` finding. `schedule()` still raises for direct callers, and that test still passes. |

## 4 · TESTS

| Suite | Phase 1 | Phase 2 | Notes |
|---|---|---|---|
| `test_engine.py` | 51 | **64** | prototype regressions + registry + suppression |
| `test_api.py` | 36 | **46** | tier counts, checks_run, suppressed findings, persisted runs |
| `test_detectors.py` | — | **43** | precision/recall in both domains; each Tier-0 detector fired *and* silenced; the cold-start contract |
| `test_core_purity.py` | 24 | **34** | grew with the module count |
| `test_domain_leak.py` | 7 | 7 | projection now strips `explanation` too |
| `test_properties.py` | 168 | 168 | unchanged |
| `test_authoring.py` | 25 | 25 | unchanged |
| **Total** | **309** | **388 pass / 0 fail / 0 skip** | |

Detector accuracy, measured by the harness itself:

| Fixture | Labelled | Detected | Recall | Precision | Planted found |
|---|---|---|---|---|---|
| Campus Tech Symposium | 11 | 11 | **100%** | **100%** | **3 of 3** |
| Battery Pack Pilot Line | 7 | 7 | **100%** | **100%** | none planted |

Zero missed, zero unexpected, on both.

**Every Tier-0 detector has a negative test.** A detector that fires on
everything is not a detector, so each one is asserted silent on a workflow it
should not fire on — and three thresholds (`fan_out_threshold`,
`critical_share_threshold`, `serial_chain_threshold`) are asserted
configurable and echoed in the evidence.

Two more assertions of mine turned out wrong and the behaviour right, or the
behaviour genuinely too lenient:

- `zero_slack_chain` fired at 50% critical, which is common and unremarkable.
  I raised the threshold to a configurable 0.6 rather than weakening the test.
- The domain-leak projection needed `explanation` stripped as well as
  `suggested_action` — both quote the user's own words by design, and
  `test_findings_quote_the_users_words_but_not_the_engines` asserts they
  genuinely differ, so the comparison cannot pass by the engine going silent.

## 5 · HOW TO TEST

    .venv/Scripts/python.exe -m pytest -q                              # 388 passed
    .venv/Scripts/python.exe -m pytest backend/tests/test_detectors.py -q -v

    # the cold-start beat, on a workflow with no history whatsoever
    .venv/Scripts/python.exe -m backend.scripts.demo battery-pilot-line

    # over HTTP
    .venv/Scripts/python.exe -m uvicorn backend.app.main:app --reload --port 8001
    curl -s -X POST localhost:8001/api/projects/00000000-0000-0000-0000-000000000002/analyze
    curl -s localhost:8001/api/projects/00000000-0000-0000-0000-000000000002/accuracy
    curl -s localhost:8001/api/projects/00000000-0000-0000-0000-000000000001/analysis-runs

What you should see on the **battery** project: seven Tier-0 findings on a
workflow with no statuses, no events and no actuals — an infeasible deadline
by 5 days, a single point of failure, no absorbing slack, two resource
overloads, two redundant dependencies — `tier_reached: 0`, `checks_run` listing
exactly the nine structural checks, and `unavailable_checks` naming all five
that could not run plus five more that are not built yet, each with what it
needs and what unlocks it.

On the **campus** project: eleven findings across three tiers, `checks_run` of
14, one suppressed roll-up overload with its reason, and `accuracy` reporting
recall 100%, precision 100%, planted 3 of 3.

## 6 · DECISIONS

D-17 … D-22 in `docs/DECISIONS.md`. The three that matter most:

- **D-18 — `precision_vs_planted` had to go.** It is the one metric in the
  prototype that actively misleads: adding correct detectors lowers it. Fully
  labelling both fixtures costs eighteen labelled findings with descriptions
  and makes recall *and* precision meaningful.
- **D-19 — a cyclic workflow returns a finding, not an exception.**
- **D-21 — `ready_but_idle` is Tier 2, not Tier 1** as ARCHITECTURE D.1's
  table has it. It ages from a recorded event; with no event log the age is
  measured from day 0 and it over-reports on every fresh project. The tier is
  a data requirement, and this detector's requirement is history.

## 7 · DEVIATIONS

1. **`ready_but_idle` moved from ARCHITECTURE's Tier 1 to Tier 2** (D-21).
   Reasoning above.
2. **Two detectors beyond the brief's Tier-0 list.**
   `projected_vs_planned_finish` (Tier 1) is in ARCHITECTURE D.1's table but
   not in the prompt's list, and it is the number a delivery lead actually
   asks for. `isolated_task` implements D.1's "orphan/unreachable tasks".
3. **`PLANNED_CHECKS`.** Five checks appear in `unavailable_checks` marked
   `(not built yet)` although nothing implements them. Not asked for, but the
   alternative is a Tier-3 gap that lists nothing, which would imply
   cross-project calibration is available once you have history. It is not.
4. **`Impact.magnitude_kind`.** The brief says impact is
   `days_lost x (1 + |downstream|)`. At Tier 0 nothing has been lost yet, so
   the same formula runs over "days of work exposed" and the payload names
   which. Renaming the field is a deviation; silently calling exposure a loss
   would have been worse.
5. **`critical_share_threshold` added to `EngineConfig`**, so
   `zero_slack_chain` is not hardcoded at a number I picked.

## 8 · RISKS

1. **Eleven findings on the campus fixture is a lot to read**, and three of
   them share the root cause T03 (blocker, single point of failure, stalled in
   review). All three are true and distinct, but the UI must group by root
   cause or Phase 6 will ship a wall of red. Noted for the findings panel.
2. **`resource_overallocated` does a boundary sweep per resource** — fine at
   this scale, but combined with `transitive_redundant_edges`' graph-copy per
   edge it is the slowest thing in `evaluate()`. Both need attention before
   the Phase 5 optimizer calls `evaluate()` thousands of times; measuring it
   is the first task of that phase.
3. **The labelled fixtures are now a strict regression lock.** Any new
   detector that fires on either seed fixture fails `test_precision_is_100_percent`
   until it is labelled. That is the intended behaviour — it forces a
   deliberate review of every new detection — but it will feel like friction,
   and the fix is to add the label, never to loosen the test.
4. **`suppress_idle_explained_by_contention` runs after all detectors, in
   `run_all`.** It is the only cross-detector interaction, and it is currently
   hardcoded rather than declared. If a second suppression rule appears it
   should become a declared post-pass, not a second `if` in `run_all`.
5. **`projected_vs_planned_finish` reads `baseline_project_end`**, which
   `evaluate()` injects into the schedule dict. That is a slightly smelly
   channel — a detector reading a key no scheduler produces. It works and it is
   tested, but a `DetectorContext.baseline_schedule` field would be cleaner.

---

# Phase 3 — Capability 3: mutations, scenarios, simulation

Built before prediction and optimization, because both consume it.

## 1 · CHANGED

### D — the mutation algebra (`core/mutations.py`, ~1150 lines)

Seventeen kinds, exactly the ARCHITECTURE D.3 list. Each has:

| Part | What it is |
|---|---|
| payload schema | required and optional fields, checked before anything semantic runs |
| semantic validator | returns `Rejection`s with user-readable reasons, and the cited constraint where one applies |
| applier | returns a **new** `(snapshot, state)` pair; cannot modify what it was given |
| inverse | returns a **tuple** of mutations that undoes it |

"Restructure the project" is not expressible, and an unknown kind is refused
with the valid set printed. `Mutation.payload` is a `MappingProxyType`, so a
stored mutation cannot be edited in place.

### Simulation (`core/simulation.py`)

`Scenario = base snapshot + base state + ordered mutations`. `simulate()`
materialises it in memory and calls **the same `evaluate()`** Capability 1
uses. `_compare()` produces the full ARCHITECTURE D.3 diff:

- projected completion before/after/delta/direction
- tasks moved, each with its own delta and name
- slack consumed, per task and totalled
- critical path before/after, newly critical, no longer critical
- findings created, removed, unchanged
- resource overload before/after, resolved, introduced
- feasibility before/after, margin delta, whether the verdict changed
- structure: tasks added/removed, dependencies added/removed, **total effort delta**
- the effort model and its efficiency factor

`summarise()` renders it deterministically. That is the Narrator's
`NullProvider` fallback: the engine can always describe its own result, so
language is never a capability the model adds.

### Persistence and the single write path

| File | What it is |
|---|---|
| `services/scenarios.py` | create / add mutation / remove mutation / evaluate / diff / **apply** / delete / one-shot what-if |
| `api/routers/scenarios.py` | 9 endpoints, including `GET /api/scenarios/mutation-kinds` which publishes the algebra with its payload contracts |

**`apply_scenario()` is the only function in the codebase that writes workflow
state.** It creates a new immutable version whose parent is the base, moves the
project pointer, and returns the parent's content hash so the caller can
confirm history was preserved. An LLM proposal will be a `Scenario` row with
`origin="llm_proposal"`; it reaches a version only through this function, only
on an explicit human call. That is what will make Phase 7's "the LLM cannot
mutate the database" structural rather than a policy.

### `RESOURCE_UNAVAILABLE_WINDOW` — the demo's beat 6

`ResourceSpec.unavailable_windows` plus `effort.apply_unavailability()`. A task
whose scheduled window overlaps an assignee's absence has the overlap added to
its duration, in a single pass over the resource-blind schedule.

Verified over HTTP: *"what if Anitha is unavailable next week"* moves projected
completion from day 26 to day 33, three tasks shift, and the base version's
hash is byte-identical before and after. Suresh away for the same week adds
seven days of *work* and zero days of *project*, because he has slack — two
facts reported separately.

It is an approximation and the payload says so: `is_approximation: true` and
`"This is not a resource-constrained optimal schedule - we do not solve RCPSP
and do not claim to."` (ARCHITECTURE H, risk #2.)

## 2 · PRESERVED

| Prototype behaviour | Where it is now |
|---|---|
| `apply_delay()` | `core/engine/cpm.py`, untouched; `TASK_DELAY_ADD` is the mutation-level equivalent |
| `diff()` | `core/engine/cpm.py`, untouched; `simulation._compare()` wraps and extends it |
| `POST /simulate/delay` | `POST /api/projects/{id}/what-if` with a `TASK_DELAY_ADD` — **the same numbers**: 26 → 31, +5 days, 7 tasks moved, critical path unchanged. Asserted. |
| Calendar dates at the boundary | `projected_end_date_before/after`, still produced only in the service layer |
| The stalled-review observed duration | untouched; the delay model was changed *because* it interacted with it wrongly |

## 3 · REMOVED

Nothing was deleted in this phase. Two behaviours changed deliberately:

| Changed | From | To | Why |
|---|---|---|---|
| `TASK_DELAY_ADD` | added to `effort` | writes a separate `added_delay` | T03 is nine elapsed days against a two-day estimate, so raising the estimate to seven changed the schedule **not at all**. A delay has to sit on top of what the task already looks like it will take. Keeping it separate also makes a slip read as slip rather than as a re-baselined plan. |
| `inverse()` | `-> Mutation` | `-> tuple[Mutation, ...]` | A single-mutation inverse was quietly wrong; see TESTS. |

## 4 · TESTS

| Suite | Phase 2 | Phase 3 | Notes |
|---|---|---|---|
| `test_mutations.py` | — | **80** | all 17 kinds round-trip, every rejection, every constraint cited |
| `test_simulation.py` | — | **53** | immutability at three levels, the full diff payload, apply |
| `test_engine.py` | 64 | 64 | unchanged |
| `test_detectors.py` | 43 | 43 | unchanged |
| `test_api.py` | 46 | 46 | unchanged |
| `test_core_purity.py` | 34 | 36 | grew with the module count |
| `test_domain_leak.py` | 7 | 7 | unchanged |
| `test_properties.py` | 168 | 168 | unchanged |
| `test_authoring.py` | 25 | 25 | unchanged |
| **Total** | **388** | **525 pass / 0 fail / 0 skip** | |

### The brief's Phase-3 checklist

| Requirement | Test |
|---|---|
| every mutation type round-trips and validates | `TestRoundTrip`, parametrised over all 17 |
| invalid mutations rejected with reasons | `TestStructuralRejections`, `TestSemanticRejections` (11 cases) |
| **base version's hash unchanged after evaluation** | `TestBaseImmutability` (4), `test_evaluating_returns_the_diff_and_proves_the_base_is_intact` |
| non-divisible tasks cannot be split | `test_a_non_divisible_task_cannot_be_split` |
| apply creates a new version leaving the parent intact | `TestApplyIsTheOnlyWrite` (10) |

### Three bugs the round-trip test found

Writing the parametrised round-trip is what exposed all three. Each was a real
defect, not a test artefact:

1. **A single-mutation inverse was wrong.** Undoing a task removal has to
   re-add the task, restore each edge **with its `dep_type` and `consumes`
   flags** (the `predecessors`/`successors` shorthand cannot carry them, and
   losing `consumes` silently turns an artifact dependency into ordering only,
   changing what a requirement change invalidates), drop the bridges the
   removal created, re-attach the assignments, and re-link the requirements the
   task consumed. `inverse()` returns a tuple now.
2. **`REQUIREMENT_VERSION_BUMP`'s inverse bumped again**, landing on version 3
   instead of back on 1, and did not restore the statuses the bump had reset.
   The payload now accepts an explicit `version_no`.
3. **`content_hash()` was order-sensitive on set-like fields.** An identical
   workflow could hash differently after a round trip because `consumed_by`
   came back in a different order. `to_canonical()` sorts them now — which
   matters well beyond round-tripping, since the hash is what version
   comparison and the immutability guarantee rest on.

Two of my own assertions were also wrong and the behaviour right: a uniform
push of a zero-slack task consumes **no** slack (every late date moves with the
project end), and a delay is **not** an effort change so `total_effort_delta`
is correctly 0. Both became two tests each, pinning the contrast.

One real staleness bug: `expire_on_commit=False` meant an
identity-mapped `Scenario` kept the `mutations` collection it was first loaded
with, so an appended mutation was invisible. `get_row` uses
`populate_existing=True`.

## 5 · HOW TO TEST

    .venv/Scripts/python.exe -m pytest -q                                # 525 passed
    .venv/Scripts/python.exe -m pytest backend/tests/test_mutations.py -q
    .venv/Scripts/python.exe -m pytest backend/tests/test_simulation.py -q

    .venv/Scripts/python.exe -m uvicorn backend.app.main:app --port 8001

    # the published algebra
    curl -s localhost:8001/api/scenarios/mutation-kinds

    # demo beat 6: what if Anitha is away next week?
    curl -s -X POST localhost:8001/api/projects/00000000-0000-0000-0000-000000000001/what-if \
      -H 'Content-Type: application/json' -d '{"keep":false,"mutations":[
        {"kind":"RESOURCE_UNAVAILABLE_WINDOW",
         "payload":{"resource_key":"anitha","from_day":14,"to_day":21}}]}'

    # demo beat 8: the refusal
    curl -s -X POST localhost:8001/api/projects/00000000-0000-0000-0000-000000000002/what-if \
      -H 'Content-Type: application/json' -d '{"keep":false,"mutations":[
        {"kind":"TASK_REMOVE","payload":{"key":"M09"}}]}'

Verified output for beat 6: `day 26 -> day 33 (+7 days)`, three tasks shift,
`base_unchanged: true` with the hash identical before and after.

Verified output for beat 8, HTTP 422:

    reason   : M09 is a mandatory task and cannot be removed.
    cited    : MANDATORY_TASK
    on record: UN38.3 safety certification is a legal precondition to shipping.

## 6 · DECISIONS

D-25 … D-30 in `docs/DECISIONS.md`. The two that changed behaviour:

- **D-26 — `TASK_DELAY_ADD` writes `added_delay`, not `effort`.** Without
  this, delaying the fixture's stalled approval did nothing, because its
  observed duration already exceeded the raised estimate.
- **D-25 — `inverse()` returns a tuple.** A single-mutation inverse is not
  expressible for a task removal, and pretending it was produced two silent
  round-trip failures.

## 7 · DEVIATIONS

1. **`TaskSpec.added_delay` and `ResourceSpec.unavailable_windows` are not in
   ARCHITECTURE C's field list.** Both are required by mutations
   ARCHITECTURE D.3 *does* list (`TASK_DELAY_ADD`,
   `RESOURCE_UNAVAILABLE_WINDOW`), so the fields are the storage those
   mutations need rather than new concepts.
2. **`RESOURCE_UNAVAILABLE_WINDOW` also accepts a whole `windows` list**, and
   `TASK_DELAY_ADD` a `total_delay_days`, and `REQUIREMENT_VERSION_BUMP` a
   `version_no`. Each exists so the mutation's inverse is exact. The
   alternative was three more kinds used by nothing but undo, which would
   have made the algebra twenty kinds to save three optional fields.
3. **`TASK_ADD` gained `consumed_requirements` and `added_delay`.** Same
   reason: without them, removing a task severs requirement links that no
   inverse can restore.
4. **`POST /what-if` is not in ARCHITECTURE E's endpoint list.** It is
   create + evaluate + diff in one call, which is what a what-if *panel*
   needs and what restores the prototype's `/simulate/delay`. It writes
   nothing the three separate endpoints would not.
5. **A cyclic or otherwise invalid scenario is still stored** when created
   through `POST /scenarios`, with `status="rejected"` and the reason on the
   row. A rejected proposal the user can read beats a silent failure — and
   Phase 7 needs exactly this for LLM proposals. `POST /what-if` validates
   first and writes nothing, because a throwaway question should not leave a
   row behind.

## 8 · RISKS

1. **`_compare()` calls `evaluate()` twice per simulation.** Correct, and the
   point of the spine, but the Phase 5 optimizer will call `simulate()` once
   per candidate, so that is 2N evaluations. The base evaluation is identical
   across all candidates and should be computed once and passed in. First task
   of Phase 5.
2. **`transitive_redundant_edges` is still O(E × (V+E))** and
   `resource_overallocated` sweeps boundaries per resource. Both run inside
   every `evaluate()`, so they are now inside the optimizer's hot loop too.
   Measure before optimising, but measure early.
3. **The `applied` test fixture had to become class-scoped**, because applying
   moves the project pointer and a per-test fixture tried to remove an edge the
   previous apply had already removed. That is a real property of the system —
   applying is stateful — and any future test that applies must account for it.
4. **`TaskSpec.added_delay` is persisted on the version row.** Applying a
   what-if therefore bakes the delay into the new version's plan, where it will
   read as `added_delay` rather than as effort. That is intended, but it means
   a version's "plan" and its "current expectation" are both in one snapshot
   and only `evaluate()` distinguishes them. If that gets confusing, the fix is
   a separate expectation record, not folding the delay into effort.
5. **`RESOURCE_UNAVAILABLE_WINDOW`'s effect is one pass.** A task pushed by an
   absence into a *second* absence is not pushed again. Documented in the
   payload; a fixed-point loop would be more accurate and is a P1 change.
6. **`deploy-kit/` appeared in the working tree during this phase** (a
   `DEPLOY.md`, a `Dockerfile.backend` and a `dockerignore`). Left untracked
   and unread; it is Phase 9 material and will be reconciled there against the
   Dockerfiles already fixed and verified.
