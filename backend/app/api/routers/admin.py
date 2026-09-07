"""
The one destructive endpoint, behind a token.

A deployed demo that a stranger can break is a demo you cannot hand to a
stranger. `POST /admin/reset-seed` drops everything and reloads both seed
domains, which is what makes the deployment safe to give away: whatever anyone
does to it, one call puts it back.

Two deliberate choices:

* **No token means the endpoint does not exist.** Not "open by default" - an
  unguarded database reset on a public URL is an undo button for your demo
  that anyone on the internet can press. It returns 403 and says so.
* **The token is compared in constant time**, because comparing a secret with
  `==` leaks its length and prefix to anyone patient enough to measure.

This is not authentication and it is not RBAC. It is one shared operator
token on one destructive route.
"""
from __future__ import annotations

import hmac

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db import get_db
from backend.app.seed import loader
from backend.app.settings import settings

router = APIRouter(prefix="/admin", tags=["admin"])


def require_admin_token(x_admin_token: str = Header(default="")) -> None:
    if not settings.ADMIN_TOKEN:
        raise HTTPException(
            status_code=403,
            detail=(
                "Admin endpoints are disabled: no ADMIN_TOKEN is configured "
                "in this deployment."
            ),
        )
    if not hmac.compare_digest(x_admin_token, settings.ADMIN_TOKEN):
        raise HTTPException(
            status_code=401,
            detail="Wrong or missing X-Admin-Token.",
        )


@router.get("/status")
async def admin_status():
    """Whether the reset endpoint is available here. Says nothing secret -
    only whether a token is configured, which anyone learns by trying."""
    return {
        "reset_available": bool(settings.ADMIN_TOKEN),
        "environment": settings.ENVIRONMENT,
        "database": "sqlite" if settings.is_sqlite else "postgres",
        "seed_on_startup": settings.SEED_ON_STARTUP,
        "note": (
            "POST /admin/reset-seed with the X-Admin-Token header drops "
            "every project and reloads both seed domains."
        ),
    }


@router.post("/reset-seed", dependencies=[Depends(require_admin_token)])
async def reset_seed(db: AsyncSession = Depends(get_db)):
    """Drop everything and reload both seed domains.

    **Destructive.** Every project a visitor created is gone, including the
    seeded ones' edit history. That is the point: it is how the demo gets a
    clean database in one call, from anywhere, without a shell.
    """
    projects = await loader.reset_and_seed(db)
    return {
        "status": "reset",
        "projects": projects,
        "note": (
            "Every project was dropped and both seed domains reloaded. Any "
            "identity a visitor picked is gone too - the frontend will ask "
            "for a name again."
        ),
    }
