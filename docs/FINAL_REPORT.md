# Final report

What this is now, what it can and cannot do, what was deleted, what was
decided, and what I would look at first if I were reviewing it.

All eleven phases are complete, committed and tagged (`phase-0-plan` through `phase-11-complete`). Phase 10 added Google sign-in, enforced roles and the shadcn design system; Phase 11 closed the three clauses of the problem statement that were still outstanding - *in real time*, *tracks* rather than plans, and *changing requirements* as a first-class capability - and turned a refusal to state a probability into a stated, uncalibrated one.

---

## 1 · What you should look at first

In this order. It takes about twenty minutes.

1. **`backend/app/core/workflow.py`** — the immutable snapshot. Read the field
   list and notice what is *not* there: no domain, no department, no owner
   string. The domain is not ignored by the engine; it is absent from it.
2. **`backend/app/core/engine/evaluate.py`** — one pure function. Schedule,
   findings, risk, feasibility, and an explicit statement of what it could not
   assess. No I/O, no clock read, no database.
3. **`backend/tests/test_core_purity.py`** and **`test_domain_leak.py`** — the
   two tests that make the above claims structural instead of aspirational.
   They parse the source and fail on a forbidden import or an `if domain ==`.
4. **`backend/app/core/mutations.py`** — the closed algebra. Seventeen kinds,
   each with a schema, a semantic validator, an applier and an inverse. The
   inverse is what makes "the base is unchanged" checkable rather than
   promised.
5. **`backend/tests/test_ai_boundary.py`** — the two invariants that keep the
   model honest, tested by parsing the AI package and by asserting on narrated
   prose.
6. **`backend/scripts/demo_check.py`** — every claim the demo makes out loud,
   as an assertion. Run it.
7. **`backend/tests/test_hardening.py`** — what happens when things go wrong:
   a refusal keeping its structure through the error envelope, readiness
   failing while liveness passes, the optimizer returning partial results
   when it runs out of budget.
8. **`backend/app/core/engine/montecarlo.py`** — the forecast, and its
   `assumptions` block. Read the block before the numbers: it is the clearest
   single example of what this codebase means by honesty. It states the
   distribution family and why, the spread's provenance per task, the seed,
   that resource contention is not simulated, and that independent sampling is
   optimistic — for a number it could simply have printed.
9. **`backend/app/services/replay.py`** — every frame is one `evaluate()` call
   over the same immutable snapshot. There is no simulation in it, and no
   database write path at all: grep it for `.commit()` and the only hits are
   Python sets.
10. **`backend/app/services/requirements.py`**, `_assumptions()` — the sentence
    that leads it says the report computes a blast radius from the dependency
    graph and does not read the two texts, so whether the wording really
    invalidates the work is the user's call. That is the most important
    sentence in the feature.

Then run the demo: `docs/HOW_TO_DEMO.md`. To deploy it: `docs/DEPLOY.md`.

---

## 2 · What the four capabilities can and cannot do

### Capability 1 — detect current bottlenecks, explainably

**Can.** Fifteen detectors across four evidence tiers. Ten are structural and
run on a workflow with no history at all. Every finding names a **root cause**
rather than a symptom, carries the evidence it reasoned from, an impact number
with the formula worked out beside it, a suggested action and a plain-language
explanation. Findings are ranked by impact, and a finding that is a
consequence of another is suppressed with a stated reason rather than
duplicated.

Crucially, the analysis also reports what it **could not** assess and what
would unlock each locked check. Tier is reached from the evidence present, not
from configuration.

**Cannot.** It does not solve RCPSP. CPM is resource-blind: the schedule is
computed without resource constraints and overload is reported separately,
deliberately, rather than pretending to a resource-feasible schedule. It has
no notion of partial completion — a task is not-started, in-progress, blocked
or done. It cannot detect anything that requires cross-project evidence
(Tier 3): those checks exist in the registry, report themselves unavailable,
and say what would unlock them.

### Capability 2 — predict future bottlenecks, explainably

