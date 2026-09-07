from __future__ import annotations

from typing import Any
from pydantic import BaseModel


class DelayRequest(BaseModel):
    task_code: str
    extra_days: float


class MovedTask(BaseModel):
    task_code: str
    name: str
    department: str
    owner: str
    delta: float
    from_date: str
    to_date: str


class DelayResult(BaseModel):
    project_end_before: float
    project_end_after: float
    project_end_delta: float
    end_date_before: str
    end_date_after: str
    tasks_moved: dict[str, Any]
    critical_path_changed: bool
    newly_critical: list[str]
    no_longer_critical: list[str]
    slack_consumed: dict[str, float]
    moved_detail: list[MovedTask]
    notify: list[str]


class AffectedTask(BaseModel):
    task_code: str
    name: str
    department: str
    owner: str
    status: str


class RequirementChangeRequest(BaseModel):
    req_code: str


class RequirementChangeResult(BaseModel):
    req_code: str
    text: str
    from_version: int
    to_version: int
    directly_consumed_by: list[str]
    must_redo: list[AffectedTask]
    must_recheck: list[AffectedTask]
    departments_hit: list[str]
    wasted_days: float
