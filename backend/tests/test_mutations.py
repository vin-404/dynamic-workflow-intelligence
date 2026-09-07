"""
Mutation algebra tests.

The brief's list: every mutation type round-trips and validates; invalid
mutations are rejected with reasons; base immutability holds; non-divisible
tasks cannot be split; apply creates a new version leaving the parent intact.

The last one lives in `test_simulation.py` with the rest of the DB-level
apply behaviour. Everything here is pure - no database, no API.
"""
from __future__ import annotations

import pytest

from backend.app.core import mutations as M
from backend.app.core.mutations import Mutation, MutationKind as K
from backend.app.core.workflow import (
    ConstraintKind,
    ConstraintSpec,
    TaskStatus,
    WorkflowState,
)


@pytest.fixture
def pair(event_fixture):
    return event_fixture.snapshot, event_fixture.state


# ---------------------------------------------------------------------------
# The algebra is closed and complete
# ---------------------------------------------------------------------------


class TestTheAlgebraIsClosed:
    def test_the_seventeen_kinds_from_the_architecture_all_exist(self):
        assert {k.value for k in K} == {
            "TASK_ADD", "TASK_REMOVE", "TASK_EFFORT_SET",
            "TASK_DELAY_ADD", "TASK_SPLIT", "TASK_MERGE",
            "TASK_STATUS_SET", "TASK_PRIORITY_SET",
            "DEPENDENCY_ADD", "DEPENDENCY_REMOVE", "DEPENDENCY_TYPE_CHANGE",
            "ASSIGNMENT_ADD", "ASSIGNMENT_REMOVE",
            "RESOURCE_CAPACITY_SET", "RESOURCE_UNAVAILABLE_WINDOW",
            "DEADLINE_SET", "REQUIREMENT_VERSION_BUMP",
        }

    def test_every_kind_has_a_validator_an_applier_and_an_inverse(self):
        handlers = M.handlers()
        assert set(handlers) == set(K)
        for kind in K:
            h = handlers[kind]
            assert callable(h.validate)
            assert callable(h.apply)
            assert callable(h.inverse)

    def test_every_kind_declares_a_payload_schema(self):
        schema = M.payload_schema()
        assert set(schema) == set(K)
        for kind, (required, optional) in schema.items():
            assert required, f"{kind} declares no required fields"
            assert not set(required) & set(optional)

    def test_an_unknown_kind_is_refused_with_the_valid_set(self):
        with pytest.raises(ValueError) as exc:
            Mutation.from_dict({"kind": "RESTRUCTURE_THE_PROJECT"})
        message = str(exc.value)
        assert "closed" in message
        assert "TASK_SPLIT" in message

    def test_a_mutations_payload_cannot_be_mutated_after_construction(self):
        m = Mutation(K.TASK_EFFORT_SET, {"key": "T01", "effort": 3})
        with pytest.raises(TypeError):
            m.payload["effort"] = 99

    def test_every_kind_describes_itself_in_one_line(self):
        for kind, (required, _) in M.payload_schema().items():
            payload = {f: "x" for f in required}
            text = Mutation(kind, payload).describe()
            assert text and text != kind.value or text == kind.value


# ---------------------------------------------------------------------------
# Round-trip: apply then apply the inverse, and land back on the base
# ---------------------------------------------------------------------------