**Can.** Nine weighted factors per task, each with its value, its weight, its
contribution, the raw evidence behind its normalisation, and a sentence
explaining why it reads the way it does. The score is exactly the sum of the
contributions — the arithmetic on screen adds up (D-58). Weights are inputs:
change them and the ranking changes, and the response echoes the weights it
used. A three-point feasibility range comes from running the same schedule at
optimistic, likely and pessimistic durations.

A factor that cannot be measured reports `available: false`, contributes
zero, and is listed in the assumptions with what would unlock it. It is never
imputed and never silently dropped.

**Can, since Phase 11: state an actual probability.** A seeded Monte Carlo
samples the three-point estimates tasks already carried — Beta-PERT fitted
exactly to the three points (D-130) — and returns P50/P80/P90 completion dates,
the probability of meeting the deadline, a completion histogram, and for every
task its **criticality index**: the fraction of iterations in which it lay on
the critical path. That last one is the rigorous form of "at risk of becoming a
bottleneck", and it is the number the feature exists for. 5,000 iterations over
a 40-task workflow in **0.267s**, seeded, so a figure on screen is
reproducible.

**Cannot.** **The structural score is still not a probability, and its payload
still says so four times** — those four statements are byte-identical to what
they said before Phase 11, and all 50 tests asserting them pass unmodified.
Adding a real number licensed stating new assumptions, not deleting old
caveats.

And the new number is **uncalibrated, and says so**. Nothing in this system has
ever compared a forecast against what actually happened. It samples durations
**independently**, which is optimistic because real delays correlate — the week
the supplier is late is the week the reviewer is on leave — so the true spread
is wider than reported and P80/P90 are nearer than they look. Resource
contention is not simulated at all. Beta-PERT is bounded above by the
pessimistic estimate, so no simulated run can exceed the worst case anyone
wrote down. All four of those are in the payload, in plain language, not in a
comment. When there is nothing to sample the structural estimate is returned
instead and the response says which of the two it is answering with — reading a
band from one against a number from the other is a category error the payload
names explicitly. Band labels remain cut points on a continuum and are never
shown without the number.

### Capability 3 — simulate hypotheticals without touching the real workflow

**Can.** A closed algebra of seventeen typed mutations. Every one has a payload
schema, a semantic validator, an applier and an inverse that round-trips —
which is property-tested. A scenario is validated before anything is written;
where it is refused, the refusal carries the constraint and the human-written
reason for it. Simulation returns a full before/after comparison, the tasks
that moved, and the base version's content hash before and after so the "your
workflow is untouched" claim is one the user can read off the screen.

Natural language is an *entry point* to this, not a parallel path: a sentence
becomes typed mutations that are shown to the user before anything runs.

**Cannot.** The algebra is closed on purpose, so anything outside those
seventeen kinds cannot be expressed — you cannot simulate "restructure the
whole thing". Mutations compose in sequence, not in parallel branches. There
is no scenario-of-a-scenario: every scenario is relative to a real version.

### Capability 4 — propose and evaluate better workflows

**Can.** Generate-and-verify. Six deterministic generators (plus the LLM
Proposer when a model is configured) produce candidates; seven hard constraint
gates run **before** any scoring; survivors are scored on six decomposed
criteria with weights on screen. The search is bounded by both a candidate
count and an injected wall-clock budget, and the response says whether it
stopped early and why. Every surviving candidate is a real scenario you can
diff, edit or apply through endpoints that already existed — there is no
special apply path.

It returns **two** recommendations: the best candidate, and the best candidate
that does not change scope, so "do less work" is presented as a scope decision
rather than an engineering result.

**Cannot.** It is a local search over generated restructurings, not an optimal
scheduler. It will not find a rearrangement no generator proposes. It respects
effort conservation, so it cannot make work smaller — only differently
arranged. And it refuses to buy the date by deleting mandatory work, which is
a capability rather than a limitation, but it does mean the "optimal" answer it
gives you is optimal *within your constraints*.

---

### The three clauses Phase 11 closed

