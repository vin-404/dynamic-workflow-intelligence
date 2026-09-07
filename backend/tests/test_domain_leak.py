"""
The domain leak test.

ARCHITECTURE A.3: domain must be context for the LLM and defaults for the
user, never an input to the engine. Two projects with identical structure and
different domains must produce **byte-identical** evaluation output. This
fails the moment someone writes `if domain == "software"` anywhere below the
service layer, which is why it is a test rather than a hope.

`test_core_purity.test_core_input_types_have_no_domain_field` is the
structural half: no domain field exists to branch on. This file is the
behavioural half: even the *words* in the workflow cannot change the numbers.
"""
from __future__ import annotations

import json

import pytest

from backend.app.core.engine import evaluate
from backend.app.core.workflow import (
    AssignmentSpec,
    Clock,
    ConstraintKind,
    ConstraintSpec,
    DependencySpec,
    DepType,
    ResourceSpec,
    TaskSpec,
    WorkflowSnapshot,
    WorkflowState,
)

# ---------------------------------------------------------------------------
# The same workflow, twice, wearing different clothes.
# ---------------------------------------------------------------------------

#: Structure shared by both: five tasks, a diamond plus a tail, one team of
#: two with capacity 1, one non-divisible task, one deadline.
_STRUCTURE = [
    # (task index, effort, divisible)
    (1, 3.0, True),
    (2, 2.0, True),
    (3, 4.0, True),
    (4, 2.0, False),
    (5, 1.0, True),
]
_EDGES = [(1, 2, True), (1, 3, False), (2, 4, True), (3, 4, True), (4, 5, True)]

_SOFTWARE_NAMES = {
    1: "Write API spec",
    2: "Implement endpoint",
    3: "Build client SDK",
    4: "Security review",
    5: "Ship release",
}
_KITCHEN_NAMES = {
    1: "Write the menu",
    2: "Prep the sauce",
    3: "Bake the bread",
    4: "Head chef tasting",
    5: "Service",
}


def _build(names: dict[int, str], team_name: str, person_names: list[str]):
    tasks = tuple(
        TaskSpec(key=f"K{i:02d}", name=names[i], effort=effort, divisible=divisible)
        for i, effort, divisible in _STRUCTURE
    )
    deps = tuple(
        DependencySpec(
            from_task=f"K{u:02d}",
            to_task=f"K{v:02d}",
            dep_type=DepType.FS,
            consumes=consumes,
        )
        for u, v, consumes in _EDGES
    )
    resources = (
        ResourceSpec(key="team", name=team_name, kind="team", capacity=1),
    ) + tuple(
        ResourceSpec(
            key=f"p{i}", name=name, kind="person", capacity=1, parent_key="team"
        )
        for i, name in enumerate(person_names, start=1)
    )
    assignments = tuple(
        AssignmentSpec(
            task_key=f"K{i:02d}",
            resource_key=f"p{1 + (idx % len(person_names))}",
        )
        for idx, (i, _, _) in enumerate(_STRUCTURE)
    )
    constraints = (
        ConstraintSpec(
            kind=ConstraintKind.NON_DIVISIBLE_TASK,
            target="K04",
            reason="One reviewer, one signature.",
        ),
    )
    return WorkflowSnapshot.build(
        tasks=tasks,
        dependencies=deps,
        resources=resources,
        assignments=assignments,
        constraints=constraints,
        deadline_day=9.0,
    )


@pytest.fixture
def software():
    return _build(_SOFTWARE_NAMES, "Platform Team", ["Dev A", "Dev B"])


@pytest.fixture
def kitchen():
    return _build(_KITCHEN_NAMES, "Kitchen Brigade", ["Cook A", "Cook B"])


def _numeric_projection(result) -> dict:
    """Everything the engine computed, with the human-readable strings that
    legitimately echo the input's own words stripped out.

    Names, resource labels and suggested actions quote the user's data by
    design - a finding that said "unblock the task" instead of "unblock
    Security review" would be useless. What must not differ is any number,
    any structural conclusion, or any verdict.
    """
    payload = result.as_dict()
    payload.pop("input_hash", None)  # hashes the names, so it differs by design
    for finding in payload["findings"]:
        finding.pop("suggested_action", None)
        finding["evidence"].pop("resource_name", None)
        finding["evidence"].pop("assigned_to", None)
    payload["feasibility"].pop("statement", None)
    return payload


