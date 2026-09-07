"""Shared test fixtures."""
import sys
import os

# Ensure project root is on the path so `import engine` works
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

import pytest
import engine as E

# Import scenario data from the seed module (our canonical source)
from backend.app.services.seed import (
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
