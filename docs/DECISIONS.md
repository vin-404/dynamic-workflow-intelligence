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