ROUND_TRIP_CASES = [
    (K.TASK_ADD, {"key": "NEW", "name": "New task", "effort": 3,
                  "predecessors": ["T01"], "successors": ["T17"]}),
    (K.TASK_REMOVE, {"key": "T12"}),
    (K.TASK_EFFORT_SET, {"key": "T05", "effort": 9}),
    (K.TASK_DELAY_ADD, {"key": "T05", "extra_days": 4}),
    (K.TASK_SPLIT, {"key": "T08", "parts": 2}),
    (K.TASK_STATUS_SET, {"key": "T04", "status": "in_progress"}),
    (K.TASK_PRIORITY_SET, {"key": "T04", "priority": 7}),
    (K.DEPENDENCY_ADD, {"from_task": "T04", "to_task": "T12"}),
    (K.DEPENDENCY_REMOVE, {"from_task": "T03", "to_task": "T05"}),
    (K.DEPENDENCY_TYPE_CHANGE, {"from_task": "T03", "to_task": "T05",
                                "consumes": True}),
    (K.ASSIGNMENT_ADD, {"task_key": "T05", "resource_key": "ravi"}),
    (K.ASSIGNMENT_REMOVE, {"task_key": "T05", "resource_key": "suresh"}),
    (K.RESOURCE_CAPACITY_SET, {"resource_key": "mkt", "capacity": 3}),
    (K.DEADLINE_SET, {"deadline_day": 40}),
    (K.REQUIREMENT_VERSION_BUMP, {"requirement_key": "R2"}),
]


