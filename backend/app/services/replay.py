"""
Replay - the project's event log walked forward in accelerated simulated time.

This is Capability 1 put in motion. It adds no new reasoning: every frame it
emits is one call to `core.engine.evaluate()` over the **same immutable
snapshot**, with a different `WorkflowState` and a different `Clock`. The
engine is unchanged, and nothing here can reach a detector that the `/analyze`
endpoint cannot.

What a replay is
----------------
Given a base `WorkflowVersion` and the project's append-only `Event` log, a
replay reconstructs, for each simulated day `d`:

* the **statuses** each task held at day `d` - the `to_status` of that task's
  last event at or before `d`, or the `from_status` of its first event if `d`
  precedes it, or the stored status for a task that has no events at all;
* the **event history known at day `d`** - every event with `day <= d`, and
  deliberately not one event more;
* a `Clock(today_day=d)`.

`evaluate()` is then called with those three things plus the base snapshot.
Because the clock is an argument to the engine and never read from the wall,
findings that depend on elapsed time (`ready_but_idle`, `stalled_in_review`,
`critical_path_blocker`) appear and clear at the *simulated* day they
genuinely cross their threshold. That is a property of the engine's purity,
not something this module simulates.

What a replay is not
--------------------
It **never writes**. No `Event` row, no `WorkflowVersion`, no status update,
no `AnalysisRun`. It loads once, holds immutable value objects, and the
driver task never touches the database again. `test_stream.py` reads the base
version's `content_hash` before and after and asserts it byte-identical.

The honesty layer
-----------------
Every frame's projection is computed from the events known at that simulated
day. Later events exist in the log and have deliberately not been applied.
That is a real caveat about a real number, so it travels in the payload as
`derived`, not in a comment. Two more are stated there:

* observed durations for work in flight are reconstructed from the event log
  and the simulated clock only. The stored `actual_start_day` /
  `actual_end_day` columns describe *today*, not day `d`, so replaying them
  would leak the future backwards. They are excluded, and the payload says so.
* the evidence tier moves during a replay - a workflow with no events yet is
  Tier 1, and becomes Tier 2 once the first event lands. Each frame reports
  the tier it actually reached.

Where replays live, and what that costs
---------------------------------------
**In process memory, keyed by project id** (`_REPLAYS` below). This is the
right storage for this object and a deliberate decision, not an oversight: a
replay is ephemeral scratch state - a viewing position over data that is
already durable - exactly like a `Scenario` is scratch paper over a workflow.
Persisting a cursor and a speed multiplier would buy nothing and would put a
write path next to a feature whose entire promise is that it writes nothing.

The cost, stated plainly: **this is correct for one process and wrong for
several.** Under multiple uvicorn workers, `POST /replay` and `GET /stream`
can land on different workers, and the second would report no replay running.
Fixing that means a shared broker (Redis pub/sub or Postgres LISTEN/NOTIFY)
and is out of scope for this phase. This application deploys as a single
process; `docs/DEPLOY.md` should keep it that way while this feature exists.
"""
from __future__ import annotations

import asyncio
import math
import uuid
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Iterable, Mapping

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.engine import evaluate as core_evaluate
from backend.app.core.workflow import (
    Clock,
    EngineConfig,
    EventRecord,
    TaskStatus,
    WorkflowSnapshot,
    WorkflowState,
)
from backend.app.services import versions as V
from backend.app.services.versions import NotFound

__all__ = [
    "NotFound",
    "ReplayNotRunning",
    "BadControl",
    "start",
    "status",
    "control",
    "stop",
    "timeline",
    "subscribe",
    "active_project_ids",
    "session_for",
    "reset",
    "IDLE_GRACE_SECONDS",
]


class ReplayNotRunning(Exception):
    """No replay exists for this project. Routers map it to 404."""


class BadControl(Exception):
    """An unknown action, or one missing the argument it needs. 400."""


#: Seconds a replay with no subscribers is kept before it is cancelled and
#: dropped. It is not zero because `POST /replay` legitimately precedes the
#: first `GET /stream` by a round trip, and a viewer refreshing the page
#: should not destroy the replay everybody else is watching. Read at reap
#: time, so a test may shorten it.
IDLE_GRACE_SECONDS = 30.0