The problem statement asks for a platform that tracks cross-department
workflows, responsibilities and dependencies **while detecting bottlenecks,
delays and changing requirements in real time**. Three clauses in that sentence
were not honestly delivered before Phase 11.

**"In real time."** *Can.* A replay engine walks a project's append-only event
log forward in accelerated simulated time and streams it over Server-Sent
Events. Findings appear and clear on their own at the correct simulated day —
not because anything simulates them, but because `Clock` was already an
argument to the pure engine, so a check that fires after three idle days fires
on the day it would have. Every frame is one full `evaluate()` call over the
same immutable snapshot. Pausable, seekable, restartable, many viewers on one
replay, and it writes nothing: no event row, no version, not even an
`AnalysisRun`. The stored content hash is asserted identical before and after.

*Cannot.* A replay lives in the process that started it, so **the backend must
run as a single process** (D-143) — with more than one worker, the stream and
the replay can land on different ones and the live screen silently never
starts. This is not a live feed from a real system either: it replays a log
that already exists. The GitHub webhook is what lets that log grow on its own.

**"Tracks."** *Can.* A real Jira issue export imports with its dependencies
intact — including the repeated same-named link columns that `csv.DictReader`
silently collapses, where every count still looks right while most of the graph
is gone. Preview then commit, never into a live workflow. Every inference is
visible per row before anything is created, every unmappable row is reported
with its reason, and a cycle is refused at preview with the path named. A
signature-verified GitHub webhook appends transitions to the event log; with no
secret configured it refuses rather than accepting unsigned writes.

*Cannot.* No Jira API client, no OAuth, no polling sync — the import is a file
and a webhook. Imported edges all carry `consumes=false`, because a tracker's
"blocks" link says nothing about artifact consumption; the consequence is that
an imported project **under-reports its requirement-change blast radius** until
someone marks the consuming edges by hand. That is stated in the payload and it
is the sharpest remaining seam between two features that are each correct
alone.

**"Changing requirements."** *Can.* A first-class capability rather than one of
seventeen mutation kinds. Asking what a re-wording would cost returns work that
must be **redone** (it consumed something now wrong) separately from work that
must merely be **rechecked**, with the consuming path that put each task in its
list; the days of completed work invalidated, with the arithmetic on the row;
who needs to know, grouped by owner; the findings created and cleared; and a
ready-to-apply replan that is a real scenario the existing evaluate / diff /
apply endpoints accept unchanged. No eighteenth mutation kind was added.
Requirement versions are first class, with history and diffs.

*Cannot.* **It does not read your two sentences and decide whether the meaning
changed.** It computes a blast radius from the dependency graph *assuming* the
meaning moved materially, and the report says so before it says anything else.
Two different wordings of the same requirement therefore cost exactly the same,
and comparing them returns an explicit tie rather than an invented difference —
a comparison becomes real only when the options declare which consumers each
one spares. And the **projected finish usually does not move**, which is not
the change being free: the scheduler is status-blind, so completed work already
occupies its span and re-opening it cannot lengthen the critical path. Rather
than build a second scheduler to make a demo line come true, the report states
the limit, names what would lift it, and the screen leads with the effort cost
instead.

---

## 3 · Every deliberate deletion