class TestRoundTrip:
    """Apply, then apply the inverse, and both the content hash and the
    statuses must return to the base. That is what makes undo and "discard
    this scenario" trivial.

    The inverse is a *list*, not a single mutation: undoing a task removal has
    to re-add the task, drop the bridges the removal created, and restore its
    assignments. Writing this test is what exposed that - a single-mutation
    inverse silently left extra edges behind, and bumping a requirement twice
    landed on version 3 instead of back on version 1.
    """

    @pytest.mark.parametrize(
        "kind,payload", ROUND_TRIP_CASES, ids=[c[0].value for c in ROUND_TRIP_CASES]
    )
    def test_apply_then_inverse_returns_to_the_base(self, pair, kind, payload):
        snapshot, state = pair
        base_hash = snapshot.content_hash()
        statuses_before = dict(state.statuses)
        mutation = Mutation(kind, payload)

        assert M.validate(snapshot, state, mutation).valid, kind

        undo = M.inverse(snapshot, state, mutation)
        assert undo, f"{kind.value} produced no inverse"

        after, after_state = M.apply(snapshot, state, mutation)
        if kind is not K.TASK_STATUS_SET:
            # TASK_STATUS_SET changes state, not the snapshot, so its hash
            # legitimately does not move.
            assert after.content_hash() != base_hash

        restored, restored_state = M.apply_all(after, after_state, list(undo))[:2]
        assert restored.content_hash() == base_hash, (
            f"{kind.value} did not round-trip"
        )
        assert dict(restored_state.statuses) == statuses_before, (
            f"{kind.value} round-tripped the snapshot but not the statuses"
        )

    def test_the_inverse_of_a_removal_takes_more_than_one_step(self, pair):
        """T14 sits between T13 and T15, so removing it bridges T13 -> T15.
        Undoing that has to drop the bridge as well as re-add the task."""
        snapshot, state = pair
        undo = M.inverse(
            snapshot, state, Mutation(K.TASK_REMOVE, {"key": "T14"})
        )
        kinds = [m.kind for m in undo]
        assert K.TASK_ADD in kinds
        assert K.DEPENDENCY_REMOVE in kinds
        assert K.ASSIGNMENT_ADD in kinds

    def test_the_inverse_of_a_requirement_bump_sets_rather_than_bumps(self, pair):
        snapshot, state = pair
        undo = M.inverse(snapshot, state, Mutation(
            K.REQUIREMENT_VERSION_BUMP, {"requirement_key": "R2"},
        ))
        assert undo[0].payload["version_no"] == 1
        # It also restores the statuses the bump reset.
        assert any(m.kind is K.TASK_STATUS_SET for m in undo)

    @pytest.mark.parametrize(
        "kind,payload", ROUND_TRIP_CASES, ids=[c[0].value for c in ROUND_TRIP_CASES]
    )
    def test_apply_never_mutates_the_base(self, pair, kind, payload):
        snapshot, state = pair
        before = snapshot.content_hash()
        statuses_before = dict(state.statuses)
        M.apply(snapshot, state, Mutation(kind, payload))
        assert snapshot.content_hash() == before
        assert dict(state.statuses) == statuses_before

    def test_task_merge_round_trips_after_a_split(self, pair):
        snapshot, state = pair
        base_hash = snapshot.content_hash()
        split = Mutation(K.TASK_SPLIT, {"key": "T08", "parts": 3})
        after, after_state = M.apply(snapshot, state, split)
        assert len(after.tasks) == len(snapshot.tasks) + 2

        merge = Mutation(K.TASK_MERGE, {
            "keys": ["T08.1", "T08.2", "T08.3"],
            "into_key": "T08",
            "name": snapshot.task_by_key["T08"].name,
        })
        assert M.validate(after, after_state, merge).valid
        back, _ = M.apply(after, after_state, merge)
        assert back.content_hash() == base_hash

    def test_resource_unavailable_window_applies_and_is_readable(self, pair):
        snapshot, state = pair
        m = Mutation(K.RESOURCE_UNAVAILABLE_WINDOW, {
            "resource_key": "anitha", "from_day": 14, "to_day": 21,
        })
        after, _ = M.apply(snapshot, state, m)
        assert after.resource_by_key["anitha"].unavailable_windows == ((14.0, 21.0),)
        assert snapshot.resource_by_key["anitha"].unavailable_windows == ()

    def test_resource_unavailable_window_round_trips(self, pair):
        """Adding a window needs *removing* one to undo it, which "add a
        window" cannot express - so the same mutation also accepts a whole
        `windows` list, and the inverse sets it back to exactly what it was.
        That keeps the algebra at seventeen kinds."""
        snapshot, state = pair
        base_hash = snapshot.content_hash()
        m = Mutation(K.RESOURCE_UNAVAILABLE_WINDOW, {
            "resource_key": "anitha", "from_day": 14, "to_day": 21,
        })
        undo = M.inverse(snapshot, state, m)
        after, after_state = M.apply(snapshot, state, m)
        restored, _, _ = M.apply_all(after, after_state, list(undo))
        assert restored.content_hash() == base_hash
        assert restored.resource_by_key["anitha"].unavailable_windows == ()

    def test_a_windows_list_replaces_rather_than_appends(self, pair):
        snapshot, state = pair
        one, one_state = M.apply(snapshot, state, Mutation(
            K.RESOURCE_UNAVAILABLE_WINDOW,
            {"resource_key": "anitha", "from_day": 2, "to_day": 4},
        ))
        two, _ = M.apply(one, one_state, Mutation(
            K.RESOURCE_UNAVAILABLE_WINDOW,
            {"resource_key": "anitha", "windows": [[10, 12]]},
        ))
        assert two.resource_by_key["anitha"].unavailable_windows == ((10.0, 12.0),)

    def test_a_window_mutation_needs_either_a_pair_or_a_list(self, pair):
        result = M.validate(*pair, Mutation(
            K.RESOURCE_UNAVAILABLE_WINDOW, {"resource_key": "anitha"},
        ))
        assert not result.valid
        assert "either from_day and to_day" in result.rejections[0].reason


