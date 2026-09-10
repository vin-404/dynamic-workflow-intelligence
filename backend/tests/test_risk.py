"""
Capability 2 tests - Layer A risk, and the refusal to invent a probability.

The brief's list: the factor decomposition sums to the reported score; a
tight-slack high-fan-out task outranks an abundant-slack one; and no
probability language appears anywhere in P0 output.
"""
from __future__ import annotations

import json

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from backend.app.core.engine import evaluate
from backend.app.core.engine.feasibility import three_point_range
from backend.app.core.engine.graph import build_graph_from_snapshot
from backend.app.core.engine.risk import (
    SCORE_KIND,
    RiskWeights,
    score_tasks,
)
from backend.app.core.workflow import (
    AssignmentSpec,
    Clock,
    DependencySpec,
    ResourceSpec,
    TaskSpec,
    WorkflowSnapshot,
    WorkflowState,
)
from backend.app.main import app

EVENT_PROJECT_ID = "00000000-0000-0000-0000-000000000001"
MFG_PROJECT_ID = "00000000-0000-0000-0000-000000000002"


@pytest.fixture
def risks(event_fixture):
    return evaluate(
        event_fixture.snapshot, event_fixture.state,
        Clock(event_fixture.today_day),
    ).risk


# ---------------------------------------------------------------------------
# Decomposition
# ---------------------------------------------------------------------------


class TestDecomposition:
    """"Never emit a bare numeric score" applies to risk as much as to
    findings."""

    def test_the_factors_sum_to_the_reported_score(self, risks):
        for task in risks["tasks"]:
            total = sum(f["contribution"] for f in task["factors"])
            assert task["score"] == pytest.approx(total, abs=1e-3), (
                f"{task['task_key']} score does not equal its factor sum"
            )

    def test_each_contribution_is_weight_times_value(self, risks):
        for task in risks["tasks"]:
            for factor in task["factors"]:
                assert factor["contribution"] == pytest.approx(
                    factor["weight"] * factor["value"], abs=1e-4
                )

    def test_every_task_reports_all_nine_factors(self, risks):
        expected = {
            "slack_ratio", "downstream_fan_out", "criticality_proximity",
            "deadline_pressure", "resource_pressure", "duration_uncertainty",
            "predecessor_health", "remaining_chain_depth", "assignment_gap",
        }
        for task in risks["tasks"]:
            assert {f["name"] for f in task["factors"]} == expected

    def test_every_factor_carries_a_reason_and_its_evidence(self, risks):
        for task in risks["tasks"]:
            for factor in task["factors"]:
                assert factor["reason"], f"{factor['name']} has no reason"
                assert factor["evidence"], f"{factor['name']} has no evidence"

    def test_every_factor_value_is_normalised(self, risks):
        for task in risks["tasks"]:
            for factor in task["factors"]:
                assert 0.0 <= factor["value"] <= 1.0

    def test_the_score_lands_on_a_zero_to_one_scale(self, risks):
        for task in risks["tasks"]:
            assert 0.0 <= task["score"] <= 1.0

    def test_the_default_weights_sum_to_one(self):
        assert RiskWeights().total == pytest.approx(1.0)

    def test_the_weights_are_echoed_in_the_response(self, risks):
        echoed = risks["assumptions"]["weights"]
        assert echoed == RiskWeights().as_dict()
        assert risks["assumptions"]["weights_total"] == pytest.approx(1.0)

    def test_the_formula_is_published(self, risks):
        assert risks["assumptions"]["formula"] == "risk = sum(weight_i * factor_i)"

    def test_the_explanation_names_the_top_factors(self, risks):
        for task in risks["tasks"]:
            assert task["explanation"]
            for name in task["top_factors"]:
                assert name.replace("_", " ") in task["explanation"]


# ---------------------------------------------------------------------------
# Does it rank the right things?
# ---------------------------------------------------------------------------


def _two_task_workflow(slack_effort: float, fan_out: int) -> WorkflowSnapshot:
    """A tight critical task with fan-out, and a slack task with none."""
    tasks = [
        TaskSpec(key="TIGHT", name="Tight", effort=4.0),
        TaskSpec(key="SLACKY", name="Slacky", effort=1.0),
        TaskSpec(key="LONG", name="Long", effort=slack_effort),
        TaskSpec(key="END", name="End", effort=1.0),
    ] + [
        TaskSpec(key=f"D{i}", name=f"Down {i}", effort=1.0)
        for i in range(fan_out)
    ]
    deps = [
        DependencySpec(from_task="TIGHT", to_task="END"),
        DependencySpec(from_task="SLACKY", to_task="END"),
        DependencySpec(from_task="LONG", to_task="TIGHT"),
    ] + [
        DependencySpec(from_task="TIGHT", to_task=f"D{i}")
        for i in range(fan_out)
    ] + [
        DependencySpec(from_task=f"D{i}", to_task="END") for i in range(fan_out)
    ]
    return WorkflowSnapshot.build(tasks=tasks, dependencies=deps)


