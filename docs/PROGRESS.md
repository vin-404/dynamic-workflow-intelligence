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

---

# Phase 4 — Capability 2: explainable risk prediction

## 1 · CHANGED

### `core/engine/risk.py` — Layer A

Nine factors, exactly the ARCHITECTURE D.4 list, each normalised to 0–1 where
higher means more exposed:

| Factor | Signal | Tier |
|---|---|---|
| `slack_ratio` | `1 - slack/max(duration,1)` | 0 |
| `downstream_fan_out` | `|descendants| / (|tasks|-1)` | 0 |
| `criticality_proximity` | slack **rank**, so near-zero-but-not-zero reads distinctly from already-critical | 0 |
| `deadline_pressure` | the task's own late finish against the deadline | 0 |
| `resource_pressure` | concurrent demand on the assignee **and its roll-up** during this task's window, versus capacity | 0 |
| `duration_uncertainty` | three-point spread if given, else the stated prior | 0 |
| `predecessor_health` | days since the worst incomplete predecessor moved | 2 |
| `remaining_chain_depth` | unfinished downstream days / project end | 0 |
| `assignment_gap` | 1.0 if unassigned *and* critical, 0.5 if unassigned, 0 if assigned | 0 |

`risk = Σ wᵢ·fᵢ`, weights summing to 1.0 by default so the score is on a 0–1
scale. Every response returns each factor's value, weight, product, reason and
raw evidence, and `RiskWeights` is a request input echoed back.

`_explain()` builds prose from the top three contributors, deterministically,
in the engine. The Narrator may rephrase it in Phase 7; it may not originate
it.

### `core/engine/feasibility.py` — a verdict, a margin, and a range

`three_point_range()` runs the schedule three times, scaling each task's
*observed* duration by its own band, so a task already overrunning keeps its
overrun in all three runs. The `likely` run is literally the headline
projection.

The `monte_carlo` block is the seam and it is **empty on purpose**:

    available: false
    why: needs durations sampled from calibrated distributions
    what_it_would_report: P(deadline) and each task's criticality index
    why_not_faked: an invented percentage is worse than no percentage;
                   it looks like evidence and is not

### API

| Endpoint | What it does |
|---|---|
| `GET /api/projects/{id}/risk` | full decomposition, plus calendar dates for the three-point range |
| `POST /api/projects/{id}/risk` | the same with your own weights, echoed back |

`analyze` also carries the whole risk block, so one call still answers
Capability 1 and 2 together.

## 2 · PRESERVED

Nothing was replaced. `Feasibility` gained `three_point` and its statement now
quotes the range; the verdict and margin fields are unchanged and every
existing assertion on them still holds.

## 3 · REMOVED

| Removed | Why |
|---|---|
| `test_api.py::test_no_probability_language_in_p0_output` | The assertion was wrong: it banned the *word* "probability", which the payload now uses repeatedly and correctly — always to deny one. It was already passing only because `is_probability` was popped as a special case, which does not scale. Replaced by two stronger tests (below). |

## 4 · TESTS

| Suite | Phase 3 | Phase 4 |
|---|---|---|
| `test_risk.py` | — | **47** |
| `test_api.py` | 46 | 47 |
| `test_domain_leak.py` | 7 | 8 |
| everything else | 472 | 476 |
| **Total** | **525** | **578 pass / 0 fail / 0 skip** |

### The brief's Phase-4 checklist

| Requirement | Test |
|---|---|
| factor decomposition sums to the reported score | `test_the_factors_sum_to_the_reported_score`, `test_each_contribution_is_weight_times_value` |
| a tight-slack high-fan-out task outranks an abundant-slack one | `test_tight_slack_and_high_fan_out_outranks_abundant_slack` |
| no probability language in P0 output | `test_p0_never_emits_a_probability` + `test_no_probability_phrasing_in_user_facing_prose` + `TestItIsNotAProbability` (6) |

### The no-probability test, rewritten

Banning the word was the wrong test. The honest payload says "not a
probability" four times, names the flag `is_probability`, and includes a field
called `what_would_make_this_a_probability`. A word-ban either fails on those
denials or gets weakened with per-key exceptions until it proves nothing.

What it asserts instead:

1. every `is_probability` flag is `False`, `monte_carlo.available` is `False`,
   `score_kind` is `structural_estimate`, `monte_carlo_run` is `False`