#: Frames buffered per subscriber. A subscriber slower than this loses the
#: oldest frames and is told so on the next one it receives - dropping
#: silently would let a viewer's screen disagree with the engine and never
#: say why.
MAX_QUEUED_FRAMES = 512

#: One simulated day takes `60 / speed` real seconds, so `speed` reads as
#: **simulated days per real minute**. The default of 60 is therefore one
#: simulated day per second: a three-week project replays in about twenty
#: seconds, which is the pace a demo wants. Every state payload echoes both
#: numbers so nobody has to infer the unit.
SECONDS_PER_MINUTE = 60.0

#: How long the stream waits before emitting an SSE comment, so that an idle
#: (paused, or finished) replay keeps proxies and load balancers from closing
#: a connection they think is dead.
HEARTBEAT_SECONDS = 15.0


# ---------------------------------------------------------------------------
# What one subscriber sees
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Message:
    """One SSE message: an event name, a JSON-safe body, and a sequence id."""

    event: str
    data: dict
    seq: int


class Subscription:
    """One viewer's queue. Created by `subscribe()`, released in the SSE
    generator's `finally` - which is what runs on client disconnect."""

    __slots__ = ("queue", "dropped", "_session", "_closed")

    def __init__(self, session: "ReplaySession") -> None:
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=MAX_QUEUED_FRAMES)
        self.dropped = 0
        self._session = session
        self._closed = False

    def catchup(self) -> dict:
        """Current state, for a viewer arriving mid-replay. Never empty."""
        return self._session.catchup_payload()

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self._session._unsubscribe(self)


# ---------------------------------------------------------------------------
# The base a replay runs over - loaded once, immutable thereafter
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ReplayBase:
    project_id: uuid.UUID
    project_name: str
    project_start: date
    project_deadline: date | None
    today_day: float
    version_id: uuid.UUID
    version_no: int
    content_hash: str
    snapshot: WorkflowSnapshot
    #: Statuses as stored on the version's task rows. Used only for tasks the
    #: event log never mentions, whose status is constant for the whole run.
    stored_statuses: Mapping[str, TaskStatus]
    #: The whole log, ascending by day.
    events: tuple[EventRecord, ...]
    events_by_task: Mapping[str, tuple[EventRecord, ...]]
    config: EngineConfig = field(default_factory=EngineConfig)

    # -- reconstruction ----------------------------------------------------

    def state_at(self, day: float) -> WorkflowState:
        """The `WorkflowState` as it stood at simulated day `day`.

        `actual_durations` is deliberately empty: the stored actuals describe
        the present, and feeding them to a simulated past would let the
        replay know things it could not have known. The engine's
        `observed_durations` bridge still stretches in-flight work, from the
        event log and the simulated clock - which is evidence that genuinely
        existed at day `day`.
        """
        statuses: dict[str, TaskStatus] = {}
        for key in self.snapshot.task_keys:
            log = self.events_by_task.get(key, ())
            if not log:
                statuses[key] = self.stored_statuses.get(key, TaskStatus.NOT_STARTED)
                continue
            latest = None
            for e in log:
                if e.day <= day:
                    latest = e
                else:
                    break
            statuses[key] = latest.to_status if latest else log[0].from_status

        known = tuple(e for e in self.events if e.day <= day)
        return WorkflowState(statuses=statuses, events=known)

    def events_on(self, day: float) -> tuple[EventRecord, ...]:
        return tuple(e for e in self.events if e.day == day)

    def events_between(self, after: float, upto: float) -> tuple[EventRecord, ...]:
        """Events strictly after `after` and at or before `upto`. A seek can
        cross many days at once, and the frame must name all of them."""
        return tuple(e for e in self.events if after < e.day <= upto)

    @property
    def last_event_day(self) -> float:
        return self.events[-1].day if self.events else 0.0

    def horizon(self, start_day: float) -> float:
        """Where the replay ends: the present, or the last event if the log
        runs past it."""
        return max(self.last_event_day, self.today_day, start_day)

    def step_days(self, start_day: float) -> tuple[float, ...]:
        """Every simulated day the replay stops at.

        Event days, because that is when the log changes, **and** every whole
        day in between, because several findings are threshold-on-the-clock
        rather than threshold-on-an-event: `ready_but_idle` fires when a task
        has been ready for `idle_threshold` days, and nothing happens on the
        day it crosses. Stepping only on events would report it late and make
        "findings appear at the correct simulated time" false.
        """
        end = self.horizon(start_day)
        days = {float(start_day), float(end)}
        days.update(float(e.day) for e in self.events if start_day <= e.day <= end)
        whole = int(math.ceil(start_day))
        while whole <= end:
            days.add(float(whole))
            whole += 1
        return tuple(sorted(days))


