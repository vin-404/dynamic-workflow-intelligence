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
