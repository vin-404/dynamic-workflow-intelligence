"""
Getting data in without typing it - Jira CSV import, a generic mapped CSV
path, and a GitHub webhook receiver.

Owned by Agent INGEST (Phase 11 wave 2).

Two routers on purpose. `router` carries the project role guard: importing is
authorship, so it needs an identity. `webhook_router` cannot, because a
webhook has no session - it is authenticated by an HMAC signature over the
body instead, and rejects outright when no secret is configured.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from backend.app.api.deps import project_role_guard

router = APIRouter(
    prefix="/api/import", tags=["import"], dependencies=[project_role_guard]
)
webhook_router = APIRouter(prefix="/api/ingest", tags=["ingest"])

_NOT_YET = "Import is not implemented yet."


@router.post("/preview")
async def preview(request: Request):
    raise HTTPException(status_code=501, detail=_NOT_YET)


@router.post("/commit", status_code=201)
async def commit(request: Request):
    raise HTTPException(status_code=501, detail=_NOT_YET)


@router.get("/samples")
async def samples():
    raise HTTPException(status_code=501, detail=_NOT_YET)


@router.get("/samples/{name}")
async def sample(name: str):
    raise HTTPException(status_code=501, detail=_NOT_YET)


@webhook_router.post("/github")
async def github(request: Request):
    raise HTTPException(status_code=501, detail=_NOT_YET)
