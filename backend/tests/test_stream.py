"""
Replay over Server-Sent Events - the tests for Phase 11's "in real time".

**Why this file speaks ASGI directly.** The rest of the suite drives the app
through `httpx.ASGITransport`, and that transport is not usable here: it
`await`s the whole application before it returns a response object
(`ASGIResponseStream` joins a list of already-collected body parts). An SSE
endpoint by definition does not finish, so a streaming request through it
would hang forever, and a "streaming" test that only ever saw the response
after it completed would prove nothing about streaming.

So `SSEConnection` below is a minimal ASGI client: it calls `app(scope,
receive, send)` itself, reads `http.response.body` messages as they arrive,
and can send a real `http.disconnect`. Everything else - routing, the role
guard, the request-id middleware, the error envelope - is the real
application. The lifecycle endpoints are still driven through the ordinary
`api_client`, so both paths are covered.
"""
from __future__ import annotations

import asyncio
import json
import uuid

import pytest
import pytest_asyncio

from backend.app.main import app
from backend.app.services import replay as R

#: Every test here runs on the **session** event loop, which is the one the
#: `api_client` fixture lives on. A replay owns background tasks, so a test
#: that started one on a per-function loop would hand the teardown fixture a
#: registry full of tasks belonging to a loop that had already closed.
pytestmark = pytest.mark.asyncio(loop_scope="session")

EVENT_PROJECT_ID = "00000000-0000-0000-0000-000000000001"
MFG_PROJECT_ID = "00000000-0000-0000-0000-000000000002"

#: `speed` is simulated days per real minute, so this is 0.05 real seconds
#: per simulated day: the whole 14-day log replays in about 0.7s, which is
#: fast enough for a test and slow enough that a subscriber connecting on the
#: next line of the test has not already missed the first tick.
TEST_SPEED = 60.0 / 0.05

#: Fast enough that a whole replay is over almost immediately, for the tests
#: that do not care about catching every frame.
FAST_SPEED = 60.0 / 0.005


# ---------------------------------------------------------------------------
# A minimal streaming ASGI client
# ---------------------------------------------------------------------------


class StreamClosed(Exception):
    """The application finished the response body."""