class TestOrderedApplication:
    def test_a_list_applies_in_order(self, pair):
        snapshot, state = pair
        muts = [
            Mutation(K.TASK_ADD, {"key": "X1", "name": "New", "effort": 2}),
            Mutation(K.DEPENDENCY_ADD, {"from_task": "T01", "to_task": "X1"}),
        ]
        assert M.validate_all(snapshot, state, muts).valid
        after, after_state, inverses = M.apply_all(snapshot, state, muts)
        assert "X1" in after.task_keys
        assert ("T01", "X1") in after.dependency_by_edge
        # Inverses come back already ordered so replaying them undoes the list.
        assert [m.kind for m in inverses] == [
            K.DEPENDENCY_REMOVE, K.TASK_REMOVE
        ]
        restored, _, _ = M.apply_all(after, after_state, inverses)
        assert restored.content_hash() == snapshot.content_hash()

    def test_order_matters_and_the_wrong_order_is_rejected(self, pair):
        snapshot, state = pair
        wrong = [
            Mutation(K.DEPENDENCY_ADD, {"from_task": "T01", "to_task": "X1"}),
            Mutation(K.TASK_ADD, {"key": "X1", "name": "New", "effort": 2}),
        ]
        result = M.validate_all(snapshot, state, wrong)
        assert not result.valid
        assert "mutation 1" in result.rejections[0].reason
        assert "X1" in result.rejections[0].reason

    def test_a_whole_list_round_trips(self, pair):
        snapshot, state = pair
        base_hash = snapshot.content_hash()
        muts = [
            Mutation(K.DEPENDENCY_REMOVE, {"from_task": "T01", "to_task": "T04"}),
            Mutation(K.TASK_EFFORT_SET, {"key": "T05", "effort": 1}),
            Mutation(K.ASSIGNMENT_ADD, {"task_key": "T05", "resource_key": "ravi"}),
        ]
        after, after_state, inverses = M.apply_all(snapshot, state, muts)
        assert after.content_hash() != base_hash
        restored, _, _ = M.apply_all(after, after_state, inverses)
        assert restored.content_hash() == base_hash


# ---------------------------------------------------------------------------
# Rejections, each with a reason a human can act on
# ---------------------------------------------------------------------------


class TestStructuralRejections:
    def test_a_missing_required_field_is_named(self, pair):
        result = M.validate(*pair, Mutation(K.TASK_EFFORT_SET, {"key": "T01"}))
        assert not result.valid
        assert "effort" in result.rejections[0].reason

    def test_an_unknown_field_is_named(self, pair):
        result = M.validate(*pair, Mutation(K.TASK_EFFORT_SET, {
            "key": "T01", "effort": 2, "colour": "blue",
        }))
        assert not result.valid
        assert "colour" in result.rejections[0].reason


