"""
The immutable workflow snapshot, in the database.

`WorkflowVersion` and everything scoped to it are written once and never
updated. Authoring edits create a new draft version; applying a scenario
creates a new version and moves the project pointer. The parent always
survives, which is what gives undo, comparison, provenance and "apply this
improvement" for free (ARCHITECTURE A.2).

Full row copy on version bump, not base+delta - deliberate, stated in
ARCHITECTURE C: simpler, correct, and these workflows are tiny. Deltas exist
only for `Scenario`, which is ephemeral.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    Float,
    ForeignKey,
    Integer,
    JSON,
    String,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db import Base
from backend.app.models.base import created_at, pk


class WorkflowVersion(Base):
    __tablename__ = "workflow_versions"
    __table_args__ = (UniqueConstraint("project_id", "version_no"),)

    id: Mapped[uuid.UUID] = pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    parent_version_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("workflow_versions.id", ondelete="SET NULL"), nullable=True
    )
    #: Set when this version was produced by applying a scenario, so every
    #: change has provenance.
    created_from_scenario_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, nullable=True
    )
    note: Mapped[str] = mapped_column(String(500), default="")
    #: Hash of the canonical snapshot projection. Phase 3 asserts a base
    #: version's hash is unchanged after a scenario is evaluated against it.
    content_hash: Mapped[str] = mapped_column(String(64), default="")
    #: True while the version is still being authored. An applied version is
    #: sealed.
    is_draft: Mapped[bool] = mapped_column(Boolean, default=True)
    #: Deadline as an integer working-day offset, the only form the engine sees.
    deadline_day: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = created_at()

    project: Mapped["Project"] = relationship("Project", back_populates="versions")
    tasks: Mapped[list["Task"]] = relationship(
        "Task", back_populates="version", cascade="all, delete-orphan"
    )
    dependencies: Mapped[list["Dependency"]] = relationship(
        "Dependency", back_populates="version", cascade="all, delete-orphan"
    )
    resources: Mapped[list["Resource"]] = relationship(
        "Resource", back_populates="version", cascade="all, delete-orphan"
    )
    assignments: Mapped[list["Assignment"]] = relationship(
        "Assignment", back_populates="version", cascade="all, delete-orphan"
    )
    requirements: Mapped[list["Requirement"]] = relationship(
        "Requirement", back_populates="version", cascade="all, delete-orphan"
    )
    constraints: Mapped[list["Constraint"]] = relationship(
        "Constraint", back_populates="version", cascade="all, delete-orphan"
    )
    calendars: Mapped[list["Calendar"]] = relationship(
        "Calendar", back_populates="version", cascade="all, delete-orphan"
    )


class Task(Base):
    __tablename__ = "tasks"
    __table_args__ = (UniqueConstraint("version_id", "key"),)

    id: Mapped[uuid.UUID] = pk()
    version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("workflow_versions.id", ondelete="CASCADE"), nullable=False
    )
    key: Mapped[str] = mapped_column(String(40), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(String(2000), default="")
    #: Work content, in working days. Duration is derived from effort and
    #: assignee count by the effort model; it is never stored.
    effort: Mapped[float] = mapped_column(Float, nullable=False)
    effort_unit: Mapped[str] = mapped_column(String(20), default="day")
    optimistic: Mapped[float | None] = mapped_column(Float, nullable=True)
    likely: Mapped[float | None] = mapped_column(Float, nullable=True)
    pessimistic: Mapped[float | None] = mapped_column(Float, nullable=True)
    #: False means extra assignees give no speedup at all - an approval, a
    #: single-signature review, a one-oven bake.
    divisible: Mapped[bool] = mapped_column(Boolean, default=True)
    priority: Mapped[int] = mapped_column(Integer, default=0)
    required_skills: Mapped[list] = mapped_column(JSON, default=list)
    #: Observed state. Lives on the version row because a version is a
    #: snapshot of the workflow *as it stood*.
    status: Mapped[str] = mapped_column(String(20), default="not_started")
    actual_start_day: Mapped[float | None] = mapped_column(Float, nullable=True)
    actual_end_day: Mapped[float | None] = mapped_column(Float, nullable=True)

    version: Mapped["WorkflowVersion"] = relationship(
        "WorkflowVersion", back_populates="tasks"
    )


class Dependency(Base):
    __tablename__ = "dependencies"
    __table_args__ = (UniqueConstraint("version_id", "from_task", "to_task"),)

    id: Mapped[uuid.UUID] = pk()
    version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("workflow_versions.id", ondelete="CASCADE"), nullable=False
    )
    from_task: Mapped[str] = mapped_column(String(40), nullable=False)
    to_task: Mapped[str] = mapped_column(String(40), nullable=False)
    #: FS | SS | FF
    dep_type: Mapped[str] = mapped_column(String(4), default="FS")
    #: True = artifact dependency: the successor consumes something the
    #: predecessor produces, so a requirement change invalidates it. False =
    #: ordering only, and therefore droppable by the optimizer if unprotected.
    consumes: Mapped[bool] = mapped_column(Boolean, default=False)

    version: Mapped["WorkflowVersion"] = relationship(
        "WorkflowVersion", back_populates="dependencies"
    )


class Resource(Base):
    """What replaced `Department`.

    `kind` is data - "person", "team", "equipment", "budget". A campus event
    has departments, a software project has teams, a factory has machines. The
    engine sees only resources with capacity, which is what makes the platform
    domain-agnostic in the schema rather than in the marketing copy.
    """

    __tablename__ = "resources"
    __table_args__ = (UniqueConstraint("version_id", "key"),)

    id: Mapped[uuid.UUID] = pk()
    version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("workflow_versions.id", ondelete="CASCADE"), nullable=False
    )
    key: Mapped[str] = mapped_column(String(40), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    kind: Mapped[str] = mapped_column(String(40), default="person")
    capacity: Mapped[int] = mapped_column(Integer, default=1)
    skills: Mapped[list] = mapped_column(JSON, default=list)
    #: Roll-up parent, so a team can cap throughput below the sum of its
    #: members (decision D-16).
    parent_key: Mapped[str | None] = mapped_column(String(40), nullable=True)
    calendar_key: Mapped[str | None] = mapped_column(String(40), nullable=True)
    #: Present when this resource is a real person with an account.
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    version: Mapped["WorkflowVersion"] = relationship(
        "WorkflowVersion", back_populates="resources"
    )


class Assignment(Base):
    __tablename__ = "assignments"
    __table_args__ = (UniqueConstraint("version_id", "task_key", "resource_key"),)

    id: Mapped[uuid.UUID] = pk()
    version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("workflow_versions.id", ondelete="CASCADE"), nullable=False
    )
    task_key: Mapped[str] = mapped_column(String(40), nullable=False)
    resource_key: Mapped[str] = mapped_column(String(40), nullable=False)
    allocation: Mapped[float] = mapped_column(Float, default=1.0)

    version: Mapped["WorkflowVersion"] = relationship(
        "WorkflowVersion", back_populates="assignments"
    )


class Requirement(Base):
    __tablename__ = "requirements"
    __table_args__ = (UniqueConstraint("version_id", "key"),)

    id: Mapped[uuid.UUID] = pk()
    version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("workflow_versions.id", ondelete="CASCADE"), nullable=False
    )
    key: Mapped[str] = mapped_column(String(40), nullable=False)
    version_no: Mapped[int] = mapped_column(Integer, default=1)
    text: Mapped[str] = mapped_column(String(2000), nullable=False)
    #: Task keys that consumed this requirement. A list, because normalising
    #: it buys nothing here (ARCHITECTURE C).
    consumed_by_task_keys: Mapped[list] = mapped_column(JSON, default=list)

    version: Mapped["WorkflowVersion"] = relationship(
        "WorkflowVersion", back_populates="requirements"
    )


class Constraint(Base):
    """Without this table the optimizer cheats (ARCHITECTURE D.5 step 4)."""

    __tablename__ = "constraints"

    id: Mapped[uuid.UUID] = pk()
    version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("workflow_versions.id", ondelete="CASCADE"), nullable=False
    )
    #: MANDATORY_TASK | IMMUTABLE_DEPENDENCY | NON_DIVISIBLE_TASK |
    #: FIXED_ASSIGNMENT | MIN_DURATION
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    #: Task key, resource key, or "FROM->TO" for a dependency.
    target: Mapped[str] = mapped_column(String(100), nullable=False)
    #: Shown to the user verbatim when a candidate is rejected. The reason is
    #: the feature, not the rejection.
    reason: Mapped[str] = mapped_column(String(1000), default="")
    value: Mapped[float | None] = mapped_column(Float, nullable=True)

    version: Mapped["WorkflowVersion"] = relationship(
        "WorkflowVersion", back_populates="constraints"
    )


class Calendar(Base):
    __tablename__ = "calendars"
    __table_args__ = (UniqueConstraint("version_id", "key"),)

    id: Mapped[uuid.UUID] = pk()
    version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("workflow_versions.id", ondelete="CASCADE"), nullable=False
    )
    key: Mapped[str] = mapped_column(String(40), nullable=False)
    #: Monday = 0 .. Sunday = 6.
    working_days: Mapped[list] = mapped_column(JSON, default=lambda: [0, 1, 2, 3, 4])
    holidays: Mapped[list] = mapped_column(JSON, default=list)

    version: Mapped["WorkflowVersion"] = relationship(
        "WorkflowVersion", back_populates="calendars"
    )


class Event(Base):
    """Append-only status transitions. Feeds the Tier-2 detectors, and is what
    makes findings evidential rather than inferred.

    Scoped to the project, not the version: history is about what happened,
    and it survives every version bump.
    """

    __tablename__ = "events"

    id: Mapped[uuid.UUID] = pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    day: Mapped[float] = mapped_column(Float, nullable=False)
    task_key: Mapped[str] = mapped_column(String(40), nullable=False)
    actor: Mapped[str] = mapped_column(String(255), default="")
    from_status: Mapped[str] = mapped_column(String(20), nullable=False)
    to_status: Mapped[str] = mapped_column(String(20), nullable=False)
    created_at: Mapped[datetime] = created_at()

    project: Mapped["Project"] = relationship("Project", back_populates="events")