2. **no numeric field anywhere in the payload is named like a likelihood** —
   the tree is walked, and any key containing `probability`, `likelihood`,
   `confidence`, `odds`, `success_rate` or `p_deadline` must hold a string,
   bool or null, never a number
3. separately, no *sentence a user reads* contains a probability claim
   (`"% chance"`, `"chance of"`, `"confidence level"`, `"likelihood of"`, …)

That catches the actual failure mode — a number presented as a likelihood —
which the word-ban never did.

## 5 · HOW TO TEST

    .venv/Scripts/python.exe -m pytest -q                            # 578 passed
    .venv/Scripts/python.exe -m pytest backend/tests/test_risk.py -q

    # sections 3 and 3b of the CLI are the whole capability, offline
    .venv/Scripts/python.exe -m backend.scripts.demo campus-symposium

    .venv/Scripts/python.exe -m uvicorn backend.app.main:app --port 8001
    curl -s localhost:8001/api/projects/00000000-0000-0000-0000-000000000001/risk
    curl -s -X POST localhost:8001/api/projects/00000000-0000-0000-0000-000000000001/risk \
      -H 'Content-Type: application/json' \
      -d '{"weights":{"downstream_fan_out":0.9,"slack_ratio":0.1}}'

Verified output, campus project: bands `{high: 1, moderate: 8, low: 8}`, T01
top at 0.592 driven by slack ratio (1.00 × 0.20), fan-out (blocks 16 of 16),
criticality proximity and remaining chain depth — the four printed with their
arithmetic. Three-point range day 20 / 26 / 32 with verdicts
feasible / infeasible / infeasible, and the statement reading *"infeasible by
2 days without a change. Running the same schedule at optimistic and
pessimistic task durations gives day 20 to day 32."*

Battery project: bands `{high: 4, moderate: 5, low: 3}`, M05 top at 0.642,
`predecessor_health` reported `available: false` on every task with the reason
`"no status history yet"`.

## 6 · DECISIONS

D-32 … D-36 in `docs/DECISIONS.md`. The two that matter:

- **D-33 — the `likely` run of the three-point range *is* the headline
  projection**, rather than a separately computed "likely" estimate. Otherwise
  the middle of the range is a fourth number that does not match the one on
  screen, and every reader has to ask which is real.
- **D-35 — the no-probability test asserts substance, not vocabulary.**

## 7 · DEVIATIONS

1. **`criticality_proximity` is rank-based.** ARCHITECTURE D.4 describes it as
   "slack rank; near-zero slack that is not yet zero". A pure ratio would
   duplicate `slack_ratio`; a rank distinguishes "third-tightest of seventeen"
   from "already critical", and the reason string says which.
2. **`resource_pressure` also measures the roll-up.** A person with one task
   whose *team* is at capacity is under pressure, and measuring only the person
   would miss the seeded marketing bottleneck entirely.
3. **`RiskWeights` is a frozen dataclass, not a dict on `EngineConfig`.**
   Typed, and it keeps `core/` free of module-level mutable state.
4. **Risk is computed inside `evaluate()`, not on demand.** It is pure
   arithmetic over the schedule that call already produced, so it costs the
   Phase-5 optimizer nothing extra per candidate — and it means `analyze`
   answers Capabilities 1 and 2 in one round trip.
5. **`three_point` lives on `Feasibility`**, not as a sibling field. It is a
   feasibility statement with three runs behind it, and separating them would
   invite a UI that shows the range without the verdict.

## 8 · RISKS

1. **`evaluate()` now does four schedule passes** — baseline, current,
   optimistic, pessimistic — plus a fifth if resource unavailability is
   present. The Phase-5 optimizer calls `evaluate()` per candidate, so that is
   4N passes before the search does anything clever. `three_point_range` should
   become opt-out for optimizer candidates, which is the first thing to measure
   in Phase 5.
2. **The nine weights are mine.** They are exposed, echoed and adjustable,
   which is the mitigation ARCHITECTURE H #5 asks for, but nobody has
   calibrated them against real outcomes and the defaults will look
   authoritative on screen. The UI must show them, not just the score.
3. **`_resource_pressure` walks every task per resource per task** — O(T²·R) in
   the worst case. Fine at 17 tasks; it is the second thing to measure in
   Phase 5.
4. **`criticality_proximity` uses `list.index`** on the sorted slack values,
   which is O(T) per task and gives every task with equal slack the same rank.
   Correct, but it means a workflow where everything has identical slack scores
   every task at 1.0 on that factor.