async def load_base(
    db: AsyncSession, project_id: uuid.UUID, version_id: uuid.UUID | None
) -> ReplayBase:
    """Read everything a replay needs, once. Nothing below this line touches
    the database again."""
    project, version, snapshot, state, _clock = await V.load_context(
        db, project_id, version_id
    )
    events = tuple(sorted(state.events, key=lambda e: (e.day, e.task_key)))
    by_task: dict[str, list[EventRecord]] = {}
    for e in events:
        by_task.setdefault(e.task_key, []).append(e)

    return ReplayBase(
        project_id=project.id,
        project_name=project.name,
        project_start=project.start_date,
        project_deadline=project.deadline,
        today_day=float(project.today_day),
        version_id=version.id,
        version_no=version.version_no,
        content_hash=version.content_hash,
        snapshot=snapshot,
        stored_statuses=dict(state.statuses),
        events=events,
        events_by_task={k: tuple(v) for k, v in by_task.items()},
    )


# ---------------------------------------------------------------------------
# Findings, and the delta between two frames
# ---------------------------------------------------------------------------


def finding_id(payload: Mapping[str, Any]) -> str:
    """A stable identity for one finding across frames.

    Kind plus root cause plus the tasks it is about. Severity and evidence are
    excluded on purpose: those are what we want to watch *change* on a finding
    that is still the same finding.
    """
    tasks = ",".join(payload.get("task_ids") or ())
    return f"{payload['kind']}:{payload.get('root_cause') or '-'}:{tasks}"


def _index(findings: Iterable[Mapping[str, Any]]) -> dict[str, dict]:
    return {finding_id(f): dict(f) for f in findings}


def diff_findings(before: Mapping[str, dict], after: Mapping[str, dict]) -> dict:
    """Which findings appeared, which cleared, which changed severity.

    Pure, and the only new arithmetic in this module. It is deliberately
    *here* rather than in `core/`: it diffs two serialised evaluations, which
    is presentation, and `core/` gains nothing by knowing about it.
    """
    appeared = [after[k] for k in after if k not in before]
    cleared = [
        {
            "id": k,
            "kind": before[k]["kind"],
            "root_cause": before[k].get("root_cause"),
            "task_ids": list(before[k].get("task_ids") or ()),
            "severity_was": before[k]["severity"],
            "explanation_was": before[k]["explanation"],
        }
        for k in before
        if k not in after
    ]
    changed = []
    for k in after:
        if k not in before:
            continue
        was, now = before[k]["severity"], after[k]["severity"]
        if was != now:
            changed.append({
                "id": k,
                "kind": after[k]["kind"],
                "root_cause": after[k].get("root_cause"),
                "task_ids": list(after[k].get("task_ids") or ()),
                "severity_from": was,
                "severity_to": now,
                "explanation": after[k]["explanation"],
            })

    def key(row):
        return (row.get("kind", ""), row.get("root_cause") or "")

    return {
        "appeared": sorted(appeared, key=key),
        "cleared": sorted(cleared, key=key),
        "severity_changed": sorted(changed, key=key),
        "unchanged": len(set(before) & set(after)) - len(changed),
    }


# ---------------------------------------------------------------------------
# The replay itself
# ---------------------------------------------------------------------------