class SSEConnection:
    """One SSE client: opens the request, reads events, and can disconnect."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.status: int | None = None
        self.headers: dict[str, str] = {}
        self._chunks: asyncio.Queue = asyncio.Queue()
        self._buffer = b""
        self._started = asyncio.Event()
        self._disconnected = asyncio.Event()
        self._body_sent = False
        self._task: asyncio.Task | None = None

    # -- ASGI callables ---------------------------------------------------

    async def _receive(self) -> dict:
        if not self._body_sent:
            self._body_sent = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await self._disconnected.wait()
        return {"type": "http.disconnect"}

    async def _send(self, message) -> None:
        if message["type"] == "http.response.start":
            self.status = message["status"]
            self.headers = {
                k.decode().lower(): v.decode()
                for k, v in message.get("headers", [])
            }
            self._started.set()
        elif message["type"] == "http.response.body":
            body = message.get("body", b"")
            if body:
                self._chunks.put_nowait(body)
            if not message.get("more_body", False):
                self._chunks.put_nowait(None)

    # -- lifecycle --------------------------------------------------------

    async def __aenter__(self) -> "SSEConnection":
        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": self.path,
            "raw_path": self.path.encode(),
            "query_string": b"",
            "root_path": "",
            "headers": [
                (b"host", b"test"),
                (b"accept", b"text/event-stream"),
            ],
            "client": ("127.0.0.1", 123),
            "server": ("test", 80),
        }
        self._task = asyncio.create_task(app(scope, self._receive, self._send))
        await asyncio.wait_for(self._started.wait(), timeout=5.0)
        return self

    async def __aexit__(self, *exc) -> None:
        await self.disconnect()

    async def disconnect(self) -> None:
        """What a browser closing the tab does."""
        self._disconnected.set()
        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        # Give the endpoint's `finally` a turn to run.
        await asyncio.sleep(0)
        await asyncio.sleep(0)

    # -- reading ----------------------------------------------------------

    async def next_event(self, timeout: float = 5.0) -> dict:
        """The next named SSE event. Heartbeat comments are skipped."""
        while True:
            split = self._buffer.find(b"\n\n")
            if split != -1:
                raw, self._buffer = self._buffer[:split], self._buffer[split + 2:]
                parsed = _parse_sse(raw)
                if parsed is not None:
                    return parsed
                continue
            chunk = await asyncio.wait_for(self._chunks.get(), timeout=timeout)
            if chunk is None:
                raise StreamClosed(f"stream ended with {self._buffer!r} buffered")
            self._buffer += chunk

    async def collect_until(
        self, event_name: str, timeout: float = 15.0
    ) -> list[dict]:
        """Every event up to and including the first `event_name`."""
        out: list[dict] = []
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            assert remaining > 0, f"never saw {event_name!r}; got {_names(out)}"
            event = await self.next_event(timeout=remaining)
            out.append(event)
            if event["event"] == event_name:
                return out


def _parse_sse(raw: bytes) -> dict | None:
    """One SSE message block. Returns None for a comment (a heartbeat)."""
    event, data_lines, seq = "message", [], None
    for line in raw.decode().split("\n"):
        if not line or line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        value = value.lstrip(" ")
        if field == "event":
            event = value
        elif field == "data":
            data_lines.append(value)
        elif field == "id":
            seq = value
    if not data_lines:
        return None
    return {"event": event, "seq": seq, "data": json.loads("\n".join(data_lines))}


def _names(events: list[dict]) -> list[str]:
    return [e["event"] for e in events]


def _frames(events: list[dict]) -> list[dict]:
    return [e["data"] for e in events if e["event"] == "frame"]


def _finding_ids(frame: dict) -> set[tuple[str, str | None]]:
    return {(f["kind"], f["root_cause"]) for f in frame["findings"]}


def _delta_ids(rows) -> set[tuple[str, str | None]]:
    return {(r["kind"], r["root_cause"]) for r in rows}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture(scope="session")
async def api_client():
    """Same shape as `test_api.py`'s: the app with its lifespan running."""
    from httpx import ASGITransport, AsyncClient

    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c


@pytest_asyncio.fixture(autouse=True)
async def no_replay_leaks():
    """No replay outlives its test. Also the assertion that `reset()` works,
    since every test in this file depends on starting from nothing."""
    R.reset()
    yield
    R.reset()
    await asyncio.sleep(0)
    assert R.active_project_ids() == []


@pytest.fixture
def short_grace(monkeypatch):
    """A reap window a test can wait out."""
    monkeypatch.setattr(R, "IDLE_GRACE_SECONDS", 0.25)
    return 0.25


async def _start(api_client, project_id=EVENT_PROJECT_ID, **body):
    r = await api_client.post(f"/api/projects/{project_id}/replay", json=body)
    assert r.status_code == 200, r.text
    return r.json()


# ---------------------------------------------------------------------------
# 1. Findings appear and clear at the correct simulated times
# ---------------------------------------------------------------------------


