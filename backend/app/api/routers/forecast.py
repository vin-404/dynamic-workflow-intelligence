"""
Capability 2, with a number attached - a Monte Carlo forecast over the
three-point estimates the tasks already carry.

Owned by Agent FORECAST (Phase 11 wave 2). The Layer-A structural risk score
is not replaced by this: it is the cold-start answer, and the response always
says which of the two it is reporting.

Two things this router is careful about.

**Which number is this?** Every response carries `answer_kind`, exactly one of
`monte_carlo_probability` or `structural_estimate`, plus the sentence that
tells them apart. Both blocks are always present - `forecast` and
`structural_risk` - so a UI never has to guess, and when there is nothing to
sample the forecast block says `available: false` with the reason and
`answer_kind` falls back to the structural estimate.

**Where the spread comes from.** A task with its own optimistic/likely/
pessimistic numbers is sampled from those. A task without them falls back to
the project's domain `duration_variance_prior`, which reaches the engine as a
plain float on `EngineConfig` and never as a domain name - the engine has no
domain field to branch on and this router does not give it one. Every task
reports which of the two it used, and a task using the prior is labelled
`assumed`.

The simulation is pure, seeded and deterministic, and runs off the event loop
in a worker thread because it is CPU-bound arithmetic, not I/O.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.deps import project_role_guard
from backend.app.api.limits import bounded
from backend.app.core.engine import evaluate as core_evaluate
from backend.app.core.engine.graph import CycleError, build_graph_from_snapshot
from backend.app.core.engine.montecarlo import (
    FORECAST_KIND,
    STRUCTURAL_KIND,
    forecast as run_forecast,
)
from backend.app.core.engine.risk import SCORE_DISCLAIMER, SCORE_KIND
from backend.app.core.workflow import DONE_STATUSES, EngineConfig
from backend.app.db import get_db
from backend.app.models import Domain
from backend.app.services import versions as V
from backend.app.settings import settings

router = APIRouter(
    prefix="/api/projects/{project_id}",
    tags=["forecast"],
    dependencies=[project_role_guard],
)

#: The one sentence a caller needs in order not to confuse the two numbers.
ANSWER_KIND_NOTE = {
    FORECAST_KIND: (
        "You are looking at a probability. It is the fraction of seeded "
        "simulated runs that finished on or before the deadline, under the "
        "assumptions in `forecast.assumptions`. It is not calibrated against "
        "any real outcome. The Layer-A structural estimate is still here, in "
        "`structural_risk`, and is a different quantity on a different scale."
    ),
    STRUCTURAL_KIND: (
        "You are looking at a STRUCTURAL ESTIMATE, not a probability. There "
        "was nothing to sample, so no distribution was invented - see "
        "`forecast.unavailable_reason`. The structural score in "
        "`structural_risk` ranks how exposed each task is given the shape of "
        "the workflow; it does not say how likely anything is."
    ),
}


class ForecastIn(BaseModel):
    version_id: uuid.UUID | None = None
    iterations: int = Field(default=5000, ge=100, le=100_000)
    seed: int = 12345


async def _spread_prior(db: AsyncSession, domain_id: uuid.UUID | None) -> EngineConfig:
    """The engine config, carrying the domain's variance prior as a number.

    `Domain.duration_variance_prior` is described in the model as "a plain
    number handed to the simulator as a spread, never as a domain identity the
    engine could branch on". This is the one place that hand-off happens. The
    domain's *key* and *name* are deliberately not passed on: `EngineConfig`
    has no field for them, and `test_domain_leak.py` would catch it if it did.
    """
    if domain_id is None:
        return EngineConfig()
    prior = (
        await db.execute(
            select(Domain.duration_variance_prior).where(Domain.id == domain_id)
        )
    ).scalar_one_or_none()
    if prior is None:
        return EngineConfig()
    return EngineConfig(
        default_duration_spread=float(prior),
        duration_spread_provenance="domain_prior",
    )


@router.post("/forecast")
async def forecast(
    project_id: uuid.UUID,
    payload: ForecastIn | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Run the simulation and return the distribution, or say why there is none.

    A pure read: it loads an immutable snapshot, samples over it and writes
    nothing. The stored workflow is not touched, which is why this sits with
    the reads in `deps.READS_THAT_POST`.
    """
    body = payload or ForecastIn()
    try:
        project, version, snapshot, state, clock = await V.load_context(
            db, project_id, body.version_id
        )
    except V.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))

    config = await _spread_prior(db, project.domain_id)
    result = core_evaluate(snapshot, state, clock, config)

    # Finished work has a known duration; sampling it would invent uncertainty
    # about something that already happened. Those tasks are held constant and
    # reported as `measured_actual`.
    known = tuple(
        key for key in snapshot.task_keys
        if state.status_of(key) in DONE_STATUSES
    )

    def _work():
        graph = build_graph_from_snapshot(snapshot)
        return run_forecast(
            snapshot,
            graph,
            result.schedule["durations"],
            config,
            iterations=body.iterations,
            seed=body.seed,
            known_duration_keys=known,
        )

    if result.schedulable:
        try:
            simulation = await bounded(
                run_in_threadpool(_work),
                settings.ANALYZE_TIMEOUT_SECONDS,
                "The forecast",
                "Lower `iterations` and try again.",
            )
            forecast_block = _with_dates(simulation.as_dict(), project.start_date)
        except CycleError as e:
            forecast_block = _unschedulable(body, e.cycles)
    else:
        forecast_block = _unschedulable(body, result.cycles)

    answer_kind = FORECAST_KIND if forecast_block["available"] else STRUCTURAL_KIND

    return {
        "project_id": str(project.id),
        "project_name": project.name,
        "version_id": str(version.id),
        "version_no": version.version_no,
        "project_start": project.start_date.isoformat(),
        "today_day": project.today_day,
        "deadline_date": project.deadline.isoformat() if project.deadline else None,
        "engine_version": result.engine_version,
        "input_hash": result.input_hash,
        "tier_reached": result.tier_reached,
        "schedulable": result.schedulable,
        "answer_kind": answer_kind,
        "answer_kind_note": ANSWER_KIND_NOTE[answer_kind],
        "forecast": forecast_block,
        # Always present, never replaced. This is the cold-start answer and it
        # is the answer whenever `forecast.available` is false.
        "structural_risk": {
            "score_kind": SCORE_KIND,
            "is_probability": False,
            "disclaimer": SCORE_DISCLAIMER,
            "band_counts": result.risk.get("band_counts", {}),
            "top": result.risk.get("top", []),
            "assumptions": result.risk.get("assumptions", {}),
        },
        # The deterministic numbers the rest of the product shows, so the
        # distribution can be reconciled against them rather than floating
        # free as a fourth figure nobody can tie back.
        "deterministic": {
            "projected_end_day": result.projected_end,
            "projected_end_date": V.day_to_date(
                project.start_date, result.projected_end
            ),
            "planned_end_day": result.planned_end,
            "slip_days": result.slip_days,
            "feasibility": result.feasibility.as_dict(),
            "note": (
                "The three-point range here is three deterministic schedule "
                "runs and remains `is_probability: false`. The distribution "
                "in `forecast` is the separate, sampled answer."
            ),
        },
    }


