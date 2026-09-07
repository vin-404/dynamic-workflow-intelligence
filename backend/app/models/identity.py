"""Identity, access and domain context.

Deliberately thin (ARCHITECTURE C): three roles, no permission matrix, no SSO.
A `Domain` is a table row and not an enum, which is what makes "define your
own domain" a feature rather than a code change.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, Float, ForeignKey, JSON, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db import Base
from backend.app.models.base import created_at, pk


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = pk()
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = created_at()

    memberships: Mapped[list["ProjectMember"]] = relationship(
        "ProjectMember", back_populates="user", cascade="all, delete-orphan"
    )


class Domain(Base):
    """Context for the LLM and defaults for the UI. **Never an engine input.**"""

    __tablename__ = "domains"

    id: Mapped[uuid.UUID] = pk()
    key: Mapped[str] = mapped_column(String(80), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str] = mapped_column(String(1000), default="")
    vocabulary_hints: Mapped[list] = mapped_column(JSON, default=list)
    task_templates: Mapped[list] = mapped_column(JSON, default=list)
    #: A plain number handed to the simulator as a spread, never as a domain
    #: identity the engine could branch on.
    duration_variance_prior: Mapped[float] = mapped_column(Float, default=0.25)
    is_custom: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = created_at()

    projects: Mapped[list["Project"]] = relationship("Project", back_populates="domain")


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = pk()
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(String(1000), default="")
    goal: Mapped[str] = mapped_column(String(1000), default="")
    domain_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("domains.id", ondelete="SET NULL"), nullable=True
    )
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    #: Calendar deadline. The engine only ever sees the integer day offset,
    #: converted at the API boundary.
    deadline: Mapped[date | None] = mapped_column(Date, nullable=True)
    #: How far into the project "now" is, in working days. The clock is data,
    #: so analysis is reproducible.
    today_day: Mapped[float] = mapped_column(Float, default=0.0)
    #: The version the project currently points at. Moved only by an explicit
    #: apply (ARCHITECTURE A.2).
    current_version_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, nullable=True
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = created_at()

    domain: Mapped["Domain | None"] = relationship("Domain", back_populates="projects")
    members: Mapped[list["ProjectMember"]] = relationship(
        "ProjectMember", back_populates="project", cascade="all, delete-orphan"
    )
    versions: Mapped[list["WorkflowVersion"]] = relationship(
        "WorkflowVersion", back_populates="project", cascade="all, delete-orphan"
    )
    events: Mapped[list["Event"]] = relationship(
        "Event", back_populates="project", cascade="all, delete-orphan"
    )


class ProjectMember(Base):
    __tablename__ = "project_members"

    id: Mapped[uuid.UUID] = pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    #: owner | editor | viewer. Three roles, no RBAC beyond that.
    role: Mapped[str] = mapped_column(String(20), default="editor", nullable=False)
    created_at: Mapped[datetime] = created_at()

    project: Mapped["Project"] = relationship("Project", back_populates="members")
    user: Mapped["User"] = relationship("User", back_populates="memberships")