5. **The band thresholds (0.55 / 0.30) are unexplained numbers.** They are
   labels on a continuum, not claims, and `band` is always accompanied by
   `score`, but a UI that shows only the band inherits an arbitrary cut.

---

# Phase 5 — Capability 4: optimization as generate-and-verify

Implemented with **no LLM**. Phase 7 adds the Proposer as a third candidate
*source*, through `extra_candidates`, subject to the same validation, the same
gates and the same scoring.

## 1 · CHANGED

### `core/optimization.py`

| Piece | What it is |
|---|---|
| 5 generators | `transitive_reduction`, `parallelize_zero_slack`, `drop_soft_ordering`, `resource_levelling`, `resequence_contended` — the ARCHITECTURE D.5 list |
| `gen_drop_bottleneck_tasks` | opt-in via `aggressive=True`; this is "optimize with no limits", and it is what produces the refusal |
| `gate()` | 7 hard constraint gates, run **before** scoring |
| `score_candidate()` | 6 criteria, each decomposed |
| `optimize()` | the bounded search |

### The gates

| Gate | Refuses |
|---|---|
| `MANDATORY_TASK` | removing a task the user declared mandatory |
| `IMMUTABLE_DEPENDENCY` | breaking a protected ordering |
| `NON_DIVISIBLE_TASK` | splitting work that cannot be divided |
| `SKILL_REQUIREMENT` | assigning someone without the skills |
| `FIXED_ASSIGNMENT` | reassigning work whose owner is fixed |
| `MIN_DURATION` | dropping below a contractual floor |
| `TOTAL_EFFORT_CONSERVATION` | reducing total effort with no mutation that explicitly changes it |

Every rejection carries the constraint **and the reason on record**, so the
refusal reads *"UN38.3 safety certification is a legal precondition to
shipping"* rather than *"constraint violated"*.

### The gates are lineage-aware — and that took two attempts

The first version refused `Split T02 across 2 people` with
`IMMUTABLE_DEPENDENCY`, reporting *"this candidate drops T02 -> T03"*. It
does not: a `TASK_SPLIT` replaces `T02` with `T02.1`/`T02.2` and rewires every
predecessor to every part and every part to every successor, so both the work
and the ordering survive — only the endpoint names changed. **A misleading
refusal is worse than none**, so `_lineage()` now tracks which keys carry a
task's work through splits and merges, and:

- a mandatory task may be split (a `NON_DIVISIBLE_TASK` constraint is the
  right tool for "this must stay whole", and `TASK_SPLIT` already honours it)
- an immutable ordering survives a split if every carrier of the predecessor
  still precedes every carrier of the successor, checked by direct edge or by
  reachability
- a `MIN_DURATION` floor applies to the **parts' total** — splitting a task
  with a contractual lead time does not shorten the lead time
- a genuine deletion is still refused, tested explicitly so the leniency
  cannot become a loophole

### Scoring

Six criteria, each with `before`, `after`, `delta`, `improvement` (signed so
positive is always better), `weight`, `contribution`, `unit`, and a sentence.
The blended total is returned **only ever alongside the table**, labelled *"a
ranking aid, not a measurement. The per-criterion table below is the result;
read that."*

### Scope changes are priced in the open

A candidate that changes *how much work there is* rather than how it is
arranged carries `scope_change: true` and its `effort_delta_days`. And
`optimize()` returns **two** recommendations:

- `recommended` — the top scorer under the given weights
- `recommended_same_scope` — the top scorer that preserves the work

"Same work, faster" and "less work, faster" are different offers. Ranking one
above the other is a scope decision, and it is the user's, so both are
returned rather than one being quietly preferred.

### Bounded, and cheap

`max_candidates` plus a caller-supplied `should_stop`. `core/` has no clock —
the time budget is injected the same way `Clock` is, which also makes the
budget test deterministic rather than a race against a real timer.

The base workflow is evaluated **once** and shared across every candidate, so
N candidates cost N+1 evaluations rather than 2N. Asserted by a test that
monkeypatches `evaluate` and counts the calls.

### Persistence and API

| File | What it is |
|---|---|
| `services/optimization.py` | supplies the wall-clock budget; persists each survivor as a real `Scenario` with `origin="heuristic_proposal"` |
| `api/routers/optimize.py` | `POST /optimize`, `GET /optimize/objectives` |

There is **no special apply path**. An optimizer candidate is a `Scenario`, so
`GET /api/scenarios/{id}/diff` and `POST /api/scenarios/{id}/apply` already
work on it — asserted end to end.

