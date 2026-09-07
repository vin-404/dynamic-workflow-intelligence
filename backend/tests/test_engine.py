"""
Regression tests for the core engine.

Every assertion in this file was written against the prototype `engine.py` and
is preserved unchanged through the move into `core/`, the `Department` ->
`Resource` rename, and the `duration` -> `effort` rename. If a number here
moves, the refactor broke something.

The only mechanical changes from the original: fixtures come from
`backend.app.seed.fixtures` instead of module-level globals, `detect()` takes
an explicit snapshot/state/clock instead of dicts and a `depts` mapping, and
the resource-contention root cause is the resource key `"mkt"` rather than the
department string `"MKT"`.
"""
import pytest

from backend.app.core import engine as E
from backend.app.core.workflow import Clock, DepType


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

    def test_non_critical_has_positive_slack(self, snapshot, current_schedule):
        non_critical = set(snapshot.task_keys) - set(current_schedule["critical"])
        for tid in non_critical:
            assert current_schedule["slack"][tid] > 0


class TestBottleneckDetection:
    """Bottleneck detector regression tests."""

    @pytest.fixture
    def found(self, graph, current_schedule, snapshot, state, clock, config):
        return E.detect(graph, current_schedule, snapshot, state, clock, config)

    def test_detects_four_bottlenecks(self, found):
        assert len(found) == 4

    def test_recall_100_percent(self, found):
        detected = {b.root_cause for b in found}
        truth = {"T03", "mkt", "T12"}
        assert truth.issubset(detected), f"Missed: {truth - detected}"

    def test_precision_100_percent(self, found):
        detected = {b.root_cause for b in found}
        truth = {"T03", "mkt", "T12"}
        extra = detected - truth
        assert len(extra) == 0, f"Extra detections: {extra}"

    def test_critical_path_blocker_found(self, found):
        kinds = {b.kind for b in found if b.root_cause == "T03"}
        assert "critical_path_blocker" in kinds

    def test_stalled_in_review_found(self, found):
        kinds = {b.kind for b in found if b.root_cause == "T03"}
        assert "stalled_in_review" in kinds

    def test_resource_contention_found(self, found):
        contention = [b for b in found if b.kind == "resource_contention"]
        assert len(contention) == 1
        assert contention[0].root_cause == "mkt"

    def test_ready_but_idle_found(self, found):
        idle = [b for b in found if b.kind == "ready_but_idle"]
        assert len(idle) == 1
        assert idle[0].root_cause == "T12"

    def test_contention_reports_capacity_not_headcount(self, found):
        """Marketing has two people but capacity 1, and the finding cites the
        capacity it actually breached (decision D-16)."""
        contention = next(b for b in found if b.kind == "resource_contention")
        assert contention.evidence["capacity"] == 1
        assert contention.evidence["ready_tasks"] == 2
        assert contention.evidence["queue"] == ["T11", "T12"]

    def test_impact_score_is_a_recomputable_formula(self, found):
        for b in found:
            expected = b.attributed_delay_days * (1 + len(b.downstream_affected))
            assert b.impact_score == expected

    def test_every_finding_carries_evidence(self, found):
        for b in found:
            assert b.evidence, f"{b.kind} emitted a bare score"
            assert b.suggested_action
            assert b.severity in {"low", "medium", "high"}


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

    def test_t03_plus_5_critical_path_unchanged(
        self, graph, observed_durations, current_schedule
    ):
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

    def test_r2_must_redo(self, graph, snapshot):
        req = snapshot.requirement_by_key["R2"]
        st = E.stale_tasks(graph, set(req.consumed_by))
        assert sorted(st["must_redo"]) == ["T10", "T11", "T12", "T16"]

    def test_r2_must_recheck(self, graph, snapshot):
        req = snapshot.requirement_by_key["R2"]
        st = E.stale_tasks(graph, set(req.consumed_by))
        assert st["must_recheck"] == ["T17"]

    def test_r1_must_redo(self, graph, snapshot):
        req = snapshot.requirement_by_key["R1"]
        st = E.stale_tasks(graph, set(req.consumed_by))
        # T02 consumes R1, and T03 consumes T02's artifact, etc.
        assert "T02" in st["must_redo"]
        assert "T04" in st["must_redo"]

    def test_r3_must_redo(self, graph, snapshot):
        req = snapshot.requirement_by_key["R3"]
        st = E.stale_tasks(graph, set(req.consumed_by))
        assert "T05" in st["must_redo"]
        assert "T12" in st["must_redo"]

    def test_consuming_edges_drive_staleness_not_ordering_edges(self, graph, snapshot):
        """`consumes` replaced the artifact/temporal edge kind (D-11), and it
        is the property that makes requirement impact computable: an ordering
        edge propagates a re-check, not a redo."""
        st = E.stale_tasks(graph, {"T03"})
        # T03 -> T04 and T03 -> T05 are ordering only, so neither is invalid.
        assert "T04" not in st["must_redo"]
        assert "T05" not in st["must_redo"]
        assert "T04" in st["must_recheck"]


