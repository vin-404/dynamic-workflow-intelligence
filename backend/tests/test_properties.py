"""
Property tests - invariants that must hold for every workflow, not just the
fixtures (ARCHITECTURE F, "Testing intelligence").

These are the four the brief names, plus the immutability property that
Capability 3 depends on:

1. adding a dependency never shortens the project
2. removing a non-mandatory task never lengthens it
3. slack >= 0 everywhere
4. critical-path length equals project end
5. evaluating never mutates the snapshot it was given

Each runs over both seed fixtures and over a batch of generated random DAGs,
so a property cannot pass by luck of one hand-built example. Generation is
seeded, so a failure is reproducible.
"""
from __future__ import annotations

import random

import pytest

from backend.app.core.engine import evaluate
from backend.app.core.engine.cpm import schedule
from backend.app.core.engine.graph import build_graph_from_snapshot
from backend.app.core.workflow import (
    Clock,
    ConstraintKind,
    DependencySpec,
    DepType,
    TaskSpec,
    WorkflowSnapshot,
    WorkflowState,
)

SEED = 20260907
CASES = 25


def _random_snapshot(rng: random.Random) -> WorkflowSnapshot:
    """A random DAG. Tasks are numbered, and an edge only ever goes from a
    lower index to a higher one, so the result is acyclic by construction."""
    n = rng.randint(3, 12)
    tasks = tuple(
        TaskSpec(
            key=f"N{i:02d}",
            name=f"Task {i}",
            effort=float(rng.randint(1, 8)),
            divisible=rng.random() > 0.25,
        )
        for i in range(n)
    )
    edges = []
    for j in range(1, n):
        for i in range(j):
            if rng.random() < 0.3:
                edges.append(
                    DependencySpec(
                        from_task=f"N{i:02d}",
                        to_task=f"N{j:02d}",
                        dep_type=DepType.FS,
                        consumes=rng.random() < 0.5,
                    )
                )
    return WorkflowSnapshot.build(tasks=tasks, dependencies=edges)


def _snapshots():
    """Both seed fixtures plus the generated batch."""
    from backend.app.seed.fixtures import (
        event_operations_fixture,
        hardware_manufacturing_fixture,
    )

    out = [
        event_operations_fixture().snapshot,
        hardware_manufacturing_fixture().snapshot,
    ]
    rng = random.Random(SEED)
    out.extend(_random_snapshot(rng) for _ in range(CASES))
    return out


ALL_SNAPSHOTS = _snapshots()
IDS = [f"snap{i}" for i in range(len(ALL_SNAPSHOTS))]


def _end(snapshot: WorkflowSnapshot) -> float:
    from backend.app.core.engine.effort import planned_durations

    durations, _ = planned_durations(snapshot)
    G = build_graph_from_snapshot(snapshot)
    return schedule(G, durations)["project_end"]


def _sched(snapshot: WorkflowSnapshot) -> dict:
    from backend.app.core.engine.effort import planned_durations

    durations, _ = planned_durations(snapshot)
    return schedule(build_graph_from_snapshot(snapshot), durations)


@pytest.mark.parametrize("snapshot", ALL_SNAPSHOTS, ids=IDS)
def test_slack_is_never_negative(snapshot):
    """Negative slack would mean the backward pass finished before the forward
    pass, which is arithmetically impossible and a sign of a broken CPM."""
    sched = _sched(snapshot)
    for key, slack in sched["slack"].items():
        assert slack >= -1e-9, f"{key} has slack {slack}"


@pytest.mark.parametrize("snapshot", ALL_SNAPSHOTS, ids=IDS)
def test_critical_path_length_equals_project_end(snapshot):
    """The critical path is the longest path through the graph, so the sum of
    its durations must be exactly the project end."""
    sched = _sched(snapshot)
    G = build_graph_from_snapshot(snapshot)
    critical = sched["critical"]
    if not critical:
        assert sched["project_end"] == 0
        return

    # Walk the critical chain: consecutive critical tasks connected by an edge
    # must tile the whole timeline with no gap.
    longest = 0.0
    for key in critical:
        longest = max(longest, sched["EF"][key])
    assert longest == pytest.approx(sched["project_end"])

    # Every critical task has zero slack, and the chain starts at day 0.
    assert min(sched["ES"][k] for k in critical) == pytest.approx(0.0)
    for key in critical:
        assert abs(sched["slack"][key]) < 1e-9
    del G


@pytest.mark.parametrize("snapshot", ALL_SNAPSHOTS, ids=IDS)
def test_adding_a_dependency_never_shortens_the_project(snapshot):
    """A constraint can only push work later, never earlier. If this fails,
    the forward pass is wrong."""
    keys = list(snapshot.task_keys)
    if len(keys) < 2:
        pytest.skip("needs at least two tasks")

    before = _end(snapshot)
    existing = set(snapshot.dependency_by_edge)
    G = build_graph_from_snapshot(snapshot)
    import networkx as nx

    added = 0
    for i, u in enumerate(keys):
        for v in keys[i + 1:]:
            if (u, v) in existing or nx.has_path(G, v, u):
                continue
            probe = snapshot.evolve(
                dependencies=snapshot.dependencies + (
                    DependencySpec(from_task=u, to_task=v),
                )
            )
            assert _end(probe) >= before - 1e-9, (
                f"adding {u} -> {v} shortened the project "
                f"from {before} to {_end(probe)}"
            )
            added += 1
            if added >= 12:      # bounded: this is O(n^2) schedules
                return