## 2 · PRESERVED

Nothing was replaced. `core/simulation._compare()` is reused verbatim for each
candidate's diff, so an optimizer candidate and a hand-written what-if produce
the same comparison payload.

## 3 · REMOVED

Nothing.

## 4 · TESTS

| Suite | Phase 4 | Phase 5 |
|---|---|---|
| `test_optimization.py` | — | **60** |
| everything else | 578 | 580 |
| **Total** | **578** | **640 pass / 0 fail / 0 skip** |

### The brief's Phase-5 checklist

| Requirement | Test |
|---|---|
| transitive reduction never changes project end when the edge is genuinely redundant | `test_removing_redundant_edges_never_moves_the_finish`, parametrised over **both** fixtures |
| a candidate deleting a mandatory task is rejected with the constraint named | `test_a_candidate_deleting_a_mandatory_task_is_rejected`, `test_the_refusal_names_the_constraint_in_the_payload` |
| optimization respects its budget | `test_the_candidate_budget_is_respected`, `test_the_time_budget_is_respected` |
| the recommended candidate genuinely scores best under the given weights | `test_the_recommendation_is_the_top_scorer`, `test_changing_the_weights_changes_the_recommendation` |

Also asserted: a refused candidate is **never scored** (`scores is None`) and
never evaluated; the scorer cannot reach the AI module (AST check on the
imports); the optimizer never mutates the base; two runs are identical.

## 5 · HOW TO TEST

    .venv/Scripts/python.exe -m pytest -q                                  # 640
    .venv/Scripts/python.exe -m pytest backend/tests/test_optimization.py -q

    # section 9 of the CLI is the whole capability, offline
    .venv/Scripts/python.exe -m backend.scripts.demo battery-pilot-line

    .venv/Scripts/python.exe -m uvicorn backend.app.main:app --port 8001
    curl -s localhost:8001/api/projects/00000000-0000-0000-0000-000000000002/optimize/objectives
    curl -s -X POST localhost:8001/api/projects/00000000-0000-0000-0000-000000000002/optimize \
      -H 'Content-Type: application/json' -d '{"aggressive":true}'

Verified CLI output on the battery project: 22 candidates generated, 21
evaluated, 1 refused, and the refusal reading

    Drop M09 entirely
      M09 is a mandatory task and cannot be removed.
      cites MANDATORY_TASK: UN38.3 safety certification is a legal
      precondition to shipping.

with `Recommended: Drop M05 entirely` (labelled `-8d` scope change) and
`Same scope: Split M05 across 2 people` offered beside it, plus the full
six-row criterion table for the winner.

Timing: a full unbounded search over the 17-task fixture completes in ~250 ms,
the 12-task one in ~75 ms.

## 6 · DECISIONS

D-38 … D-43 in `docs/DECISIONS.md`. The three that shaped it:

- **D-39 — the gates follow task lineage.** A split is not a deletion.
- **D-40 — two recommendations, not one.** A scope change must never quietly
  outrank a restructuring.
- **D-41 — the time budget is injected, not read.** Keeps `core/` pure and
  makes the budget test deterministic.

## 7 · DEVIATIONS

1. **`gen_drop_bottleneck_tasks` is an extra generator** beyond the brief's
   five. It exists to make the refusal reachable: an optimizer that never
   proposes the cheat never demonstrates that it will not take it. Opt-in, and
   the default mode generates nothing that cuts scope.
2. **`scope_change` and `recommended_same_scope`** are not in ARCHITECTURE
   D.5's response shape. Added because `TASK_REMOVE` is on the brief's own
   "justified" list for the effort gate, which means a permitted deletion
   would otherwise outrank every restructuring with no visible caveat.
3. **`resequence_contended` usually makes the schedule *longer*.** It is
   proposed anyway, because CPM is resource-blind and this is the only way a
   resource-feasible ordering reaches the table at all. The score decides;
   the rationale says plainly what it costs.
4. **The optimizer persists candidates by default.** Not specified either way.
   It is what lets the UI diff or apply one without re-running the search, and
   `persist_candidates: false` turns it off.

## 8 · RISKS

1. **The optimizer writes a lot of `Scenario` rows.** A 20-candidate run
   creates 20 scenarios, and nothing prunes them. Fine for a demo; a real
   deployment wants either a TTL or `persist_candidates: false` by default
   with an explicit "keep this one".