| Deleted | Phase | Why |
|---|---|---|
| root `scenario.py` | 1 | Prototype scratch file superseded by `core/mutations.py`. |
| root `api.py` | 1 | Superseded by `backend/app/main.py` and the router package. |
| root `index.html` | 1 | Single-file prototype UI, superseded by the Next.js app. |
| root `engine.py` | 1 | **Moved, not rewritten** (D-08) into `backend/app/core/engine/`. Every behaviour it had is still tested. |
| root `demo.py` | 1 | Kept, moved to `backend/scripts/demo.py` as a dev CLI. |
| `backend/app/core/config.py`, `core/database.py` | 1 | Moved out of `core/`, which may not import a web framework, an ORM or a settings library (D-02). |
| `accuracy.precision_vs_planted` | 2 | Measured a number that could not be wrong: it compared planted findings against themselves. Replaced by fully labelled fixtures and separate `recall` / `precision` / `planted_recall` (D-18). |
| edge attribute `kind: str` | 1 | Replaced by `consumes: bool` + `dep_type`, because the prototype's `{artifact, temporal}` string was a domain-flavoured stand-in for one boolean (D-11). |
| `DashboardView`, `GanttChart`, `AccuracyPanel`, `DemoWalkthrough`, `TasksView`, `WhyLateView`, `BottleneckInbox`, `SimulationPanel`, `Header`, `TabNav`, `Card` | 6 | Dashboard drift. The brief asks for a workflow-centric product, not an analytics surface. The accuracy view was rebuilt inside `VersionHistory`, where it belongs (D-45). |
| The hardcoded `{ORG, FIN, FAC, MKT, SPON}` node palette | 6 | The domain leak in the frontend — it would have shown grey for every node in any other domain. Nodes are coloured by slack, which is true of every workflow (D-46). |

Nothing else was deleted. `backend/alembic/` is inert but retained (D-03).
`docs/ARCHITECTURE.md` was never modified except by appending.

---

## 4 · Test inventory

**1,054 passing, 0 failing, 0 skipped**, in about 34 seconds. 780 at the end of Phase 9, 819 after Phase 10's auth work, 1,054 after Phase 11 — and **not one existing test was edited to get there**, which is the number that actually matters. Every caveat the suite pinned before still holds.

| File | Tests | Covers |
|---|---:|---|
| `test_properties.py` | 168 | Property tests: mutation inverse round-trips, content-hash order independence, schedule invariants, effort conservation |
| `test_ingest.py` | 91 | Jira CSV with repeated link columns, every rejected row reported, cycles refused at preview, the signed GitHub webhook, commit parity with a hand-made project |
| `test_montecarlo.py` | 55 | Seed reproducibility, criticality index at 1.0 and 0.0, P50 ≤ P80 ≤ P90, widening a spread, the assumptions block, the fully-assumed fallback |
| `test_requirements.py` | 55 | Wasted-effort arithmetic, the no-impact answer, the report mutating nothing, revision history and diffs, comparing wordings, the guarded apply |
| `test_auth.py` | 39 | The header pair, role enforcement across the matrix, and two tests that walk every route and fail on an unguarded write |
| `test_stream.py` | 32 | Findings appearing and clearing at the right simulated day, the base hash unchanged, disconnect leaking no task, pause/seek/restart, concurrent viewers |
| `test_ai_boundary.py` | 85 | The two AI invariants, structured output discipline, SDK contract against recorded responses, every capability under `NullProvider` |
| `test_mutations.py` | 80 | The closed algebra: schemas, semantic validation, appliers, inverses, rejections |
| `test_engine.py` | 64 | The migrated engine's behaviour, preserved from the prototype |
| `test_optimization.py` | 60 | Generators, the seven gates, scoring, budgets, the two recommendations |
| `test_detectors.py` | 54 | Each detector against a workflow that should trigger it and one that should not; precision and recall across both domains |
| `test_simulation.py` | 53 | Scenarios, diffs, apply-is-the-only-write |
| `test_risk.py` | 50 | The nine factors, the additive model, unavailability, the not-a-probability contract, display arithmetic |
| `test_api.py` | 47 | Every endpoint, end to end, over HTTP |
| `test_hardening.py` | 42 | Structured errors, liveness vs readiness, bounded work, the name picker, identity driving ownership, the guarded reset, seed idempotency |
| `test_core_purity.py` | 44 | `core/` imports no framework, no ORM, no AI client, does no I/O, holds no mutable module state |
| `test_authoring.py` | 25 | Creating and editing workflows, versions, sealing |
| `test_domain_leak.py` | 8 | No domain field in the analysis payload; no `if domain ==` anywhere in `core/` |

Plus, outside pytest:

