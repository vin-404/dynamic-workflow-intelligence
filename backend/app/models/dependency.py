import uuid

from sqlalchemy import String, ForeignKey, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db import Base


class Dependency(Base):
    __tablename__ = "dependencies"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, default=uuid.uuid4
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    predecessor_code: Mapped[str] = mapped_column(String(20), nullable=False)
    successor_code: Mapped[str] = mapped_column(String(20), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)  # 'artifact' or 'temporal'

    # Relationships
    project: Mapped["Project"] = relationship("Project", back_populates="dependencies")