class TestSimulatedTime:
    async def test_the_replay_walks_every_simulated_day(self, api_client):
        """The campus fixture's log runs day 0 to 13 and today is day 14, so
        the replay stops at every whole day in [0, 14]. Whole days matter as
        much as event days: `ready_but_idle` crosses its threshold on the
        clock, not on an event."""
        state = await _start(api_client, speed=TEST_SPEED)
        assert state["horizon_day"] == 14.0
        assert state["seconds_per_simulated_day"] == pytest.approx(0.05)

        async with SSEConnection(f"/api/projects/{EVENT_PROJECT_ID}/stream") as c:
            assert c.status == 200
            assert c.headers["content-type"].startswith("text/event-stream")
            events = await c.collect_until("end")

        assert events[0]["event"] == "catchup"
        days = [f["clock"]["sim_day"] for f in _frames(events)]
        assert days == [float(d) for d in range(1, 15)], days
        assert events[0]["data"]["frame"]["clock"]["sim_day"] == 0.0

    async def test_stalled_in_review_appears_on_the_day_it_crosses(
        self, api_client
    ):
        """T03 entered review on day 5 with a 4-day idle threshold, so it is
        stalled from day 9 and not one simulated day sooner."""
        await _start(api_client, speed=TEST_SPEED)
        async with SSEConnection(f"/api/projects/{EVENT_PROJECT_ID}/stream") as c:
            events = await c.collect_until("end")

        by_day = {f["clock"]["sim_day"]: f for f in _frames(events)}
        by_day[0.0] = events[0]["data"]["frame"]

        target = ("stalled_in_review", "T03")
        for day in range(0, 9):
            assert target not in _finding_ids(by_day[float(day)]), day
        for day in range(9, 15):
            assert target in _finding_ids(by_day[float(day)]), day

        assert target in _delta_ids(by_day[9.0]["delta"]["appeared"])
        assert target not in _delta_ids(by_day[9.0]["delta"]["cleared"])
        for day in range(10, 15):
            assert target not in _delta_ids(
                by_day[float(day)]["delta"]["appeared"]
            ), f"day {day} re-announced a finding that was already showing"

    async def test_ready_but_idle_appears_and_a_blocker_clears(self, api_client):
        """One finding appearing and another clearing, each at its own day.
        T12 is ready-but-idle from day 8; T01 blocks the critical path until
        it completes on day 2, and the finding clears with it."""
        await _start(api_client, speed=TEST_SPEED)
        async with SSEConnection(f"/api/projects/{EVENT_PROJECT_ID}/stream") as c:
            events = await c.collect_until("end")

        by_day = {f["clock"]["sim_day"]: f for f in _frames(events)}
        by_day[0.0] = events[0]["data"]["frame"]

        assert ("ready_but_idle", "T12") not in _finding_ids(by_day[7.0])
        assert ("ready_but_idle", "T12") in _finding_ids(by_day[8.0])
        assert ("ready_but_idle", "T12") in _delta_ids(
            by_day[8.0]["delta"]["appeared"]
        )

        assert ("critical_path_blocker", "T01") in _finding_ids(by_day[1.0])
        assert ("critical_path_blocker", "T01") not in _finding_ids(by_day[2.0])
        cleared = {(r["kind"], r["root_cause"]) for r in by_day[2.0]["delta"]["cleared"]}
        assert ("critical_path_blocker", "T01") in cleared

    async def test_the_final_frame_agrees_with_analyze(self, api_client):
        """At the simulated present the replay must reproduce exactly what
        `/analyze` says today. If it did not, one of them would be lying."""
        analysis = (
            await api_client.post(f"/api/projects/{EVENT_PROJECT_ID}/analyze")
        ).json()

        await _start(api_client, speed=FAST_SPEED)
        async with SSEConnection(f"/api/projects/{EVENT_PROJECT_ID}/stream") as c:
            events = await c.collect_until("end")

        last = _frames(events)[-1] if _frames(events) else events[0]["data"]["frame"]
        assert last["clock"]["sim_day"] == 14.0
        assert last["projection"]["projected_end_day"] == analysis["projected_end"]
        assert last["projection"]["planned_end_day"] == analysis["planned_end"]
        assert last["projection"]["slip_days"] == analysis["slip_days"]
        assert last["critical_path"] == analysis["critical_path"]
        assert _finding_ids(last) == {
            (f["kind"], f["root_cause"]) for f in analysis["findings"]
        }

    async def test_every_frame_states_what_it_could_not_know(self, api_client):
        """The honesty layer. A projection computed at simulated day 6 rests
        on the events known at day 6, and the payload says so rather than a
        comment saying so."""
        await _start(api_client, speed=FAST_SPEED)
        async with SSEConnection(f"/api/projects/{EVENT_PROJECT_ID}/stream") as c:
            events = await c.collect_until("end")

        frames = [events[0]["data"]["frame"], *_frames(events)]
        assert frames
        for frame in frames:
            derived = frame["derived"]
            assert derived["is_reconstruction"] is True
            assert derived["computed_at_simulated_day"] == frame["clock"]["sim_day"]
            assert derived["events_known"] + derived["events_pending"] == (
                derived["events_total"]
            )
            assert derived["caveats"]
            assert any(
                "deliberately not been applied" in c for c in derived["caveats"]
            )
            assert frame["projection"]["is_probability"] is False
            assert "unavailable_checks" in frame

        early = frames[1]
        assert early["derived"]["events_pending"] > 0
        assert any(
            "occur after this simulated day" in c
            for c in early["derived"]["caveats"]
        )

    async def test_a_cold_start_project_replays_without_a_log(self, api_client):
        """The manufacturing fixture has no events at all. A replay of it is
        a clock advancing over a workflow that never changes - which is the
        honest answer, not an error."""
        state = await _start(api_client, project_id=MFG_PROJECT_ID, speed=FAST_SPEED)
        assert state["events_total"] == 0
        async with SSEConnection(f"/api/projects/{MFG_PROJECT_ID}/stream") as c:
            events = await c.collect_until("end", timeout=10.0)
        frame = events[0]["data"]["frame"]
        assert frame["derived"]["events_total"] == 0
        assert frame["tier_reached"] == 0
        assert frame["unavailable_checks"]


