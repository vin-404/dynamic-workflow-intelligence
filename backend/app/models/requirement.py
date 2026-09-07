import uuid

from sqlalchemy import String, Integer, ForeignKey, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.core.database import Base


class Requirement(Base):
    __tablename__ = "requirements"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    req_code: Mapped[str] = mapped_column(String(20), nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1)
    text: Mapped[str] = mapped_column(String(1000), nullable=False)

    # Relationships
    project: Mapped["Project"] = relationship("Project", back_populates="requirements")
    consumers: Mapped[list["RequirementConsumer"]] = relationship(
        "RequirementConsumer", back_populates="requirement", cascade="all, delete-orphan"
    )


class RequirementConsumer(Base):
    __tablename__ = "requirement_consumers"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4
    )
    requirement_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("requirements.id", ondelete="CASCADE"), nullable=False
    )
    task_code: Mapped[str] = mapped_column(String(20), nullable=False)

    # Relationships
    requirement: Mapped["Requirement"] = relationship(
        "Requirement", back_populates="consumers"
    )
