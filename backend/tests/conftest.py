"""Shared test fixtures.

Hermeticity note (decision D-06): the database URL is redirected to a
throwaway file *before* any application module is imported, so the suite never
reads or writes the developer's `dwi.db`. Nothing here depends on state left
behind by a previous run.

Engine fixtures are built from `backend.app.seed.fixtures`, which returns a
fresh immutable snapshot on every call. There are no module-level workflow
globals anywhere in the suite - that was the prototype's `scenario.py`, and it
is what made evaluating N optimizer candidates impossible.
"""
import os
import pathlib
import sys
import tempfile

# Project root on the path so `backend.app...` imports resolve.
_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

# Redirect the database to a temporary file. Must happen before the app's
# settings module is imported, because the async engine is created at import.
_TMPDIR = pathlib.Path(tempfile.mkdtemp(prefix="dwi-tests-"))
_DBFILE = (_TMPDIR / "test.db").as_posix()
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_DBFILE}"
os.environ["DATABASE_URL_SYNC"] = f"sqlite:///{_DBFILE}"

# Pin the open configuration, for the same reason and by the same technique.
# `Settings` reads `env_file=".env"`, so a developer who puts a real
# `PROXY_SHARED_SECRET` in the repo-root `.env` would silently flip the whole
# suite into enforcing mode - and the tests that assert the pre-auth behaviour
# (`test_hardening`'s advisory-role cases) would fail on their machine and
# nowhere else. An explicitly empty environment variable outranks the dotenv
# value, so this makes the compatibility path the one the suite always runs.
# `test_auth.py` sets the secret per-test on the live `settings` object, which
# is how the enforcing configuration gets covered.
os.environ["PROXY_SHARED_SECRET"] = ""

import pytest  # noqa: E402

from backend.app.core import engine as E  # noqa: E402
from backend.app.core.engine.graph import build_graph_from_snapshot  # noqa: E402
from backend.app.core.workflow import Clock, EngineConfig  # noqa: E402
from backend.app.seed.fixtures import (  # noqa: E402
    event_operations_fixture,
    hardware_manufacturing_fixture,
)


# ---------------------------------------------------------------------------
# Fixture projects
# ---------------------------------------------------------------------------


@pytest.fixture
def event_fixture():
    """The migrated campus symposium: statuses and event history, Tier 2."""
    return event_operations_fixture()


@pytest.fixture
def mfg_fixture():
    """A pilot production line with no history at all: the cold start, Tier 0."""
    return hardware_manufacturing_fixture()


@pytest.fixture
def snapshot(event_fixture):
    return event_fixture.snapshot


@pytest.fixture
def state(event_fixture):
    return event_fixture.state


@pytest.fixture
def clock(event_fixture):
    return Clock(event_fixture.today_day)


@pytest.fixture
def config():
    return EngineConfig()


# ---------------------------------------------------------------------------
# Derived engine inputs
# ---------------------------------------------------------------------------


@pytest.fixture
def graph(snapshot):
    return build_graph_from_snapshot(snapshot)


@pytest.fixture
def planned_durations(snapshot, config):
    durations, _ = E.planned_durations(snapshot, config)
    return durations


@pytest.fixture
def observed_durations(snapshot, state, clock, config):
    """Planned durations stretched by what has actually been observed.

    T03 entered review on day 5 and it is now day 14, so its two planned days
    have become nine elapsed ones. The prototype computed the same number by
    hand in this file; it is now engine arithmetic in
    `core.engine.effort.observed_durations`.
    """
    return E.observed_durations(snapshot, state, clock, config)


@pytest.fixture
def baseline_schedule(graph, planned_durations):
    return E.schedule(graph, planned_durations)


@pytest.fixture
def current_schedule(graph, observed_durations):
    return E.schedule(graph, observed_durations)


@pytest.fixture
def evaluation(snapshot, state, clock, config):
    return E.evaluate(snapshot, state, clock, config)