class ReplaySession:
    """One project's replay, and the fan-out to every viewer of it.

    One driver task per project; N subscribers read from it. The driver owns
    the simulated clock and is the only thing that advances it.
    """

    def __init__(self, base: ReplayBase, speed: float, start_day: float) -> None:
        self.base = base
        self.speed = float(speed)
        self.start_day = float(start_day)
        self.sim_day = float(start_day)
        self.paused = False
        self.finished = False
        self.stopped = False
        self.seq = 0
        self.started_seq = 0

        self._steps = base.step_days(self.start_day)
        self._subs: set[Subscription] = set()
        self._wake = asyncio.Event()
        self._task: asyncio.Task | None = None
        self._reaper: asyncio.Task | None = None
        self._loop = asyncio.get_running_loop()
        self._prev: dict[str, dict] = {}
        self._last_frame: dict = {}

    # -- lifecycle ---------------------------------------------------------

    def open(self) -> dict:
        """Compute the first frame and start the driver. The first frame is
        emitted synchronously so that a viewer connecting a moment later has
        real state to receive rather than an empty screen."""
        self._last_frame = self._build_frame(self.sim_day, reason="start")
        self._task = asyncio.create_task(
            self._run(), name=f"replay:{self.base.project_id}"
        )
        self._arm_reaper()
        return self.state_payload()

    def close(self, reason: str = "stopped") -> None:
        """Cancel the driver, wake every subscriber, and let their generators
        finish. Idempotent.

        Every step is guarded against a closed event loop. Closing a replay is
        a teardown path - it runs from `reset()`, from a process shutdown and
        from a test's fixture - and "the loop this replay belonged to has
        already gone" is a thing that has genuinely happened, not a
        hypothetical. Nothing here is worth raising over at that point.
        """
        if self.stopped:
            return
        self.stopped = True
        self._cancel_reaper()
        _cancel(self._task)
        try:
            self._emit(reason, {"replay": self.state_payload()})
            for sub in list(self._subs):
                try:
                    sub.queue.put_nowait(None)
                except asyncio.QueueFull:  # pragma: no cover - drain and retry
                    _drop_oldest(sub)
                    sub.queue.put_nowait(None)
        except RuntimeError:  # pragma: no cover - loop already closed
            pass

    @property
    def task_done(self) -> bool:
        return self._task is None or self._task.done()

    @property
    def subscriber_count(self) -> int:
        return len(self._subs)

    # -- subscribers -------------------------------------------------------

    def subscribe(self) -> Subscription:
        sub = Subscription(self)
        self._subs.add(sub)
        self._cancel_reaper()
        return sub

    def _unsubscribe(self, sub: Subscription) -> None:
        self._subs.discard(sub)
        if not self._subs:
            self._arm_reaper()

    def _arm_reaper(self) -> None:
        """No viewers: collect this replay after the grace period.

        This is what stops a disconnect from leaking the driver task. It is a
        timer rather than an immediate kill because `POST /replay` precedes
        the first `GET /stream`, and because a viewer refreshing the page
        should not destroy a replay other people are watching.
        """
        if self.stopped or self._reaper is not None:
            return
        self._reaper = asyncio.create_task(
            self._reap(), name=f"replay-reap:{self.base.project_id}"
        )

    def _cancel_reaper(self) -> None:
        _cancel(self._reaper)
        self._reaper = None

    async def _reap(self) -> None:
        try:
            await asyncio.sleep(IDLE_GRACE_SECONDS)
        except asyncio.CancelledError:
            return
        if self._subs:  # pragma: no cover - a viewer arrived on the boundary
            self._reaper = None
            return
        self._reaper = None
        _forget(self.base.project_id, self)
        self.close("expired")

    # -- control -----------------------------------------------------------

    def pause(self) -> dict:
        self.paused = True
        self._wake.set()
        return self._control_frame("pause")

    def resume(self) -> dict:
        if self.finished:
            # Resuming a replay that has run out of log is a no-op, and saying
            # so is better than pretending it started again.
            self.paused = False
            return self._control_frame("resume")
        self.paused = False
        self._wake.set()
        return self._control_frame("resume")

    def set_speed(self, speed: float) -> dict:
        if speed is None or speed <= 0:
            raise BadControl("speed must be greater than zero.")
        self.speed = float(speed)
        self._wake.set()
        return self._control_frame("speed")

    def seek(self, to_day: float) -> dict:
        if to_day is None:
            raise BadControl("seek needs `to_day`.")
        target = min(max(float(to_day), self.start_day), self.horizon)
        previous = self.sim_day
        self.sim_day = target
        self.finished = target >= self.horizon
        frame = self._build_frame(target, reason="seek", since=previous)
        self._last_frame = frame
        self._emit("frame", frame)
        self._wake.set()
        return self._control_frame("seek")

    def restart(self) -> dict:
        self.sim_day = self.start_day
        self.finished = False
        self.paused = False
        self._prev = {}
        frame = self._build_frame(self.start_day, reason="restart")
        self._last_frame = frame
        self._emit("frame", frame)
        self._wake.set()
        return self._control_frame("restart")

    def _control_frame(self, action: str) -> dict:
        payload = self.state_payload()
        self._emit("control", {"action": action, "replay": payload})
        return payload

    # -- the driver --------------------------------------------------------

    async def _run(self) -> None:
        try:
            while not self.stopped:
                if self.paused or self.finished:
                    self._wake.clear()
                    await self._wake.wait()
                    continue

                nxt = self._next_step()
                if nxt is None:
                    self.finished = True
                    self._emit("end", {
                        "replay": self.state_payload(),
                        "note": (
                            "The event log is exhausted at simulated day "
                            f"{self.sim_day:g}. Nothing after this point has "
                            "been observed."
                        ),
                    })
                    continue

                delay = (nxt - self.sim_day) * self.seconds_per_day
                if delay > 0:
                    self._wake.clear()
                    try:
                        await asyncio.wait_for(self._wake.wait(), timeout=delay)
                        continue  # paused, seeked, restarted or re-sped
                    except asyncio.TimeoutError:
                        pass

                previous = self.sim_day
                self.sim_day = nxt
                frame = self._build_frame(nxt, reason="tick", since=previous)
                self._last_frame = frame
                self._emit("frame", frame)
        except asyncio.CancelledError:  # pragma: no cover - normal shutdown
            raise

    def _next_step(self) -> float | None:
        for day in self._steps:
            if day > self.sim_day:
                return day
        return None

    # -- frames ------------------------------------------------------------

    def _build_frame(
        self, day: float, *, reason: str, since: float | None = None
    ) -> dict:
        base = self.base
        state = base.state_at(day)
        result = core_evaluate(base.snapshot, state, Clock(day), base.config)

        findings = [f.to_dict() for f in result.findings]
        after = _index(findings)
        delta = diff_findings(self._prev, after)
        self._prev = after

        known = len(state.events)
        total = len(base.events)
        deadline_day = base.snapshot.deadline_day
        margin = None if deadline_day is None else deadline_day - result.projected_end

        landed = (
            base.events_between(since, day)
            if since is not None and since < day
            else base.events_on(day)
        )

        self.seq += 1
        return {
            "seq": self.seq,
            "reason": reason,
            "clock": {
                "sim_day": day,
                "sim_date": V.day_to_date(base.project_start, day),
                "start_day": self.start_day,
                "horizon_day": self.horizon,
                "horizon_date": V.day_to_date(base.project_start, self.horizon),
                "project_start": base.project_start.isoformat(),
                "percent_complete": (
                    100.0
                    if self.horizon <= self.start_day
                    else round(
                        100.0
                        * (day - self.start_day)
                        / (self.horizon - self.start_day),
                        2,
                    )
                ),
            },
            "events": [
                {
                    "day": e.day,
                    "date": V.day_to_date(base.project_start, e.day),
                    "task_key": e.task_key,
                    "task_name": base.snapshot.task_by_key[e.task_key].name
                    if e.task_key in base.snapshot.task_by_key
                    else e.task_key,
                    "actor": e.actor,
                    "from_status": e.from_status.value,
                    "to_status": e.to_status.value,
                }
                for e in landed
            ],
            "delta": delta,
            "findings": findings,
            "finding_counts_by_severity": _severity_counts(findings),
            "projection": {
                "planned_end_day": result.planned_end,
                "planned_end_date": V.day_to_date(
                    base.project_start, result.planned_end
                ),
                "projected_end_day": result.projected_end,
                "projected_end_date": V.day_to_date(
                    base.project_start, result.projected_end
                ),
                "slip_days": result.slip_days,
                "deadline_day": deadline_day,
                "deadline_date": (
                    base.project_deadline.isoformat()
                    if base.project_deadline
                    else None
                ),
                "margin_days": margin,
                "verdict": result.feasibility.verdict,
                "statement": result.feasibility.statement,
                "is_probability": False,
            },
            "statuses": {k: v.value for k, v in state.statuses.items()},
            "critical_path": list(result.schedule["critical"]),
            "engine_version": result.engine_version,
            "input_hash": result.input_hash,
            "tier_reached": result.tier_reached,
            "checks_run": list(result.checks_run),
            "unavailable_checks": result.unavailable_checks,
            "derived": {
                "computed_at_simulated_day": day,
                "events_known": known,
                "events_total": total,
                "events_pending": total - known,
                "is_reconstruction": True,
                "caveats": _caveats(day, known, total, result.tier_reached),
            },
        }

    def catchup_payload(self) -> dict:
        """What a viewer arriving mid-replay receives first. Never empty: if
        the driver has not produced a frame yet there is still the frame
        computed at `open()`."""
        return {
            "replay": self.state_payload(),
            "frame": self._last_frame,
            "note": (
                "Current state at the moment you connected. Live frames "
                "follow."
            ),
        }

    def state_payload(self) -> dict:
        base = self.base
        return {
            "project_id": str(base.project_id),
            "project_name": base.project_name,
            "version_id": str(base.version_id),
            "version_no": base.version_no,
            "base_content_hash": base.content_hash,
            "running": not self.stopped,
            "paused": self.paused,
            "finished": self.finished,
            "stopped": self.stopped,
            "sim_day": self.sim_day,
            "sim_date": V.day_to_date(base.project_start, self.sim_day),
            "start_day": self.start_day,
            "horizon_day": self.horizon,
            "horizon_date": V.day_to_date(base.project_start, self.horizon),
            "today_day": base.today_day,
            "speed": self.speed,
            "simulated_days_per_minute": self.speed,
            "seconds_per_simulated_day": self.seconds_per_day,
            "events_total": len(base.events),
            "steps_total": len(self._steps),
            "subscribers": len(self._subs),
            "seq": self.seq,
            "writes_nothing": True,
            "note": (
                "A replay runs over an immutable snapshot. It writes no "
                "event, no workflow version and no analysis run, and the "
                "base version's content hash is unchanged by it."
            ),
        }

    def timeline_payload(self) -> dict:
        """The scrubber's data: every day the replay stops at, and what lands
        there. A UI can render a seek bar without waiting for the stream."""
        base = self.base
        return {
            "project_id": str(base.project_id),
            "version_id": str(base.version_id),
            "project_start": base.project_start.isoformat(),
            "start_day": self.start_day,
            "horizon_day": self.horizon,
            "today_day": base.today_day,
            "steps": [
                {
                    "day": d,
                    "date": V.day_to_date(base.project_start, d),
                    "events": len(base.events_on(d)),
                }
                for d in self._steps
            ],
            "events": [
                {
                    "day": e.day,
                    "date": V.day_to_date(base.project_start, e.day),
                    "task_key": e.task_key,
                    "actor": e.actor,
                    "from_status": e.from_status.value,
                    "to_status": e.to_status.value,
                }
                for e in base.events
            ],
            "note": (
                "Steps are every event day plus every whole day in between: "
                "some findings cross their threshold on the clock rather "
                "than on an event."
            ),
        }

    # -- properties --------------------------------------------------------

    @property
    def last_frame(self) -> dict:
        return self._last_frame

    @property
    def horizon(self) -> float:
        return self.base.horizon(self.start_day)

    @property
    def seconds_per_day(self) -> float:
        return SECONDS_PER_MINUTE / self.speed

    # -- fan-out -----------------------------------------------------------

    def _emit(self, event: str, data: dict) -> None:
        self.started_seq += 1
        msg = Message(event=event, data=data, seq=self.started_seq)
        for sub in list(self._subs):
            try:
                sub.queue.put_nowait(msg)
            except asyncio.QueueFull:
                _drop_oldest(sub)
                sub.dropped += 1
                try:
                    sub.queue.put_nowait(msg)
                except asyncio.QueueFull:  # pragma: no cover
                    pass


