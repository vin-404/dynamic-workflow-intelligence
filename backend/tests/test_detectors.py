"""
Detector tests - precision, recall, and the cold-start contract.

`test_engine.py` holds the prototype regression assertions. This file tests
the Phase-2 additions on their own terms:

* precision and recall across **both** seed domains, against fully labelled
  fixtures
* each Tier-0 detector against a purpose-built workflow that should trigger
  it, and one that should not - a detector that fires on everything is not a
  detector
* the cold-start contract: a workflow with no history returns real Tier-0
  findings *and* an explicit statement of what it could not assess
"""
from __future__ import annotations

import pytest

from backend.app.core.engine import Tier, all_detectors, evaluate
from backend.app.core.engine.detectors import DetectorContext, unavailable_checks
from backend.app.core.engine.effort import planned_durations
from backend.app.core.engine.cpm import schedule
from backend.app.core.engine.graph import build_graph_from_snapshot
from backend.app.core.workflow import (
    AssignmentSpec,
    Clock,
    ConstraintKind,
    ConstraintSpec,
    DependencySpec,
    EngineConfig,
    ResourceSpec,
    TaskSpec,
    WorkflowSnapshot,
    WorkflowState,
)


def build(
    tasks,
    deps=(),
    resources=(),
    assignments=(),
    constraints=(),
    deadline=None,
):
    """A tiny workflow builder, so each detector test reads as one idea."""
    return WorkflowSnapshot.build(
        tasks=[
            TaskSpec(key=k, name=f"Task {k}", effort=float(e), divisible=d)
            for k, e, d in tasks
        ],
        dependencies=[
            DependencySpec(from_task=u, to_task=v, consumes=c) for u, v, c in deps
        ],
        resources=list(resources),
        assignments=list(assignments),
        constraints=list(constraints),
        deadline_day=deadline,
    )


def context(snapshot, state=None, today=0.0, config=None):
    cfg = config or EngineConfig()
    st = state or WorkflowState.empty(snapshot)
    G = build_graph_from_snapshot(snapshot)
    durations, _ = planned_durations(snapshot, cfg)
    return DetectorContext(
        graph=G,
        schedule=schedule(G, durations),
        snapshot=snapshot,
        state=st,
        clock=Clock(today),
        config=cfg,
    )


def run(name, snapshot, **kw):
    det = next(d for d in all_detectors() if d.name == name)
    return det(context(snapshot, **kw))


# ---------------------------------------------------------------------------
# Precision and recall across both seed domains
# ---------------------------------------------------------------------------


class TestPrecisionAndRecallBothDomains:
    """The brief asks for precision/recall against labelled fixtures in both
    seed domains. Both fixtures label every problem they contain, so a missed
    label means a detector regressed and an unexpected detection means one
    started firing spuriously."""

    @pytest.fixture(params=["event", "mfg"])
    def case(self, request, event_fixture, mfg_fixture):
        return {"event": event_fixture, "mfg": mfg_fixture}[request.param]

    def test_recall_is_100_percent(self, case):
        result = evaluate(case.snapshot, case.state, Clock(case.today_day))
        detected = {(f.kind, f.root_cause) for f in result.findings}
        missed = case.labelled_refs - detected
        assert not missed, f"{case.key} missed: {sorted(missed)}"

    def test_precision_is_100_percent(self, case):
        result = evaluate(case.snapshot, case.state, Clock(case.today_day))
        detected = {(f.kind, f.root_cause) for f in result.findings}
        unexpected = detected - case.labelled_refs
        assert not unexpected, f"{case.key} unexpected: {sorted(unexpected)}"

    def test_every_label_has_a_description(self, case):
        for label in case.labelled:
            assert label.description, f"{label.ref} is labelled without a reason"

    def test_planted_faults_are_found_where_they_exist(self, case):
        """The event fixture plants three faults deliberately; the cold-start
        fixture plants none, because it has no history for a fault to sit in.
        Both are asserted, so neither can drift unnoticed."""
        result = evaluate(case.snapshot, case.state, Clock(case.today_day))
        detected = {(f.kind, f.root_cause) for f in result.findings}
        expected = {"campus-symposium": 3, "battery-pilot-line": 0}[case.key]
        assert len(case.planted) == expected
        for fault in case.planted:
            assert fault.ref in detected, f"missed planted fault {fault.ref}"

    def test_findings_are_identical_shape_across_domains(
        self, event_fixture, mfg_fixture
    ):
        a = evaluate(
            event_fixture.snapshot, event_fixture.state,
            Clock(event_fixture.today_day),
        )
        b = evaluate(
            mfg_fixture.snapshot, mfg_fixture.state, Clock(mfg_fixture.today_day)
        )
        keys_a = {frozenset(f.to_dict()) for f in a.findings}
        keys_b = {frozenset(f.to_dict()) for f in b.findings}
        assert keys_a == keys_b