| Check | Result |
|---|---|
| `backend/scripts/demo_check.py` (model disabled) | All beats passed, from a clean database and again on a used one |
| `backend/scripts/demo_check.py --provider recorded` (model enabled) | All beats passed, twice |
| Playwright journey — seeded project, all six stages | 27 checks, no console errors |
| Playwright journey — cold start in a user-defined domain | 20 checks, no console errors |
| Playwright — the AI surfaces | 13 checks, no console errors |
| Playwright — the Phase 9 surfaces | 17 checks, no console errors |
| `scripts/smoke.sh` — image built from scratch, SQLite | Passed, 30s including the build |
| `scripts/smoke.sh` — same image, **Postgres, empty database** | Passed, 6s |
| `scripts/smoke.ps1` — the PowerShell twin | Passed |
| Full suite against real Postgres | 780 passed |
| Container restarted twice against a populated Postgres | No duplicate rows |

### Run it

```bash
.venv/Scripts/python.exe -m pytest backend/tests -q
.venv/Scripts/python.exe -m backend.scripts.reset_db
.venv/Scripts/python.exe -m backend.scripts.demo_check
.venv/Scripts/python.exe -m backend.scripts.demo_check --provider recorded
.venv/Scripts/python.exe -m backend.scripts.perf
bash scripts/smoke.sh                    # or .\scripts\smoke.ps1
cd frontend && npm run e2e:all
```

### Measured

Warm, over HTTP, SQLite, median of twelve runs:

| Endpoint | Median | Floor in the brief |
|---|---:|---|
| `analyze` (17 tasks) | **23.9ms** | under 1s |
| `simulate` (1 mutation, full diff) | 38.4ms | — |
| `optimize` (40 candidates, persisted) | 706.5ms | respect the budget |

The optimizer returns **partial ranked results** rather than failing when it
runs out of time: 11 ranked candidates in 136ms against a 0.1s budget.
Nothing is cached to make any of these look better.

---

## 5 · Every decision

The reasoning for each is in `docs/DECISIONS.md`. This is the index.

**Phase 0 — inspect and plan**

- **D-01** Keep the existing `./.venv` rather than pinning `requirements.txt` exactly.
- **D-02** Move `core/config.py` → `app/settings.py`, `core/database.py` → `app/db.py`.
- **D-03** Leave `alembic/` inert; `create_all` plus a reset-and-seed command.
- **D-04** Stay on SQLite.
- **D-05** Purity enforced by AST source inspection, not import-time patching.
- **D-06** Fix the non-hermetic test harness first, in its own commit.
- **D-07** Migrate the fixture as `effort == planned_duration`, one assignee per task.
- **D-08** Delete root `scenario.py` / `api.py` / `index.html`; keep `demo.py` as a dev CLI.
- **D-09** No conflict found between the brief and ARCHITECTURE.
- **D-10** Untracked `SETUP.md` and setup scripts appeared mid-run; kept, not reverted.

**Phase 1 — domain-agnostic core**

- **D-11** `consumes: bool` + `dep_type` replace the string edge `kind`.
- **D-12** Snapshots store tuples and wrap derived lookups in `MappingProxyType`.
- **D-13** A minimal `evaluate()` lands in Phase 1, not Phase 2.
- **D-14** One `effort` float with optional three-point estimates.
- **D-15** Resource capacity derived as the prototype derived it; five groups become five team resources.
- **D-16** `ResourceSpec.parent_key` — a roll-up parent, so a team can cap throughput below its headcount.

**Phase 2 — explainable current bottlenecks**

- **D-17** The registry is a function returning a tuple, not a decorator writing into module state.
- **D-18** Delete `precision_vs_planted`; label every finding and report recall, precision and planted recall separately.
- **D-19** A cyclic workflow returns `schedulable=False` plus a finding, rather than raising.
- **D-20** `Impact.magnitude_kind` distinguishes observed delay from exposed days.
- **D-21** `ready_but_idle` is Tier 2, not Tier 1 as ARCHITECTURE D.1 has it. **The one deliberate deviation from ARCHITECTURE.**
- **D-22** Add `projected_vs_planned_finish` and `isolated_task` beyond the brief's list.
- **D-23** `unavailable_checks` includes five planned checks marked "not built yet".
- **D-24** `zero_slack_chain` threshold is configurable, default 0.6, not a hardcoded 0.5.

