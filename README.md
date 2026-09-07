# Workflow Intelligence — MVP

TECHKNOTS 9. Five files, no database, no auth, no build step.

## Run

```bash
pip install fastapi uvicorn networkx
python demo.py                                  # engine proof, prints to terminal
uvicorn api:app --reload --port 8000            # then open http://localhost:8000
```

## What's here

| File | Lines | What it is |
|---|---|---|
| `engine.py` | ~250 | CPM schedule, cycle detection, 4 detectors, diff, staleness. **The product.** |
| `scenario.py` | ~120 | 17 tasks / 5 depts / 3 requirements / event log / 3 planted faults |
| `demo.py` | ~130 | CLI walkthrough — verifies the engine with no UI involved |
| `api.py` | ~110 | 4 FastAPI endpoints |
| `index.html` | ~330 | Single page, vanilla JS, inline CSS, **zero CDN** (works on bad venue wifi) |

## What it computes

- **Schedule** — CPM forward/backward pass → earliest start, slack, critical path.
  Planned finish vs projected finish, because pretending a stalled task still
  takes its estimate is how schedules lie.
- **Bottlenecks** — four detectors, each emitting *evidence* and a *root cause*,
  ranked by `impact = days lost × (1 + downstream tasks)`. A formula, not a model:
  anyone can recompute it by hand.
  - `critical_path_blocker` — walks back to the earliest incomplete zero-slack ancestor
  - `resource_contention` — dept has more ready tasks than capacity
  - `stalled_in_review` — no activity past threshold
  - `ready_but_idle` — unblocked and nobody started it
- **Change propagation** — diff two schedule states: tasks moved, slack consumed,
  critical path shifts, new end date, who to notify.
- **Requirement staleness** — the differentiator. A spec changes, and we separate
  `must_redo` (consumed an artifact that is now wrong, propagated along *artifact*
  edges only) from `must_recheck` (merely downstream). Blunt `descendants()` would
  turn the whole project red and be useless.
- **Accuracy** — 3 planted faults, 3 detected, 0 false positives.

## Deliberate non-goals for the MVP

No auth, no persistence, no live feed, no LLM, no Gantt, no Monte Carlo.
Each of those is additive; none is load-bearing.

## Next three things, in order

1. **Real event log.** Point `scenario.py`'s loader at a BPI Challenge log
   (tf-pm.org/resources/logs) and derive durations from historical medians instead
   of estimates. Removes the "you detect the bugs you planted" objection.
2. **Live feed.** SSE endpoint replaying the event log at 60× with detectors firing
   on screen. This is what earns the word "real time" in the problem title.
3. **Requirement diff from text.** LLM reads a message, proposes a requirement
   change as a card a human approves. Never auto-applied.

## Two answers to rehearse

**"How is this not Jira?"** Jira stores state. We compute delay attribution, root
cause, propagation and requirement invalidation. Then show panel B.

**"How is this not process mining / Celonis?"** Process mining is retrospective —
it tells you what the process did. We hold a live dependency model and answer what
breaks *next* when a date or a spec moves. Diagnosis vs blast radius.
