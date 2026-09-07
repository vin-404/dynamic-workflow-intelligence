from __future__ import annotations

import uuid
from pydantic import BaseModel


class TaskCreate(BaseModel):
    task_code: str
    name: str
    department: str
    owner: str
    planned_duration: float
    status: str = "not_started"


class TaskRead(BaseModel):
    id: uuid.UUID
    task_code: str
    name: str
    department: str
    owner: str
    planned_duration: float
    actual_duration: float | None
    status: str

    model_config = {"from_attributes": True}


class TaskRow(BaseModel):
    task_code: str
    name: str
    department: str
    owner: str
    planned_duration: float
    status: str
    es: float
    ef: float
    ls: float
    lf: float
    slack: float
    critical: bool
    start_date: str
    end_date: str
    depends_on: list[str]
