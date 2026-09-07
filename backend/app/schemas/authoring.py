"""
Input DTOs for authoring a workflow.

These are what the Phase 6 builder posts. Note what is absent: no
`department`, no `owner` string, no domain on any task. A task is named,
sized in effort, optionally divisible, and assigned to resources by key.
"""
from __future__ import annotations

import uuid
from datetime import date

from pydantic import BaseModel, Field, field_validator

from backend.app.core.workflow import ConstraintKind, DepType, TaskStatus


class DomainIn(BaseModel):
    key: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=160)
    description: str = ""
    vocabulary_hints: list[str] = Field(default_factory=list)
    task_templates: list[dict] = Field(default_factory=list)
    duration_variance_prior: float = 0.25


class DomainOut(BaseModel):
    id: uuid.UUID
    key: str
    name: str
    description: str
    vocabulary_hints: list[str]
    task_templates: list[dict]
    duration_variance_prior: float
    is_custom: bool

    model_config = {"from_attributes": True}


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str = ""
    goal: str = ""
    domain_id: uuid.UUID | None = None
    #: A custom domain created inline, as an alternative to `domain_id`. This
    #: is how "define your own domain" works without a separate round trip.
    new_domain: DomainIn | None = None
    start_date: date
    deadline: date | None = None
    today_day: float = 0.0
    owner_email: str | None = None


class ProjectOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str
    goal: str
    domain_id: uuid.UUID | None
    start_date: date
    deadline: date | None
    today_day: float
    current_version_id: uuid.UUID | None
    #: Who created it, from the identity they picked. None for a visitor who
    #: had not picked a name - which is allowed, because this is an identity
    #: and not a credential.
    created_by: uuid.UUID | None = None

    model_config = {"from_attributes": True}


class MemberIn(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    name: str = ""
    role: str = "editor"

    @field_validator("role")
    @classmethod
    def _role(cls, v: str) -> str:
        allowed = {"owner", "editor", "viewer"}
        if v not in allowed:
            raise ValueError(f"role must be one of {sorted(allowed)}")
        return v


class MemberOut(BaseModel):
    user_id: uuid.UUID
    email: str
    name: str
    role: str


class TaskIn(BaseModel):
    key: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=255)
    description: str = ""
    effort: float = Field(ge=0)
    divisible: bool = True
    priority: int = 0
    optimistic: float | None = None
    likely: float | None = None
    pessimistic: float | None = None
    required_skills: list[str] = Field(default_factory=list)
    status: TaskStatus = TaskStatus.NOT_STARTED
    #: Resource keys. One assignee means duration == effort; more than one
    #: applies the effort model, and a non-divisible task refuses the speedup.
    assignees: list[str] = Field(default_factory=list)


class TaskPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    effort: float | None = Field(default=None, ge=0)
    divisible: bool | None = None
    priority: int | None = None
    optimistic: float | None = None
    likely: float | None = None
    pessimistic: float | None = None
    required_skills: list[str] | None = None
    status: TaskStatus | None = None
    assignees: list[str] | None = None


class DependencyIn(BaseModel):
    from_task: str = Field(min_length=1, max_length=40)
    to_task: str = Field(min_length=1, max_length=40)
    dep_type: DepType = DepType.FS
    #: True marks an artifact dependency, which carries requirement
    #: invalidation. False is ordering only.
    consumes: bool = False


class ResourceIn(BaseModel):
    key: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=255)
    kind: str = "person"
    capacity: int = Field(default=1, ge=0)
    skills: list[str] = Field(default_factory=list)
    parent_key: str | None = None
    calendar_key: str | None = None


class AssignmentIn(BaseModel):
    resource_key: str = Field(min_length=1, max_length=40)
    allocation: float = Field(default=1.0, ge=0)


class ConstraintIn(BaseModel):
    kind: ConstraintKind
    target: str = Field(min_length=1, max_length=100)
    reason: str = ""
    value: float | None = None


class VersionOut(BaseModel):
    id: uuid.UUID
    version_no: int
    parent_version_id: uuid.UUID | None
    created_from_scenario_id: uuid.UUID | None
    note: str
    content_hash: str
    is_draft: bool
    deadline_day: float | None

    model_config = {"from_attributes": True}
