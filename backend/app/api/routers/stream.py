"""
Capability 1, in motion - replay a project's event log forward in accelerated
time over Server-Sent Events.

SSE rather than WebSocket: the traffic is one-directional and SSE survives a
reverse proxy with no extra configuration. The control channel is ordinary
JSON over POST, which means pause/seek/speed go through the same role guard,
the same error envelope and the same request-id logging as everything else -
a bidirectional socket would have needed its own copy of all three.

Every endpoint here is a **read**. A replay runs over an immutable snapshot
exactly like a scenario does: it writes no `Event`, no `WorkflowVersion` and
no `AnalysisRun`, and `test_stream.py` asserts the base version's content hash
is byte-identical before and after. That is why the three non-GET routes below
appear in `deps.READS_THAT_POST` - a seat that cannot pause the thing it is
watching is not a read-only seat.

The event stream
----------------
Named SSE events, each carrying one JSON object:

* `catchup` - `{replay, frame, note}`. **Always the first message**, so a
  viewer arriving mid-replay sees current state rather than an empty screen.
* `frame`   - one simulated step: the clock, the events that landed, the
  delta in findings, the full current findings, and the new projection.
* `control` - `{action, replay}` when somebody pauses, seeks, re-speeds or
  restarts, so every viewer's controls stay in agreement.
* `end`     - the event log is exhausted. The replay stays alive and
  seekable.
* `restarted` / `stopped` / `expired` - this replay is over; the stream ends.
* `: ping` comments every 15s, so an idle connection is not reaped by a
  proxy that mistakes a paused replay for a dead one.
"""
from __future__ import annotations

import asyncio
import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.deps import project_role_guard
from backend.app.api.limits import bounded
from backend.app.db import get_db
from backend.app.services import replay as R
from backend.app.services import versions as V
from backend.app.settings import settings

router = APIRouter(
    prefix="/api/projects/{project_id}",
    tags=["replay"],
    dependencies=[project_role_guard],
)

#: `text/event-stream` plus the two headers that stop an intermediary from
#: buffering it into uselessness. `X-Accel-Buffering` is nginx's; the others
#: are the spec's.
SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


class ReplayStartIn(BaseModel):
    """A replay runs over an immutable snapshot; it never writes one."""

    version_id: uuid.UUID | None = None
    speed: float = Field(default=60.0, gt=0)
    start_day: float = Field(default=0.0, ge=0)


class ReplayControlIn(BaseModel):
    action: str
    to_day: float | None = None
    speed: float | None = None


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


@router.post("/replay", status_code=200)
async def start_replay(
    project_id: uuid.UUID,
    payload: ReplayStartIn | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Start, or restart, this project's replay.

    One replay per project, because N viewers watching two different clocks
    for the same screen is not a feature. Starting again replaces the running
    one and tells its subscribers so.

    `speed` is **simulated days per real minute**; the default 60 is one
    simulated day per second. Both that and `seconds_per_simulated_day` are
    echoed in the response so the unit never has to be inferred.
    """
    body = payload or ReplayStartIn()
    try:
        return await bounded(
            R.start(
                db,
                project_id,
                version_id=body.version_id,
                speed=body.speed,
                start_day=body.start_day,
            ),
            settings.ANALYZE_TIMEOUT_SECONDS,
            "Starting this replay",
            "It evaluates the workflow once before the first frame.",
        )
    except V.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except R.BadControl as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/replay")
async def replay_status(project_id: uuid.UUID):
    """Current replay state plus the last frame computed, for a viewer
    arriving mid-replay who wants a snapshot without opening a stream."""
    try:
        return R.status(project_id)
    except R.ReplayNotRunning as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/replay/control")
async def control_replay(project_id: uuid.UUID, payload: ReplayControlIn):
    """`pause` | `resume` | `seek` (needs `to_day`) | `restart` | `speed`
    (needs `speed`).

    A control applies to the one replay, so every viewer sees it. Seeking
    emits a frame at the target day whose delta is measured against wherever
    the replay was - a jump is honest about being a jump.
    """
    try:
        return R.control(
            project_id, payload.action, payload.to_day, payload.speed
        )
    except R.ReplayNotRunning as e:
        raise HTTPException(status_code=404, detail=str(e))
    except R.BadControl as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/replay", status_code=200)
async def stop_replay(project_id: uuid.UUID):
    """Stop and discard. Subscribers receive a `stopped` event and their
    streams end; nothing in the database changes, because nothing in the
    database ever changed."""
    try:
        return R.stop(project_id)
    except R.ReplayNotRunning as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/replay/timeline")
async def replay_timeline(project_id: uuid.UUID):
    """Every simulated day the replay stops at and every event in the log, so
    a scrubber can be drawn without waiting for the stream to reach the end."""
    try:
        return R.timeline(project_id)
    except R.ReplayNotRunning as e:
        raise HTTPException(status_code=404, detail=str(e))


# ---------------------------------------------------------------------------
# The stream
# ---------------------------------------------------------------------------


def _sse(event: str, data: dict, seq: int) -> str:
    """One SSE message. `json.dumps` with no newlines, because a raw newline
    inside `data:` would split the message."""
    body = json.dumps(data, separators=(",", ":"), default=str)
    return f"event: {event}\nid: {seq}\ndata: {body}\n\n"


@router.get("/stream")
async def stream(project_id: uuid.UUID, request: Request):
    """The Server-Sent Events endpoint.

    Deliberately takes no database session: the replay was loaded in full when
    it started, so holding a connection open for the length of a stream would
    cost a pooled connection for nothing.
    """
    try:
        session, sub = R.subscribe(project_id)
    except R.ReplayNotRunning as e:
        raise HTTPException(status_code=404, detail=str(e))

    async def events():
        # The catch-up message is computed *after* the subscription exists, so
        # a frame emitted between the two is queued rather than missed. A
        # viewer therefore sees current state and then every subsequent frame,
        # in order, with no gap.
        try:
            yield _sse("catchup", sub.catchup(), 0)
            if session.finished:
                # Connecting to a replay that has already run out of log. The
                # `end` that the driver emitted happened before this viewer
                # existed, and leaving them waiting for one that will never
                # come would be the empty screen this feature exists to
                # prevent.
                yield _sse("end", {
                    "replay": session.state_payload(),
                    "note": (
                        "This replay had already reached the end of the event "
                        "log when you connected. Seek or restart to watch it "
                        "again."
                    ),
                }, 0)
            while True:
                try:
                    msg = await asyncio.wait_for(
                        sub.queue.get(), timeout=R.HEARTBEAT_SECONDS
                    )
                except asyncio.TimeoutError:
                    if await request.is_disconnected():
                        break
                    yield ": ping\n\n"
                    continue
                if msg is None:
                    # The replay ended or was discarded; the `stopped` /
                    # `expired` / `restarted` event has already been queued
                    # ahead of this sentinel.
                    break
                data = msg.data
                if sub.dropped:
                    data = {**data, "dropped_frames": sub.dropped}
                yield _sse(msg.event, data, msg.seq)
        finally:
            # Runs on client disconnect, on cancellation, and on a clean end.
            # This is the whole leak story: the last subscriber leaving arms
            # the reaper, which cancels the driver task and drops the replay
            # from the registry.
            sub.close()

    return StreamingResponse(
        events(), media_type="text/event-stream", headers=SSE_HEADERS
    )
