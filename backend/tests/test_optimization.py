"""
Capability 4 tests - generate, gate, score, rank.

The brief's list: transitive reduction never changes the project end when the
removed edge is genuinely redundant; a candidate deleting a mandatory task is
rejected with the constraint named; optimization respects its budget; the
recommended candidate genuinely scores best under the given weights.
"""
from __future__ import annotations

import time

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from backend.app.core.engine import evaluate
from backend.app.core.engine.cpm import schedule
from backend.app.core.engine.effort import planned_durations
from backend.app.core.engine.graph import (
    build_graph_from_snapshot,
    transitive_redundant_edges,
)
from backend.app.core.mutations import Mutation, MutationKind as K, apply_all
from backend.app.core.optimization import (
    Budget,
    Candidate,
    ObjectiveWeights,
    gate,
    generate,
    generators,
    optimize,
    score_candidate,
)
from backend.app.core.workflow import Clock
from backend.app.main import app

EVENT_PROJECT_ID = "00000000-0000-0000-0000-000000000001"
MFG_PROJECT_ID = "00000000-0000-0000-0000-000000000002"


@pytest.fixture
def result(event_fixture):
    return optimize(
        event_fixture.snapshot, event_fixture.state,
        Clock(event_fixture.today_day),
    )


@pytest.fixture
def mfg_result(mfg_fixture):
    return optimize(mfg_fixture.snapshot, mfg_fixture.state, Clock(0.0))


def cheat(key: str) -> Candidate:
    """The candidate every unconstrained optimizer eventually proposes."""
    return Candidate(
        name="Just delete the slow task",
        generator="adversarial",
        rationale="the classic cheat",
        mutations=(Mutation(K.TASK_REMOVE, {"key": key}),),
    )


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------


class TestGeneration:
    def test_all_five_deterministic_generators_are_registered(self):
        names = {g.__name__ for g in generators()}
        assert names == {
            "gen_transitive_reduction",
            "gen_parallelize_zero_slack",
            "gen_drop_soft_ordering",
            "gen_resource_levelling",
            "gen_resequence_contended",
        }

    def test_it_generates_candidates_for_both_domains(self, result, mfg_result):
        assert result.generated > 5
        assert mfg_result.generated > 5

    def test_every_candidate_is_a_real_mutation_list(self, result):
        for candidate in result.candidates:
            assert candidate.mutations
            for mutation in candidate.mutations:
                assert mutation.kind in set(K)

    def test_every_candidate_explains_itself(self, result):
        for candidate in result.candidates:
            assert candidate.name
            assert candidate.rationale
            assert candidate.generator

    def test_duplicate_candidates_are_collapsed(self, event_fixture):
        base = evaluate(
            event_fixture.snapshot, event_fixture.state, Clock(14.0)
        )
        pool = generate(event_fixture.snapshot, event_fixture.state, base)
        signatures = [
            tuple((m.kind.value, str(sorted(m.payload.items(), key=str)))
                  for m in c.mutations)
            for c in pool
        ]
        assert len(signatures) == len(set(signatures))

    def test_it_never_proposes_splitting_a_non_divisible_task(self, mfg_fixture):
        """M09 is the certification: non-divisible by constraint. The
        generator must not even suggest it."""
        base = evaluate(mfg_fixture.snapshot, mfg_fixture.state, Clock(0.0))
        pool = generate(mfg_fixture.snapshot, mfg_fixture.state, base)
        for candidate in pool:
            for mutation in candidate.mutations:
                if mutation.kind is K.TASK_SPLIT:
                    assert mutation.payload["key"] != "M09"

    def test_it_never_proposes_dropping_a_protected_edge(self, mfg_fixture):
        base = evaluate(mfg_fixture.snapshot, mfg_fixture.state, Clock(0.0))
        pool = generate(mfg_fixture.snapshot, mfg_fixture.state, base)
        for candidate in pool:
            for mutation in candidate.mutations:
                if mutation.kind is K.DEPENDENCY_REMOVE:
                    assert (
                        mutation.payload["from_task"],
                        mutation.payload["to_task"],
                    ) != ("M09", "M12")

    def test_scope_cutting_is_opt_in(self, mfg_fixture):
        base = evaluate(mfg_fixture.snapshot, mfg_fixture.state, Clock(0.0))
        default = generate(mfg_fixture.snapshot, mfg_fixture.state, base)
        aggressive = generate(
            mfg_fixture.snapshot, mfg_fixture.state, base, aggressive=True
        )
        assert not any(
            m.kind is K.TASK_REMOVE for c in default for m in c.mutations
        )
        assert any(
            m.kind is K.TASK_REMOVE for c in aggressive for m in c.mutations
        )


