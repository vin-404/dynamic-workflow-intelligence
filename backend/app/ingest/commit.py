"""
Turning an accepted plan into a project.

Two rules shape this module.

**An import never touches a live workflow.** Commit creates a *new* project
with its own version 1. There is no merge, no upsert and no "import into
project X": a bulk write built out of inference, landing on top of work
somebody has been maintaining by hand, is how a planning tool loses a user's
trust in one click. Wanting the two joined is a real wish; the answer is to
import, look, and then move what you want across with the mutation algebra,
which is reversible and leaves provenance behind. This is not.

**A project created here is indistinguishable from one created by hand.** The
same `Project` fields, the same owner `ProjectMember` row with role `owner`,
the same draft version 1 written by `services.versions.write_version`. Nothing
in the rest of the application should be able to tell, and nothing should have
to special-case an imported project. The only difference is the version note,
which records where the rows came from - that is provenance, not behaviour.

**And no history is invented.** The tasks arrive with the statuses the file
stated, but the project's event log starts empty, because the file did not say
*when* anything moved. The analysis will then correctly report that its
history-dependent checks could not run, instead of running them on fiction.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.ingest.plan import ImportPlan
from backend.app.models import Domain, Project, ProjectMember, User
from backend.app.services import versions as V


class CommitRefused(Exception):
    """The plan cannot be committed. `detail` is rendered as a 422 body."""

    def __init__(self, detail):
        self.detail = detail
        super().__init__(str(detail))


async def commit_plan(
    db: AsyncSession,
    plan: ImportPlan,
    *,
    name: str,
    description: str = "",
    goal: str = "",
    domain_id: uuid.UUID | None = None,
    today_day: float = 0.0,
    owner_email: str | None = None,
    who: User | None = None,
    blocking: list[str] | None = None,
    csv_sha256: str = "",
) -> dict:
    """Create the project, its owner membership and its version 1.

    Commits the session, the way `POST /api/projects` does, so a caller that
    gets a 201 has a project that survives the process.
    """
    if blocking:
        raise CommitRefused(
            {
                "reason": "import_would_not_schedule",
                "blocking": blocking,
                "message": (
                    "Nothing was created. Fix the source file and preview "
                    "again; this endpoint refuses rather than importing a "
                    "workflow it already knows cannot be scheduled."
                ),
            }
        )

    if domain_id is not None:
        exists = (
            await db.execute(select(Domain).where(Domain.id == domain_id))
        ).scalar_one_or_none()
        if exists is None:
            raise CommitRefused("Unknown domain_id.")

    # Identical to `POST /api/projects`: an explicit `owner_email` wins, and
    # otherwise whoever is signed in owns what they create.
    owner: User | None = who
    if owner_email:
        owner = (
            await db.execute(select(User).where(User.email == owner_email))
        ).scalar_one_or_none()
        if owner is None:
            owner = User(email=owner_email, name=owner_email)
            db.add(owner)
            await db.flush()

    project = Project(
        name=name,
        description=description,
        goal=goal,
        domain_id=domain_id,
        start_date=plan.start_date,
        deadline=plan.deadline,
        today_day=today_day,
        created_by=owner.id if owner else None,
    )
    db.add(project)
    await db.flush()

    if owner is not None:
        db.add(ProjectMember(project_id=project.id, user_id=owner.id, role="owner"))

    snapshot = plan.snapshot()
    version = await V.write_version(
        db,
        project.id,
        snapshot,
        statuses=dict(plan.statuses),
        note=(
            f"Imported from a {plan.source} CSV"
            + (f" (sha256 {csv_sha256[:12]})" if csv_sha256 else "")
        ),
        is_draft=True,
    )
    project.current_version_id = version.id

    await db.commit()
    await db.refresh(project)

    return {
        "project_id": str(project.id),
        "version_id": str(version.id),
        "version_no": version.version_no,
        "content_hash": version.content_hash,
        "is_draft": version.is_draft,
        "name": project.name,
        "start_date": project.start_date.isoformat(),
        "deadline": project.deadline.isoformat() if project.deadline else None,
        "today_day": project.today_day,
        "created_by": str(project.created_by) if project.created_by else None,
        "owner_email": owner.email if owner else None,
    }