def _cancel(task: asyncio.Task | None) -> None:
    """Cancel a task, tolerating a loop that has already been closed."""
    if task is None or task.done():
        return
    try:
        task.cancel()
    except RuntimeError:  # pragma: no cover - loop already closed
        pass


def _drop_oldest(sub: Subscription) -> None:
    try:
        sub.queue.get_nowait()
    except asyncio.QueueEmpty:  # pragma: no cover
        pass


def _severity_counts(findings: list[dict]) -> dict:
    counts = {"high": 0, "medium": 0, "low": 0}
    for f in findings:
        if f["severity"] in counts:
            counts[f["severity"]] += 1
    return counts


def _caveats(day: float, known: int, total: int, tier: int) -> list[str]:
    out = [
        (
            f"This projection was computed at simulated day {day:g} from the "
            f"{known} of {total} events known at that point. Later events "
            f"exist in the log and have deliberately not been applied - the "
            f"number is what the engine would have said on that day, not what "
            f"it says now."
        ),
        (
            "Observed durations are reconstructed from the event log and the "
            "simulated clock only. Recorded actual start and end days "
            "describe the present, so replaying them would let this frame "
            "know things it could not have known; they are excluded."
        ),
    ]
    if total - known:
        out.append(
            f"{total - known} event(s) in this project's log occur after this "
            f"simulated day and are not reflected in any number on this frame."
        )
    if tier < 2:
        out.append(
            "No status transitions have been observed yet at this simulated "
            "day, so the historical checks could not run. The frame reports "
            "which ones in `unavailable_checks`."
        )
    return out