class TestRanking:
    def test_tight_slack_and_high_fan_out_outranks_abundant_slack(self):
        """The brief's named assertion."""
        snapshot = _two_task_workflow(slack_effort=6.0, fan_out=3)
        result = evaluate(snapshot, WorkflowState.empty(snapshot), Clock(0.0))
        scores = {t["task_key"]: t["score"] for t in result.risk["tasks"]}
        assert scores["TIGHT"] > scores["SLACKY"], scores

    def test_the_tight_task_is_driven_by_slack_and_fan_out(self):
        snapshot = _two_task_workflow(slack_effort=6.0, fan_out=3)
        result = evaluate(snapshot, WorkflowState.empty(snapshot), Clock(0.0))
        tight = next(
            t for t in result.risk["tasks"] if t["task_key"] == "TIGHT"
        )
        assert "slack_ratio" in tight["top_factors"]
        assert "downstream_fan_out" in tight["top_factors"]

    def test_more_downstream_work_raises_the_score(self):
        low = evaluate(
            s := _two_task_workflow(6.0, 1), WorkflowState.empty(s), Clock(0.0)
        )
        high = evaluate(
            t := _two_task_workflow(6.0, 5), WorkflowState.empty(t), Clock(0.0)
        )
        score_low = next(
            x for x in low.risk["tasks"] if x["task_key"] == "TIGHT"
        )["score"]
        score_high = next(
            x for x in high.risk["tasks"] if x["task_key"] == "TIGHT"
        )["score"]
        assert score_high > score_low

    def test_an_unassigned_critical_task_scores_the_assignment_gap(self):
        snapshot = _two_task_workflow(6.0, 2)
        result = evaluate(snapshot, WorkflowState.empty(snapshot), Clock(0.0))
        tight = next(
            t for t in result.risk["tasks"] if t["task_key"] == "TIGHT"
        )
        gap = next(
            f for f in tight["factors"] if f["name"] == "assignment_gap"
        )
        assert gap["value"] == 1.0
        assert "critical path" in gap["reason"]

    def test_assigning_someone_removes_the_assignment_gap(self):
        base = _two_task_workflow(6.0, 2)
        assigned = base.evolve(
            resources=(ResourceSpec(key="p", name="Pat"),),
            assignments=tuple(
                AssignmentSpec(task_key=k, resource_key="p")
                for k in base.task_keys
            ),
        )
        result = evaluate(assigned, WorkflowState.empty(assigned), Clock(0.0))
        for task in result.risk["tasks"]:
            gap = next(
                f for f in task["factors"] if f["name"] == "assignment_gap"
            )
            assert gap["value"] == 0.0

    def test_results_are_ranked_highest_first(self, risks):
        scores = [t["score"] for t in risks["tasks"]]
        assert scores == sorted(scores, reverse=True)

    def test_moving_a_weight_moves_the_ranking(self, event_fixture):
        """Weights are inputs, and the point of exposing them is that a user
        can disagree with them (ARCHITECTURE H, risk #5)."""
        default = evaluate(
            event_fixture.snapshot, event_fixture.state, Clock(14.0)
        ).risk
        fan_out_only = evaluate(
            event_fixture.snapshot, event_fixture.state, Clock(14.0),
            weights=RiskWeights(
                slack_ratio=0.0, downstream_fan_out=1.0,
                criticality_proximity=0.0, deadline_pressure=0.0,
                resource_pressure=0.0, duration_uncertainty=0.0,
                predecessor_health=0.0, remaining_chain_depth=0.0,
                assignment_gap=0.0,
            ),
        ).risk
        assert (
            [t["task_key"] for t in default["tasks"]]
            != [t["task_key"] for t in fan_out_only["tasks"]]
        )
        # And the response says which weights produced it.
        assert fan_out_only["assumptions"]["weights"]["downstream_fan_out"] == 1.0


