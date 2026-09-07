"""
Identity without authentication.

The product is multi-user; it is not multi-tenant and it has no accounts. A
user picks a name on first visit, the browser remembers it, and that identity
is what appears on `created_by` and in the member list.

There is deliberately **no login, no password, no session, no token**. Anyone
with the URL can pick any identity, including an existing one. That is the
correct amount of security for a shared demo of a planning tool, and building
less than a real auth system while pretending otherwise would be worse than
building none.

Nothing here enforces permission. `ProjectMember.role` is advisory and the UI
uses it to phrase things, not to forbid them.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db import get_db
from backend.app.models import Project, ProjectMember, User

router = APIRouter(prefix="/api/users", tags=["users"])


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    name: str
    project_count: int = 0


class UserIn(BaseModel):
    #: A name, not credentials. The email is an identifier, not a login.
    name: str = Field(min_length=1, max_length=255)
    email: str | None = Field(default=None, max_length=255)


def _slug(name: str) -> str:
    cleaned = "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-")
    while "--" in cleaned:
        cleaned = cleaned.replace("--", "-")
    return cleaned or "someone"


@router.get("", response_model=list[UserOut])
async def list_users(db: AsyncSession = Depends(get_db)):
    """Everyone who has used this instance, most-connected first.

    This is the name picker's list. It is not a directory and it is not
    private: on a shared demo instance, everyone can see everyone.
    """
    counts = dict(
        (
            await db.execute(
                select(ProjectMember.user_id, func.count())
                .group_by(ProjectMember.user_id)
            )
        ).all()
    )
    rows = (await db.execute(select(User).order_by(User.created_at))).scalars().all()
    people = [
        UserOut(
            id=u.id, email=u.email, name=u.name,
            project_count=counts.get(u.id, 0),
        )
        for u in rows
    ]
    people.sort(key=lambda u: (-u.project_count, u.name.lower()))
    return people


@router.post("", response_model=UserOut, status_code=201)
async def create_or_get_user(payload: UserIn, db: AsyncSession = Depends(get_db)):
    """Pick a name.

    Returning the existing row for a known email rather than refusing is
    deliberate: "come back tomorrow and carry on" has to work, and there is no
    password to check them against.
    """
    email = (payload.email or f"{_slug(payload.name)}@local").strip().lower()
    existing = (
        await db.execute(select(User).where(User.email == email))
    ).scalar_one_or_none()
    if existing is not None:
        # A returning user may have changed how they spell their name.
        if payload.name and payload.name != existing.name:
            existing.name = payload.name
            await db.commit()
        return UserOut(id=existing.id, email=existing.email, name=existing.name)

    user = User(email=email, name=payload.name)
    db.add(user)
    await db.commit()
    return UserOut(id=user.id, email=user.email, name=user.name)


@router.get("/{user_id}", response_model=UserOut)
async def get_user(user_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """Used on page load to check a remembered identity still exists - after
    an admin reset, it will not, and the UI must ask again rather than send a
    dangling id on every request."""
    user = (
        await db.execute(select(User).where(User.id == user_id))
    ).scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=404,
            detail="That identity no longer exists on this instance.",
        )
    count = (
        await db.execute(
            select(func.count())
            .select_from(ProjectMember)
            .where(ProjectMember.user_id == user_id)
        )
    ).scalar_one()
    return UserOut(
        id=user.id, email=user.email, name=user.name, project_count=count
    )


@router.get("/{user_id}/projects")
async def user_projects(user_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """What this person is on, and in what capacity.

    Advisory. Every project on this instance is visible to everyone; this only
    answers "which are mine".
    """
    rows = (
        await db.execute(
            select(Project, ProjectMember.role)
            .join(ProjectMember, ProjectMember.project_id == Project.id)
            .where(ProjectMember.user_id == user_id)
            .order_by(Project.created_at)
        )
    ).all()
    return {
        "user_id": str(user_id),
        "projects": [
            {"id": str(p.id), "name": p.name, "role": role} for p, role in rows
        ],
        "note": (
            "Roles are advisory. This instance has no authentication and "
            "enforces no permissions."
        ),
    }