class TestCycleDetection:
    """Cycle detection regression tests."""

    def test_cycle_detected(self, graph, observed_durations):
        bad = graph.copy()
        bad.add_edge("T15", "T13", consumes=False, dep_type=DepType.FS.value)
        with pytest.raises(E.CycleError) as exc_info:
            E.schedule(bad, observed_durations)
        assert len(exc_info.value.cycles) > 0

    def test_valid_graph_no_cycle(self, graph, observed_durations):
        # Should not raise
        E.schedule(graph, observed_durations)

    def test_find_cycles_is_non_raising(self, graph):
        from backend.app.core.engine.graph import find_cycles

        assert find_cycles(graph) == []
        bad = graph.copy()
        bad.add_edge("T15", "T13", consumes=False, dep_type=DepType.FS.value)
        assert find_cycles(bad)


class TestEffortModel:
    """The parallelisation fallacy, refused explicitly (ARCHITECTURE D.3)."""

    def test_one_assignee_means_duration_equals_effort(self):
        assert E.duration_for(4.0, 1, divisible=True, efficiency=0.6) == 4.0

    def test_two_assignees_do_not_halve_the_task(self):
        d = E.duration_for(4.0, 2, divisible=True, efficiency=0.6)
        assert d == pytest.approx(4.0 / 1.6)
        assert d > 2.0, "duration / n is the wrong model"

    def test_non_divisible_task_gains_nothing_from_extra_people(self):
        assert E.duration_for(5.0, 4, divisible=False, efficiency=0.6) == 5.0

    def test_model_and_efficiency_are_reported(self, snapshot, config):
        _, model = E.planned_durations(snapshot, config)
        payload = model.as_dict()
        assert payload["efficiency"] == 0.6
        assert "effort / (1 + efficiency" in payload["formula"]

    def test_constraint_makes_a_task_non_divisible(self, snapshot):
        """T03 carries a NON_DIVISIBLE_TASK constraint, so the snapshot
        refuses to split it whatever the task flag says."""
        assert snapshot.is_divisible("T03") is False
        assert snapshot.is_divisible("T02") is True


class TestEvaluate:
    """The primitive itself."""

    def test_evaluate_reproduces_the_schedule(self, evaluation):
        assert evaluation.planned_end == 22
        assert evaluation.projected_end == 26
        assert evaluation.slip_days == 4

    def test_evaluate_reproduces_the_findings(self, evaluation):
        assert len(evaluation.findings) == 4
        assert {f.root_cause for f in evaluation.findings} == {"T03", "mkt", "T12"}

    def test_evaluate_is_pure_and_repeatable(self, snapshot, state, clock, config):
        a = E.evaluate(snapshot, state, clock, config).as_dict()
        b = E.evaluate(snapshot, state, clock, config).as_dict()
        assert a == b

    def test_evaluate_does_not_mutate_its_input(self, snapshot, state, clock, config):
        before = snapshot.content_hash()
        E.evaluate(snapshot, state, clock, config)
        assert snapshot.content_hash() == before

    def test_engine_version_and_input_hash_are_reported(self, evaluation):
        assert evaluation.engine_version
        assert len(evaluation.input_hash) == 64

    def test_feasibility_is_a_verdict_and_a_margin(self, evaluation):
        f = evaluation.feasibility.as_dict()
        assert f["verdict"] == "infeasible"
        assert f["margin_days"] == -2.0
        assert f["is_probability"] is False
        assert "infeasible by 2 days" in f["statement"]

    def test_no_deadline_means_no_verdict_invented(self, snapshot, state, clock):
        result = E.evaluate(snapshot.evolve(deadline_day=None), state, clock)
        assert result.feasibility.verdict == "no_deadline_set"
        assert result.feasibility.margin_days is None