2. **`test_optimization.py` takes ~40 s** because several API tests run a full
   search. That is over half the suite's runtime. If it grows, the API tests
   should share one module-scoped optimize call.
3. **The six objective weights are mine**, exactly as the risk weights are.
   Exposed, echoed and adjustable — but a UI that shows only the total inherits
   my priorities silently. It must render the table.
4. **`_improvement` normalises by `max(|before|, 1)`**, so a criterion whose
   base value is near zero saturates immediately: going from 0 to 1 overloaded
   resource scores the same as 0 to 5. Acceptable at this scale, wrong in
   general.
5. **Local search is not implemented.** ARCHITECTURE D.5 mentions combining
   and perturbing candidates within the budget; this generates a flat pool and
   ranks it. Combining the top candidates pairwise is the obvious next step and
   the budget machinery already supports it.
6. **`gen_resource_levelling` proposes moves to *any* less-loaded resource
   with a matching skill**, including ones on other teams, which can produce
   organisationally odd suggestions. The `FIXED_ASSIGNMENT` constraint is the
   user's tool against that, but nothing in the seed data uses it.

---

# Phase 6 — Frontend: the authoring experience first

## 1 · CHANGED

### Built first, because nothing else mattered until it existed

The repo had **no way to author a workflow**. Every component was a read-only
view over a hardcoded seeded project.

| Component | What it does |
|---|---|
| `SetupPanel.ProjectCreate` | name, goal, dates, and a domain you pick **or define on the spot** |
| `WorkflowBuilder` | resources, tasks, dependencies — the whole graph, editable |
| `SetupPanel.MemberList` | add/remove collaborators, roles advisory |

`WorkflowBuilder` is three panels:

- **Who and what does the work** — person / team / equipment / budget, each
  with a capacity and an optional roll-up parent. The copy says plainly that a
  team's capacity can be lower than its headcount, because that gap is how a
  bottleneck gets found.
- **The work** — a table with inline editing of name, effort, divisibility,
  status and assignees. Constraint badges (`mandatory`, `indivisible`) appear
  on the tasks that carry them, and the divisibility control is disabled where
  a constraint fixes it.
- **What waits on what** — dependency list and editor, distinguishing
  `artifact` edges (which carry requirement invalidation) from `ordering`
  ones, with protected edges shown as `locked` instead of deletable.

Every rejection renders the backend's own reason. A cycle shows the cycle; a
constraint violation shows the constraint **and the reason on record**.

### Then the analysis surfaces

| Component | The commitment it carries |
|---|---|
| `FindingsPanel` | groups by root cause; every finding shows tier, evidence, and impact as `magnitude × (1 + downstream)` with the worked arithmetic; suppressed findings are shown *with the reason they were suppressed* |
| `RiskPanel` | every task expands to nine factors as `value × weight = contribution` with a sentence each; labelled a structural estimate; weights editable on screen |
| `WhatIfPanel` + `DiffView` | typed mutations, full before/after diff, and the base version's content hash **before and after** evaluation |
| `OptimizePanel` | per-criterion table, weights, refused candidates with cited constraints, and both recommendations |
| `VersionHistory` | every version with hash, parent and provenance; accuracy lives here |
| `ui.tsx` | shared primitives, including `TierBanner` and `Assumptions` — the two that carry product commitments rather than styling |

### Demoted and removed

`DashboardView`, `GanttChart`, `DemoWalkthrough`, `TasksView`, `WhyLateView`,
`BottleneckInbox`, `SimulationPanel`, `AccuracyPanel`, `Header`, `TabNav`,
`Card`. That is the dashboard drift being corrected. There is **no dashboard
home page**: the landing surface is the list of workflows and a button to make
one, and the analysis stages are disabled until a workflow exists.

`DependencyGraph` is kept and de-domained. It coloured nodes from a hardcoded
`{ORG, FIN, FAC, MKT, SPON}` palette — the frontend's domain leak. Colour now
means **slack**, which is true of every workflow in every domain, and the
resource is rendered as text from the data.

### The journey

`page.tsx` is a six-stage shell in the order a person actually works:
build → bottlenecks → predicted risk → what if → better workflows → history.

## 2 · PRESERVED

| Kept | Where |
|---|---|
| dagre + xyflow graph layout | `DependencyGraph`, same libraries, new colouring |
| the accuracy harness view | `VersionHistory`, reachable but off the landing surface (as the brief requires) |
| the dark theme tokens | `globals.css`, untouched |
| the API rewrite proxy | `next.config.ts`, plus a `turbopack.root` fix so the build stops reading a lockfile from the user's home directory |