# ---------------------------------------------------------------------------
# Each Tier-0 detector, on a workflow built to trigger it and one built not to
# ---------------------------------------------------------------------------


class TestDependencyCycle:
    def test_fires_on_a_cycle_and_reports_it(self):
        snap = build(
            [("A", 2, True), ("B", 2, True), ("C", 2, True)],
            [("A", "B", True), ("B", "C", True), ("C", "A", True)],
        )
        result = evaluate(snap)
        assert result.schedulable is False
        assert result.cycles
        finding = result.findings[0]
        assert finding.kind == "dependency_cycle"
        assert set(finding.evidence["cycle"]) == {"A", "B", "C"}
        assert "->" in finding.evidence["chain"]

    def test_an_unschedulable_workflow_does_not_raise(self):
        """A bad graph must not take the page down."""
        snap = build(
            [("A", 1, True), ("B", 1, True)],
            [("A", "B", True), ("B", "A", True)],
        )
        result = evaluate(snap)
        assert result.feasibility.verdict == "unschedulable"
        assert result.schedule["critical"] == []

    def test_silent_on_a_dag(self):
        snap = build([("A", 1, True), ("B", 1, True)], [("A", "B", True)])
        assert run("dependency_cycle", snap) == []


class TestDeadlineInfeasible:
    def test_fires_when_the_plan_overruns(self):
        snap = build(
            [("A", 5, True), ("B", 5, True)], [("A", "B", True)], deadline=7.0
        )
        found = run("deadline_infeasible", snap)
        assert len(found) == 1
        assert found[0].evidence["overshoot_days"] == 3.0
        assert found[0].impact.magnitude == 3.0

    def test_silent_when_the_plan_fits(self):
        snap = build(
            [("A", 5, True), ("B", 5, True)], [("A", "B", True)], deadline=12.0
        )
        assert run("deadline_infeasible", snap) == []

    def test_silent_when_no_deadline_is_set(self):
        snap = build([("A", 5, True)])
        assert run("deadline_infeasible", snap) == []

    def test_never_states_a_probability(self):
        snap = build([("A", 9, True)], deadline=3.0)
        found = run("deadline_infeasible", snap)
        blob = (found[0].explanation + found[0].suggested_action).lower()
        for banned in ("probability", "% chance", "likelihood", "confidence"):
            assert banned not in blob


class TestSinglePointOfFailure:
    def test_fires_on_high_fan_out(self):
        snap = build(
            [("A", 2, True)] + [(f"B{i}", 1, True) for i in range(4)],
            [("A", f"B{i}", True) for i in range(4)],
        )
        found = run("single_point_of_failure", snap)
        assert [f.root_cause for f in found] == ["A"]
        assert found[0].evidence["fan_out"] == 4

    def test_silent_below_the_threshold(self):
        snap = build(
            [("A", 2, True), ("B", 1, True), ("C", 1, True)],
            [("A", "B", True), ("A", "C", True)],
        )
        assert run("single_point_of_failure", snap) == []

    def test_the_threshold_is_configurable_and_echoed(self):
        snap = build(
            [("A", 2, True), ("B", 1, True), ("C", 1, True)],
            [("A", "B", True), ("A", "C", True)],
        )
        found = run(
            "single_point_of_failure", snap, config=EngineConfig(fan_out_threshold=2)
        )
        assert len(found) == 1
        assert found[0].evidence["threshold"] == 2


class TestSerialChainNoParallelism:
    def test_fires_on_a_long_single_file_run(self):
        snap = build(
            [(k, 2, True) for k in "ABCDE"],
            [("A", "B", True), ("B", "C", True), ("C", "D", True),
             ("D", "E", True)],
        )
        found = run("serial_chain_no_parallelism", snap)
        assert len(found) == 1
        assert found[0].evidence["chain"] == ["A", "B", "C", "D", "E"]
        assert found[0].evidence["chain_duration_days"] == 10.0
        assert found[0].evidence["share_of_project"] == 1.0

    def test_silent_when_work_runs_in_parallel(self):
        snap = build(
            [(k, 2, True) for k in "ABCDE"],
            [("A", "B", True), ("A", "C", True), ("A", "D", True),
             ("B", "E", True)],
        )
        assert run("serial_chain_no_parallelism", snap) == []

    def test_silent_on_a_short_chain(self):
        snap = build(
            [(k, 2, True) for k in "ABC"],
            [("A", "B", True), ("B", "C", True)],
        )
        assert run("serial_chain_no_parallelism", snap) == []


