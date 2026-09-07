import uuid
from datetime import date

from sqlalchemy import String, Date, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db import Base


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(String(1000), default="")
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    today_day: Mapped[float] = mapped_column(default=0.0)

    # Relationships
    tasks: Mapped[list["Task"]] = relationship(
        "Task", back_populates="project", cascade="all, delete-orphan"
    )
    dependencies: Mapped[list["Dependency"]] = relationship(
        "Dependency", back_populates="project", cascade="all, delete-orphan"
    )
    events: Mapped[list["Event"]] = relationship(
        "Event", back_populates="project", cascade="all, delete-orphan"
    )
    requirements: Mapped[list["Requirement"]] = relationship(
        "Requirement", back_populates="project", cascade="all, delete-orphan"
    )
    dept_capacities: Mapped[list["DepartmentCapacity"]] = relationship(
        "DepartmentCapacity", back_populates="project", cascade="all, delete-orphan"
    )