# ---------------------------------------------------------------------------
# Transitive reduction - the provably safe candidate
# ---------------------------------------------------------------------------


class TestTransitiveReduction:
    """The brief's named assertion: removing a genuinely redundant edge never
    changes the project end."""

    @pytest.mark.parametrize("which", ["event", "mfg"])
    def test_removing_redundant_edges_never_moves_the_finish(
        self, which, event_fixture, mfg_fixture
    ):
        fx = {"event": event_fixture, "mfg": mfg_fixture}[which]
        snapshot, state = fx.snapshot, fx.state
        G = build_graph_from_snapshot(snapshot)
        durations, _ = planned_durations(snapshot)
        before = schedule(G, durations)["project_end"]

        redundant = transitive_redundant_edges(G)
        assert redundant, f"{which} fixture has no redundant edges to test"

        changed, changed_state, _ = apply_all(snapshot, state, [
            Mutation(K.DEPENDENCY_REMOVE, {"from_task": u, "to_task": v})
            for u, v in redundant
        ])
        after_durations, _ = planned_durations(changed)
        after = schedule(
            build_graph_from_snapshot(changed), after_durations
        )["project_end"]
        assert after == before

    def test_the_candidate_scores_zero_on_completion(self, result):
        candidate = next(
            c for c in result.candidates
            if c.generator == "transitive_reduction"
        )
        completion = next(
            c for c in candidate.score.criteria
            if c.name == "expected_completion"
        )
        assert completion.delta == 0.0

    def test_but_it_does_reduce_dependency_complexity(self, result):
        candidate = next(
            c for c in result.candidates
            if c.generator == "transitive_reduction"
        )
        complexity = next(
            c for c in candidate.score.criteria
            if c.name == "dependency_complexity"
        )
        assert complexity.delta < 0
        assert complexity.improvement > 0

    def test_it_preserves_total_effort(self, result):
        for candidate in result.candidates:
            if candidate.generator == "transitive_reduction":
                assert candidate.scope_change is False


# ---------------------------------------------------------------------------
# The gates
# ---------------------------------------------------------------------------