# ---------------------------------------------------------------------------
# 2. A replay never touches the stored workflow
# ---------------------------------------------------------------------------


class TestReplayWritesNothing:
    async def test_the_base_version_hash_is_byte_identical_afterwards(
        self, api_client
    ):
        before = (
            await api_client.get(f"/api/projects/{EVENT_PROJECT_ID}/workflow")
        ).json()

        await _start(api_client, speed=FAST_SPEED)
        async with SSEConnection(f"/api/projects/{EVENT_PROJECT_ID}/stream") as c:
            await c.collect_until("end")
        for body in (
            {"action": "seek", "to_day": 3},
            {"action": "restart"},
            {"action": "pause"},
            {"action": "speed", "speed": 120},
            {"action": "resume"},
        ):
            r = await api_client.post(
                f"/api/projects/{EVENT_PROJECT_ID}/replay/control", json=body
            )
            assert r.status_code == 200, r.text
        await api_client.delete(f"/api/projects/{EVENT_PROJECT_ID}/replay")

        after = (
            await api_client.get(f"/api/projects/{EVENT_PROJECT_ID}/workflow")
        ).json()
        assert after["version"]["content_hash"] == before["version"]["content_hash"]
        assert after["version"]["id"] == before["version"]["id"]
        assert after["version"]["version_no"] == before["version"]["version_no"]
        assert after["tasks"] == before["tasks"]

    async def test_no_event_rows_and_no_versions_are_written(self, api_client):
        """A replay reads the log. It must never append to it, or a demo
        would double the history every time somebody pressed play."""
        versions_before = (
            await api_client.get(f"/api/projects/{EVENT_PROJECT_ID}/versions")
        ).json()
        analysis_before = (
            await api_client.post(f"/api/projects/{EVENT_PROJECT_ID}/analyze")
        ).json()

        await _start(api_client, speed=FAST_SPEED)
        async with SSEConnection(f"/api/projects/{EVENT_PROJECT_ID}/stream") as c:
            await c.collect_until("end")
        await api_client.delete(f"/api/projects/{EVENT_PROJECT_ID}/replay")

        versions_after = (
            await api_client.get(f"/api/projects/{EVENT_PROJECT_ID}/versions")
        ).json()
        analysis_after = (
            await api_client.post(f"/api/projects/{EVENT_PROJECT_ID}/analyze")
        ).json()

        assert len(versions_after) == len(versions_before)
        assert analysis_after["input_hash"] == analysis_before["input_hash"]
        assert analysis_after["projected_end"] == analysis_before["projected_end"]
        assert len(analysis_after["findings"]) == len(analysis_before["findings"])

    async def test_the_state_payload_says_it_writes_nothing(self, api_client):
        state = await _start(api_client, speed=FAST_SPEED)
        assert state["writes_nothing"] is True
        assert "immutable snapshot" in state["note"]