## 3 · REMOVED

All eleven components above, plus the prototype's `api.ts` types
(`ProjectState`, `TaskRow` with `department`/`owner`, `DelayResult`,
`AccuracyResult`). Every one carried the old contract; the new client is typed
against the current API and has no domain vocabulary in it.

## 4 · TESTS

Verified **in a real browser**, twice, as the brief requires — driven with
Playwright against the running stack.

| Walkthrough | Checks | Result |
|---|---|---|
| Seeded domains (`journey.mjs`) — every stage over *both* fixtures, the what-if diff, the refusal | 27 | all pass |
| Cold start (`coldstart.mjs`) — define a domain, build 4 tasks and 3 dependencies from empty, get a cycle refused, then analyse / risk / what-if / optimize | 20 | all pass |

Backend suite unchanged: **640 passed**. Frontend `tsc --noEmit` clean and
`next build` succeeds.

### Two real bugs the browser found

Both were invisible from the API and from unit tests:

1. **A refresh lost your workflow.** There was no routing state at all, so
   reloading dropped you back to the project list. The open project and stage
   now live in the URL hash — which also makes links deep-link, and is a
   prerequisite for Phase 9's "two browsers open the same project".
   Subtlety: the hash-sync effect fired on mount with `project === null` and
   *wiped the hash it was about to read*, so the sync is gated on the initial
   restore completing.
2. **Two buttons were both labelled "Add"** — ambiguous for anyone navigating
   by accessible name. Now "Add resource" and "Add member".

Four other failures during the walkthrough were **harness** defects, not
product ones, and are recorded here so the distinction is not lost: task names
render in `<input value>` which `getByText` cannot see; `select` elements
indexed off the whole page shift as rows are added; the dependency count was
read mid-update. Each was confirmed against the API before being dismissed —
the workflow genuinely had all four tasks and all three edges.

## 5 · HOW TO TEST

    # backend
    .venv/Scripts/python.exe -m uvicorn backend.app.main:app --port 8001
    # frontend
    cd frontend && npm run dev
    # then open http://localhost:3000

What to try, in order:

1. **New workflow** → pick "+ define my own…" → name a domain that does not
   exist. Create it. You land on an empty builder that tells you what to do.
2. Add a resource, then four tasks, then dependencies. Try drawing a cycle:
   it is refused *with the cycle drawn out*.
3. **Bottlenecks** — note the evidence tier and "what this analysis cannot
   assess yet", which is populated from the detector registry.
4. **Predicted risk** — expand a task to see nine factors with their
   arithmetic. Change a weight and re-rank.
5. **What if** — "Someone is unavailable", pick a person, simulate. Scroll to
   the bottom: the base version's hash, before and after.
6. **Better workflows** — tick "No limits" on the battery project. It refuses
   to delete the safety certification and quotes UN38.3.
7. Refresh at any point: you stay where you were.

## 6 · DECISIONS

D-44 … D-48 in `docs/DECISIONS.md`.

## 7 · DEVIATIONS

1. **The what-if panel offers five phrased questions rather than a raw
   mutation editor.** The algebra is published at
   `GET /api/scenarios/mutation-kinds` and the panel shows each queued change's
   `kind` as a badge, so nothing is hidden — but "A task slips" is a question a
   delivery lead asks and `TASK_DELAY_ADD` is not.
2. **URL hash rather than real routes.** Smaller and reversible; a proper
   `/projects/[id]` route is a later change if it earns one.