class TestConstraintGates:
    """Without these, the optimizer's best move is always "delete the slow
    task"."""

    def test_a_candidate_deleting_a_mandatory_task_is_rejected(self, mfg_fixture):
        """The brief's named assertion."""
        result = optimize(
            mfg_fixture.snapshot, mfg_fixture.state, Clock(0.0),
            extra_candidates=[cheat("M09")],
        )
        refused = next(
            c for c in result.rejected if c.name == "Just delete the slow task"
        )
        assert refused.rejected
        rejection = refused.rejections[0]
        assert rejection.constraint == "MANDATORY_TASK"
        assert "UN38.3" in rejection.constraint_reason
        assert "M09" in rejection.reason

    def test_the_refusal_names_the_constraint_in_the_payload(self, mfg_fixture):
        result = optimize(
            mfg_fixture.snapshot, mfg_fixture.state, Clock(0.0),
            extra_candidates=[cheat("M09")],
        ).as_dict()
        refused = next(
            c for c in result["rejected"]
            if c["name"] == "Just delete the slow task"
        )
        violation = refused["constraint_violations"][0]
        assert violation["constraint"] == "MANDATORY_TASK"
        assert violation["constraint_reason"]
        assert refused["scores"] is None, "a refused candidate is never scored"

    def test_a_refused_candidate_is_never_evaluated(self, mfg_fixture):
        result = optimize(
            mfg_fixture.snapshot, mfg_fixture.state, Clock(0.0),
            extra_candidates=[cheat("M09")],
        )
        assert result.evaluated == len(result.candidates)
        for candidate in result.rejected:
            assert candidate.evaluated is False

    def test_the_gate_rejects_an_immutable_dependency_being_dropped(
        self, mfg_fixture
    ):
        snapshot, state = mfg_fixture.snapshot, mfg_fixture.state
        mutations = [
            Mutation(K.DEPENDENCY_REMOVE, {"from_task": "M09", "to_task": "M12"})
        ]
        # The mutation validator refuses it too; the gate is the second layer,
        # so it is checked directly here.
        changed = snapshot.evolve(
            dependencies=tuple(
                d for d in snapshot.dependencies
                if d.edge != ("M09", "M12")
            )
        )
        violations = gate(snapshot, state, changed, mutations)
        assert any(
            v.constraint == "IMMUTABLE_DEPENDENCY" for v in violations
        )
        assert "certification" in violations[0].constraint_reason

    def test_the_gate_rejects_a_silent_effort_reduction(self, event_fixture):
        """A restructuring changes sequence and allocation, not the work.
        Without this gate the optimizer would always "find" an improvement."""
        snapshot, state = event_fixture.snapshot, event_fixture.state
        shrunk = snapshot.evolve(
            tasks=tuple(
                t if t.key != "T05" else type(t)(
                    key=t.key, name=t.name, effort=0.5, divisible=t.divisible,
                )
                for t in snapshot.tasks
            )
        )
        # No TASK_EFFORT_SET / TASK_REMOVE / TASK_MERGE in the mutation list,
        # so the reduction is unexplained.
        violations = gate(snapshot, state, shrunk, [
            Mutation(K.DEPENDENCY_REMOVE, {"from_task": "T03", "to_task": "T05"})
        ])
        assert any(
            v.constraint == "TOTAL_EFFORT_CONSERVATION" for v in violations
        )

    def test_an_explicit_effort_change_is_allowed(self, event_fixture):
        snapshot, state = event_fixture.snapshot, event_fixture.state
        changed, _, _ = apply_all(snapshot, state, [
            Mutation(K.TASK_EFFORT_SET, {"key": "T05", "effort": 1})
        ])
        violations = gate(snapshot, state, changed, [
            Mutation(K.TASK_EFFORT_SET, {"key": "T05", "effort": 1})
        ])
        assert not any(
            v.constraint == "TOTAL_EFFORT_CONSERVATION" for v in violations
        )

    def test_the_gate_rejects_a_skill_mismatch(self, mfg_fixture):
        snapshot, state = mfg_fixture.snapshot, mfg_fixture.state
        mutations = [
            Mutation(K.ASSIGNMENT_REMOVE, {
                "task_key": "M09", "resource_key": "lena",
            }),
        ]
        changed, _, _ = apply_all(snapshot, state, mutations)
        changed = changed.evolve(
            assignments=changed.assignments + (
                type(changed.assignments[0])(task_key="M09", resource_key="tan"),
            )
        )
        violations = gate(snapshot, state, changed, mutations)
        assert any(v.constraint == "SKILL_REQUIREMENT" for v in violations)
        assert "certification" in violations[0].reason

    def test_the_gate_rejects_dropping_below_a_min_duration(self, mfg_fixture):
        snapshot, state = mfg_fixture.snapshot, mfg_fixture.state
        mutations = [Mutation(K.TASK_EFFORT_SET, {"key": "M05", "effort": 2})]
        changed = snapshot.evolve(
            tasks=tuple(
                t if t.key != "M05" else type(t)(
                    key=t.key, name=t.name, effort=2.0,
                )
                for t in snapshot.tasks
            )
        )
        violations = gate(snapshot, state, changed, mutations)
        assert any(v.constraint == "MIN_DURATION" for v in violations)
        assert "lead time" in violations[0].constraint_reason