# ---------------------------------------------------------------------------
# 3. Disconnect, and the task that must not leak
# ---------------------------------------------------------------------------


class TestNoLeaks:
    async def test_a_disconnect_mid_stream_reaps_the_replay(
        self, api_client, short_grace
    ):
        """The whole leak story: a viewer closes the tab mid-replay, the SSE
        generator's `finally` releases the subscription, the last subscriber
        leaving arms the reaper, and the driver task is cancelled and the
        registry emptied."""
        await _start(api_client, speed=TEST_SPEED)
        pid = uuid.UUID(EVENT_PROJECT_ID)
        session = R.session_for(pid)
        assert session is not None

        conn = SSEConnection(f"/api/projects/{EVENT_PROJECT_ID}/stream")
        await conn.__aenter__()
        first = await conn.next_event()
        assert first["event"] == "catchup"
        assert session.subscriber_count == 1

        await conn.disconnect()
        assert session.subscriber_count == 0

        await asyncio.sleep(short_grace * 3)
        assert R.active_project_ids() == []
        assert session.task_done
        assert session.stopped is True

    async def test_a_replay_nobody_ever_watches_is_reaped_too(
        self, api_client, short_grace
    ):
        await _start(api_client, speed=TEST_SPEED)
        assert R.active_project_ids() != []
        await asyncio.sleep(short_grace * 3)
        assert R.active_project_ids() == []

    async def test_one_viewer_leaving_does_not_stop_the_others(
        self, api_client, short_grace
    ):
        await _start(api_client, speed=TEST_SPEED)
        session = R.session_for(uuid.UUID(EVENT_PROJECT_ID))

        a = await SSEConnection(f"/api/projects/{EVENT_PROJECT_ID}/stream").__aenter__()
        b = await SSEConnection(f"/api/projects/{EVENT_PROJECT_ID}/stream").__aenter__()
        await a.next_event()
        await b.next_event()
        assert session.subscriber_count == 2

        await a.disconnect()
        assert session.subscriber_count == 1
        await asyncio.sleep(short_grace * 2)
        assert R.active_project_ids() != []
        assert not session.task_done or session.finished

        assert (await b.next_event())["event"] in ("frame", "end", "control")
        await b.disconnect()
        await api_client.delete(f"/api/projects/{EVENT_PROJECT_ID}/replay")

    async def test_stopping_ends_every_open_stream(self, api_client):
        await _start(api_client, speed=TEST_SPEED)
        async with SSEConnection(f"/api/projects/{EVENT_PROJECT_ID}/stream") as c:
            await c.next_event()
            r = await api_client.delete(
                f"/api/projects/{EVENT_PROJECT_ID}/replay"
            )
            assert r.status_code == 200
            assert r.json()["stopped"] is True

            saw_stop = False
            with pytest.raises(StreamClosed):
                while True:
                    event = await c.next_event()
                    saw_stop = saw_stop or event["event"] == "stopped"
            assert saw_stop
        assert R.active_project_ids() == []


# ---------------------------------------------------------------------------
# 4. Pause, resume, seek, restart
# ---------------------------------------------------------------------------


