"""
Who is asking.

The frontend sends `X-User-Id` - the identity a person picked from the name
picker. It is an **identity, not a credential**: nothing is checked against
anything, nothing is protected by it, and a request without one is served
exactly the same.

It exists so a workflow has an owner and a change has an author, which is what
makes a shared instance make sense to two people at once. That is the whole
of the multi-user story (9.5), and building anything more would be the
authentication the brief rules out.
"""
from __future__ import annotations

import uuid

from fastapi import Depends, Header
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db import get_db
from backend.app.models import User


async def current_user(
    x_user_id: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
) -> User | None:
    """The picked identity, or None.

    Never raises. A missing, malformed or stale id is not an error - it is a
    visitor who has not picked a name yet, or whose identity was wiped by an
    admin reset. Refusing the request would be enforcing an identity, which is
    exactly what this is not.
    """
    if not x_user_id:
        return None
    try:
        user_id = uuid.UUID(x_user_id)
    except ValueError:
        return None
    return (
        await db.execute(select(User).where(User.id == user_id))
    ).scalar_one_or_none()