class TestGatesAreLineageAware:
    """A split renames a task's endpoints; it does not delete the work. A gate
    that cannot tell the difference produces a refusal that is not just
    unhelpful but false."""

    def test_splitting_a_mandatory_task_is_not_removing_it(self, mfg_fixture):
        snapshot, state = mfg_fixture.snapshot, mfg_fixture.state
        mutations = [Mutation(K.TASK_SPLIT, {"key": "M12", "parts": 2})]
        changed, _, _ = apply_all(snapshot, state, mutations)
        violations = gate(snapshot, state, changed, mutations)
        assert not any(v.constraint == "MANDATORY_TASK" for v in violations)

    def test_splitting_an_endpoint_preserves_an_immutable_dependency(
        self, event_fixture
    ):
        """T02 -> T03 is immutable. Splitting T02 rewires it to
        T02.1 -> T03 and T02.2 -> T03, so the ordering survives."""
        snapshot, state = event_fixture.snapshot, event_fixture.state
        mutations = [Mutation(K.TASK_SPLIT, {"key": "T02", "parts": 2})]
        changed, _, _ = apply_all(snapshot, state, mutations)
        violations = gate(snapshot, state, changed, mutations)
        assert not any(
            v.constraint == "IMMUTABLE_DEPENDENCY" for v in violations
        ), [v.reason for v in violations]
        assert ("T02.1", "T03") in changed.dependency_by_edge
        assert ("T02.2", "T03") in changed.dependency_by_edge

    def test_a_split_still_respects_a_min_duration_across_the_parts(
        self, mfg_fixture
    ):
        """Splitting a task with a contractual lead time does not shorten the
        lead time, so the floor applies to the parts' total."""
        snapshot, state = mfg_fixture.snapshot, mfg_fixture.state
        mutations = [Mutation(K.TASK_SPLIT, {"key": "M05", "parts": 2})]
        changed, _, _ = apply_all(snapshot, state, mutations)
        violations = gate(snapshot, state, changed, mutations)
        assert not any(v.constraint == "MIN_DURATION" for v in violations)
        assert sum(
            changed.task_by_key[k].effort for k in ("M05.1", "M05.2")
        ) == 8.0

    def test_a_genuine_deletion_is_still_refused(self, mfg_fixture):
        """Being lineage-aware must not become a loophole."""
        snapshot, state = mfg_fixture.snapshot, mfg_fixture.state
        mutations = [Mutation(K.TASK_REMOVE, {"key": "M09"})]
        changed = snapshot.evolve(
            tasks=tuple(t for t in snapshot.tasks if t.key != "M09"),
            dependencies=tuple(
                d for d in snapshot.dependencies
                if "M09" not in (d.from_task, d.to_task)
            ),
        )
        violations = gate(snapshot, state, changed, mutations)
        assert any(v.constraint == "MANDATORY_TASK" for v in violations)


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------


class TestScoring:
    def test_all_six_criteria_are_reported(self, result):
        expected = {
            "expected_completion", "feasibility_margin",
            "peak_resource_overload", "structural_risk",
            "dependency_complexity", "parallelization",
        }
        for candidate in result.candidates:
            assert {c.name for c in candidate.score.criteria} == expected

    def test_each_criterion_reports_before_after_delta_and_direction(
        self, result
    ):
        for candidate in result.candidates:
            for criterion in candidate.score.criteria:
                assert criterion.delta == pytest.approx(
                    criterion.after - criterion.before
                )
                assert criterion.better in ("lower", "higher")
                assert criterion.unit
                assert criterion.explanation

    def test_the_total_is_the_sum_of_the_contributions(self, result):
        for candidate in result.candidates:
            assert candidate.score.total == pytest.approx(
                sum(c.contribution for c in candidate.score.criteria)
            )

    def test_the_total_is_never_returned_without_the_table(self, result):
        payload = result.as_dict()
        for candidate in payload["candidates"]:
            assert candidate["scores"]["criteria"]
            assert candidate["scores"]["note"]

    def test_the_weights_are_echoed(self, result):
        payload = result.as_dict()
        assert payload["weights"] == ObjectiveWeights().as_dict()
        assert payload["weights_total"] == pytest.approx(1.0)

    def test_improvement_is_signed_consistently(self, result):
        for candidate in result.candidates:
            for criterion in candidate.score.criteria:
                if abs(criterion.delta) < 1e-9:
                    assert criterion.improvement == 0
                elif criterion.better == "lower":
                    assert (criterion.delta < 0) == (criterion.improvement > 0)
                else:
                    assert (criterion.delta > 0) == (criterion.improvement > 0)

    def test_scoring_never_touches_the_ai_module(self):
        """Structurally impossible - `core/` may not import it - but asserted
        because it is a product promise."""
        import ast
        import pathlib

        source = pathlib.Path(
            "backend/app/core/optimization.py"
        ).read_text(encoding="utf-8")
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                names = [
                    a.name for a in getattr(node, "names", [])
                ] + [getattr(node, "module", "") or ""]
                for name in names:
                    assert "ai" not in name.split("."), name