class TestSemanticRejections:
    """A well-formed mutation that is nonetheless wrong. This is the half a
    schema cannot catch, and it is where the value is."""

    def test_a_cycle_is_rejected_with_the_cycle(self, pair):
        result = M.validate(*pair, Mutation(K.DEPENDENCY_ADD, {
            "from_task": "T17", "to_task": "T01",
        }))
        assert not result.valid
        reason = result.rejections[0].reason
        assert "circular dependency" in reason
        assert "T01" in reason and "T17" in reason

    def test_a_self_dependency_is_rejected(self, pair):
        result = M.validate(*pair, Mutation(K.DEPENDENCY_ADD, {
            "from_task": "T05", "to_task": "T05",
        }))
        assert not result.valid
        assert "cannot depend on itself" in result.rejections[0].reason

    def test_a_missing_task_reference_is_rejected_by_name(self, pair):
        result = M.validate(*pair, Mutation(K.TASK_EFFORT_SET, {
            "key": "GHOST", "effort": 2,
        }))
        assert not result.valid
        assert "GHOST" in result.rejections[0].reason

    def test_a_duplicate_task_key_is_rejected(self, pair):
        result = M.validate(*pair, Mutation(K.TASK_ADD, {
            "key": "T01", "name": "Clash", "effort": 1,
        }))
        assert not result.valid
        assert "already exists" in result.rejections[0].reason

    def test_a_duplicate_dependency_is_rejected(self, pair):
        result = M.validate(*pair, Mutation(K.DEPENDENCY_ADD, {
            "from_task": "T01", "to_task": "T02",
        }))
        assert not result.valid
        assert "already exists" in result.rejections[0].reason

    def test_removing_a_dependency_that_does_not_exist_is_rejected(self, pair):
        result = M.validate(*pair, Mutation(K.DEPENDENCY_REMOVE, {
            "from_task": "T05", "to_task": "T01",
        }))
        assert not result.valid
        assert "does not exist" in result.rejections[0].reason

    def test_negative_effort_is_rejected(self, pair):
        result = M.validate(*pair, Mutation(K.TASK_EFFORT_SET, {
            "key": "T05", "effort": -1,
        }))
        assert not result.valid
        assert "negative" in result.rejections[0].reason

    def test_a_negative_delay_points_at_the_right_mutation(self, pair):
        result = M.validate(*pair, Mutation(K.TASK_DELAY_ADD, {
            "key": "T05", "extra_days": -3,
        }))
        assert not result.valid
        assert "TASK_EFFORT_SET" in result.rejections[0].reason

    def test_an_invalid_status_lists_the_valid_ones(self, pair):
        result = M.validate(*pair, Mutation(K.TASK_STATUS_SET, {
            "key": "T05", "status": "nearly_done",
        }))
        assert not result.valid
        assert "in_review" in result.rejections[0].reason

    def test_a_backwards_unavailable_window_is_rejected(self, pair):
        result = M.validate(*pair, Mutation(K.RESOURCE_UNAVAILABLE_WINDOW, {
            "resource_key": "anitha", "from_day": 20, "to_day": 12,
        }))
        assert not result.valid
        assert "starts on day" in result.rejections[0].reason

    def test_assigning_someone_without_the_required_skill_is_rejected(
        self, mfg_fixture
    ):
        """M09 needs certification skills; Tan does assembly."""
        result = M.validate(
            mfg_fixture.snapshot, mfg_fixture.state,
            Mutation(K.ASSIGNMENT_ADD, {
                "task_key": "M09", "resource_key": "tan",
            }),
        )
        assert not result.valid
        reason = result.rejections[0].reason
        assert "does not have the skills" in reason
        assert "certification" in reason


class TestConstraintsAreCited:
    """A rejection caused by a `Constraint` quotes the constraint and the
    reason on record. Without this the optimizer's best move is always
    "delete the slow task" (ARCHITECTURE D.5 step 4)."""

    def test_a_mandatory_task_cannot_be_removed(self, mfg_fixture):
        result = M.validate(
            mfg_fixture.snapshot, mfg_fixture.state,
            Mutation(K.TASK_REMOVE, {"key": "M09"}),
        )
        assert not result.valid
        r = result.rejections[0]
        assert r.constraint == "MANDATORY_TASK"
        assert "UN38.3" in r.constraint_reason
        assert "mandatory task" in r.reason

    def test_an_immutable_dependency_cannot_be_removed(self, mfg_fixture):
        result = M.validate(
            mfg_fixture.snapshot, mfg_fixture.state,
            Mutation(K.DEPENDENCY_REMOVE, {
                "from_task": "M09", "to_task": "M12",
            }),
        )
        assert not result.valid
        r = result.rejections[0]
        assert r.constraint == "IMMUTABLE_DEPENDENCY"
        assert "certification" in r.constraint_reason

    def test_a_non_divisible_task_cannot_be_split(self, mfg_fixture):
        result = M.validate(
            mfg_fixture.snapshot, mfg_fixture.state,
            Mutation(K.TASK_SPLIT, {"key": "M09", "parts": 3}),
        )
        assert not result.valid
        assert "non-divisible" in result.rejections[0].reason

    def test_a_min_duration_floor_is_enforced(self, mfg_fixture):
        """M05 has a 6-day contractual minimum lead time."""
        result = M.validate(
            mfg_fixture.snapshot, mfg_fixture.state,
            Mutation(K.TASK_EFFORT_SET, {"key": "M05", "effort": 2}),
        )
        assert not result.valid
        r = result.rejections[0]
        assert r.constraint == "MIN_DURATION"
        assert "minimum duration of 6" in r.reason
        assert "lead time" in r.constraint_reason

    def test_the_floor_permits_a_value_at_or_above_it(self, mfg_fixture):
        assert M.validate(
            mfg_fixture.snapshot, mfg_fixture.state,
            Mutation(K.TASK_EFFORT_SET, {"key": "M05", "effort": 6}),
        ).valid

    def test_a_droppable_dependency_is_still_droppable(self, mfg_fixture):
        """The guardrails must be specific, not a blanket refusal to change
        anything."""
        assert M.validate(
            mfg_fixture.snapshot, mfg_fixture.state,
            Mutation(K.DEPENDENCY_REMOVE, {
                "from_task": "M11", "to_task": "M12",
            }),
        ).valid

    def test_a_fixed_assignment_cannot_be_removed(self, event_fixture):
        snapshot = event_fixture.snapshot.evolve(
            constraints=event_fixture.snapshot.constraints + (
                ConstraintSpec(
                    kind=ConstraintKind.FIXED_ASSIGNMENT,
                    target="T03",
                    reason="Only the finance director may approve a budget.",
                ),
            )
        )
        result = M.validate(
            snapshot, event_fixture.state,
            Mutation(K.ASSIGNMENT_REMOVE, {
                "task_key": "T03", "resource_key": "deepa",
            }),
        )
        assert not result.valid
        assert result.rejections[0].constraint == "FIXED_ASSIGNMENT"
        assert "finance director" in result.rejections[0].constraint_reason

    def test_apply_refuses_an_invalid_mutation(self, mfg_fixture):
        with pytest.raises(M.MutationError) as exc:
            M.apply(
                mfg_fixture.snapshot, mfg_fixture.state,
                Mutation(K.TASK_REMOVE, {"key": "M09"}),
            )
        assert "mandatory" in str(exc.value)


