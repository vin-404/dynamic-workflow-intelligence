# Decisions

Judgement calls made during the autonomous refactor. One line of reasoning
each. Newest phase last.

Rule applied throughout: when ambiguous, choose the option that is **smaller,
more reversible, and closer to `docs/ARCHITECTURE.md`**.

---

## Phase 0

| # | Decision | Reasoning |
|---|---|---|
| D-01 | Keep the existing `./.venv` (Python 3.14.5) rather than creating a new one or pinning `backend/requirements.txt` exactly | Deps are already installed and the baseline suite is green (35/35). Re-pinning risks a dependency conflict for zero product value. Root `requirements.txt` pins *newer* versions than `backend/requirements.txt`; the installed venv matches root. I align `backend/requirements.txt` to what is installed rather than downgrading a working environment. |
| D-02 | Move `backend/app/core/config.py` → `backend/app/settings.py` and `backend/app/core/database.py` → `backend/app/db.py` | The prompt requires `core/` to be pure and enforced by an import test. Those two modules import `pydantic_settings` and `sqlalchemy`, so they cannot stay under `core/`. Moving two files is smaller than exempting them from the purity rule and weakening the invariant. Consistent with ARCHITECTURE A.1, which lists `db/` as a sibling of `core/`. |
| D-03 | Leave `backend/alembic/` inert; stay on `create_all` + a reset-and-seed command | `versions/` is empty — no migration has ever been generated, so there is no history to preserve. Both the prompt and ARCHITECTURE A.6 say explicitly not to spend hours on migrations. |
| D-04 | Stay on SQLite (`dwi.db`) | Prompt is explicit; ARCHITECTURE A.5 says the engine cannot tell the difference. `.env.example` mentioning Postgres is the thing that is wrong, so `.env.example` gets corrected, not `settings.py`. |
| D-05 | Purity is enforced by **AST source inspection**, not by import-time monkeypatching | Catches a forbidden import in a module that is never executed by any other test, and cannot be defeated by lazy imports inside functions (those are also parsed). |
| D-06 | Fix the non-hermetic `test_api.py` harness (module-import lifespan + shared on-disk `dwi.db`) **first**, in its own commit, before any schema change | It is the regression net for everything that follows. Repairing it while the schema is also moving would make failures unattributable. |
| D-07 | Migrate the seeded fixture as `effort == planned_duration` with exactly one assignee per task | Twelve existing assertions depend on its exact numbers (planned 22, projected 26, slip 4, 7 critical tasks, 4 bottlenecks). Keeping `effort/(1+0.6·(1−1))  = effort` makes the effort model a no-op for the fixture, so the regression net survives the rename. |
| D-08 | Delete root `scenario.py`, `api.py`, `index.html`; keep `demo.py` as a dev CLI under `backend/scripts/` | ARCHITECTURE A.6 marks all four DEMOTE and explicitly says keep `demo.py`, retire the rest once `core/` lands. Their behaviour is preserved: `scenario.py`'s data becomes a seed fixture, `api.py` is superseded by `backend/app/main.py`, `index.html` by the Next.js app. |
| D-09 | No conflict found between `docs/AUTONOMOUS_PROMPT.md` and `docs/ARCHITECTURE.md` in Phase 0 | The only near-conflict is persistence: ARCHITECTURE A.5 says "if Postgres already works, keep it", the prompt says stay on SQLite. The repo's working default *is* SQLite, so both point the same way. Recorded here because the prompt asked for conflicts to be logged. |

---

## Phase 1

| # | Decision | Reasoning |
|---|---|---|
| D-10 | `docs/SETUP.md` and `scripts/{setup,run-backend}.{sh,ps1}` appeared untracked in the working tree mid-run (timestamps 22:11, after this session started) and were swept into the phase-1 commit by `git add -A`. Kept, not reverted. | They are the repo owner's own onboarding scripts, they are correct, and they document the SQLite-only setup this refactor standardises on. Deleting them would destroy work that is not reproducible from seed code — an explicit hard-stop condition. From this point on every commit stages explicit paths rather than `-A`. |
| D-11 | `build_graph` sets `consumes: bool` and `dep_type` on every edge and drops the string `kind` attribute, rather than carrying both | ARCHITECTURE C says the artifact/temporal distinction becomes a `consumes` flag. Carrying both would be exactly the duplication the brief warns about. Cost is one mechanical line in the cycle test (`kind="temporal"` -> `consumes=False`); `stale_tasks` reads `consumes` and its four regression assertions are unchanged. |
| D-12 | `WorkflowSnapshot` stores sequences as tuples and wraps its derived lookups in `MappingProxyType` | Real immutability, not a convention. A frozen dataclass holding a plain `dict` is still mutable through the dict; the optimizer will evaluate thousands of candidates against one base snapshot and must not be able to corrupt it. |
| D-13 | A minimal `evaluate()` lands in Phase 1, not Phase 2 | The domain-leak test the brief requires in Phase 1 asserts byte-identical `evaluate()` output for two structurally identical workflows. The test cannot exist without the function. Phase 2 enriches it with the detector registry and tiering rather than introducing it. |
| D-14 | Task effort is stored as a single `effort` float with optional `optimistic/likely/pessimistic`; the seeded fixture sets `effort = planned_duration` and one assignee per task | Preserves the twelve assertions pinning the fixture's arithmetic (D-07) while giving Phase 3's effort model and Phase 4's three-point range real fields to read. |
| D-15 | `Resource.capacity` for the migrated fixture is derived the same way `_compute_dept_capacity` derived it (count of distinct people per group), and the five seeded groups become five `Resource` rows of `kind="team"` | Keeps `resource_contention` detecting exactly what `dept` contention detected, so the detector's regression assertions hold across the rename. The engine sees only `Resource{kind,name,capacity,skills}`; `kind` is data. |

