"""
Optimization, in the database.

The search itself lives in `core/optimization.py` and is pure. This layer does
three things around it: supply the wall-clock budget (`core/` has no clock),
turn every surviving candidate into a real persisted `Scenario` so the user can
inspect, diff, edit or apply it through the endpoints that already exist, and
serialise the result.

There is no special apply path for an optimizer candidate. It becomes a
`Scenario` with `origin="heuristic_proposal"` and goes through
`scenarios.apply_scenario()` like anything else.
"""
from __future__ import annotations

import time
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.optimization import (
    Budget,
    ObjectiveWeights,
    OptimizationResult,
    optimize as core_optimize,
)
from backend.app.core.workflow import EngineConfig
from backend.app.services import scenarios, versions as V


def _stopper(budget: Budget):
    """The time budget, injected. `core/` cannot read a clock, which is what
    keeps it pure and its search reproducible in tests."""
    if budget.max_seconds is None:
        return lambda: False
    started = time.monotonic()
    return lambda: (time.monotonic() - started) >= budget.max_seconds


async def optimize(
    db: AsyncSession,
    project_id: uuid.UUID,
    version_id: uuid.UUID | None = None,
    weights: ObjectiveWeights | None = None,
    budget: Budget | None = None,
    config: EngineConfig | None = None,
    aggressive: bool = False,
    persist_candidates: bool = True,
) -> dict:
    """Run the search and return the per-criterion comparison table.

    `persist_candidates` stores each survivor as a pending `Scenario`, which
    is what lets the UI diff or apply one without re-running the search. The
    rejected ones are *not* stored - they exist in the response with the
    constraint that refused them, which is where they are useful.
    """
    project, version, snapshot, state, clock = await V.load_context(
        db, project_id, version_id
    )
    b = budget or Budget()

    started = time.monotonic()
    result: OptimizationResult = core_optimize(
        snapshot,
        state,
        clock,
        config,
        weights,
        b,
        should_stop=_stopper(b),
        aggressive=aggressive,
    )
    elapsed = time.monotonic() - started

    payload = result.as_dict()
    payload.update({
        "project_id": str(project.id),
        "base_version_id": str(version.id),
        "elapsed_seconds": round(elapsed, 4),
        "project_start": project.start_date.isoformat(),
    })
    payload["current"]["projected_end_date"] = V.day_to_date(
        project.start_date, result.base.projected_end
    )

    if not persist_candidates:
        return payload

    # Persist each survivor as a real scenario, so "apply this one" needs no
    # special path.
    by_name: dict[str, str] = {}
    for candidate in result.candidates:
        row = await scenarios.create(
            db,
            project.id,
            name=candidate.name,
            base_version_id=version.id,
            origin=candidate.origin,
            rationale=candidate.rationale,
            mutations=[m.as_dict() for m in candidate.mutations],
        )
        by_name[candidate.name] = str(row.id)

    for entry in payload["candidates"]:
        entry["scenario_id"] = by_name.get(entry["name"])
    for key in ("recommended", "recommended_same_scope"):
        if payload.get(key):
            payload[key]["scenario_id"] = by_name.get(payload[key]["name"])
    payload["recommended_scenario_id"] = (
        by_name.get(result.recommended.name) if result.recommended else None
    )
    return payload
