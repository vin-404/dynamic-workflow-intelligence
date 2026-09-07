"""Project API router — CRUD and intelligence endpoints."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db import get_db
from backend.app.models import Project
from backend.app.schemas.project import ProjectCreate, ProjectRead
from backend.app.services import intelligence

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("", response_model=list[ProjectRead])
async def list_projects(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Project))
    return result.scalars().all()


@router.get("/{project_id}", response_model=ProjectRead)
async def get_project(project_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.get("/{project_id}/state")
async def get_project_state(project_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """Full project intelligence state — schedule, bottlenecks, tasks, deps."""
    try:
        return await intelligence.get_project_state(db, project_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/{project_id}/accuracy")
async def get_accuracy(project_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """Detector accuracy against planted ground truth (demo verification)."""
    try:
        return await intelligence.get_accuracy(db, project_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