# ---------------------------------------------------------------------------
# Semantics worth pinning down
# ---------------------------------------------------------------------------


class TestSplitSemantics:
    def test_a_split_preserves_total_effort(self, pair):
        """A restructuring changes sequence and allocation, not the amount of
        work. Anything else is the optimizer cheating."""
        snapshot, state = pair
        before = snapshot.total_effort()
        after, _ = M.apply(snapshot, state, Mutation(K.TASK_SPLIT, {
            "key": "T08", "parts": 4,
        }))
        assert after.total_effort() == pytest.approx(before)

    def test_the_parts_run_in_parallel(self, pair):
        snapshot, state = pair
        after, _ = M.apply(snapshot, state, Mutation(K.TASK_SPLIT, {
            "key": "T08", "parts": 2,
        }))
        # T07 -> T08 -> T09 becomes T07 -> {T08.1, T08.2} -> T09
        assert ("T07", "T08.1") in after.dependency_by_edge
        assert ("T07", "T08.2") in after.dependency_by_edge
        assert ("T08.1", "T09") in after.dependency_by_edge
        assert ("T08.2", "T09") in after.dependency_by_edge
        assert ("T08.1", "T08.2") not in after.dependency_by_edge

    def test_a_split_shortens_the_project_when_it_is_on_the_path(self, pair):
        from backend.app.core.engine import evaluate
        from backend.app.core.workflow import Clock

        snapshot, state = pair
        before = evaluate(snapshot, state, Clock(14.0)).projected_end
        after_snap, after_state = M.apply(snapshot, state, Mutation(K.TASK_SPLIT, {
            "key": "T14", "parts": 2,
        }))
        after = evaluate(after_snap, after_state, Clock(14.0)).projected_end
        assert after < before

    def test_splitting_into_fewer_than_two_parts_is_rejected(self, pair):
        result = M.validate(*pair, Mutation(K.TASK_SPLIT, {
            "key": "T08", "parts": 1,
        }))
        assert not result.valid
        assert "at least 2 parts" in result.rejections[0].reason

    def test_a_part_key_clash_is_rejected(self, pair):
        result = M.validate(*pair, Mutation(K.TASK_SPLIT, {
            "key": "T08", "parts": 2, "part_keys": ["T01", "T08.2"],
        }))
        assert not result.valid
        assert "already in use" in result.rejections[0].reason


