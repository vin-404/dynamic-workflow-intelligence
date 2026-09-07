"""Simulation API router — delay propagation and requirement impact."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import get_db
from backend.app.schemas.simulation import (
    DelayRequest,
    RequirementChangeRequest,
)
from backend.app.services import intelligence

router = APIRouter(prefix="/api/projects/{project_id}/simulate", tags=["simulate"])


@router.post("/delay")
async def simulate_delay(
    project_id: uuid.UUID,
    req: DelayRequest,
    db: AsyncSession = Depends(get_db),
):
    """Simulate a task delay and show downstream impact."""
    try:
        return await intelligence.simulate_delay(
            db, project_id, req.task_code, req.extra_days
        )
    except (ValueError, KeyError) as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/requirement")
async def simulate_requirement_change(
    project_id: uuid.UUID,
    req: RequirementChangeRequest,
    db: AsyncSession = Depends(get_db),
):
    """Simulate a requirement change and show affected work."""
    try:
        return await intelligence.simulate_requirement_change(
            db, project_id, req.req_code
        )
    except (ValueError, KeyError) as e:
        raise HTTPException(status_code=400, detail=str(e))
