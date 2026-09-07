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
