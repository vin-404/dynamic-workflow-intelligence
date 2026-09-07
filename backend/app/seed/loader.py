"""
Persist the seed fixtures.

Replaces the prototype's `seed_demo_project`, which hardcoded one campus
event. Loading is idempotent by fixture key, and `reset_and_seed` drops every
table and reloads both domains - the single command Phase 8's demo path needs.
"""
from __future__ import annotations

import uuid

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db import Base, engine
from backend.app.models import (
    Domain,
    Event,
    Project,
    ProjectMember,
    User,
)
from backend.app.seed.fixtures import (
    DOMAINS,
    DomainFixture,
    ProjectFixture,
    all_fixtures,
    fixture,
)
from backend.app.services import versions as V

#: Deterministic ids so the demo path and the frontend can deep-link without
#: a lookup round trip.
PROJECT_IDS: dict[str, uuid.UUID] = {
    "campus-symposium": uuid.UUID("00000000-0000-0000-0000-000000000001"),
    "battery-pilot-line": uuid.UUID("00000000-0000-0000-0000-000000000002"),
}

#: The project the prototype exposed as `DEMO_PROJECT_ID`. Kept stable so
#: existing links and the regression suite keep working.
DEMO_PROJECT_ID = PROJECT_IDS["campus-symposium"]


async def _upsert_user(db: AsyncSession, email: str, name: str) -> User:
    row = (
        await db.execute(select(User).where(User.email == email))
    ).scalar_one_or_none()
    if row is not None:
        return row
    row = User(email=email, name=name)
    db.add(row)
    await db.flush()
    return row


async def _upsert_domain(db: AsyncSession, dom: DomainFixture) -> Domain:
    row = (
        await db.execute(select(Domain).where(Domain.key == dom.key))
    ).scalar_one_or_none()
    if row is not None:
        return row
    row = Domain(
        key=dom.key,
        name=dom.name,
        description=dom.description,
        vocabulary_hints=list(dom.vocabulary_hints),
        task_templates=[dict(t) for t in dom.task_templates],
        duration_variance_prior=dom.duration_variance_prior,
        is_custom=False,
    )
    db.add(row)
    await db.flush()
    return row


async def seed_domains(db: AsyncSession) -> list[Domain]:
    """Seeded domains are just rows. Users create their own the same way."""
    return [await _upsert_domain(db, d) for d in DOMAINS]


async def load_fixture(db: AsyncSession, fx: ProjectFixture) -> uuid.UUID:
    """Create the project, its version 1, its members and its history.

    Idempotent: if the project id already exists, nothing is written.
    """
    project_id = PROJECT_IDS.get(fx.key, uuid.uuid4())
    existing = (
        await db.execute(select(Project).where(Project.id == project_id))
    ).scalar_one_or_none()
    if existing is not None:
        return project_id

    domain = await _upsert_domain(db, fx.domain)
    owner = await _upsert_user(db, fx.owner_email, "Programme Lead")

    deadline = None
    if fx.snapshot.deadline_day is not None:
        from datetime import timedelta

        deadline = fx.start_date + timedelta(days=int(fx.snapshot.deadline_day))

    project = Project(
        id=project_id,
        name=fx.name,
        description=fx.description,
        goal=fx.goal,
        domain_id=domain.id,
        start_date=fx.start_date,
        deadline=deadline,
        today_day=fx.today_day,
        created_by=owner.id,
    )
    db.add(project)
    await db.flush()

    for member in fx.members:
        user = await _upsert_user(db, member.email, member.name)
        db.add(ProjectMember(
            project_id=project.id, user_id=user.id, role=member.role
        ))

    version = await V.write_version(
        db,
        project.id,
        fx.snapshot,
        statuses=dict(fx.state.statuses),
        note=f"Seeded from fixture {fx.key}",
        is_draft=False,
    )
    project.current_version_id = version.id

    for e in fx.state.events:
        db.add(Event(
            project_id=project.id,
            day=e.day,
            task_key=e.task_key,
            actor=e.actor,
            from_status=e.from_status.value,
            to_status=e.to_status.value,
        ))

    await db.flush()
    return project_id


async def seed_all(db: AsyncSession) -> dict[str, str]:
    """Load every fixture. Idempotent, so it is safe on every startup."""
    await seed_domains(db)
    out: dict[str, str] = {}
    for fx in all_fixtures():
        out[fx.key] = str(await load_fixture(db, fx))
    await db.commit()
    return out


async def seed_one(db: AsyncSession, key: str) -> uuid.UUID:
    fx = fixture(key)
    project_id = await load_fixture(db, fx)
    await db.commit()
    return project_id


async def reset_and_seed(db: AsyncSession) -> dict[str, str]:
    """Drop every table, recreate, and reload both domains.

    The one command Phase 8's demo path needs, and the reason no Alembic
    migration is required (decision D-03). Destructive by design and only
    reachable from an explicit call.
    """
    await db.rollback()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    return await seed_all(db)


async def clear_projects(db: AsyncSession) -> None:
    """Remove seeded projects without touching the schema. Used by tests that
    need a clean slate but not a full drop."""
    for pid in PROJECT_IDS.values():
        await db.execute(delete(Project).where(Project.id == pid))
    await db.commit()
