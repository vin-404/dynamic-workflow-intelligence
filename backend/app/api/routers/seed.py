"""Seed and reset - the single command the demo path needs."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db import get_db
from backend.app.seed import loader

router = APIRouter(prefix="/api/seed", tags=["seed"])


@router.post("")
async def seed(db: AsyncSession = Depends(get_db)):
    """Load both seed domains. Idempotent, so it is safe to call repeatedly."""
    projects = await loader.seed_all(db)
    return {"status": "ok", "projects": projects}


@router.post("/reset")
async def reset(db: AsyncSession = Depends(get_db)):
    """Drop everything and reload both seed domains.

    Destructive, and deliberately explicit: this is what gives the demo a
    clean database in one call.
    """
    projects = await loader.reset_and_seed(db)
    return {"status": "reset", "projects": projects}


@router.get("/projects")
async def seeded_projects():
    """Deterministic ids for the seeded fixtures, so the frontend can
    deep-link without a lookup."""
    return {
        "projects": {k: str(v) for k, v in loader.PROJECT_IDS.items()},
        "demo_project_id": str(loader.DEMO_PROJECT_ID),
    }