class TestZeroSlackChain:
    def test_fires_when_most_of_the_workflow_is_critical(self):
        snap = build(
            [(k, 2, True) for k in "ABCD"],
            [("A", "B", True), ("B", "C", True), ("C", "D", True)],
        )
        found = run("zero_slack_chain", snap)
        assert len(found) == 1
        assert found[0].evidence["share_of_tasks"] == 1.0
        assert found[0].severity == "high"

    def test_silent_when_there_is_plenty_of_slack(self):
        """Three of five tasks have nine days of slack each, so the workflow
        can absorb a delay and this is not a finding."""
        snap = build(
            [("A", 10, True), ("B", 1, True), ("C", 1, True), ("D", 1, True),
             ("E", 1, True)],
            [("A", "E", True), ("B", "E", True), ("C", "E", True),
             ("D", "E", True)],
        )
        found = run("zero_slack_chain", snap)
        assert found == [], (
            "2 of 5 critical is unremarkable; only a plan with almost no "
            "slack anywhere should be reported"
        )

    def test_the_threshold_is_configurable_and_echoed(self):
        snap = build(
            [("A", 10, True), ("B", 1, True), ("C", 1, True), ("D", 1, True),
             ("E", 1, True)],
            [("A", "E", True), ("B", "E", True), ("C", "E", True),
             ("D", "E", True)],
        )
        found = run(
            "zero_slack_chain", snap,
            config=EngineConfig(critical_share_threshold=0.3),
        )
        assert len(found) == 1
        assert found[0].evidence["threshold"] == 0.3


class TestResourceOverallocated:
    def _snap(self, capacity=1):
        return build(
            [("A", 3, True), ("B", 3, True)],
            resources=[
                ResourceSpec(key="r", name="Rig", kind="equipment",
                             capacity=capacity)
            ],
            assignments=[
                AssignmentSpec(task_key="A", resource_key="r"),
                AssignmentSpec(task_key="B", resource_key="r"),
            ],
        )

    def test_fires_when_the_plan_needs_a_resource_twice_at_once(self):
        found = run("resource_overallocated", self._snap(capacity=1))
        assert len(found) == 1
        assert found[0].root_cause == "r"
        assert found[0].evidence["peak_concurrent_tasks"] == 2
        assert found[0].evidence["capacity"] == 1

    def test_silent_when_capacity_covers_the_peak(self):
        assert run("resource_overallocated", self._snap(capacity=2)) == []

    def test_silent_when_the_tasks_do_not_overlap(self):
        snap = build(
            [("A", 3, True), ("B", 3, True)],
            [("A", "B", True)],
            resources=[ResourceSpec(key="r", name="Rig", capacity=1)],
            assignments=[
                AssignmentSpec(task_key="A", resource_key="r"),
                AssignmentSpec(task_key="B", resource_key="r"),
            ],
        )
        assert run("resource_overallocated", snap) == []

    def test_it_admits_the_schedule_is_resource_blind(self):
        """ARCHITECTURE H risk #2: claiming an optimal resource-constrained
        schedule would be false, so the finding says what it is instead."""
        found = run("resource_overallocated", self._snap())
        note = found[0].evidence["note"].lower()
        assert "resource-blind" in note
        assert "do not claim an optimal" in note


class TestUnassignedCriticalTask:
    def test_fires_on_unowned_critical_work(self):
        snap = build([("A", 3, True), ("B", 2, True)], [("A", "B", True)])
        found = run("unassigned_critical_task", snap)
        assert {f.root_cause for f in found} == {"A", "B"}

    def test_silent_when_everything_critical_is_assigned(self):
        snap = build(
            [("A", 3, True), ("B", 2, True)],
            [("A", "B", True)],
            resources=[ResourceSpec(key="p", name="Pat")],
            assignments=[
                AssignmentSpec(task_key="A", resource_key="p"),
                AssignmentSpec(task_key="B", resource_key="p"),
            ],
        )
        assert run("unassigned_critical_task", snap) == []


