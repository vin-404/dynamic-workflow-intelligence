"""
Capability 1, in motion - replay a project's event log forward in accelerated
time over Server-Sent Events.

Owned by Agent LIVE (Phase 11 wave 2). The route templates below are the
contract the frontend and `deps.py` are written against; the bodies are
implemented by that agent.

SSE rather than WebSocket: the traffic is one-directional and SSE survives a
reverse proxy with no extra configuration.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.app.api.deps import project_role_guard

router = APIRouter(
    prefix="/api/projects/{project_id}",
    tags=["replay"],
    dependencies=[project_role_guard],
)

_NOT_YET = "Replay is not implemented yet."


class ReplayStartIn(BaseModel):
    """A replay runs over an immutable snapshot; it never writes one."""

    version_id: uuid.UUID | None = None
    speed: float = Field(default=60.0, gt=0)
    start_day: float = Field(default=0.0, ge=0)


class ReplayControlIn(BaseModel):
    action: str
    to_day: float | None = None
    speed: float | None = None


@router.post("/replay", status_code=200)
async def start_replay(project_id: uuid.UUID, payload: ReplayStartIn | None = None):
    raise HTTPException(status_code=501, detail=_NOT_YET)


@router.get("/replay")
async def replay_status(project_id: uuid.UUID):
    raise HTTPException(status_code=501, detail=_NOT_YET)


@router.post("/replay/control")
async def control_replay(project_id: uuid.UUID, payload: ReplayControlIn):
    raise HTTPException(status_code=501, detail=_NOT_YET)


@router.delete("/replay", status_code=200)
async def stop_replay(project_id: uuid.UUID):
    raise HTTPException(status_code=501, detail=_NOT_YET)


@router.get("/stream")
async def stream(project_id: uuid.UUID):
    raise HTTPException(status_code=501, detail=_NOT_YET)
