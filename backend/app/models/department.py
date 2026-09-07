import uuid

from sqlalchemy import String, Integer, ForeignKey, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db import Base


class DepartmentCapacity(Base):
    __tablename__ = "department_capacities"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    department: Mapped[str] = mapped_column(String(50), nullable=False)
    capacity: Mapped[int] = mapped_column(Integer, nullable=False)

    # Relationships
    project: Mapped["Project"] = relationship("Project", back_populates="dept_capacities")
