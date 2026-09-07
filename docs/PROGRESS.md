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
