"""
The AI endpoints.

`POST /interpret` **never mutates**. It returns a pending scenario the user
applies explicitly or not at all (ARCHITECTURE E).

`POST /explain` is presentation only.

There is no `POST /apply-what-the-model-said`. Applying goes through
`POST /api/scenarios/{id}/apply` like everything else, which is the single
write path to workflow state.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db import get_db
from backend.app.api.deps import project_role_guard
from backend.app.services import ai_service, versions as V

router = APIRouter(
    prefix="/api/projects/{project_id}",
    tags=["ai"],
    dependencies=[project_role_guard],
)
status_router = APIRouter(
    prefix="/api/ai",
    tags=["ai"],
    dependencies=[project_role_guard],
)


class InterpretIn(BaseModel):
    utterance: str = Field(min_length=1, max_length=2000)
    version_id: uuid.UUID | None = None
    #: False interprets without storing a scenario, for a preview.
    keep: bool = True


class ExplainIn(BaseModel):
    version_id: uuid.UUID | None = None


@status_router.get("/status")
async def ai_status(db: AsyncSession = Depends(get_db)):
    """What the AI layer can do right now, and what it does without a model.

    Published deliberately: "every capability works with the LLM disabled" is
    a claim a user should be able to check rather than take on trust.
    """
    return await ai_service.status(db)


@router.post("/interpret")
async def interpret(
    project_id: uuid.UUID,
    payload: InterpretIn,
    db: AsyncSession = Depends(get_db),
):
    """Natural language in, a **pending** scenario out.

    Nothing is applied. If the interpretation does not validate semantically,
    the reasons come back with it and no scenario is created.
    """
    try:
        return await ai_service.interpret(
            db,
            project_id,
            payload.utterance,
            payload.version_id,
            keep=payload.keep,
        )
    except V.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/explain")
async def explain(
    project_id: uuid.UUID,
    payload: ExplainIn | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Rephrase the current analysis. Presentation only - every number in the
    prose came from the engine, and a narration that invents one is discarded
    in favour of the engine's own wording."""
    try:
        return await ai_service.narrate_analysis(
            db, project_id, payload.version_id if payload else None
        )
    except V.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