class TestDomainLeak:
    def test_identical_structure_evaluates_identically_at_cold_start(
        self, software, kitchen
    ):
        a = evaluate(software, WorkflowState.empty(software), Clock(0.0))
        b = evaluate(kitchen, WorkflowState.empty(kitchen), Clock(0.0))
        assert _numeric_projection(a) == _numeric_projection(b)

    def test_identical_structure_evaluates_identically_with_state(
        self, software, kitchen
    ):
        from backend.app.core.workflow import EventRecord, TaskStatus

        def stateful(snapshot):
            return WorkflowState(
                statuses={
                    "K01": TaskStatus.DONE,
                    "K02": TaskStatus.IN_REVIEW,
                    "K03": TaskStatus.NOT_STARTED,
                    "K04": TaskStatus.NOT_STARTED,
                    "K05": TaskStatus.NOT_STARTED,
                },
                events=(
                    EventRecord(0.0, "K01", "someone", TaskStatus.NOT_STARTED,
                                TaskStatus.IN_PROGRESS),
                    EventRecord(3.0, "K01", "someone", TaskStatus.IN_PROGRESS,
                                TaskStatus.DONE),
                    EventRecord(3.0, "K02", "someone", TaskStatus.NOT_STARTED,
                                TaskStatus.IN_REVIEW),
                ),
            )

        a = evaluate(software, stateful(software), Clock(12.0))
        b = evaluate(kitchen, stateful(kitchen), Clock(12.0))
        proj_a, proj_b = _numeric_projection(a), _numeric_projection(b)
        assert proj_a == proj_b
        # And the comparison is not vacuous: there is something to compare.
        assert proj_a["findings"], "the fixtures produced no findings to compare"

    def test_the_projections_are_byte_identical_as_json(self, software, kitchen):
        a = evaluate(software, WorkflowState.empty(software), Clock(0.0))
        b = evaluate(kitchen, WorkflowState.empty(kitchen), Clock(0.0))
        dump_a = json.dumps(_numeric_projection(a), sort_keys=True)
        dump_b = json.dumps(_numeric_projection(b), sort_keys=True)
        assert dump_a == dump_b

    def test_task_names_do_not_change_the_schedule(self, software, kitchen):
        a = evaluate(software, WorkflowState.empty(software), Clock(0.0))
        b = evaluate(kitchen, WorkflowState.empty(kitchen), Clock(0.0))
        assert a.projected_end == b.projected_end
        assert a.schedule["critical"] == b.schedule["critical"]
        assert a.schedule["slack"] == b.schedule["slack"]

    def test_findings_quote_the_users_words_but_not_the_engines(
        self, software, kitchen
    ):
        """The one thing that legitimately differs is the prose, because it
        quotes the workflow's own names. Assert that difference exists, so
        this file cannot pass by the engine having gone silent."""
        from backend.app.core.workflow import EventRecord, TaskStatus

        def stateful():
            return WorkflowState(
                statuses={
                    "K01": TaskStatus.DONE,
                    "K02": TaskStatus.IN_REVIEW,
                    "K03": TaskStatus.NOT_STARTED,
                    "K04": TaskStatus.NOT_STARTED,
                    "K05": TaskStatus.NOT_STARTED,
                },
                events=(
                    EventRecord(3.0, "K02", "someone", TaskStatus.NOT_STARTED,
                                TaskStatus.IN_REVIEW),
                ),
            )

        a = evaluate(software, stateful(), Clock(12.0))
        b = evaluate(kitchen, stateful(), Clock(12.0))
        actions_a = [f.suggested_action for f in a.findings]
        actions_b = [f.suggested_action for f in b.findings]
        assert actions_a and actions_b
        assert actions_a != actions_b
        assert any("Platform Team" in s or "Dev" in s for s in actions_a)
        assert any("Kitchen Brigade" in s or "Cook" in s for s in actions_b)


class TestSeededDomainsShareOneCodePath:
    """The two seed fixtures are structurally different projects in different
    domains. Neither gets a special case anywhere."""

    def test_both_seed_domains_produce_the_same_result_shape(
        self, event_fixture, mfg_fixture
    ):
        a = evaluate(
            event_fixture.snapshot, event_fixture.state, Clock(event_fixture.today_day)
        ).as_dict()
        b = evaluate(
            mfg_fixture.snapshot, mfg_fixture.state, Clock(mfg_fixture.today_day)
        ).as_dict()
        assert set(a) == set(b)
        assert set(a["schedule"]) == set(b["schedule"])
        assert set(a["feasibility"]) == set(b["feasibility"])

    def test_neither_domain_appears_in_engine_output(
        self, event_fixture, mfg_fixture
    ):
        """No domain key, name or vocabulary hint may appear in an evaluation
        payload - not even incidentally."""
        for fx in (event_fixture, mfg_fixture):
            payload = json.dumps(
                evaluate(fx.snapshot, fx.state, Clock(fx.today_day)).as_dict()
            )
            assert fx.domain.key not in payload
            assert fx.domain.name not in payload
            for hint in fx.domain.vocabulary_hints:
                assert f'"{hint}"' not in payload