@router.get("/forecast/assumptions")
async def assumptions(project_id: uuid.UUID):
    """The model, its parameters and its known weaknesses, without running it.

    A UI that wants to show "what is this number resting on?" before the user
    presses anything should read this rather than hardcode the prose.
    """
    from backend.app.core.engine import montecarlo as MC

    return {
        "kind": FORECAST_KIND,
        "distribution": MC.DISTRIBUTION,
        "distribution_name": "Beta-PERT",
        "distribution_lambda": MC.PERT_LAMBDA,
        "default_iterations": ForecastIn.model_fields["iterations"].default,
        "default_seed": ForecastIn.model_fields["seed"].default,
        "is_calibrated": False,
        "disclaimer": MC.FORECAST_DISCLAIMER,
        "what_would_calibrate_it": MC.WHAT_WOULD_CALIBRATE_IT,
        "not_modelled": [
            {"what": "correlation between task durations",
             "why_it_matters": MC.INDEPENDENCE_NOTE},
            {"what": "resource contention",
             "why_it_matters": MC.RESOURCE_CONTENTION_NOTE},
            {"what": "rework",
             "why_it_matters": (
                 "A task that has to be redone appears only through whatever "
                 "its pessimistic estimate already allowed for."
             )},
        ],
        "bands": {
            "on_track": "probability of meeting the deadline >= 0.80",
            "at_risk": "0.50 <= probability < 0.80",
            "unlikely": "probability < 0.50",
            "note": MC.BAND_NOTE,
        },
        "spread_provenance": {
            MC.PROVENANCE_ESTIMATE: (
                "the task carries its own optimistic/likely/pessimistic "
                "numbers and was sampled from them"
            ),
            MC.PROVENANCE_PRIOR: (
                "the task carries no estimate, so the project's domain "
                "variance prior supplied the width. Labelled `assumed`."
            ),
            MC.PROVENANCE_MEASURED: (
                "the work is finished, so its duration is known and was held "
                "constant rather than sampled"
            ),
        },
    }


# ---------------------------------------------------------------------------
# Presentation
# ---------------------------------------------------------------------------


def _with_dates(block: dict, start_date) -> dict:
    """Working-day offsets become calendar dates here and nowhere deeper.

    `core/` reasons in integer-friendly working days only; this is the API
    boundary that turns them into something a person can read.
    """
    completion = block.get("completion", {})
    dated = {}
    for key, value in completion.items():
        dated[key] = value
        if key.endswith("_day") and isinstance(value, (int, float)):
            dated[key[:-4] + "_date"] = V.day_to_date(start_date, value)
    block["completion"] = dated

    for row in block.get("histogram", {}).get("bins", []):
        row["from_date"] = V.day_to_date(start_date, row["from_day"])
        row["to_date"] = V.day_to_date(start_date, row["to_day"])

    deadline_day = block.get("deadline", {}).get("deadline_day")
    if deadline_day is not None:
        block["deadline"]["deadline_date"] = V.day_to_date(start_date, deadline_day)
    return block


def _unschedulable(body: ForecastIn, cycles) -> dict:
    """A cyclic workflow has no finish date, so it has no distribution of them.

    Reported rather than raised, for the same reason `evaluate()` reports
    cycles rather than raising: a bad graph must not take the page down.
    """
    return {
        "kind": FORECAST_KIND,
        "available": False,
        "is_probability": False,
        "is_calibrated": False,
        "iterations": body.iterations,
        "seed": body.seed,
        "completion": {},
        "deadline": {},
        "histogram": {"bins": [], "bin_count": 0},
        "tasks": [],
        "assumptions": {},
        "fall_back_to": STRUCTURAL_KIND,
        "unavailable_reason": (
            "This workflow contains a circular dependency, so it has no "
            "finish date and therefore no distribution of finish dates. "
            f"Break the cycle first: {[list(c) for c in cycles]}"
        ),
    }