# ---------------------------------------------------------------------------
# The registry. One replay per project, in this process's memory.
# ---------------------------------------------------------------------------

#: Deliberately a plain dict and deliberately lock-free: every mutation below
#: is synchronous with no `await` between the read and the write, so there is
#: no interleaving point for a second request to slip through. An
#: `asyncio.Lock` here would additionally bind this module to one event loop,
#: which the test suite does not guarantee.
_REPLAYS: dict[uuid.UUID, ReplaySession] = {}


def _forget(project_id: uuid.UUID, session: ReplaySession) -> None:
    """Remove `session` from the registry, but only if it is still the
    current one - a restart may already have replaced it."""
    if _REPLAYS.get(project_id) is session:
        _REPLAYS.pop(project_id, None)


def session_for(project_id: uuid.UUID) -> ReplaySession | None:
    return _REPLAYS.get(project_id)


def active_project_ids() -> list[uuid.UUID]:
    return list(_REPLAYS)


def reset() -> None:
    """Cancel and drop every replay. For tests and for a clean shutdown."""
    for project_id in list(_REPLAYS):
        session = _REPLAYS.pop(project_id)
        session.close("stopped")


async def start(
    db: AsyncSession,
    project_id: uuid.UUID,
    version_id: uuid.UUID | None = None,
    speed: float = 60.0,
    start_day: float = 0.0,
) -> dict:
    """Start, or restart, this project's replay.

    Starting a second time replaces the first: one replay per project is the
    whole point of the fan-out, and two would give two viewers two different
    clocks for the same screen.
    """
    if speed <= 0:
        raise BadControl("speed must be greater than zero.")
    base = await load_base(db, project_id, version_id)

    existing = _REPLAYS.pop(project_id, None)
    if existing is not None:
        existing.close("restarted")

    session = ReplaySession(base, speed=speed, start_day=max(0.0, float(start_day)))
    _REPLAYS[project_id] = session
    return session.open()