class TestControls:
    async def _control(self, api_client, **body):
        r = await api_client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/replay/control", json=body
        )
        assert r.status_code == 200, r.text
        return r.json()

    async def test_pause_stops_the_clock_and_resume_starts_it_again(
        self, api_client
    ):
        await _start(api_client, speed=TEST_SPEED)
        paused = await self._control(api_client, action="pause")
        assert paused["paused"] is True

        held = paused["sim_day"]
        await asyncio.sleep(0.3)  # six simulated days' worth of real time
        still = (
            await api_client.get(f"/api/projects/{EVENT_PROJECT_ID}/replay")
        ).json()
        assert still["sim_day"] == held
        assert still["paused"] is True

        resumed = await self._control(api_client, action="resume")
        assert resumed["paused"] is False
        await asyncio.sleep(0.3)
        moved = (
            await api_client.get(f"/api/projects/{EVENT_PROJECT_ID}/replay")
        ).json()
        assert moved["sim_day"] > held

    async def test_seek_jumps_the_clock_and_emits_the_frame_for_that_day(
        self, api_client
    ):
        await _start(api_client, speed=TEST_SPEED)
        async with SSEConnection(f"/api/projects/{EVENT_PROJECT_ID}/stream") as c:
            await c.next_event()
            await self._control(api_client, action="pause")
            await self._control(api_client, action="seek", to_day=9)

            frame = None
            while frame is None:
                event = await c.next_event()
                if event["event"] == "frame" and event["data"]["reason"] == "seek":
                    frame = event["data"]
            assert frame["clock"]["sim_day"] == 9.0
            assert ("stalled_in_review", "T03") in _finding_ids(frame)

        state = (
            await api_client.get(f"/api/projects/{EVENT_PROJECT_ID}/replay")
        ).json()
        assert state["sim_day"] == 9.0

    async def test_seek_is_clamped_to_the_replay_window(self, api_client):
        await _start(api_client, speed=TEST_SPEED)
        await self._control(api_client, action="pause")
        assert (
            await self._control(api_client, action="seek", to_day=999)
        )["sim_day"] == 14.0
        assert (
            await self._control(api_client, action="seek", to_day=0)
        )["sim_day"] == 0.0

    async def test_restart_returns_the_clock_to_the_start(self, api_client):
        await _start(api_client, speed=TEST_SPEED)
        await self._control(api_client, action="pause")
        await self._control(api_client, action="seek", to_day=12)
        restarted = await self._control(api_client, action="restart")
        assert restarted["sim_day"] == 0.0
        assert restarted["paused"] is False
        assert restarted["finished"] is False

    async def test_speed_changes_the_pace_and_is_echoed(self, api_client):
        await _start(api_client, speed=TEST_SPEED)
        faster = await self._control(api_client, action="speed", speed=6000)
        assert faster["speed"] == 6000
        assert faster["seconds_per_simulated_day"] == pytest.approx(0.01)

    async def test_an_unknown_action_is_refused_with_the_list(self, api_client):
        await _start(api_client, speed=TEST_SPEED)
        r = await api_client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/replay/control",
            json={"action": "rewind"},
        )
        assert r.status_code == 400
        assert "pause" in r.json()["detail"]

    async def test_seek_without_a_day_is_refused(self, api_client):
        await _start(api_client, speed=TEST_SPEED)
        r = await api_client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/replay/control",
            json={"action": "seek"},
        )
        assert r.status_code == 400

    async def test_controls_without_a_replay_are_404(self, api_client):
        for method, path, body in (
            ("get", f"/api/projects/{EVENT_PROJECT_ID}/replay", None),
            ("get", f"/api/projects/{EVENT_PROJECT_ID}/replay/timeline", None),
            ("get", f"/api/projects/{EVENT_PROJECT_ID}/stream", None),
            ("delete", f"/api/projects/{EVENT_PROJECT_ID}/replay", None),
        ):
            r = await getattr(api_client, method)(path)
            assert r.status_code == 404, path
        r = await api_client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/replay/control",
            json={"action": "pause"},
        )
        assert r.status_code == 404

    async def test_starting_a_replay_for_a_missing_project_is_404(
        self, api_client
    ):
        missing = "00000000-0000-0000-0000-0000000000ff"
        r = await api_client.post(f"/api/projects/{missing}/replay", json={})
        assert r.status_code == 404

    async def test_the_timeline_names_every_step_and_event(self, api_client):
        await _start(api_client, speed=TEST_SPEED)
        timeline = (
            await api_client.get(
                f"/api/projects/{EVENT_PROJECT_ID}/replay/timeline"
            )
        ).json()
        assert [s["day"] for s in timeline["steps"]] == [
            float(d) for d in range(0, 15)
        ]
        assert len(timeline["events"]) == 13
        assert timeline["events"][0]["task_key"] == "T01"


