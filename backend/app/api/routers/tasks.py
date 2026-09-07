"""Task API router — CRUD operations for tasks within a project."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import get_db
from backend.app.models import Task
from backend.app.schemas.task import TaskCreate, TaskRead

router = APIRouter(prefix="/api/projects/{project_id}/tasks", tags=["tasks"])


@router.get("", response_model=list[TaskRead])
async def list_tasks(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Task).where(Task.project_id == project_id).order_by(Task.task_code)
    )
    return result.scalars().all()


@router.get("/{task_code}", response_model=TaskRead)
async def get_task(
    project_id: uuid.UUID,
    task_code: str,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Task).where(
            Task.project_id == project_id,
            Task.task_code == task_code,
        )
    )
    task = result.scalar_one_or_none()
    if task is None:
        raise HTTPException(status_code=404, detail=f"Task {task_code} not found")
    return task