3. **No test runner for the frontend.** The verification is the two Playwright
   walkthroughs, which is what the brief asked for ("complete the full journey
   in a browser for both seed domains"). Component-level tests would be a
   second, weaker check of the same thing.

## 8 · RISKS

1. **The Playwright walkthroughs live in the scratch directory, not the repo.**
   They are verification I ran, not a suite anyone can re-run from a clean
   checkout. If the frontend is going to keep working, they belong in
   `frontend/e2e/` with a script entry — a Phase 9 candidate.
2. **Everything is one client component.** `page.tsx` fetches in the browser
   and holds all the state. Fine at this size; it will not survive many more
   stages without splitting.
3. **No optimistic updates.** Every edit round-trips and re-renders the whole
   workflow, which is why the harness kept reading mid-update. It is correct
   but it will feel slow on a large workflow.
4. **`RiskPanel`'s re-rank merges the risk block into the existing analysis
   object**, so the weights change the ranking but not the findings around it.
   Correct today because findings do not depend on risk weights — a trap if
   that ever changes.
5. **No loading skeletons on stage switches**, only a spinner. Acceptable, but
   the optimize stage can take a couple of seconds and shows nothing but
   "Generating, gating and scoring candidates…".

---

# Phase 7 — The AI service boundary

The model is a **boundary**, not a brain. Three narrow roles, three schemas,
three fallbacks — and two invariants that are structural rather than
promised: it cannot write, and it cannot state a number.

## 1 · CHANGED

### `backend/app/ai/` — a new package that imports no database

| Module | Role |
|---|---|
| `provider.py` | `AIProvider` protocol, `NullProvider` (the default), `AnthropicProvider`, `AIRequest`/`AIResponse`, `get_provider()` |
| `schemas.py` | Pydantic output models + the JSON schemas sent to the model. `MutationOut.kind` validates against the closed algebra, so an invented mutation kind never leaves this module |
| `projection.py` | The compact workflow projection. Keys not names, findings capped, tasks capped. The **only** place a domain leaves the database for a prompt |
| `runner.py` | Call → validate → **one** repair → reject. Plus `ResponseCache` keyed by prompt hash, and `Interaction` (the audit record) |
| `interpreter.py` | Natural language → typed mutations, or a refusal |
| `proposer.py` | Restructuring candidates for the Phase-5 search |
| `narrator.py` | Rephrases an engine result, and `verify_numbers()` |

Nothing under `ai/` imports SQLAlchemy, a model, a service, a router or the
app. That is not a convention — a test parses every module in the package and
fails on the import.

### The three roles, and what each does with no model

| Role | With a model | With `NullProvider` |
|---|---|---|
| Interpreter | Structured output → typed mutations | A **labelled** pattern matcher over the same shapes the what-if form offers. Refuses rather than guesses |
| Proposer | Up to four restructuring candidates | Nothing, and says so. The six deterministic generators are the primary source either way |
| Narrator | Rephrases the engine's result | The engine's own templated wording |

### `backend/app/services/ai_service.py` — where `ai/` meets the database

The one direction allowed. An interpretation becomes a **pending scenario** —
the same row a hand-written what-if creates. Every interaction is logged as an
`AIInteraction` row: role, provider, prompt hash, schema, valid, repaired,
cached, rejection reason. That log is the evidence the model never had
authority.

### Endpoints

| Endpoint | Does |
|---|---|
| `GET /api/ai/status` | provider, availability, what each role degrades to, the mechanism behind each capability, the guarantees |
| `POST /api/projects/{id}/interpret` | a sentence → a **pending** scenario. Never applies |
| `POST /api/projects/{id}/explain` | rephrases the current analysis. Presentation only |

`POST /optimize` gained `use_llm` (default true) and an `llm_proposals` block
saying what the Proposer contributed. There is deliberately **no**
`POST /apply-what-the-model-said`: applying goes through
`POST /api/scenarios/{id}/apply`, which is the single write path.

### Frontend

- **`AskPanel`** on the what-if stage. Type a sentence, see the **typed
  mutations it produced** before anything runs, a badge saying whether a model
  or the pattern matcher read it, a badge saying "nothing applied", and — when
  the workflow refuses it — the constraint and the reason on record. The
  simulate button evaluates the pending scenario into the existing diff view.
- **`Explainer`** on the analysis stage. "Say this in plain language", labelled
  `rephrased by model` or `engine wording`. If a model narration was discarded
  for inventing a number, **the panel says so** — that is the guarantee
  working, not an error to hide.

## 2 · PRESERVED

`core/` is untouched by this phase: no import, no call, no new argument. The
engine does not know the AI layer exists. Every Phase 1–6 endpoint behaves
identically with the model absent, which is the default.

`anthropic==1.4.0` is now pinned in `requirements.txt`, but the import is lazy
and the application starts, and the whole suite passes, without it.

## 3 · REMOVED

Nothing. This phase is additive.

## 4 · TESTS

**723 passing, up from 640.** `backend/tests/test_ai_boundary.py` adds 85.

The two invariants, tested structurally:

- **No write path.** Every module under `ai/` is parsed; an import of
  `sqlalchemy`, `aiosqlite`, `backend.app.db`, `.models`, `.services`, `.api`,
  `.seed` or `.main` fails the test, as does a call to `.commit()`,
  `.flush()`, `.execute()` or `.apply_scenario()`. End to end: interpreting
  leaves the project's `content_hash` byte-identical.
- **Never the authority for a number.** `verify_numbers` directly, and end to
  end — a narration claiming "87% likely to slip" is discarded and the
  engine's own wording is returned with the reason.

Named in the brief, and present:

- Contract tests against **recorded responses**, never a live API. The
  `AnthropicProvider` tests stub the SDK client and check the request against
  the installed SDK's own parameter types (`MessageCreateParamsBase`,
  `OutputConfigParam`) and the response against a real `anthropic.types.
  Message`. Structured output, adaptive thinking, no prefill, refusal
  handling, and the 4xx-rejects / 5xx-falls-back split are each asserted.