def status(project_id: uuid.UUID) -> dict:
    session = _require(project_id)
    return {**session.state_payload(), "frame": session.last_frame}


def timeline(project_id: uuid.UUID) -> dict:
    return _require(project_id).timeline_payload()


def control(
    project_id: uuid.UUID,
    action: str,
    to_day: float | None = None,
    speed: float | None = None,
) -> dict:
    session = _require(project_id)
    verb = (action or "").strip().lower()
    if verb == "pause":
        return session.pause()
    if verb == "resume":
        return session.resume()
    if verb == "seek":
        return session.seek(to_day)
    if verb == "restart":
        return session.restart()
    if verb == "speed":
        return session.set_speed(speed)
    raise BadControl(
        f"Unknown replay action {action!r}. Use one of: pause, resume, seek, "
        f"restart, speed."
    )


def stop(project_id: uuid.UUID) -> dict:
    session = _require(project_id)
    _REPLAYS.pop(project_id, None)
    payload = session.state_payload()
    session.close("stopped")
    return {**payload, "running": False, "stopped": True}


def subscribe(project_id: uuid.UUID) -> tuple[ReplaySession, Subscription]:
    session = _require(project_id)
    return session, session.subscribe()


def _require(project_id: uuid.UUID) -> ReplaySession:
    session = _REPLAYS.get(project_id)
    if session is None:
        raise ReplayNotRunning(
            f"No replay is running for project {project_id}. Start one with "
            f"POST /api/projects/{project_id}/replay."
        )
    return session