class TestRanking:
    def test_the_recommendation_is_the_top_scorer(self, result):
        """The brief's named assertion."""
        assert result.recommended is result.candidates[0]
        assert result.recommended.score.total == max(
            c.score.total for c in result.candidates
        )

    def test_candidates_are_ranked_by_total(self, result):
        totals = [c.score.total for c in result.candidates]
        assert totals == sorted(totals, reverse=True)

    def test_changing_the_weights_changes_the_recommendation(self, event_fixture):
        completion_only = optimize(
            event_fixture.snapshot, event_fixture.state, Clock(14.0),
            weights=ObjectiveWeights(
                expected_completion=1.0, feasibility_margin=0.0,
                peak_resource_overload=0.0, structural_risk=0.0,
                dependency_complexity=0.0, parallelization=0.0,
            ),
        )
        complexity_only = optimize(
            event_fixture.snapshot, event_fixture.state, Clock(14.0),
            weights=ObjectiveWeights(
                expected_completion=0.0, feasibility_margin=0.0,
                peak_resource_overload=0.0, structural_risk=0.0,
                dependency_complexity=1.0, parallelization=0.0,
            ),
        )
        assert completion_only.recommended.name != complexity_only.recommended.name
        assert "redundant" in complexity_only.recommended.name.lower()

    def test_no_improvement_means_no_recommendation_and_says_so(self):
        """A workflow with nothing to improve gets an honest empty answer."""
        from backend.app.core.workflow import (
            DependencySpec, TaskSpec, WorkflowSnapshot, WorkflowState,
        )

        snapshot = WorkflowSnapshot.build(
            tasks=(
                TaskSpec(key="A", name="A", effort=1.0, divisible=False),
                TaskSpec(key="B", name="B", effort=1.0, divisible=False),
            ),
            dependencies=(
                DependencySpec(from_task="A", to_task="B", consumes=True),
            ),
        )
        result = optimize(snapshot, WorkflowState.empty(snapshot), Clock(0.0))
        assert result.recommended is None
        assert "not a failure" in result._recommendation_reason()

    def test_the_recommendation_reason_quotes_the_numbers(self, result):
        reason = result._recommendation_reason()
        assert result.recommended.name in reason
        assert "day" in reason
        assert "refused by a constraint" in reason


class TestScopeChangeIsPricedInTheOpen:
    def test_aggressive_mode_proposes_cutting_scope(self, mfg_fixture):
        result = optimize(
            mfg_fixture.snapshot, mfg_fixture.state, Clock(0.0),
            aggressive=True,
        )
        assert any(c.scope_change for c in result.candidates)

    def test_a_scope_change_is_labelled_with_its_effort_delta(self, mfg_fixture):
        result = optimize(
            mfg_fixture.snapshot, mfg_fixture.state, Clock(0.0),
            aggressive=True,
        ).as_dict()
        cutting = [c for c in result["candidates"] if c["scope_change"]]
        assert cutting
        for candidate in cutting:
            assert candidate["effort_delta_days"] < 0
            assert "different amount" in candidate["scope_change_note"]

    def test_a_same_scope_recommendation_is_offered_alongside(self, mfg_fixture):
        """"Same work, faster" and "less work, faster" are different offers,
        and choosing between them is the user's call."""
        result = optimize(
            mfg_fixture.snapshot, mfg_fixture.state, Clock(0.0),
            aggressive=True,
        )
        assert result.recommended.scope_change is True
        assert result.recommended_same_scope is not None
        assert result.recommended_same_scope.scope_change is False

    def test_the_default_mode_never_cuts_scope(self, mfg_result):
        assert all(not c.scope_change for c in mfg_result.candidates)
        assert mfg_result.recommended_same_scope is mfg_result.recommended

    def test_aggressive_mode_produces_the_refusal(self, mfg_fixture):
        """The demo beat: ask it to optimize with no limits and it declines to
        remove the certification, citing the constraint."""
        result = optimize(
            mfg_fixture.snapshot, mfg_fixture.state, Clock(0.0),
            aggressive=True,
        )
        refused = [
            c for c in result.rejected
            if any(r.constraint == "MANDATORY_TASK" for r in c.rejections)
        ]
        assert refused
        assert "M09" in refused[0].rejections[0].reason
        assert "UN38.3" in refused[0].rejections[0].constraint_reason