- Malformed output **repaired once, then rejected** — with the provider call
  count asserted at exactly 2, so "one repair" cannot quietly become a retry
  loop.
- An LLM proposal that violates a constraint is **rejected with the constraint
  cited**: the recorded proposal deletes `M09`, and the optimizer returns it
  refused with `MANDATORY_TASK` and the UN38.3 reason, unscored.
- The **full P0 feature set under `NullProvider`** — all four capabilities
  walked end to end over HTTP, plus the refusal beat.

### Run it

```bash
.venv/Scripts/python.exe -m pytest backend/tests -q
.venv/Scripts/python.exe -m pytest backend/tests/test_ai_boundary.py -q
```

### Verified in a browser

13 checks over the two new surfaces, no console errors: the narration is
labelled as engine wording; the sentence "Anitha is unavailable from day 14 to
day 21" shows `RESOURCE_UNAVAILABLE_WINDOW {"resource_key":"anitha",...}` and
"nothing applied" before anything runs; simulating it moves the finish to day
33 against an unchanged base; "make the coffee" comes back not understood.

## 5 · DECISIONS

D-49 … D-56 in `docs/DECISIONS.md`.

## 6 · DEVIATIONS

None from the brief. One judgement call worth naming: the brief says the
Interpreter "refuses rather than guesses" with no model, and a pure refusal
would have been simpler than the pattern matcher. The matcher is **labelled**
in the API (`method: "deterministic_patterns"`) and in the UI ("matched by
pattern (no model configured)"), and refuses anything it does not recognise —
so it adds capability without adding a claim.

## 7 · BUGS FOUND AND FIXED

Three the tests caught, all pre-existing in the Phase 7 source before it was
covered:

1. **`verify_numbers` crashed on every dict payload.** `out |= _numbers_in(...)`
   inside a nested function made `out` a local, so the number check raised
   `UnboundLocalError` — meaning the guarantee it enforces would have
   fallen back silently. Fixed to `out.update(...)`.
2. **A task key licensed its own digits.** `T03` in the payload made the
   number 3 "available", so a narration claiming "3 days" would have passed.
   The numeric token regex now requires the number not be glued to letters, on
   both sides — so `T03` is an identifier on the payload side and on the
   narration side.
3. **The projection could be talked back to full size.** 300 isolated tasks
   produce 300 findings that between them name every task, and each one pulled
   its tasks back into the "worth sending" set. Now capped: the 12 top findings
   contribute at most 5 tasks each, and a hard `MAX_TASKS_SENT` ceiling keeps
   the critical path whole and fills the rest by tightest slack.

Plus one cosmetic fix found in the browser: the interpreter built its intent
sentence from the resource **key**, so it read "anitha is unavailable" — a
person's name in lower case. Intents now read back the display name while the
mutation still carries the key.

## 8 · RISKS

1. **The `AnthropicProvider` has never made a real call.** Every test is
   against a stub or a recorded response, because CI has no key and the brief
   forbids a live API in tests. The request shape is checked against the
   installed SDK's own types, which is the strongest guarantee available
   offline — but the first live call is still a first.
2. **The pattern matcher is a demo crutch.** It handles four shapes. A user
   with a key gets a real interpreter; a user without one gets something that
   looks like one until it does not. It is labelled everywhere, which is the
   mitigation, not a fix.
3. **The response cache is process-wide and never evicted.** Fine for one
   process and a demo; it is a slow leak in a long-running server.
4. **The Proposer is untested against a real model.** Its prompt forbids
   stating numbers and the schema constrains its mutations, but whether it
   proposes anything *useful* is unknown until it runs live. The design
   degrades safely: a bad proposal is gated and scored like any other, and
   loses.
5. **`AIInteraction` rows accumulate with no retention policy.**
