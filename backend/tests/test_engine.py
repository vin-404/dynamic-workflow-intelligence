"""
Regression tests for engine.py — ported from demo.py.

These verify the deterministic engine produces correct results
with the demo scenario data. Every assertion here corresponds to
a verified output from the original demo.
"""
import pytest
from backend.app.core import engine as E

from backend.app.services.seed import (
    TASKS, DEPS, STATUS, EVENTS, REQUIREMENTS, TODAY_DAY, PROJECT_START,
)


class TestSchedule:
    """CPM scheduling regression tests."""

    def test_planned_finish(self, baseline_schedule):
        assert baseline_schedule["project_end"] == 22

    def test_projected_finish(self, current_schedule):
        assert current_schedule["project_end"] == 26

    def test_slip_days(self, baseline_schedule, current_schedule):
        slip = current_schedule["project_end"] - baseline_schedule["project_end"]
        assert slip == 4

    def test_critical_path(self, current_schedule):
        assert current_schedule["critical"] == [
            "T01", "T02", "T03", "T13", "T14", "T15", "T17"
        ]

    def test_critical_path_has_zero_slack(self, current_schedule):
        for tid in current_schedule["critical"]:
            assert abs(current_schedule["slack"][tid]) < 1e-9

    def test_non_critical_has_positive_slack(self, current_schedule):
        non_critical = set(TASKS) - set(current_schedule["critical"])
        for tid in non_critical:
            assert current_schedule["slack"][tid] > 0


class TestBottleneckDetection:
    """Bottleneck detector regression tests."""

    def test_detects_four_bottlenecks(self, graph, current_schedule, dept_capacity):
        found = E.detect(
            graph, current_schedule, STATUS, EVENTS, dept_capacity, TODAY_DAY
        )
        assert len(found) == 4

    def test_recall_100_percent(self, graph, current_schedule, dept_capacity):
        found = E.detect(
            graph, current_schedule, STATUS, EVENTS, dept_capacity, TODAY_DAY
        )
        detected = {b.root_cause for b in found}
        truth = {"T03", "MKT", "T12"}
        assert truth.issubset(detected), f"Missed: {truth - detected}"

    def test_precision_100_percent(self, graph, current_schedule, dept_capacity):
        found = E.detect(
            graph, current_schedule, STATUS, EVENTS, dept_capacity, TODAY_DAY
        )
        detected = {b.root_cause for b in found}
        truth = {"T03", "MKT", "T12"}
        extra = detected - truth
        assert len(extra) == 0, f"Extra detections: {extra}"

    def test_critical_path_blocker_found(self, graph, current_schedule, dept_capacity):
        found = E.detect(
            graph, current_schedule, STATUS, EVENTS, dept_capacity, TODAY_DAY
        )
        kinds = {b.kind for b in found if b.root_cause == "T03"}
        assert "critical_path_blocker" in kinds

    def test_stalled_in_review_found(self, graph, current_schedule, dept_capacity):
        found = E.detect(
            graph, current_schedule, STATUS, EVENTS, dept_capacity, TODAY_DAY
        )
        kinds = {b.kind for b in found if b.root_cause == "T03"}
        assert "stalled_in_review" in kinds

    def test_resource_contention_found(self, graph, current_schedule, dept_capacity):
        found = E.detect(
            graph, current_schedule, STATUS, EVENTS, dept_capacity, TODAY_DAY
        )
        contention = [b for b in found if b.kind == "resource_contention"]
        assert len(contention) == 1
        assert contention[0].root_cause == "MKT"

    def test_ready_but_idle_found(self, graph, current_schedule, dept_capacity):
        found = E.detect(
            graph, current_schedule, STATUS, EVENTS, dept_capacity, TODAY_DAY
        )
        idle = [b for b in found if b.kind == "ready_but_idle"]
        assert len(idle) == 1
        assert idle[0].root_cause == "T12"


class TestDelaySimulation:
    """Change propagation regression tests."""

    def test_t03_plus_5_project_end(self, graph, observed_durations, current_schedule):
        delayed = E.apply_delay(observed_durations, "T03", 5)
        after = E.schedule(graph, delayed)
        d = E.diff(current_schedule, after)
        assert d["project_end_after"] == 31
        assert d["project_end_delta"] == 5

    def test_t03_plus_5_moves_7_tasks(self, graph, observed_durations, current_schedule):
        delayed = E.apply_delay(observed_durations, "T03", 5)
        after = E.schedule(graph, delayed)
        d = E.diff(current_schedule, after)
        assert len(d["tasks_moved"]) == 7

    def test_t03_plus_5_critical_path_unchanged(self, graph, observed_durations, current_schedule):
        delayed = E.apply_delay(observed_durations, "T03", 5)
        after = E.schedule(graph, delayed)
        d = E.diff(current_schedule, after)
        assert d["critical_path_changed"] is False

    def test_absorbed_by_slack(self, graph, observed_durations, current_schedule):
        """A small delay on a non-critical task should be absorbed by slack."""
        delayed = E.apply_delay(observed_durations, "T12", 1)
        after = E.schedule(graph, delayed)
        d = E.diff(current_schedule, after)
        assert d["project_end_delta"] == 0


class TestRequirementStaleness:
    """Requirement impact analysis regression tests."""

    def test_r2_must_redo(self, graph):
        req = REQUIREMENTS["R2"]
        st = E.stale_tasks(graph, set(req["consumed_by"]))
        assert sorted(st["must_redo"]) == ["T10", "T11", "T12", "T16"]

    def test_r2_must_recheck(self, graph):
        req = REQUIREMENTS["R2"]
        st = E.stale_tasks(graph, set(req["consumed_by"]))
        assert st["must_recheck"] == ["T17"]

    def test_r1_must_redo(self, graph):
        req = REQUIREMENTS["R1"]
        st = E.stale_tasks(graph, set(req["consumed_by"]))
        # T02 consumes R1, and T03 consumes T02's artifact, etc.
        assert "T02" in st["must_redo"]
        assert "T04" in st["must_redo"]

    def test_r3_must_redo(self, graph):
        req = REQUIREMENTS["R3"]
        st = E.stale_tasks(graph, set(req["consumed_by"]))
        assert "T05" in st["must_redo"]
        assert "T12" in st["must_redo"]


class TestCycleDetection:
    """Cycle detection regression tests."""

    def test_cycle_detected(self, graph, observed_durations):
        bad = graph.copy()
        bad.add_edge("T15", "T13", kind="temporal")
        with pytest.raises(E.CycleError) as exc_info:
            E.schedule(bad, observed_durations)
        assert len(exc_info.value.cycles) > 0

    def test_valid_graph_no_cycle(self, graph, observed_durations):
        # Should not raise
        E.schedule(graph, observed_durations)