# ---------------------------------------------------------------------------
# Budget
# ---------------------------------------------------------------------------


class TestBudget:
    def test_the_candidate_budget_is_respected(self, event_fixture):
        result = optimize(
            event_fixture.snapshot, event_fixture.state, Clock(14.0),
            budget=Budget(max_candidates=3),
        )
        assert result.evaluated == 3
        assert result.stopped_early is True
        assert "candidate budget reached" in result.stop_reason

    def test_the_time_budget_is_respected(self, event_fixture):
        """The stop signal is injected, so this is deterministic rather than
        a race against a real clock."""
        calls = {"n": 0}

        def stop_after_two():
            calls["n"] += 1
            return calls["n"] > 2

        result = optimize(
            event_fixture.snapshot, event_fixture.state, Clock(14.0),
            budget=Budget(max_candidates=999, max_seconds=1.0),
            should_stop=stop_after_two,
        )
        assert result.stopped_early is True
        assert "time budget reached" in result.stop_reason
        assert result.evaluated <= 3

    def test_it_reports_how_many_it_did_not_get_to(self, event_fixture):
        result = optimize(
            event_fixture.snapshot, event_fixture.state, Clock(14.0),
            budget=Budget(max_candidates=2),
        )
        assert "not evaluated" in result.stop_reason

    def test_a_completed_search_says_so(self, result):
        assert result.stopped_early is False
        assert result.stop_reason == "completed"

    def test_the_budget_is_echoed(self, result):
        assert result.as_dict()["budget"] == Budget().as_dict()

    def test_a_full_search_is_fast_enough_to_be_interactive(self, event_fixture):
        started = time.perf_counter()
        optimize(event_fixture.snapshot, event_fixture.state, Clock(14.0))
        elapsed = time.perf_counter() - started
        assert elapsed < 3.0, f"{elapsed:.2f}s for a 17-task workflow"


class TestOptimizationIsPure:
    def test_it_does_not_mutate_the_base(self, event_fixture):
        before = event_fixture.snapshot.content_hash()
        optimize(event_fixture.snapshot, event_fixture.state, Clock(14.0))
        assert event_fixture.snapshot.content_hash() == before

    def test_it_is_deterministic(self, event_fixture):
        a = optimize(event_fixture.snapshot, event_fixture.state, Clock(14.0))
        b = optimize(event_fixture.snapshot, event_fixture.state, Clock(14.0))
        assert [c.name for c in a.candidates] == [c.name for c in b.candidates]
        assert [c.score.total for c in a.candidates] == [
            c.score.total for c in b.candidates
        ]

    def test_the_base_is_evaluated_once_not_once_per_candidate(
        self, event_fixture, monkeypatch
    ):
        """N candidates must cost N+1 evaluations, not 2N."""
        import backend.app.core.optimization as opt

        calls = {"n": 0}
        real = opt.evaluate

        def counting(*args, **kwargs):
            calls["n"] += 1
            return real(*args, **kwargs)

        monkeypatch.setattr(opt, "evaluate", counting)
        result = opt.optimize(
            event_fixture.snapshot, event_fixture.state, Clock(14.0)
        )
        assert calls["n"] == result.evaluated + 1


# ---------------------------------------------------------------------------
# Through the API
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture(scope="module")
async def client():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c