# ---------------------------------------------------------------------------
# 5. Many viewers on one replay
# ---------------------------------------------------------------------------


class TestConcurrentViewers:
    async def test_two_subscribers_both_receive_the_same_frames(
        self, api_client
    ):
        await _start(api_client, speed=TEST_SPEED)
        a = await SSEConnection(f"/api/projects/{EVENT_PROJECT_ID}/stream").__aenter__()
        b = await SSEConnection(f"/api/projects/{EVENT_PROJECT_ID}/stream").__aenter__()
        try:
            assert (await a.next_event())["event"] == "catchup"
            assert (await b.next_event())["event"] == "catchup"

            frames_a = _frames(await a.collect_until("end"))
            frames_b = _frames(await b.collect_until("end"))
            assert frames_a and frames_b
            assert [f["clock"]["sim_day"] for f in frames_a] == [
                f["clock"]["sim_day"] for f in frames_b
            ]
            assert [f["seq"] for f in frames_a] == [f["seq"] for f in frames_b]
        finally:
            await a.disconnect()
            await b.disconnect()

    async def test_a_late_subscriber_gets_current_state_before_live_events(
        self, api_client
    ):
        """A viewer arriving mid-replay sees where the replay actually is,
        not an empty screen and not the beginning."""
        await _start(api_client, speed=TEST_SPEED)
        early = await SSEConnection(
            f"/api/projects/{EVENT_PROJECT_ID}/stream"
        ).__aenter__()
        try:
            await early.next_event()
            # Let the replay run past the start.
            while True:
                event = await early.next_event()
                if event["event"] == "frame" and event["data"]["clock"]["sim_day"] >= 5:
                    break

            late = await SSEConnection(
                f"/api/projects/{EVENT_PROJECT_ID}/stream"
            ).__aenter__()
            try:
                first = await late.next_event()
                assert first["event"] == "catchup"
                frame = first["data"]["frame"]
                assert frame, "a late viewer must never receive an empty frame"
                assert frame["clock"]["sim_day"] >= 5.0
                assert frame["findings"] is not None
                assert first["data"]["replay"]["subscribers"] >= 2

                nxt = await late.next_event()
                assert nxt["event"] in ("frame", "control", "end")
            finally:
                await late.disconnect()
        finally:
            await early.disconnect()

    async def test_a_control_reaches_every_viewer(self, api_client):
        await _start(api_client, speed=TEST_SPEED)
        a = await SSEConnection(f"/api/projects/{EVENT_PROJECT_ID}/stream").__aenter__()
        b = await SSEConnection(f"/api/projects/{EVENT_PROJECT_ID}/stream").__aenter__()
        try:
            await a.next_event()
            await b.next_event()
            r = await api_client.post(
                f"/api/projects/{EVENT_PROJECT_ID}/replay/control",
                json={"action": "pause"},
            )
            assert r.status_code == 200

            for conn in (a, b):
                seen = None
                while seen is None:
                    event = await conn.next_event()
                    if event["event"] == "control":
                        seen = event
                assert seen["data"]["action"] == "pause"
                assert seen["data"]["replay"]["paused"] is True
        finally:
            await a.disconnect()
            await b.disconnect()

    async def test_restarting_a_running_replay_replaces_it(self, api_client):
        await _start(api_client, speed=TEST_SPEED)
        first = R.session_for(uuid.UUID(EVENT_PROJECT_ID))
        async with SSEConnection(f"/api/projects/{EVENT_PROJECT_ID}/stream") as c:
            await c.next_event()
            await _start(api_client, speed=TEST_SPEED)
            second = R.session_for(uuid.UUID(EVENT_PROJECT_ID))
            assert second is not first

            saw_restarted = False
            with pytest.raises(StreamClosed):
                while True:
                    event = await c.next_event()
                    saw_restarted = saw_restarted or event["event"] == "restarted"
            assert saw_restarted
        await api_client.delete(f"/api/projects/{EVENT_PROJECT_ID}/replay")