| # | Decision | Reasoning |
|---|---|---|
| D-16 | Add `ResourceSpec.parent_key`, a roll-up parent, and measure contention against a resource capacity over the ready work of itself and its descendants | The seeded fixture names two marketing people but sets capacity 1, and that gap *is* the planted contention bottleneck. Assigning tasks to people alone loses the finding; assigning to teams alone loses the owner names; assigning to both makes every task look like it has two assignees and breaks the effort model. A parent keeps all three correct with exactly one assignment per task. Generic structure (teams, machine cells, budget rollups), not a domain concept -- so it does not reintroduce the leak. This supersedes the capacity-derivation claim in D-15, which was wrong: the seeded capacities are hand-authored and are preserved verbatim. |

---

## Phase 2

| # | Decision | Reasoning |
|---|---|---|
| D-17 | The registry is a function returning a tuple, not a decorator writing into a module-level list | `core/` holds no mutable module state, enforced by the purity test, and that is the precondition for evaluating optimizer candidates concurrently. A decorator would need a mutable accumulator. Adding a detector is still one line. |
| D-18 | Delete `accuracy.precision_vs_planted`; label **every** finding both fixtures contain and report `recall`, `precision`, and `planted_recall` separately | The prototype's metric punished the detectors for being right. Three planted faults were labelled; Phase 2 legitimately finds eleven real problems in that fixture, so `precision_vs_planted` would have read 33% while nothing was wrong. Labelling all eighteen findings across both fixtures (with a description each, and a `planted` flag preserving the original demo story) makes both numbers mean what they say, and turns the fixtures into a strict regression lock. |
| D-19 | A cyclic workflow makes `evaluate()` return `schedulable=False` plus a `dependency_cycle` finding, instead of raising `CycleError` | An exception is a worse answer than a finding: the UI can render the cycle, point at it, and stay up. `schedule()` still raises for direct callers, so the existing cycle-detection test is untouched. |
| D-20 | `Impact` carries `magnitude_kind` (`observed_delay_days` vs `exposed_days`) rather than reusing `attributed_delay_days` for Tier-0 findings | At Tier 0 nothing has been lost yet — the magnitude is work *exposed* to a structural weakness. Calling that a delay would be the quiet kind of dishonesty the whole brief is written against. Renaming the field is the smaller cost. |
| D-21 | `ready_but_idle` is declared Tier 2 (historical), not Tier 1 as ARCHITECTURE D.1's table has it | The tier is a *data requirement*, and this detector ages a task from when its last predecessor's status transition was recorded. With no event log that age is measured from day 0, so it would report every unstarted task on every fresh project. ARCHITECTURE D.1's table wins on design intent; this is a factual correction to which tier the detector needs. |
| D-22 | Add `projected_vs_planned_finish` (Tier 1) and `isolated_task` (Tier 0) beyond the prompt's explicit list | Both are in ARCHITECTURE D.1's table — "projected vs planned finish" and "orphan/unreachable tasks". The first is the headline number a delivery lead asks for, stated as a finding with its arithmetic attached rather than only as a top-level `slip_days`. |
| D-23 | `unavailable_checks` includes five `PLANNED_CHECKS` marked `(not built yet)` | Without them the Tier-3 gap lists nothing, which implies cross-project calibration becomes available once you have history. It does not — nothing collects cross-project actuals. Showing the roadmap in the payload is more honest than an empty gap. |
| D-24 | `zero_slack_chain` uses a configurable `critical_share_threshold`, default 0.6, rather than a hardcoded 0.5 | 50% of tasks being critical is common and unremarkable; my first threshold fired on a workflow with three tasks holding nine days of slack each. Two thirds is a plan with no shock absorber. Making it config, echoed in the evidence, means the number is reviewable rather than mine. |

