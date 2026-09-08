"""
Capability 2, with a number attached - a Monte Carlo forecast over the
three-point estimates the tasks already carry.

Owned by Agent FORECAST (Phase 11 wave 2). The Layer-A structural risk score
is not replaced by this: it is the cold-start answer, and the response always
says which of the two it is reporting.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.app.api.deps import project_role_guard

router = APIRouter(
    prefix="/api/projects/{project_id}",
    tags=["forecast"],
    dependencies=[project_role_guard],
)


class ForecastIn(BaseModel):
    version_id: uuid.UUID | None = None
    iterations: int = Field(default=5000, ge=100, le=100_000)
    seed: int = 12345


@router.post("/forecast")
async def forecast(project_id: uuid.UUID, payload: ForecastIn | None = None):
    raise HTTPException(status_code=501, detail="Forecast is not implemented yet.")