class TestUnavailableFactorsSaySo:
    """A factor that cannot be measured contributes 0 and admits it, rather
    than being guessed at."""

    def test_predecessor_health_is_unavailable_without_history(self, mfg_fixture):
        result = evaluate(mfg_fixture.snapshot, mfg_fixture.state, Clock(0.0))
        for task in result.risk["tasks"]:
            factor = next(
                f for f in task["factors"] if f["name"] == "predecessor_health"
            )
            assert factor["available"] is False
            assert factor["value"] == 0.0
            assert "no status history" in factor["reason"]

    def test_deadline_pressure_is_unavailable_without_a_deadline(self, event_fixture):
        snapshot = event_fixture.snapshot.evolve(deadline_day=None)
        result = evaluate(snapshot, event_fixture.state, Clock(14.0))
        for task in result.risk["tasks"]:
            factor = next(
                f for f in task["factors"] if f["name"] == "deadline_pressure"
            )
            assert factor["available"] is False
            assert factor["value"] == 0.0

    def test_the_assumptions_list_which_factors_were_unavailable(
        self, mfg_fixture
    ):
        result = evaluate(mfg_fixture.snapshot, mfg_fixture.state, Clock(0.0))
        assert "predecessor_health" in (
            result.risk["assumptions"]["factors_unavailable"]
        )

    def test_predecessor_health_fires_once_there_is_history(self, event_fixture):
        result = evaluate(
            event_fixture.snapshot, event_fixture.state, Clock(14.0)
        )
        t13 = next(t for t in result.risk["tasks"] if t["task_key"] == "T13")
        factor = next(
            f for f in t13["factors"] if f["name"] == "predecessor_health"
        )
        assert factor["available"] is True
        assert factor["value"] > 0
        assert "T03" in factor["reason"]


# ---------------------------------------------------------------------------
# Honesty about what this number is
# ---------------------------------------------------------------------------


class TestItIsNotAProbability:
    def test_the_score_is_labelled_a_structural_estimate(self, risks):
        assert risks["assumptions"]["score_kind"] == SCORE_KIND == (
            "structural_estimate"
        )
        for task in risks["tasks"]:
            assert task["score_kind"] == "structural_estimate"

    def test_the_disclaimer_says_what_it_is_not(self, risks):
        disclaimer = risks["assumptions"]["disclaimer"]
        assert "not a probability" in disclaimer
        assert "does not say how likely" in disclaimer

    def test_the_assumptions_name_the_spread_and_its_provenance(self, risks):
        spread = risks["assumptions"]["duration_spread"]
        assert spread["provenance"] in (
            "historical", "domain_prior", "default", "three_point_estimate"
        )
        assert spread["relative_spread"] > 0
        assert isinstance(spread["tasks_using_spread_prior"], list)

    def test_the_assumptions_state_what_is_not_modelled(self, risks):
        assumptions = risks["assumptions"]
        assert assumptions["rework_modelled"] is False
        assert assumptions["monte_carlo_run"] is False

    def test_it_says_what_would_make_it_a_probability(self, risks):
        text = risks["assumptions"]["what_would_make_this_a_probability"]
        assert "criticality index" in text
        assert "historical variance" in text

    def test_no_numeric_field_is_named_like_a_likelihood(self, risks):
        suspicious = ("probability", "likelihood", "confidence", "odds",
                      "success_rate", "p_deadline")

        def walk(node, path=""):
            if isinstance(node, dict):
                for key, value in node.items():
                    if any(w in key.lower() for w in suspicious):
                        assert isinstance(value, (str, bool, type(None))), (
                            f"{path}.{key} presents a number as a likelihood"
                        )
                    walk(value, f"{path}.{key}")
            elif isinstance(node, list):
                for i, item in enumerate(node):
                    walk(item, f"{path}[{i}]")

        walk(risks)