---

## Phase 3

| # | Decision | Reasoning |
|---|---|---|
| D-25 | `inverse()` returns `tuple[Mutation, ...]`, not a single `Mutation` | Undoing a task removal is not one step: it re-adds the task, restores each edge with its `dep_type` and `consumes` flags, drops the bridges the removal created, re-attaches assignments, and re-links consumed requirements. A single-mutation inverse looked tidier and produced two silent round-trip failures. The signature should admit what is true. |
| D-26 | `TASK_DELAY_ADD` writes a separate `TaskSpec.added_delay` rather than raising `effort` | The fixture's stalled approval is nine elapsed days against a two-day estimate, so raising the estimate to seven changed the schedule not at all - the observed duration already exceeded it. A delay has to sit on top of what a task already looks like it will take. Keeping the two apart also means a slip reads as slip in `slip_days` rather than as a quietly re-baselined plan. |
| D-27 | Three mutations gained an optional "set" form (`RESOURCE_UNAVAILABLE_WINDOW.windows`, `TASK_DELAY_ADD.total_delay_days`, `REQUIREMENT_VERSION_BUMP.version_no`) instead of three new mutation kinds | Each exists only so the mutation's inverse is exact. Three extra kinds used by nothing but undo would take the algebra to twenty to save three optional fields, and would weaken the "seventeen kinds, closed" claim for no gain. |
| D-28 | `evaluate()` returns `schedulable=False` plus a `dependency_cycle` finding for a cyclic scenario, and `simulate()` returns the base evaluation plus the rejection for an invalid one, rather than raising | A UI needs to render "here is where you are, and here is why we will not do that". An exception gives it nothing to draw. |
| D-29 | `POST /projects/{id}/what-if` validates before writing anything and stores no row when `keep=false`; `POST /scenarios` stores an invalid scenario with `status="rejected"` and the reason | Two different needs. A throwaway question should leave no trace and must return the *structured* rejection - the cited constraint and the reason on record - because "M09 is mandatory" is much weaker than "M09 is mandatory because UN38.3 certification is a legal precondition to shipping". A deliberately created scenario should survive its own rejection so the user can read and edit it, which is also exactly what Phase 7 needs for LLM proposals. |
| D-30 | `to_canonical()` sorts set-like fields (`consumed_by`, `skills`, `required_skills`, `working_days`, `holidays`, `unavailable_windows`) | Their order carries no meaning, so two snapshots differing only in insertion order must hash the same. Found by a round-trip that produced an identical workflow with a different hash - which would have broken version comparison and the immutability guarantee, not just undo. |
| D-31 | `services/scenarios.get_row` uses `populate_existing=True` | The session is configured `expire_on_commit=False`, so an already-identity-mapped `Scenario` kept the `mutations` collection it was first loaded with and an appended mutation was invisible. A real bug, not a test artefact. |

---

## Phase 4

| # | Decision | Reasoning |
|---|---|---|
| D-32 | Risk is computed inside `evaluate()` rather than as a separate on-demand call | It is pure arithmetic over the schedule that call already produced, so it costs nothing extra, and it means one `analyze` round trip answers Capabilities 1 and 2 together. A separate call would have meant a second schedule pass for the same numbers. |
| D-33 | The `likely` run of the three-point range **is** the headline projection, not a separately computed estimate | Otherwise the middle of the range is a fourth number that does not match the one shown everywhere else, and the first question anyone asks is which of the two is real. |
| D-34 | `criticality_proximity` is rank-based, and `resource_pressure` measures the roll-up resource as well as the assignee | A pure slack ratio would duplicate `slack_ratio`; a rank distinguishes "third-tightest of seventeen" from "already critical". And a person with one task whose *team* is at capacity is genuinely under pressure - measuring only the person would miss the seeded marketing bottleneck entirely. |
| D-35 | The no-probability test asserts **substance, not vocabulary** | Banning the word "probability" is the wrong test once the payload is honest: it says "not a probability" four times, names a flag `is_probability`, and has a field called `what_would_make_this_a_probability`. A word-ban either fails on those denials or accumulates per-key exceptions until it proves nothing. The replacement walks the whole payload and fails if any key named like a likelihood holds a *number*, and separately checks that no sentence a user reads makes a probability claim. That catches the real failure mode. |
| D-36 | A factor that cannot be measured reports `available: false`, contributes 0, and is listed in the assumptions - rather than being imputed or silently dropped | Imputing it would invent evidence; dropping it would change the score's scale without saying so. Reporting zero with a reason keeps the arithmetic honest and tells the user what would unlock the factor, which is the same contract the detector tiering uses. |
| D-37 | Band thresholds (0.55 high, 0.30 moderate) are labels on a continuum and `band` is never returned without `score` | The cut points are arbitrary and admitting that is cheaper than defending them. Any UI that shows the band must show the number beside it. |

