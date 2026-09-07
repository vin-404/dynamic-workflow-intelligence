"""Seed API router — populate demo data."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db import get_db
from backend.app.services.seed import seed_demo_project, DEMO_PROJECT_ID

router = APIRouter(prefix="/api/seed", tags=["seed"])


@router.post("")
async def seed(db: AsyncSession = Depends(get_db)):
    """Seed the database with demo data. Idempotent."""
    project_id = await seed_demo_project(db)
    return {
        "status": "ok",
        "project_id": str(project_id),
        "message": "Demo project seeded successfully",
    }


@router.get("/demo-project-id")
async def get_demo_project_id():
    """Return the demo project ID for frontend convenience."""
    return {"project_id": str(DEMO_PROJECT_ID)}