class TestRemoveSemantics:
    def test_removing_a_task_bridges_around_it(self, pair):
        """Otherwise removing a task silently drops the ordering it carried,
        and the schedule gets shorter for the wrong reason."""
        snapshot, state = pair
        after, _ = M.apply(snapshot, state, Mutation(K.TASK_REMOVE, {
            "key": "T14",
        }))
        assert ("T13", "T15") in after.dependency_by_edge

    def test_bridging_can_be_turned_off(self, pair):
        snapshot, state = pair
        after, _ = M.apply(snapshot, state, Mutation(K.TASK_REMOVE, {
            "key": "T14", "bridge_dependencies": False,
        }))
        assert ("T13", "T15") not in after.dependency_by_edge

    def test_removing_a_task_drops_its_assignments_and_requirement_links(
        self, pair
    ):
        snapshot, state = pair
        after, after_state = M.apply(snapshot, state, Mutation(K.TASK_REMOVE, {
            "key": "T12",
        }))
        assert "T12" not in after.assignees_by_task
        for req in after.requirements:
            assert "T12" not in req.consumed_by
        assert "T12" not in after_state.statuses


class TestRequirementBumpSemantics:
    def test_a_bump_resets_completed_stale_work(self, pair):
        """R2 covers signage and creatives. T10 is done and consumed it, so a
        change to R2 means that work has to happen again - which is what makes
        requirement churn cost days rather than be a note in a document."""
        snapshot, state = pair
        assert state.is_done("T10")
        after, after_state = M.apply(snapshot, state, Mutation(
            K.REQUIREMENT_VERSION_BUMP, {"requirement_key": "R2"},
        ))
        assert after_state.status_of("T10") == TaskStatus.NOT_STARTED
        assert after.requirement_by_key["R2"].version_no == 2

    def test_a_bump_leaves_unrelated_completed_work_alone(self, pair):
        snapshot, state = pair
        after, after_state = M.apply(snapshot, state, Mutation(
            K.REQUIREMENT_VERSION_BUMP, {"requirement_key": "R2"},
        ))
        # T07/T08 are the sponsorship track; R2 is signage.
        assert after_state.is_done("T07")
        assert after_state.is_done("T08")

    def test_a_bump_can_carry_the_new_text(self, pair):
        snapshot, state = pair
        after, _ = M.apply(snapshot, state, Mutation(
            K.REQUIREMENT_VERSION_BUMP, {
                "requirement_key": "R2",
                "text": "Signage and creatives in English and Tamil",
            },
        ))
        assert "Tamil" in after.requirement_by_key["R2"].text


class TestEffortModelInteraction:
    def test_a_second_assignee_gives_sub_linear_speedup(self, pair):
        from backend.app.core.engine import planned_durations

        snapshot, state = pair
        after, _ = M.apply(snapshot, state, Mutation(K.ASSIGNMENT_ADD, {
            "task_key": "T05", "resource_key": "ravi",
        }))
        durations, _ = planned_durations(after)
        # 3 / (1 + 0.6) = 1.875, not 1.5
        assert durations["T05"] == pytest.approx(3 / 1.6)

    def test_a_second_assignee_on_a_non_divisible_task_changes_nothing(
        self, pair
    ):
        from backend.app.core.engine import planned_durations

        snapshot, state = pair
        after, _ = M.apply(snapshot, state, Mutation(K.ASSIGNMENT_ADD, {
            "task_key": "T03", "resource_key": "ravi",
        }))
        durations, model = planned_durations(after)
        assert durations["T03"] == 2.0
        assert "T03" in model.as_dict()["non_divisible_tasks"]