class TestRedundantDependency:
    def test_fires_on_an_implied_edge_and_names_the_implying_path(self):
        snap = build(
            [(k, 1, True) for k in "ABC"],
            [("A", "B", True), ("B", "C", True), ("A", "C", True)],
        )
        found = run("redundant_dependency", snap)
        assert len(found) == 1
        assert found[0].evidence["edge"] == ["A", "C"]
        assert found[0].evidence["implied_by_path"] == ["A", "B", "C"]

    def test_reports_zero_days_rather_than_inflating_it(self):
        snap = build(
            [(k, 1, True) for k in "ABC"],
            [("A", "B", True), ("B", "C", True), ("A", "C", True)],
        )
        found = run("redundant_dependency", snap)
        assert found[0].impact.magnitude == 0.0
        assert found[0].impact_score == 0.0
        assert found[0].severity == "low"
        assert "costs clarity" in found[0].explanation

    def test_a_protected_edge_is_reported_but_not_recommended_for_removal(self):
        snap = build(
            [(k, 1, True) for k in "ABC"],
            [("A", "B", True), ("B", "C", True), ("A", "C", True)],
            constraints=[
                ConstraintSpec(
                    kind=ConstraintKind.IMMUTABLE_DEPENDENCY,
                    target="A->C",
                    reason="Compliance requires the direct link on record.",
                )
            ],
        )
        found = run("redundant_dependency", snap)
        assert found[0].evidence["constraint_protected"] is True
        assert "leave it in place" in found[0].suggested_action

    def test_silent_on_a_minimal_graph(self):
        snap = build(
            [(k, 1, True) for k in "ABC"],
            [("A", "B", True), ("B", "C", True)],
        )
        assert run("redundant_dependency", snap) == []


class TestIsolatedTask:
    def test_fires_on_a_floating_task(self):
        snap = build(
            [(k, 1, True) for k in "ABCD"],
            [("A", "B", True), ("B", "C", True)],
        )
        found = run("isolated_task", snap)
        assert [f.root_cause for f in found] == ["D"]

    def test_silent_when_the_whole_workflow_is_unconnected(self):
        """Three loose tasks are a plan someone has not finished drawing, not
        three separate faults. With no edges at all there is nothing to be
        isolated *from*."""
        snap = build([(k, 1, True) for k in "ABC"])
        assert run("isolated_task", snap) == []


# ---------------------------------------------------------------------------
# The cold-start contract
# ---------------------------------------------------------------------------


class TestColdStartContract:
    def test_a_fresh_workflow_gets_tier_zero_findings(self, mfg_fixture):
        result = evaluate(mfg_fixture.snapshot, mfg_fixture.state, Clock(0.0))
        assert result.tier_reached == 0
        assert result.findings, "cold start must not return an empty analysis"
        assert all(f.tier == Tier.STRUCTURAL for f in result.findings)

    def test_it_declares_every_check_it_could_not_run(self, mfg_fixture):
        result = evaluate(mfg_fixture.snapshot, mfg_fixture.state, Clock(0.0))
        listed = {
            check.split(":")[0]
            for gap in result.unavailable_checks
            for check in gap["checks"]
        }
        stateful_and_above = {
            d.name for d in all_detectors() if d.tier > Tier.STRUCTURAL
        }
        assert stateful_and_above <= listed

    def test_each_gap_says_what_it_needs_and_what_unlocks_it(self, mfg_fixture):
        result = evaluate(mfg_fixture.snapshot, mfg_fixture.state, Clock(0.0))
        for gap in result.unavailable_checks:
            assert gap["checks"]
            assert gap["requires"]
            assert gap["why"]
            assert gap["unlocked_by"]

    def test_checks_run_distinguishes_clean_from_unchecked(self, mfg_fixture):
        """"We looked and it is fine" and "we never looked" are different
        claims, and the payload keeps them apart."""
        result = evaluate(mfg_fixture.snapshot, mfg_fixture.state, Clock(0.0))
        structural = {d.name for d in all_detectors() if d.tier == Tier.STRUCTURAL}
        assert set(result.checks_run) == structural
        assert "stalled_in_review" not in result.checks_run

    def test_tier_three_is_never_reached_and_says_so(self, event_fixture):
        """Cross-project calibration is not implemented, so it must always
        appear as unavailable rather than silently pass."""
        result = evaluate(
            event_fixture.snapshot, event_fixture.state,
            Clock(event_fixture.today_day),
        )
        assert result.tier_reached == 2
        tiers = {gap["tier"] for gap in result.unavailable_checks}
        assert tiers == {3}

    def test_an_empty_workflow_analyzes_cleanly(self):
        snap = WorkflowSnapshot.build(tasks=())
        result = evaluate(snap)
        assert result.findings == []
        assert result.projected_end == 0
        assert result.unavailable_checks

    def test_unavailable_checks_shrink_as_evidence_arrives(self):
        counts = [
            sum(len(g["checks"]) for g in unavailable_checks(tier))
            for tier in (Tier.STRUCTURAL, Tier.STATEFUL, Tier.HISTORICAL)
        ]
        assert counts[0] > counts[1] > counts[2]
        assert counts[2] > 0, "tier 3 is never reached, so something remains"