**Phase 3 — mutations, scenarios, simulation**

- **D-25** `inverse()` returns a tuple of mutations, not one.
- **D-26** `TASK_DELAY_ADD` writes a separate `added_delay` rather than raising effort.
- **D-27** Three mutations gained an optional "set" form instead of three new kinds.
- **D-28** Cyclic and invalid scenarios return structured results rather than raising.
- **D-29** `what-if` validates before writing; `POST /scenarios` stores an invalid one as `rejected` with the reason.
- **D-30** `to_canonical()` sorts set-like fields, so the content hash is order-independent.
- **D-31** `scenarios.get_row` uses `populate_existing=True` to defeat identity-map staleness.

**Phase 4 — explainable risk prediction**

- **D-32** Risk is computed inside `evaluate()`, not as a separate call.
- **D-33** The `likely` run of the three-point range **is** the headline projection.
- **D-34** `criticality_proximity` is rank-based; `resource_pressure` measures the roll-up resource too.
- **D-35** The no-probability test asserts substance, not vocabulary.
- **D-36** An unmeasurable factor reports unavailable, contributes 0, and is listed.
- **D-37** Band thresholds are labels on a continuum; `band` is never returned without `score`.

**Phase 5 — optimization**

- **D-38** A sixth generator, `gen_drop_bottleneck_tasks`, opt-in behind `aggressive=True` — otherwise the refusal beat is unreachable.
- **D-39** The constraint gates follow task lineage through splits and merges.
- **D-40** Two recommendations: the top scorer, and the top scorer that does not change scope.
- **D-41** The time budget is an injected `should_stop` callable, not a clock read inside `core/`.
- **D-42** The base is evaluated once and shared across candidates.
- **D-43** Surviving candidates are persisted as real scenarios by default.

**Phase 6 — frontend**

- **D-44** Project and stage live in the URL hash.
- **D-45** Delete the eleven dashboard-drift components rather than hiding them.
- **D-46** The graph colours nodes by slack, not by resource.
- **D-47** The what-if panel offers phrased questions, not a raw mutation editor.
- **D-48** Frontend verification is Playwright walkthroughs, not component unit tests.

**Phase 7 — the AI boundary**

- **D-49** `anthropic==1.4.0` is a listed requirement, so the contract tests actually run.
- **D-50** Three roles, three prompts, three schemas — never one mega-prompt.
- **D-51** The no-write-path guarantee is enforced by parsing the AI modules.
- **D-52** A narration with an invented number is discarded, not flagged.
- **D-53** A numeric token glued to letters is an identifier, not a quantity.
- **D-54** The projection has a hard task ceiling on top of the per-finding cap.
- **D-55** The Proposer is a third candidate source, with no shortcut.
- **D-56** With no model, the Interpreter falls back to a labelled pattern matcher.

**Phase 8 — the demo path**

- **D-57** Add `critical_path_single_owner`, a tenth Tier-0 detector, because the demo walk found the beat unrepresented.
- **D-58** The risk score is the sum of the rounded contributions, so the column on screen adds up exactly.
- **D-59** The "LLM enabled" rehearsal runs against a recorded provider — no key exists.
- **D-60** `demo_check` asserts what each beat claims, not that each endpoint returns 200.

**Phase 9 — hardening and deployment**

