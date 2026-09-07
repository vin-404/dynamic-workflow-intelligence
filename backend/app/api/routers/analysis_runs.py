"""
Stored analyses.

An `AnalysisRun` carries `engine_version` and `input_hash`, so a stored result
can be compared with a fresh one - or explained when it differs. That is what
makes an analysis reproducible rather than a screenshot.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db import get_db
from backend.app.services import analysis_runs, versions as V

router = APIRouter(prefix="/api/analysis", tags=["analysis"])


@router.get("/{run_id}")
async def get_run(run_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    try:
        return await analysis_runs.get(db, run_id)
    except V.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
