"""
Requirement revisions - what a requirement used to say, and who changed it.

**Why this table exists at all.** `Requirement` carries only `version_no` and
the *current* `text`. Bumping a requirement overwrites the wording, so the
previous one is gone and "diff v1 against v3" is unanswerable. A requirement
change is the most expensive thing that happens to a plan; losing the record
of it is the one place this system was still a planner rather than a tracker.

**Why it is scoped to the project and not to a workflow version.** A
`WorkflowVersion` copies every row on every bump (ARCHITECTURE C), so a
version-scoped history would be duplicated wholesale each time somebody edited
an unrelated task, and the authorship of a change would be re-stamped with the
copy. History is about *what happened*, and it outlives every version - which
is exactly the argument `Event` already makes for itself. So this table sits
beside `Event`, on the project.

**Why the full text and not a delta.** Same reason ARCHITECTURE C gives for
full row copy: these strings are at most 2 KB, deltas would need replaying to
answer the one question anybody asks, and a replay that goes wrong silently
produces a wording nobody ever wrote. Two lookups beat a reconstruction.

**Why `consumed_by_task_keys` is copied onto the row.** The blast radius of a
change is computed from the tasks that consumed the requirement. Asking later
what v1 -> v2 cost has to use the consumption set that existed *then*; the
graph has usually moved on. Without this column the historical answer would be
quietly recomputed against today's workflow and presented as history.

**Why `impact_summary`.** It records what the impact report said the change
would cost, at the moment somebody accepted it. That is the audit trail for a
prediction - it is stored as the claim it was, and nothing in this system
back-dates it.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    ForeignKey,
    Integer,
    JSON,
    String,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.db import Base
from backend.app.models.base import created_at, pk


class RequirementRevision(Base):
    """One wording of one requirement, and the circumstances it arrived in.

    Append-only. A row is written when a requirement change is applied, never
    updated afterwards - the same discipline as `WorkflowVersion` and `Event`.
    """

    __tablename__ = "requirement_revisions"
    __table_args__ = (
        UniqueConstraint("project_id", "requirement_key", "version_no"),
    )

    id: Mapped[uuid.UUID] = pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    requirement_key: Mapped[str] = mapped_column(String(40), nullable=False)
    #: The requirement version this row *is* the text of, not the one it
    #: replaced. `version_no=1` is the original wording.
    version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    text: Mapped[str] = mapped_column(String(2000), nullable=False)
    #: The tasks that consumed the requirement when this wording was current.
    #: Kept so a historical impact is computed against the graph as it stood.
    consumed_by_task_keys: Mapped[list] = mapped_column(JSON, default=list)

    #: Provenance. The workflow version this wording became current in, and
    #: the scenario whose apply created it - so every revision points back at
    #: the single write path that produced it.
    workflow_version_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("workflow_versions.id", ondelete="SET NULL"),
        nullable=True,
    )
    scenario_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)

    #: Who. Nullable because this instance is usable signed out, and a change
    #: with no attributable author is reported as such rather than guessed at.
    changed_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    #: Display label captured at the time, so history survives the user row
    #: being deleted or renamed.
    changed_by: Mapped[str] = mapped_column(String(255), default="")
    note: Mapped[str] = mapped_column(String(1000), default="")

    #: True when the row was reconstructed from a workflow snapshot rather
    #: than recorded as it happened - the original wording of a requirement
    #: that predates this table. Its author and timestamp are unknown, and
    #: the API says so instead of implying otherwise.
    backfilled: Mapped[bool] = mapped_column(Boolean, default=False)

    #: The headline numbers the impact report gave for this change, as they
    #: were claimed at the time. Null on a backfilled row: nobody predicted
    #: the original wording.
    impact_summary: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = created_at()