- **D-61** `CORS_ORIGINS` takes a comma-separated list; `*` is refused at startup rather than accepted and silently ignored by browsers.
- **D-62** `NoDecode` on that field, because pydantic-settings JSON-decodes complex values before any validator runs — without it the app would not start.
- **D-63** The error envelope passes `detail` through untouched, so a cited constraint survives it.
- **D-64** `/health` never touches the database; `/ready` does. A liveness probe that fails on a database blip causes a crash loop.
- **D-65** The request deadline is a backstop; the optimizer's real budget stays the injected `should_stop`, which returns partial results.
- **D-66** The picked identity is sent and never checked. A test fails if a login endpoint appears.
- **D-67** `POST /admin/reset-seed` is disabled when no token is configured, and the comparison is constant-time.
- **D-68** Every stage gets its own error boundary, keyed on the stage.
- **D-69** The walkthroughs move into `frontend/e2e/` with playwright as a devDependency.
- **D-70** The frontend gets its own `.dockerignore`, because its build context is `./frontend`.
- **D-71** The optimizer's spinner advances on a timer slower than the search, so it never overclaims.
- **D-72** `docs/DEPLOY.md` supersedes the untracked `deploy-kit/` draft, which is left in place rather than deleted.

---

## 6 · Blocked

**Nothing was blocked.** There is no `docs/BLOCKED.md` because no hard stop
condition was ever reached: the test suite ran on the first attempt every
phase, no step required a credential the product needs to function, no user
data was at risk, and every uncertainty was resolved by deciding and logging
the decision.

The one credential that does not exist — an `ANTHROPIC_API_KEY` — was needed
for a *verification*, not for the product. The enabled path is exercised
against recorded responses instead, and the fact that no live model call has
ever been made is listed as a risk below rather than treated as a blocker
(D-59).

---

## 7 · Honest limitations — say these before you are asked

1. **The risk score is not a probability.** It is an additive structural
   estimate. There is no calibration data behind it, and the product says so
   in four places rather than one. What would fix it: per-domain historical
   duration variance, and a Monte Carlo pass over it. The seam exists and is
   empty.
2. **CPM is resource-blind.** The schedule ignores resource constraints and
   overload is reported separately. This is deliberate — solving RCPSP
   properly is a different project — but it means the projected finish date
   assumes people can be in two places at once, and the overload finding is
   how you learn they cannot.
3. **The optimizer is a local search, not an optimum.** It searches
   restructurings its generators can express. A better arrangement that no
   generator proposes will not be found.
4. **The Interpreter without a key is a pattern matcher.** It handles four
   phrasings. It is labelled as such in both the API and the UI, and it
   refuses rather than guesses — but it is not an interpreter.
5. **No live model call has ever been made.** Every AI test runs against a
   stub or a recorded response. The request shape is checked against the
   installed SDK's own types, which is the strongest guarantee available
   without a key, but the first live call will still be a first.
6. **Cold start is real.** Tiers 1–3 need statuses, history and cross-project
   evidence respectively. A brand-new workflow gets ten structural checks and
   an explicit list of what it cannot assess yet. That is honest, but it is
   less than the product can do once it has been used for a while.
7. **The effort model is a simplification.** `duration = effort / (1 +
   efficiency × (assignees − 1))` with efficiency 0.6, and a non-divisible
   task refuses speedup entirely. It is a defensible curve, not a measured
   one.
8. **No authentication, by design.** Multi-user means a name picker: you
   choose a name, the browser remembers it, and it is checked against
   nothing. Anyone with the URL can be anyone. Roles on a workflow are
   advisory and nothing enforces them. The UI says all of this on screen
   rather than implying otherwise.
9. **Nothing has been deployed yet.** `docs/DEPLOY.md` is written from the
   artifacts and verified locally in containers, including against Postgres
   from an empty database — but the first real Render deploy is still a
   first.
10. **One process.** SQLite by default, Postgres by configuration.
    Concurrency beyond a handful of simultaneous users is untested.
11. **No notion of partial completion.** A task is not-started,
    in-progress, blocked or done. "60% done" cannot be expressed, so a long
    task in progress carries its whole remaining duration.
12. **Everything is one client component.** `page.tsx` fetches in the browser
    and holds all the state. Correct at this size; it will not survive many
    more stages without splitting.
13. **A timeout frees the request, not the CPU.** `asyncio.wait_for` cannot
    interrupt synchronous work, so a pathological input finishes computing
    after the client has gone. Safe because the work is pure, finite and
    lock-free — and said plainly in the code rather than implied away.