class TestCriticalPathSingleOwner:
    """The gap the demo walk found: a strictly sequential chain owned by one
    person never exceeds anyone's capacity, so `resource_overallocated` stays
    quiet and the plan looks fine. It is not fine.
    """

    def chain(self, owners, resources=None):
        """A straight chain of tasks, `owners[i]` assigned to task i."""
        keys = [f"C{i:02d}" for i in range(len(owners))]
        every = sorted({o for owner in owners for o in owner})
        return build(
            tasks=[(k, 3, True) for k in keys],
            deps=[(a, b, True) for a, b in zip(keys, keys[1:])],
            resources=resources or [
                ResourceSpec(key=r, name=r.title(), kind="person", capacity=1)
                for r in every
            ],
            assignments=[
                AssignmentSpec(task_key=key, resource_key=owner)
                for key, owner_list in zip(keys, owners)
                for owner in owner_list
            ],
        )

    def findings(self, snapshot):
        result = evaluate(snapshot, WorkflowState.empty(snapshot), Clock(0.0))
        return [f for f in result.findings if f.kind == "critical_path_single_owner"]

    def test_one_person_owning_the_whole_critical_path_is_a_finding(self):
        found = self.findings(self.chain([["ana"], ["ana"], ["ana"], ["ana"]]))
        assert len(found) == 1
        assert found[0].evidence["resource_key"] == "ana"
        assert found[0].evidence["critical_task_count"] == 4
        assert found[0].severity == "high"

    def test_capacity_is_never_exceeded_so_overallocation_stays_quiet(self):
        """Which is exactly why this detector has to exist separately."""
        snapshot = self.chain([["ana"], ["ana"], ["ana"], ["ana"]])
        result = evaluate(snapshot, WorkflowState.empty(snapshot), Clock(0.0))
        assert not [f for f in result.findings if f.kind == "resource_overallocated"]

    def test_a_second_owner_anywhere_on_the_path_clears_it(self):
        assert self.findings(self.chain([["ana"], ["ana"], ["bo"], ["ana"]])) == []

    def test_a_shared_second_assignee_clears_it(self):
        """Two people on every task is redundancy, which is the point."""
        pairs = [["ana", "bo"]] * 4
        assert self.findings(self.chain(pairs)) == []

    def test_an_unassigned_task_defers_to_the_detector_that_owns_that(self):
        snapshot = self.chain([["ana"], ["ana"], [], ["ana"]])
        assert self.findings(snapshot) == []
        result = evaluate(snapshot, WorkflowState.empty(snapshot), Clock(0.0))
        assert [f for f in result.findings if f.kind == "unassigned_critical_task"]

    def test_a_team_of_several_people_is_not_a_single_point_of_failure(self):
        """A team can absorb one absence; a person cannot. The roll-up
        hierarchy is what tells them apart."""
        snapshot = self.chain(
            [["crew"], ["crew"], ["crew"], ["crew"]],
            resources=[
                ResourceSpec(key="crew", name="Crew", kind="team", capacity=2),
                ResourceSpec(
                    key="ana", name="Ana", kind="person", capacity=1,
                    parent_key="crew",
                ),
                ResourceSpec(
                    key="bo", name="Bo", kind="person", capacity=1,
                    parent_key="crew",
                ),
            ],
        )
        assert self.findings(snapshot) == []

    def test_two_tasks_are_not_enough_to_call_it(self):
        assert self.findings(self.chain([["ana"], ["ana"]])) == []

    def test_it_needs_no_history_at_all(self):
        snapshot = self.chain([["ana"], ["ana"], ["ana"]])
        result = evaluate(snapshot, WorkflowState.empty(snapshot), Clock(0.0))
        assert result.tier_reached == 0
        assert "critical_path_single_owner" in result.checks_run

    def test_the_explanation_names_the_person_and_the_cost(self):
        finding = self.findings(self.chain([["ana"]] * 4))[0]
        assert "Ana" in finding.explanation
        assert "12 days" in finding.explanation
        assert "Ana" in finding.suggested_action

    def test_the_seeded_event_workflow_does_not_trip_it(self, event_fixture):
        """A real workflow with a mixed critical path must stay quiet, or the
        detector is just noise."""
        result = evaluate(
            event_fixture.snapshot, event_fixture.state,
            Clock(event_fixture.today_day),
        )
        assert not [
            f for f in result.findings if f.kind == "critical_path_single_owner"
        ]
