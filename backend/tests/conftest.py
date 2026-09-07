"""Shared test fixtures.

Hermeticity note (Phase 1, decision D-06): the database URL is redirected to a
throwaway file *before* any application module is imported, so the suite never
reads or writes the developer's `dwi.db`. Nothing here depends on state left
behind by a previous run.
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

import pytest  # noqa: E402

from backend.app.core import engine as E  # noqa: E402

from backend.app.services.seed import (  # noqa: E402
    TASKS, DEPS, STATUS, EVENTS, REQUIREMENTS, TODAY_DAY, PROJECT_START,
)


@pytest.fixture
def graph():
    return E.build_graph(TASKS, DEPS)


@pytest.fixture
def planned_durations():
    return {tid: float(t["duration"]) for tid, t in TASKS.items()}


@pytest.fixture
def observed_durations(planned_durations):
    d = dict(planned_durations)
    # T03 has been sitting in review since day 5, it's now day 14
    # Planned duration was 2 days. Stalled extra = 14 - 5 - 2 = 7 days
    stalled_extra = TODAY_DAY - 5.0 - d["T03"]
    d["T03"] = d["T03"] + stalled_extra
    return d


@pytest.fixture
def baseline_schedule(graph, planned_durations):
    return E.schedule(graph, planned_durations)


@pytest.fixture
def current_schedule(graph, observed_durations):
    return E.schedule(graph, observed_durations)


@pytest.fixture
def dept_capacity():
    return {"ORG": 2, "FIN": 1, "FAC": 1, "MKT": 1, "SPON": 1}