class TestThreePointRange:
    @pytest.fixture
    def three_point(self, event_fixture):
        return evaluate(
            event_fixture.snapshot, event_fixture.state, Clock(14.0)
        ).feasibility.three_point

    def test_it_reports_three_deterministic_runs(self, three_point):
        assert three_point["optimistic_day"] < three_point["likely_day"]
        assert three_point["likely_day"] < three_point["pessimistic_day"]
        assert three_point["spread_days"] == pytest.approx(
            three_point["pessimistic_day"] - three_point["optimistic_day"]
        )

    def test_the_likely_run_is_the_headline_projection(self, event_fixture):
        """Otherwise the middle of the range is a fourth number nobody can
        reconcile with the one on screen."""
        result = evaluate(event_fixture.snapshot, event_fixture.state, Clock(14.0))
        assert result.feasibility.three_point["likely_day"] == (
            result.projected_end
        )

    def test_each_run_gets_its_own_verdict(self, three_point):
        assert three_point["verdicts"]["likely"] == "infeasible"
        assert set(three_point["verdicts"]) == {
            "optimistic", "likely", "pessimistic"
        }

    def test_it_is_not_a_probability_and_says_so(self, three_point):
        assert three_point["is_probability"] is False
        assert "not a distribution" in three_point["method"]

    def test_the_monte_carlo_seam_is_empty_not_faked(self, three_point):
        mc = three_point["monte_carlo"]
        assert mc["available"] is False
        assert "calibrated distributions" in mc["why"]
        assert "criticality index" in mc["what_it_would_report"]
        assert "looks like evidence and is not" in mc["why_not_faked"]

    def test_it_states_the_independence_assumption(self, three_point):
        assumptions = three_point["assumptions"]
        assert assumptions["durations_sampled_independently"] is False
        assert "correlate" in assumptions["note"]

    def test_the_statement_quotes_the_range_in_days(self, event_fixture):
        result = evaluate(event_fixture.snapshot, event_fixture.state, Clock(14.0))
        text = result.feasibility.statement
        assert "infeasible by 2 days" in text
        assert "day 20 to day 32" in text
        assert "%" not in text

    def test_a_workflow_with_three_point_estimates_uses_them(self):
        snapshot = WorkflowSnapshot.build(
            tasks=(
                TaskSpec(key="A", name="A", effort=4.0,
                         optimistic=2.0, likely=4.0, pessimistic=12.0),
                TaskSpec(key="B", name="B", effort=2.0),
            ),
            dependencies=(DependencySpec(from_task="A", to_task="B"),),
        )
        result = evaluate(snapshot, WorkflowState.empty(snapshot), Clock(0.0))
        tp = result.feasibility.three_point
        assert "A" in tp["assumptions"]["tasks_with_three_point_estimate"]
        assert "B" in tp["assumptions"]["tasks_using_spread_prior"]
        # A's own wide spread dominates the range.
        assert tp["pessimistic_day"] >= 12.0

    def test_a_task_with_an_estimate_reports_its_own_provenance(self):
        snapshot = WorkflowSnapshot.build(
            tasks=(
                TaskSpec(key="A", name="A", effort=4.0,
                         optimistic=3.0, likely=4.0, pessimistic=5.0),
            ),
        )
        result = evaluate(snapshot, WorkflowState.empty(snapshot), Clock(0.0))
        factor = next(
            f for f in result.risk["tasks"][0]["factors"]
            if f["name"] == "duration_uncertainty"
        )
        assert factor["evidence"]["provenance"] == "three_point_estimate"
        assert factor["available"] is True


# ---------------------------------------------------------------------------
# Purity and cost
# ---------------------------------------------------------------------------


class TestRiskIsPureAndCheap:
    def test_scoring_does_not_mutate_the_snapshot(self, event_fixture):
        before = event_fixture.snapshot.content_hash()
        evaluate(event_fixture.snapshot, event_fixture.state, Clock(14.0))
        assert event_fixture.snapshot.content_hash() == before

    def test_scoring_is_deterministic(self, event_fixture):
        a = evaluate(event_fixture.snapshot, event_fixture.state, Clock(14.0)).risk
        b = evaluate(event_fixture.snapshot, event_fixture.state, Clock(14.0)).risk
        assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)

    def test_it_works_on_a_cold_start_workflow(self, mfg_fixture):
        result = evaluate(mfg_fixture.snapshot, mfg_fixture.state, Clock(0.0))
        assert len(result.risk["tasks"]) == 12
        assert result.risk["band_counts"]["high"] > 0

    def test_it_works_on_an_empty_workflow(self):
        snapshot = WorkflowSnapshot.build(tasks=())
        result = evaluate(snapshot)
        assert result.risk["tasks"] == []
        assert result.risk["band_counts"] == {"high": 0, "moderate": 0, "low": 0}

    def test_score_tasks_can_be_called_directly_with_a_schedule(
        self, event_fixture
    ):
        from backend.app.core.engine.cpm import schedule
        from backend.app.core.engine.effort import planned_durations

        snapshot = event_fixture.snapshot
        G = build_graph_from_snapshot(snapshot)
        durations, _ = planned_durations(snapshot)
        risks, assumptions = score_tasks(
            snapshot, event_fixture.state, Clock(14.0), schedule(G, durations)
        )
        assert len(risks) == 17
        assert assumptions["score_kind"] == "structural_estimate"