# ---------------------------------------------------------------------------
# 6. Two projects at once, and the payload contract
# ---------------------------------------------------------------------------


class TestRegistry:
    async def test_two_projects_replay_independently(self, api_client):
        await _start(api_client, speed=TEST_SPEED)
        await _start(api_client, project_id=MFG_PROJECT_ID, speed=TEST_SPEED)
        assert len(R.active_project_ids()) == 2

        one = (
            await api_client.get(f"/api/projects/{EVENT_PROJECT_ID}/replay")
        ).json()
        two = (
            await api_client.get(f"/api/projects/{MFG_PROJECT_ID}/replay")
        ).json()
        assert one["project_id"] != two["project_id"]
        assert one["version_id"] != two["version_id"]

        await api_client.delete(f"/api/projects/{EVENT_PROJECT_ID}/replay")
        assert len(R.active_project_ids()) == 1
        await api_client.delete(f"/api/projects/{MFG_PROJECT_ID}/replay")
        assert R.active_project_ids() == []

    async def test_start_day_moves_the_window(self, api_client):
        state = await _start(api_client, speed=TEST_SPEED, start_day=10)
        assert state["start_day"] == 10.0
        assert state["sim_day"] == 10.0
        timeline = (
            await api_client.get(
                f"/api/projects/{EVENT_PROJECT_ID}/replay/timeline"
            )
        ).json()
        assert [s["day"] for s in timeline["steps"]] == [10.0, 11.0, 12.0, 13.0, 14.0]

    async def test_a_zero_or_negative_speed_is_refused_by_validation(
        self, api_client
    ):
        r = await api_client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/replay", json={"speed": 0}
        )
        assert r.status_code == 422

    async def test_the_frame_carries_dates_not_only_day_offsets(
        self, api_client
    ):
        await _start(api_client, speed=TEST_SPEED)
        frame = (
            await api_client.get(f"/api/projects/{EVENT_PROJECT_ID}/replay")
        ).json()["frame"]
        assert frame["clock"]["sim_date"] == "2026-09-01"
        assert frame["clock"]["project_start"] == "2026-09-01"
        assert frame["projection"]["projected_end_date"]
        assert frame["projection"]["deadline_date"]

    async def test_the_delta_is_a_full_account_of_what_moved(self, api_client):
        """Appeared, cleared, severity-changed and unchanged must add up:
        a finding cannot quietly vanish from the accounting."""
        await _start(api_client, speed=FAST_SPEED)
        async with SSEConnection(f"/api/projects/{EVENT_PROJECT_ID}/stream") as c:
            events = await c.collect_until("end")

        previous = events[0]["data"]["frame"]
        for frame in _frames(events):
            delta = frame["delta"]
            before = len(previous["findings"])
            after = len(frame["findings"])
            assert after == before + len(delta["appeared"]) - len(delta["cleared"])
            assert (
                delta["unchanged"]
                + len(delta["severity_changed"])
                + len(delta["cleared"])
            ) == before
            previous = frame