class TestOptimizeApi:
    async def test_the_objectives_are_discoverable(self, client):
        r = await client.get(
            f"/api/projects/{EVENT_PROJECT_ID}/optimize/objectives"
        )
        assert r.status_code == 200
        body = r.json()
        assert len(body["criteria"]) == 6
        for criterion in body["criteria"]:
            assert criterion["better"] in ("lower", "higher")
            assert criterion["unit"] and criterion["describes"]

    async def test_optimize_returns_scored_candidates(self, client):
        r = await client.post(
            f"/api/projects/{MFG_PROJECT_ID}/optimize",
            json={"budget": {"max_candidates": 8, "max_seconds": 10}},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["candidates"]
        assert body["weights_total"] == pytest.approx(1.0)
        assert body["current"]["projected_end_day"] == 31.0
        for candidate in body["candidates"]:
            assert candidate["scores"]["criteria"]

    async def test_each_candidate_becomes_a_real_scenario(self, client):
        r = await client.post(
            f"/api/projects/{MFG_PROJECT_ID}/optimize",
            json={"budget": {"max_candidates": 3, "max_seconds": 10}},
        )
        body = r.json()
        scenario_id = body["candidates"][0]["scenario_id"]
        assert scenario_id

        # And it can be inspected and diffed through the existing endpoints -
        # there is no special path for an optimizer candidate.
        detail = await client.get(f"/api/scenarios/{scenario_id}")
        assert detail.status_code == 200
        assert detail.json()["origin"] == "heuristic_proposal"
        assert detail.json()["rationale"]

        diff = await client.get(f"/api/scenarios/{scenario_id}/diff")
        assert diff.status_code == 200
        assert diff.json()["base_unchanged"] is True

    async def test_the_recommendation_carries_its_scenario_id(self, client):
        r = await client.post(
            f"/api/projects/{MFG_PROJECT_ID}/optimize",
            json={"budget": {"max_candidates": 6, "max_seconds": 10}},
        )
        body = r.json()
        assert body["recommended_scenario_id"]
        assert body["recommended"]["scenario_id"] == body["recommended_scenario_id"]
        assert body["recommendation_reason"]

    async def test_custom_weights_are_honoured_and_echoed(self, client):
        r = await client.post(
            f"/api/projects/{MFG_PROJECT_ID}/optimize",
            json={
                "objectives": {"dependency_complexity": 1.0,
                               "expected_completion": 0.0},
                "budget": {"max_candidates": 8, "max_seconds": 10},
                "persist_candidates": False,
            },
        )
        weights = r.json()["weights"]
        assert weights["dependency_complexity"] == 1.0
        assert weights["expected_completion"] == 0.0

    async def test_the_budget_is_enforced_over_http(self, client):
        r = await client.post(
            f"/api/projects/{MFG_PROJECT_ID}/optimize",
            json={"budget": {"max_candidates": 2, "max_seconds": 10},
                  "persist_candidates": False},
        )
        body = r.json()
        assert body["evaluated"] == 2
        assert body["stopped_early"] is True
        assert body["elapsed_seconds"] < 10

    async def test_aggressive_mode_returns_the_refusal_over_http(self, client):
        r = await client.post(
            f"/api/projects/{MFG_PROJECT_ID}/optimize",
            json={"aggressive": True, "persist_candidates": False,
                  "budget": {"max_candidates": 40, "max_seconds": 20}},
        )
        assert r.status_code == 200
        body = r.json()
        refused = [
            c for c in body["rejected"]
            if any(v["constraint"] == "MANDATORY_TASK"
                   for v in c["constraint_violations"])
        ]
        assert refused
        violation = refused[0]["constraint_violations"][0]
        assert "UN38.3" in violation["constraint_reason"]

    async def test_a_recommended_candidate_can_be_applied(self, client):
        """No special path: an optimizer candidate is applied like any other
        scenario, and the parent version survives."""
        before = await client.get(f"/api/projects/{MFG_PROJECT_ID}/workflow")
        base_version = before.json()["version"]

        r = await client.post(
            f"/api/projects/{MFG_PROJECT_ID}/optimize",
            json={
                "objectives": {"dependency_complexity": 1.0},
                "budget": {"max_candidates": 10, "max_seconds": 15},
            },
        )
        scenario_id = r.json()["recommended_scenario_id"]
        assert scenario_id

        applied = await client.post(f"/api/scenarios/{scenario_id}/apply")
        assert applied.status_code == 200, applied.text
        body = applied.json()
        assert body["parent_version"]["unchanged"] is True
        assert body["new_version"]["parent_version_id"] == base_version["id"]

    async def test_an_unknown_project_is_404(self, client):
        r = await client.post(
            "/api/projects/00000000-0000-0000-0000-000000000099/optimize"
        )
        assert r.status_code == 404
