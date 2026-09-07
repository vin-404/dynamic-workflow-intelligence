"""
Capability 3 - scenarios and simulation.

`POST /scenarios/{id}/apply` is the **only** endpoint in this application that
writes workflow state. Everything else here is a read over an immutable
snapshot plus, at most, an `AnalysisRun` row.

Validation failures return 422 with the structured reason, because those
reasons are a feature: "this would create a cycle: A -> B -> C -> A" and
"budget approval is a mandatory task and cannot be removed" are the product,
not error handling.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.limits import bounded
from backend.app.core.mutations import MutationKind, payload_schema
from backend.app.db import get_db
from backend.app.services import scenarios, versions as V
from backend.app.settings import settings

project_router = APIRouter(prefix="/api/projects/{project_id}", tags=["scenarios"])
router = APIRouter(prefix="/api/scenarios", tags=["scenarios"])


class MutationIn(BaseModel):
    kind: MutationKind
    payload: dict = Field(default_factory=dict)


class ScenarioIn(BaseModel):
    name: str = ""
    base_version_id: uuid.UUID | None = None
    origin: str = "user_whatif"
    rationale: str = ""
    mutations: list[MutationIn] = Field(default_factory=list)


class WhatIfIn(BaseModel):
    mutations: list[MutationIn] = Field(min_length=1)
    name: str = "What-if"
    base_version_id: uuid.UUID | None = None
    #: False evaluates and discards, for a throwaway question.
    keep: bool = True


class ApplyIn(BaseModel):
    note: str = ""


def _unprocessable(e: scenarios.Invalid):
    return HTTPException(
        status_code=422,
        detail={
            "error": "mutation_rejected",
            "message": str(e),
            **e.result.as_dict(),
        },
    )


def _not_found(e: Exception):
    return HTTPException(status_code=404, detail=str(e))


# ---------------------------------------------------------------------------
# The algebra, discoverable
# ---------------------------------------------------------------------------


@router.get("/mutation-kinds")
async def mutation_kinds():
    """The closed algebra, with each kind's payload contract.

    Published deliberately: it is what the UI builds forms from, and it is the
    exact set the LLM Interpreter is allowed to emit. "Restructure the
    project" is not in this list, which is the point.
    """
    schema = payload_schema()
    return {
        "closed": True,
        "note": (
            "Anything a user or a model wants to express must decompose into "
            "these. There is no free-form escape hatch."
        ),
        "kinds": [
            {
                "kind": kind.value,
                "required": list(required),
                "optional": list(optional),
            }
            for kind, (required, optional) in schema.items()
        ],
    }


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------


@project_router.get("/scenarios")
async def list_scenarios(
    project_id: uuid.UUID, db: AsyncSession = Depends(get_db)
):
    try:
        await V.get_project(db, project_id)
    except V.NotFound as e:
        raise _not_found(e)
    return await scenarios.list_for_project(db, project_id)


@project_router.post("/scenarios", status_code=201)
async def create_scenario(
    project_id: uuid.UUID, payload: ScenarioIn, db: AsyncSession = Depends(get_db)
):
    try:
        row = await scenarios.create(
            db,
            project_id,
            name=payload.name,
            base_version_id=payload.base_version_id,
            origin=payload.origin,
            rationale=payload.rationale,
            mutations=[m.model_dump(mode="json") for m in payload.mutations],
        )
    except scenarios.Invalid as e:
        raise _unprocessable(e)
    except V.NotFound as e:
        raise _not_found(e)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return scenarios.serialise(row)


@router.get("/{scenario_id}")
async def get_scenario(scenario_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    try:
        return scenarios.serialise(await scenarios.get_row(db, scenario_id))
    except V.NotFound as e:
        raise _not_found(e)


@router.post("/{scenario_id}/mutations", status_code=201)
async def add_mutation(
    scenario_id: uuid.UUID, payload: MutationIn, db: AsyncSession = Depends(get_db)
):
    """422 with the reason on a semantic failure - a cycle, a missing
    reference, or a constraint that forbids it."""
    try:
        row = await scenarios.add_mutation(
            db, scenario_id, payload.model_dump(mode="json")
        )
    except scenarios.Invalid as e:
        raise _unprocessable(e)
    except V.NotFound as e:
        raise _not_found(e)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return scenarios.serialise(row)


@router.delete("/{scenario_id}/mutations/{seq}")
async def remove_mutation(
    scenario_id: uuid.UUID, seq: int, db: AsyncSession = Depends(get_db)
):
    try:
        row = await scenarios.remove_mutation(db, scenario_id, seq)
    except V.NotFound as e:
        raise _not_found(e)
    return scenarios.serialise(row)


@router.post("/{scenario_id}/evaluate")
async def evaluate_scenario(
    scenario_id: uuid.UUID, db: AsyncSession = Depends(get_db)
):
    """Evaluate the scenario and diff it against its base.

    Writes nothing but an `AnalysisRun`. The response carries the base
    version's hash before and after, so a caller can verify the original is
    untouched.
    """
    try:
        return await bounded(
            scenarios.evaluate_scenario(db, scenario_id),
            settings.SIMULATE_TIMEOUT_SECONDS,
            "Evaluating this scenario",
            "Your workflow was not modified.",
        )
    except V.NotFound as e:
        raise _not_found(e)


@router.get("/{scenario_id}/diff")
async def diff_scenario(
    scenario_id: uuid.UUID,
    against: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
):
    try:
        return await scenarios.diff(db, scenario_id, against)
    except scenarios.Invalid as e:
        raise _unprocessable(e)
    except V.NotFound as e:
        raise _not_found(e)


@router.post("/{scenario_id}/apply")
async def apply_scenario(
    scenario_id: uuid.UUID,
    payload: ApplyIn | None = None,
    db: AsyncSession = Depends(get_db),
):
    """**The only endpoint that writes workflow state.**

    Creates a new immutable version whose parent is the base, and moves the
    project pointer. The response reports the parent's content hash so the
    caller can confirm history was preserved rather than rewritten.
    """
    try:
        return await scenarios.apply_scenario(
            db, scenario_id, note=payload.note if payload else ""
        )
    except scenarios.Invalid as e:
        raise _unprocessable(e)
    except V.NotFound as e:
        raise _not_found(e)


@router.delete("/{scenario_id}", status_code=204)
async def delete_scenario(
    scenario_id: uuid.UUID, db: AsyncSession = Depends(get_db)
):
    try:
        await scenarios.delete(db, scenario_id)
    except scenarios.Invalid as e:
        raise _unprocessable(e)
    except V.NotFound as e:
        raise _not_found(e)


# ---------------------------------------------------------------------------
# One-shot what-if
# ---------------------------------------------------------------------------


@project_router.post("/what-if")
async def what_if(
    project_id: uuid.UUID, payload: WhatIfIn, db: AsyncSession = Depends(get_db)
):
    """Ask one hypothetical and get the before/after diff.

    This is how the prototype's `POST /simulate/delay` returns - as a
    `TASK_DELAY_ADD` against a real scenario, evaluated by the same engine,
    rather than as a second code path that could drift.
    """
    try:
        return await bounded(
            scenarios.what_if(
                db,
                project_id,
                [m.model_dump(mode="json") for m in payload.mutations],
                name=payload.name,
                base_version_id=payload.base_version_id,
                keep=payload.keep,
            ),
            settings.SIMULATE_TIMEOUT_SECONDS,
            "Simulating this change",
            "Your workflow was not modified.",
        )
    except scenarios.Invalid as e:
        raise _unprocessable(e)
    except V.NotFound as e:
        raise _not_found(e)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
