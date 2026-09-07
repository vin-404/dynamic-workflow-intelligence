"""Projects, members and version history."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.workflow import WorkflowSnapshot
from backend.app.api.identity import current_user
from backend.app.db import get_db
from backend.app.models import Domain, Project, ProjectMember, User
from backend.app.schemas.authoring import (
    MemberIn,
    MemberOut,
    ProjectIn,
    ProjectOut,
    VersionOut,
)
from backend.app.services import versions as V

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("", response_model=list[ProjectOut])
async def list_projects(db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(select(Project).order_by(Project.created_at))
    ).scalars().all()
    return list(rows)


@router.get("/{project_id}", response_model=ProjectOut)
async def get_project(project_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    try:
        return await V.get_project(db, project_id)
    except V.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("", response_model=ProjectOut, status_code=201)
async def create_project(
    payload: ProjectIn,
    db: AsyncSession = Depends(get_db),
    who: User | None = Depends(current_user),
):
    """Create a project and its empty version 1.

    A project starts with a real, empty workflow version rather than with
    nothing, so the builder always has something to write into and
    `analyze` never has to special-case "no version yet".
    """
    domain_id = payload.domain_id
    if payload.new_domain is not None:
        existing = (
            await db.execute(
                select(Domain).where(Domain.key == payload.new_domain.key)
            )
        ).scalar_one_or_none()
        if existing is not None:
            domain_id = existing.id
        else:
            dom = Domain(
                key=payload.new_domain.key,
                name=payload.new_domain.name,
                description=payload.new_domain.description,
                vocabulary_hints=list(payload.new_domain.vocabulary_hints),
                task_templates=[dict(t) for t in payload.new_domain.task_templates],
                duration_variance_prior=payload.new_domain.duration_variance_prior,
                is_custom=True,
            )
            db.add(dom)
            await db.flush()
            domain_id = dom.id
    elif domain_id is not None:
        exists = (
            await db.execute(select(Domain).where(Domain.id == domain_id))
        ).scalar_one_or_none()
        if exists is None:
            raise HTTPException(status_code=422, detail="Unknown domain_id.")

    # The name the visitor picked owns what they create. An explicit
    # `owner_email` still wins - the seed loader and the tests use it - but a
    # person clicking "new workflow" should not have to type their own email
    # to end up on the member list.
    owner: User | None = who
    if payload.owner_email:
        owner = (
            await db.execute(select(User).where(User.email == payload.owner_email))
        ).scalar_one_or_none()
        if owner is None:
            owner = User(email=payload.owner_email, name=payload.owner_email)
            db.add(owner)
            await db.flush()

    if payload.deadline is not None and payload.deadline < payload.start_date:
        raise HTTPException(
            status_code=422,
            detail="The deadline is before the start date.",
        )

    project = Project(
        name=payload.name,
        description=payload.description,
        goal=payload.goal,
        domain_id=domain_id,
        start_date=payload.start_date,
        deadline=payload.deadline,
        today_day=payload.today_day,
        created_by=owner.id if owner else None,
    )
    db.add(project)
    await db.flush()

    if owner is not None:
        db.add(ProjectMember(project_id=project.id, user_id=owner.id, role="owner"))

    empty = WorkflowSnapshot.build(
        tasks=(),
        deadline_day=V.date_to_day(payload.start_date, payload.deadline),
    )
    version = await V.write_version(
        db, project.id, empty, note="Empty workflow", is_draft=True
    )
    project.current_version_id = version.id

    await db.commit()
    await db.refresh(project)
    return project


@router.get("/{project_id}/members", response_model=list[MemberOut])
async def list_members(project_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    try:
        await V.get_project(db, project_id)
    except V.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    rows = (
        await db.execute(
            select(ProjectMember, User)
            .join(User, User.id == ProjectMember.user_id)
            .where(ProjectMember.project_id == project_id)
        )
    ).all()
    return [
        MemberOut(user_id=u.id, email=u.email, name=u.name, role=m.role)
        for m, u in rows
    ]


@router.post("/{project_id}/members", response_model=MemberOut, status_code=201)
async def add_member(
    project_id: uuid.UUID, payload: MemberIn, db: AsyncSession = Depends(get_db)
):
    try:
        await V.get_project(db, project_id)
    except V.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))

    user = (
        await db.execute(select(User).where(User.email == payload.email))
    ).scalar_one_or_none()
    if user is None:
        user = User(email=payload.email, name=payload.name or payload.email)
        db.add(user)
        await db.flush()

    existing = (
        await db.execute(
            select(ProjectMember).where(
                ProjectMember.project_id == project_id,
                ProjectMember.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        existing.role = payload.role
        member = existing
    else:
        member = ProjectMember(
            project_id=project_id, user_id=user.id, role=payload.role
        )
        db.add(member)

    await db.commit()
    return MemberOut(
        user_id=user.id, email=user.email, name=user.name, role=member.role
    )


@router.delete("/{project_id}/members/{user_id}", status_code=204)
async def remove_member(
    project_id: uuid.UUID, user_id: uuid.UUID, db: AsyncSession = Depends(get_db)
):
    row = (
        await db.execute(
            select(ProjectMember).where(
                ProjectMember.project_id == project_id,
                ProjectMember.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Member not found")
    await db.delete(row)
    await db.commit()


@router.get("/{project_id}/versions", response_model=list[VersionOut])
async def list_versions(project_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """Full history. Applying a change never destroys the version it came from."""
    try:
        await V.get_project(db, project_id)
    except V.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    return await V.list_versions(db, project_id)