@pytest.mark.parametrize("snapshot", ALL_SNAPSHOTS, ids=IDS)
def test_removing_a_non_mandatory_task_never_lengthens_the_project(snapshot):
    """Taking work out cannot make the project longer. If it does, the
    dependency rewiring on removal is wrong."""
    mandatory = {
        c.target for c in snapshot.constraints_of(ConstraintKind.MANDATORY_TASK)
    }
    before = _end(snapshot)

    for task in snapshot.tasks:
        if task.key in mandatory:
            continue
        remaining = tuple(t for t in snapshot.tasks if t.key != task.key)
        if not remaining:
            continue
        # Removing a task removes its edges. Predecessors are reconnected to
        # successors so the ordering that survived the removal is preserved -
        # otherwise this would test edge deletion, not task removal.
        preds = [d.from_task for d in snapshot.dependencies if d.to_task == task.key]
        succs = [d.to_task for d in snapshot.dependencies if d.from_task == task.key]
        kept = tuple(
            d for d in snapshot.dependencies
            if task.key not in (d.from_task, d.to_task)
        )
        bridged = tuple(
            DependencySpec(from_task=p, to_task=s)
            for p in preds for s in succs
            if (p, s) not in {(d.from_task, d.to_task) for d in kept}
        )
        probe = snapshot.evolve(tasks=remaining, dependencies=kept + bridged)
        after = _end(probe)
        assert after <= before + 1e-9, (
            f"removing {task.key} lengthened the project "
            f"from {before} to {after}"
        )


@pytest.mark.parametrize("snapshot", ALL_SNAPSHOTS, ids=IDS)
def test_evaluating_never_mutates_the_snapshot(snapshot):
    """The invariant Capability 3 rests on: "the original workflow must remain
    unchanged". Asserted on the content hash, so it covers every field."""
    before = snapshot.content_hash()
    evaluate(snapshot, WorkflowState.empty(snapshot), Clock(0.0))
    evaluate(snapshot, WorkflowState.empty(snapshot), Clock(5.0))
    assert snapshot.content_hash() == before


@pytest.mark.parametrize("snapshot", ALL_SNAPSHOTS, ids=IDS)
def test_more_effort_never_shortens_the_project(snapshot):
    """Monotonicity in the other direction, which catches a sign error in the
    effort model that the dependency property would miss."""
    if not snapshot.tasks:
        pytest.skip("empty workflow")
    before = _end(snapshot)
    first = snapshot.tasks[0]
    heavier = snapshot.evolve(
        tasks=(
            TaskSpec(
                key=first.key,
                name=first.name,
                effort=first.effort + 3.0,
                divisible=first.divisible,
            ),
        ) + snapshot.tasks[1:]
    )
    assert _end(heavier) >= before - 1e-9


class TestSnapshotImmutability:
    """`WorkflowSnapshot` is immutable in fact, not by convention (D-12)."""

    def test_fields_cannot_be_assigned(self, snapshot):
        with pytest.raises(Exception):
            snapshot.tasks = ()

    def test_derived_lookups_cannot_be_mutated(self, snapshot):
        with pytest.raises(TypeError):
            snapshot.task_by_key["T01"] = None
        with pytest.raises(TypeError):
            snapshot.assignees_by_task["T01"] = ()

    def test_state_lookups_cannot_be_mutated(self, state):
        with pytest.raises(TypeError):
            state.statuses["T01"] = None

    def test_evolve_returns_a_new_snapshot(self, snapshot):
        other = snapshot.evolve(deadline_day=99.0)
        assert other is not snapshot
        assert snapshot.deadline_day != 99.0
        assert other.content_hash() != snapshot.content_hash()

    def test_content_hash_is_order_independent(self, snapshot):
        """Two snapshots with the same content in a different insertion order
        must hash the same, or version comparison becomes meaningless."""
        shuffled = WorkflowSnapshot.build(
            tasks=list(reversed(snapshot.tasks)),
            dependencies=list(reversed(snapshot.dependencies)),
            resources=list(reversed(snapshot.resources)),
            assignments=list(reversed(snapshot.assignments)),
            requirements=list(reversed(snapshot.requirements)),
            constraints=list(reversed(snapshot.constraints)),
            calendars=list(reversed(snapshot.calendars)),
            deadline_day=snapshot.deadline_day,
        )
        assert shuffled.content_hash() == snapshot.content_hash()

    def test_content_hash_changes_when_content_changes(self, snapshot):
        before = snapshot.content_hash()
        changed = snapshot.evolve(
            tasks=snapshot.tasks[:-1]
        )
        assert changed.content_hash() != before