# ---------------------------------------------------------------------------
# Through the API
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture(scope="module")
async def client():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c


class TestRiskApi:
    async def test_the_risk_endpoint_returns_the_decomposition(self, client):
        r = await client.get(f"/api/projects/{EVENT_PROJECT_ID}/risk")
        assert r.status_code == 200
        body = r.json()
        assert len(body["tasks"]) == 17
        for task in body["tasks"]:
            assert task["score"] == pytest.approx(
                sum(f["contribution"] for f in task["factors"]), abs=1e-3
            )

    async def test_it_returns_calendar_dates_for_the_range(self, client):
        r = await client.get(f"/api/projects/{EVENT_PROJECT_ID}/risk")
        dates = r.json()["three_point_dates"]
        assert dates["optimistic"] < dates["likely"] < dates["pessimistic"]

    async def test_custom_weights_are_honoured_and_echoed(self, client):
        r = await client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/risk",
            json={"weights": {"downstream_fan_out": 0.9, "slack_ratio": 0.1}},
        )
        assert r.status_code == 200
        echoed = r.json()["assumptions"]["weights"]
        assert echoed["downstream_fan_out"] == 0.9
        assert echoed["slack_ratio"] == 0.1

    async def test_bands_come_from_the_engine_under_custom_weights(self, client):
        """The band on every task is `_band(score)` from the engine.

        The risk stage used to re-band in the browser with its own copy of
        the thresholds, and the copy drifted (0.6 / 0.35 against the engine's
        0.55 / 0.30), so a score of 0.57 read "moderate" there and "high"
        here. The UI now asks this endpoint instead; this pins the contract
        it relies on, at the scores the drifted copy would have got wrong.
        """
        from backend.app.core.engine.risk import _band

        assert _band(0.57) == "high"
        assert _band(0.32) == "moderate"
        assert _band(0.29) == "low"

        r = await client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/risk",
            json={"weights": {"slack_ratio": 0.9}},
        )
        assert r.status_code == 200
        body = r.json()
        for task in body["tasks"]:
            assert task["band"] == _band(task["score"]), task["task_key"]
        counted = {
            band: sum(1 for t in body["tasks"] if t["band"] == band)
            for band in ("high", "moderate", "low")
        }
        assert body["band_counts"] == counted
        assert body["assumptions"]["weights"]["slack_ratio"] == 0.9

    async def test_risk_travels_with_the_analysis_payload_too(self, client):
        r = await client.post(f"/api/projects/{EVENT_PROJECT_ID}/analyze")
        assert r.json()["risk"]["tasks"]

    async def test_the_cold_start_project_still_gets_risk(self, client):
        r = await client.get(f"/api/projects/{MFG_PROJECT_ID}/risk")
        assert r.status_code == 200
        body = r.json()
        assert body["tier_reached"] == 0
        assert len(body["tasks"]) == 12
        assert "predecessor_health" in body["assumptions"]["factors_unavailable"]

    async def test_an_unknown_project_is_404(self, client):
        r = await client.get(
            "/api/projects/00000000-0000-0000-0000-000000000099/risk"
        )
        assert r.status_code == 404


class TestTheArithmeticOnScreen:
    """The product's claim is "add the column up yourself". So the column on
    screen has to add up - not to within floating-point noise, exactly."""

    def _serialised(self, fixture):
        result = evaluate(fixture.snapshot, fixture.state, Clock(fixture.today_day))
        return result.risk["tasks"]

    def test_the_displayed_score_is_the_sum_of_the_displayed_factors(
        self, event_fixture
    ):
        for task in self._serialised(event_fixture):
            total = sum(f["contribution"] for f in task["factors"])
            assert round(total, 4) == task["score"], (
                f"{task['task_key']}: factors sum to {total}, score shows "
                f"{task['score']} - a reader adding these up gets a different "
                f"number from the headline"
            )

    def test_it_holds_in_the_other_domain_too(self, mfg_fixture):
        for task in self._serialised(mfg_fixture):
            total = sum(f["contribution"] for f in task["factors"])
            assert round(total, 4) == task["score"]

    def test_the_rounded_score_still_tracks_the_unrounded_one(
        self, event_fixture
    ):
        """Rounding for display must not drift from the value the ranking
        used - half a thousandth, not a different number."""
        for task in self._serialised(event_fixture):
            exact = sum(f["value"] * f["weight"] for f in task["factors"])
            assert abs(task["score"] - exact) < 5e-4