---

## Phase 5

| # | Decision | Reasoning |
|---|---|---|
| D-38 | Add `gen_drop_bottleneck_tasks`, a sixth generator, opt-in behind `aggressive=True` | The five deterministic generators are all restructurings, so none of them ever proposes deleting a task - which means the constraint gates never fire and the refusal beat is unreachable. An optimizer that never proposes the cheat never demonstrates that it will not take it. It is also the honest answer for a user who has marked nothing mandatory: cutting scope is a real option. |
| D-39 | The constraint gates follow task **lineage** through splits and merges | The first version refused `Split T02 across 2 people` with "this candidate drops T02 -> T03", which is false: the split rewires the edge to both parts and the ordering survives. A misleading refusal is worse than no refusal, because it teaches the user to distrust the ones that are real. A genuine deletion is still refused, and that is tested so the leniency cannot become a loophole. |
| D-40 | Return **two** recommendations: the top scorer, and the top scorer that does not change scope | `TASK_REMOVE` is on the brief's own justified list for the effort-conservation gate, so a permitted deletion can legitimately outrank every restructuring. Presenting only the winner would make "do less work" look like an engineering result. Presenting both makes it a scope decision, which is the user's to make and not the optimizer's. |
| D-41 | The time budget is a caller-supplied `should_stop` callable, not a clock read inside `core/` | Keeps the purity invariant literal - `core/` may not import `time` - and makes the budget test deterministic instead of a race against a real timer. The clock is already an argument everywhere else; this is the same rule. |
| D-42 | The base workflow is evaluated once and shared across candidates, rather than each candidate going through `simulate()` | `simulate()` evaluates base and candidate, so N candidates would cost 2N evaluations for N identical base results. Sharing it halves the work and is asserted by a test that counts the calls. The comparison payload is still `simulation._compare()`, so an optimizer candidate and a hand-written what-if produce the same shape. |
| D-43 | Surviving candidates are persisted as real `Scenario` rows by default | It is what lets the UI diff, edit or apply one without re-running the search, and it means there is no special apply path for an optimizer result - the existing scenario endpoints already work on it. `persist_candidates: false` turns it off for a throwaway comparison. |

---

## Phase 6

| # | Decision | Reasoning |
|---|---|---|
| D-44 | The open project and stage live in the **URL hash**, not in React state alone | Found in the browser: refreshing dropped the user back to the project list, losing their place. A hash is the smallest fix that also makes links deep-link, and Phase 9's "two browsers open the same project" needs it. Real routes are a later change if they earn one. The sync effect had to be gated on the initial restore finishing, because it fired on mount with no project and wiped the hash it was about to read. |
| D-45 | Delete `DashboardView`, `GanttChart`, `AccuracyPanel`, `DemoWalkthrough`, `TasksView`, `WhyLateView`, `BottleneckInbox`, `SimulationPanel`, `Header`, `TabNav`, `Card` rather than demote them into a hidden tab | The brief says demote the dashboard drift and keep an accuracy view reachable but off the landing surface. Keeping dead components around "just in case" is how drift returns. The accuracy view is rebuilt inside `VersionHistory`, where it belongs - it is evidence about the detectors, which is a history question. |
| D-46 | `DependencyGraph` colours nodes by **slack**, not by resource | The prototype keyed node colour off a hardcoded `{ORG, FIN, FAC, MKT, SPON}` palette - the domain leak in the frontend, and it would have shown grey for every node in any other domain. Slack is true of every workflow everywhere, and it is the thing the viewer actually needs to see. |
| D-47 | The what-if panel offers five **phrased questions** rather than a raw mutation editor | "A task slips" is what a delivery lead asks; `TASK_DELAY_ADD` is not. The algebra is not hidden - it is published at `/api/scenarios/mutation-kinds` and each queued change shows its `kind` as a badge - but a form that requires knowing the algebra to ask a question would make the closed algebra a burden rather than a guarantee. |
| D-48 | Frontend verification is two Playwright walkthroughs rather than component unit tests | The brief asks for the full journey completed in a browser for both seed domains. Component tests would re-check what the API tests already cover, and would not have caught either real bug this phase found - the lost-on-refresh state or the ambiguous button labels. Recorded risk: the walkthroughs currently live outside the repo. |