class TestColdStart:
    """A brand-new project must be useful *and* honest (ARCHITECTURE D.1)."""

    def test_no_history_reaches_only_tier_zero(self, mfg_fixture):
        result = E.evaluate(mfg_fixture.snapshot, mfg_fixture.state, Clock(0.0))
        assert result.tier_reached == 0

    def test_no_history_still_schedules(self, mfg_fixture):
        result = E.evaluate(mfg_fixture.snapshot, mfg_fixture.state, Clock(0.0))
        assert result.projected_end == 31
        assert result.schedule["critical"]

    def test_no_history_still_reports_feasibility(self, mfg_fixture):
        result = E.evaluate(mfg_fixture.snapshot, mfg_fixture.state, Clock(0.0))
        assert result.feasibility.verdict == "infeasible"
        assert result.feasibility.margin_days == -5.0

    def test_no_history_declares_what_it_cannot_assess(self, mfg_fixture):
        result = E.evaluate(mfg_fixture.snapshot, mfg_fixture.state, Clock(0.0))
        tiers = {g["tier"] for g in result.unavailable_checks}
        assert tiers == {1, 2, 3}
        for gap in result.unavailable_checks:
            assert gap["checks"] and gap["requires"] and gap["why"]
            assert gap["unlocked_by"]

    def test_stateful_detectors_do_not_fire_without_statuses(self, mfg_fixture):
        """Running a Tier-1 detector against an empty state would report every
        first task as blocking its own successors: noise dressed as insight."""
        result = E.evaluate(mfg_fixture.snapshot, mfg_fixture.state, Clock(0.0))
        assert result.findings == []

    def test_a_project_with_history_declares_only_tier_three_missing(self, evaluation):
        tiers = {g["tier"] for g in evaluation.unavailable_checks}
        assert tiers == {3}
        assert evaluation.tier_reached == 2


class TestTransitiveRedundancy:
    """The basis of the transitive-reduction optimizer candidate."""

    def test_finds_the_planted_redundant_edge(self, mfg_fixture):
        from backend.app.core.engine.graph import (
            build_graph_from_snapshot,
            transitive_redundant_edges,
        )

        G = build_graph_from_snapshot(mfg_fixture.snapshot)
        # M04 -> M05 -> M06 already orders these, so M04 -> M06 is implied.
        assert ("M04", "M06") in transitive_redundant_edges(G)

    def test_finds_redundancy_in_the_event_fixture_too(self, graph):
        """T01 -> T04 and T01 -> T13 are both implied by T01 -> T02 -> T03 ->
        {T04, T13}, so removing either cannot move the finish date. Real
        redundancy in hand-authored data, which is exactly why the optimizer's
        first candidate is worth generating."""
        from backend.app.core.engine.graph import transitive_redundant_edges

        redundant = transitive_redundant_edges(graph)
        assert redundant == [("T01", "T04"), ("T01", "T13")]

    def test_removing_a_redundant_edge_does_not_move_the_finish(
        self, graph, observed_durations
    ):
        from backend.app.core.engine.cpm import schedule
        from backend.app.core.engine.graph import transitive_redundant_edges

        before = schedule(graph, observed_durations)["project_end"]
        stripped = graph.copy()
        for u, v in transitive_redundant_edges(graph):
            stripped.remove_edge(u, v)
        assert schedule(stripped, observed_durations)["project_end"] == before
