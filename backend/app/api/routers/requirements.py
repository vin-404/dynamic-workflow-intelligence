"""
Requirement change as a first-class capability: what a new wording would cost,
before anyone commits to it.

Owned by Agent REQUIRE (Phase 11 wave 2). Every route here is a read - the
impact report mutates nothing, and the replan it proposes comes back as an
unapplied scenario.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.app.api.deps import project_role_guard

router = APIRouter(
    prefix="/api/projects/{project_id}",
    tags=["requirements"],
    dependencies=[project_role_guard],
)

_NOT_YET = "Requirement change analysis is not implemented yet."


class RequirementChangeIn(BaseModel):
    new_text: str
    version_id: uuid.UUID | None = None


class RequirementCompareIn(BaseModel):
    options: list[str]
    version_id: uuid.UUID | None = None


@router.get("/requirements")
async def list_requirements(project_id: uuid.UUID):
    raise HTTPException(status_code=501, detail=_NOT_YET)


@router.post("/requirements/{requirement_key}/change")
async def change(
    project_id: uuid.UUID, requirement_key: str, payload: RequirementChangeIn
):
    raise HTTPException(status_code=501, detail=_NOT_YET)


@router.post("/requirements/{requirement_key}/compare")
async def compare(
    project_id: uuid.UUID, requirement_key: str, payload: RequirementCompareIn
):
    raise HTTPException(status_code=501, detail=_NOT_YET)


@router.post("/requirements/{requirement_key}/apply")
async def apply_change(
    project_id: uuid.UUID, requirement_key: str, payload: RequirementChangeIn
):
    raise HTTPException(status_code=501, detail=_NOT_YET)


@router.get("/requirements/{requirement_key}/history")
async def history(project_id: uuid.UUID, requirement_key: str):
    raise HTTPException(status_code=501, detail=_NOT_YET)


@router.get("/requirements/{requirement_key}/diff")
async def diff(
    project_id: uuid.UUID,
    requirement_key: str,
    from_version: int | None = None,
    to_version: int | None = None,
):
    raise HTTPException(status_code=501, detail=_NOT_YET)
