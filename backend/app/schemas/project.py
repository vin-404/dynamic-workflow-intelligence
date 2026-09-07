from __future__ import annotations

import uuid
from datetime import date

from pydantic import BaseModel

from backend.app.schemas.task import TaskRow
from backend.app.schemas.bottleneck import BottleneckRead


class ProjectCreate(BaseModel):
    name: str
    description: str = ""
    start_date: date
    today_day: float = 0.0


class ProjectRead(BaseModel):
    id: uuid.UUID
    name: str
    description: str
    start_date: date
    today_day: float

    model_config = {"from_attributes": True}


class EdgeRead(BaseModel):
    source: str  # predecessor task_code
    target: str  # successor task_code
    kind: str


class RequirementRead(BaseModel):
    req_code: str
    version: int
    text: str
    consumed_by: list[str]


class DeptCapacity(BaseModel):
    department: str
    capacity: int


class ProjectState(BaseModel):
    project_id: uuid.UUID
    project_name: str
    project_start: str
    today_day: float
    planned_end: float
    projected_end: float
    planned_end_date: str
    projected_end_date: str
    slip_days: float
    critical_path: list[str]
    tasks: list[TaskRow]
    edges: list[EdgeRead]
    departments: dict[str, int]
    bottlenecks: list[BottleneckRead]
    requirements: list[RequirementRead]
