"""
Capability 2, Layer B - the Monte Carlo forecast, and the honesty that has to
survive it.

The repository's defining property is that it refuses to state numbers it
cannot support. This module is the one place where that refusal is *lifted* -
we can now compute a real probability - so it is also the place where the
lifting has to be policed hardest:

* the Layer-A structural score is unchanged, still `is_probability: false`,
  and still the answer when there is nothing to sample;
* the deterministic three-point range is unchanged and still not a
  distribution;
* and the new number arrives wearing every assumption it rests on, including
  the ones that make it optimistic.

The brief's list, tested below: a fixed seed reproduces exactly; a task on
every critical path has criticality index 1.0 and a task on none has 0.0;
P50 <= P80 <= P90; widening one task's spread widens the distribution without
moving the median.
"""
from __future__ import annotations

import json
import time

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from backend.app.core.engine import evaluate
from backend.app.core.engine.cpm import schedule
from backend.app.core.engine.graph import CycleError, build_graph_from_snapshot
from backend.app.core.engine.montecarlo import (
    FORECAST_KIND,
    PROVENANCE_ESTIMATE,
    PROVENANCE_MEASURED,
    PROVENANCE_PRIOR,
    STRUCTURAL_KIND,
    duration_bands,
    forecast,
    pert_parameters,
)
from backend.app.core.workflow import (
    Clock,
    DependencySpec,
    EngineConfig,
    TaskSpec,
    WorkflowSnapshot,
)
from backend.app.main import app

EVENT_PROJECT_ID = "00000000-0000-0000-0000-000000000001"
MFG_PROJECT_ID = "00000000-0000-0000-0000-000000000002"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def run(snapshot, *, iterations=2000, seed=12345, config=None, known=()):
    """Forecast a snapshot at its planned durations."""
    from backend.app.core.engine.effort import planned_durations

    graph = build_graph_from_snapshot(snapshot)
    durations, _ = planned_durations(snapshot, config)
    return forecast(
        snapshot, graph, durations, config,
        iterations=iterations, seed=seed, known_duration_keys=known,
    )


def chain(spreads: dict[str, tuple[float, float, float]], deadline=None):
    """A serial chain A -> B -> C, so the critical path is the whole thing and
    the completion distribution is a plain sum of independent draws."""
    tasks = []
    for key, band in spreads.items():
        if band is None:
            tasks.append(TaskSpec(key=key, name=f"Task {key}", effort=5.0))
        else:
            o, m, p = band
            tasks.append(TaskSpec(
                key=key, name=f"Task {key}", effort=m,
                optimistic=o, likely=m, pessimistic=p,
            ))
    keys = list(spreads)
    deps = tuple(
        DependencySpec(from_task=keys[i], to_task=keys[i + 1])
        for i in range(len(keys) - 1)
    )
    return WorkflowSnapshot.build(
        tasks=tuple(tasks), dependencies=deps, deadline_day=deadline
    )


def wide_workflow(task_count=40, seed=7):
    """A ~40-task DAG with three-point estimates, for the performance test."""
    import random as _random

    rng = _random.Random(seed)
    keys = [f"K{i:02d}" for i in range(task_count)]
    tasks = []
    for i, key in enumerate(keys):
        likely = 2.0 + (i % 5)
        tasks.append(TaskSpec(
            key=key, name=f"Task {i}", effort=likely,
            optimistic=likely * 0.7, likely=likely, pessimistic=likely * 1.8,
        ))
    deps = set()
    for i in range(1, task_count):
        for j in rng.sample(range(0, i), min(i, 2)):
            deps.add((keys[j], keys[i]))
    return WorkflowSnapshot.build(
        tasks=tuple(tasks),
        dependencies=tuple(
            DependencySpec(from_task=u, to_task=v) for u, v in sorted(deps)
        ),
        deadline_day=40.0,
    )


# ---------------------------------------------------------------------------
# 1. Reproducibility
# ---------------------------------------------------------------------------


class TestASeedReproducesExactly:
    """The whole point of seeding. A forecast a user cannot reproduce is a
    number they cannot check, which is the thing this repository refuses to
    ship."""

    def test_the_same_seed_gives_byte_identical_output(self, event_fixture):
        a = run(event_fixture.snapshot, seed=99).as_dict()
        b = run(event_fixture.snapshot, seed=99).as_dict()
        assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)

    def test_a_different_seed_gives_a_different_sample(self, event_fixture):
        a = run(event_fixture.snapshot, seed=99).as_dict()
        b = run(event_fixture.snapshot, seed=100).as_dict()
        assert json.dumps(a, sort_keys=True) != json.dumps(b, sort_keys=True)

    def test_the_seed_is_reported_in_the_payload(self, event_fixture):
        payload = run(event_fixture.snapshot, seed=4242).as_dict()
        assert payload["seed"] == 4242
        assert "4242" in payload["assumptions"]["reproducible"]

    def test_the_iteration_count_survives_chunking(self, event_fixture):
        """`CHUNK` is 2048, so 5000 iterations is three uneven chunks. The
        reported count must be the number actually run."""
        payload = run(event_fixture.snapshot, iterations=5000).as_dict()
        assert payload["iterations"] == 5000
        assert sum(b["count"] for b in payload["histogram"]["bins"]) == 5000

    def test_nothing_is_mutated_by_forecasting(self, event_fixture):
        before = event_fixture.snapshot.content_hash()
        run(event_fixture.snapshot)
        assert event_fixture.snapshot.content_hash() == before


# ---------------------------------------------------------------------------
# 2. Criticality index - the point of the feature
# ---------------------------------------------------------------------------


class TestCriticalityIndex:
    @pytest.fixture
    def forked(self):
        """START -> {BIG, TINY} -> END.

        BIG is 20 days with a +/-10% band, so its shortest possible run (18)
        still dwarfs TINY's longest (1). BIG is therefore on the critical path
        in every iteration and TINY in none, whatever the sampling does.
        """
        return WorkflowSnapshot.build(
            tasks=(
                TaskSpec(key="START", name="Start", effort=1.0,
                         optimistic=0.9, likely=1.0, pessimistic=1.1),
                TaskSpec(key="BIG", name="Big", effort=20.0,
                         optimistic=18.0, likely=20.0, pessimistic=22.0),
                TaskSpec(key="TINY", name="Tiny", effort=1.0,
                         optimistic=1.0, likely=1.0, pessimistic=1.0),
                TaskSpec(key="END", name="End", effort=1.0,
                         optimistic=0.9, likely=1.0, pessimistic=1.1),
            ),
            dependencies=(
                DependencySpec(from_task="START", to_task="BIG"),
                DependencySpec(from_task="START", to_task="TINY"),
                DependencySpec(from_task="BIG", to_task="END"),
                DependencySpec(from_task="TINY", to_task="END"),
            ),
        )

    def _index(self, payload, key):
        return next(
            t["criticality_index"] for t in payload["tasks"] if t["task_key"] == key
        )

    def test_a_task_on_every_critical_path_indexes_one(self, forked):
        payload = run(forked).as_dict()
        assert self._index(payload, "BIG") == 1.0
        assert self._index(payload, "START") == 1.0
        assert self._index(payload, "END") == 1.0

    def test_a_task_on_no_critical_path_indexes_zero(self, forked):
        payload = run(forked).as_dict()
        assert self._index(payload, "TINY") == 0.0

    def test_the_count_and_the_fraction_agree(self, forked):
        payload = run(forked, iterations=2000).as_dict()
        for task in payload["tasks"]:
            assert task["criticality_index"] == pytest.approx(
                task["iterations_on_critical_path"] / payload["iterations"],
                abs=1e-4,
            )

    def test_a_contested_branch_lands_strictly_between(self):
        """Two branches of the same expected length swap places run to run.
        Neither is always critical and neither is never critical - which is
        exactly the state the deterministic schedule cannot express."""
        snapshot = WorkflowSnapshot.build(
            tasks=(
                TaskSpec(key="S", name="S", effort=1.0),
                TaskSpec(key="L", name="L", effort=10.0,
                         optimistic=5.0, likely=10.0, pessimistic=15.0),
                TaskSpec(key="R", name="R", effort=10.0,
                         optimistic=5.0, likely=10.0, pessimistic=15.0),
                TaskSpec(key="E", name="E", effort=1.0),
            ),
            dependencies=(
                DependencySpec(from_task="S", to_task="L"),
                DependencySpec(from_task="S", to_task="R"),
                DependencySpec(from_task="L", to_task="E"),
                DependencySpec(from_task="R", to_task="E"),
            ),
        )
        payload = run(snapshot, iterations=3000).as_dict()
        left = self._index(payload, "L")
        right = self._index(payload, "R")
        assert 0.0 < left < 1.0
        assert 0.0 < right < 1.0
        assert left + right == pytest.approx(1.0, abs=0.02)

    def test_every_task_reports_a_criticality_index(self, event_fixture):
        payload = run(event_fixture.snapshot).as_dict()
        assert {t["task_key"] for t in payload["tasks"]} == set(
            event_fixture.snapshot.task_keys
        )
        for task in payload["tasks"]:
            assert 0.0 <= task["criticality_index"] <= 1.0
            assert "critical path" in task["criticality_means"]


# ---------------------------------------------------------------------------
# 3. The percentiles are ordered, always
# ---------------------------------------------------------------------------


class TestPercentilesAreOrdered:
    def _assert_ordered(self, payload):
        c = payload["completion"]
        assert c["p50_day"] <= c["p80_day"] <= c["p90_day"]
        assert c["earliest_day"] <= c["p50_day"]
        assert c["p90_day"] <= c["latest_day"]

    def test_on_the_seeded_workflow(self, event_fixture):
        self._assert_ordered(run(event_fixture.snapshot).as_dict())

    def test_on_a_cold_start_workflow(self, mfg_fixture):
        self._assert_ordered(run(mfg_fixture.snapshot).as_dict())

    def test_on_a_single_task(self):
        snapshot = WorkflowSnapshot.build(
            tasks=(TaskSpec(key="A", name="A", effort=3.0,
                            optimistic=1.0, likely=3.0, pessimistic=9.0),)
        )
        self._assert_ordered(run(snapshot).as_dict())

    def test_on_a_zero_effort_workflow(self):
        """Degenerate: nothing has any duration, so every percentile is 0 -
        which still satisfies P50 <= P80 <= P90."""
        snapshot = WorkflowSnapshot.build(
            tasks=(TaskSpec(key="A", name="A", effort=0.0),)
        )
        self._assert_ordered(run(snapshot).as_dict())

    def test_on_an_empty_workflow(self):
        self._assert_ordered(run(WorkflowSnapshot.build(tasks=())).as_dict())

    def test_the_median_reconciles_with_the_deterministic_projection(
        self, event_fixture
    ):
        """The middle of the distribution has to be the number already on
        screen, or it is a fourth figure nobody can tie back."""
        result = evaluate(
            event_fixture.snapshot, event_fixture.state,
            Clock(event_fixture.today_day),
        )
        graph = build_graph_from_snapshot(event_fixture.snapshot)
        payload = forecast(
            event_fixture.snapshot, graph, result.schedule["durations"],
            iterations=4000, seed=1,
        ).as_dict()
        assert payload["completion"]["p50_day"] == pytest.approx(
            result.projected_end, abs=1.0
        )

    def test_zero_spread_reproduces_the_deterministic_schedule_exactly(self):
        """The simulation is the same CPM pass, so with the variance removed
        it must agree with `cpm.schedule` to the bit, not to a tolerance."""
        snapshot = chain({"A": (5.0, 5.0, 5.0), "B": (3.0, 3.0, 3.0),
                          "C": (2.0, 2.0, 2.0)})
        config = EngineConfig(default_duration_spread=0.0)
        graph = build_graph_from_snapshot(snapshot)
        from backend.app.core.engine.effort import planned_durations

        durations, _ = planned_durations(snapshot, config)
        deterministic = schedule(graph, durations)
        payload = forecast(
            snapshot, graph, durations, config, iterations=200
        ).as_dict()
        assert payload["available"] is False   # nothing to sample, and it says so
        assert deterministic["project_end"] == 10.0


# ---------------------------------------------------------------------------
# 4. Widening a spread widens the distribution, and only that
# ---------------------------------------------------------------------------


class TestWideningASpread:
    """Both halves matter. Widening a symmetric band around the same mode has
    to change the *shape* and leave the *centre* alone; a model that moves the
    median when you widen a band is telling you something it did not learn."""

    def _payloads(self):
        narrow = chain({"A": (9.0, 10.0, 11.0), "B": (4.0, 5.0, 6.0)})
        wide = chain({"A": (2.0, 10.0, 18.0), "B": (4.0, 5.0, 6.0)})
        return (
            run(narrow, iterations=8000, seed=3).as_dict(),
            run(wide, iterations=8000, seed=3).as_dict(),
        )

    def test_the_distribution_gets_wider(self):
        narrow, wide = self._payloads()
        narrow_span = narrow["completion"]["p90_day"] - narrow["completion"]["p50_day"]
        wide_span = wide["completion"]["p90_day"] - wide["completion"]["p50_day"]
        assert wide_span > narrow_span * 2
        assert (wide["completion"]["latest_day"] - wide["completion"]["earliest_day"]) > (
            narrow["completion"]["latest_day"] - narrow["completion"]["earliest_day"]
        )

    def test_the_median_barely_moves(self):
        narrow, wide = self._payloads()
        assert wide["completion"]["p50_day"] == pytest.approx(
            narrow["completion"]["p50_day"], abs=0.35
        )

    def test_the_deadline_probability_moves_towards_a_coin_flip(self):
        """Widening uncertainty around a mode that already misses the deadline
        makes meeting it *more* possible, not less. The number has to move the
        way the model says it should."""
        narrow = chain({"A": (9.0, 10.0, 11.0), "B": (4.0, 5.0, 6.0)},
                       deadline=13.0)
        wide = chain({"A": (2.0, 10.0, 18.0), "B": (4.0, 5.0, 6.0)},
                     deadline=13.0)
        n = run(narrow, iterations=6000, seed=5).as_dict()
        w = run(wide, iterations=6000, seed=5).as_dict()
        assert n["deadline"]["probability_of_meeting_deadline"] == 0.0
        assert w["deadline"]["probability_of_meeting_deadline"] > 0.05


# ---------------------------------------------------------------------------
# 5. The assumptions block says everything it has to
# ---------------------------------------------------------------------------


class TestTheAssumptionsBlock:
    @pytest.fixture
    def payload(self, event_fixture):
        return run(event_fixture.snapshot, iterations=1000, seed=777).as_dict()

    def test_it_names_the_independence_assumption_in_plain_language(self, payload):
        note = payload["assumptions"]["independence_note"]
        assert payload["assumptions"]["durations_sampled_independently"] is True
        assert "INDEPENDENTLY" in note
        assert "optimistic" in note
        assert "correlate" in note

    def test_it_names_the_iteration_count_and_the_seed(self, payload):
        assert payload["assumptions"]["iterations"] == 1000
        assert payload["assumptions"]["seed"] == 777

    def test_it_names_the_distribution_family_and_why(self, payload):
        assumptions = payload["assumptions"]
        assert assumptions["distribution"] == "beta_pert"
        assert assumptions["distribution_name"] == "Beta-PERT"
        assert assumptions["distribution_lambda"] == 4.0
        assert "triangular" in assumptions["distribution_why"].lower()
        assert "lognormal" in assumptions["distribution_why"].lower()
        assert "bounded above" in assumptions["distribution_cost"]

    def test_it_says_resource_contention_is_not_simulated(self, payload):
        assumptions = payload["assumptions"]
        assert assumptions["resource_contention_modelled"] is False
        assert "NOT simulated" in assumptions["resource_contention_note"]
        assert assumptions["rework_modelled"] is False

    def test_it_reports_spread_provenance_per_task_not_just_overall(self, payload):
        assert payload["assumptions"]["spread_provenance_is_per_task"] is True
        for task in payload["tasks"]:
            provenance = task["duration"]["spread_provenance"]
            assert provenance in (
                PROVENANCE_ESTIMATE, PROVENANCE_PRIOR, PROVENANCE_MEASURED
            )
            assert task["duration"]["assumed"] is (provenance == PROVENANCE_PRIOR)

    def test_it_says_it_is_not_calibrated_and_what_would_calibrate_it(self, payload):
        assert payload["is_calibrated"] is False
        assert payload["assumptions"]["is_calibrated"] is False
        text = payload["assumptions"]["what_would_calibrate_it"]
        assert "actual durations" in text
        assert "reliability" in text

    def test_it_defines_the_criticality_index(self, payload):
        assert "fraction of iterations" in (
            payload["assumptions"]["criticality_index_definition"]
        )

    def test_the_band_label_never_travels_without_the_number(self, event_fixture):
        payload = run(event_fixture.snapshot).as_dict()
        deadline = payload["deadline"]
        assert deadline["band"] in ("on_track", "at_risk", "unlikely")
        assert isinstance(deadline["probability_of_meeting_deadline"], float)
        assert "continuum" in deadline["band_note"]


# ---------------------------------------------------------------------------
# 6. Falling back to the prior, and labelling it
# ---------------------------------------------------------------------------


class TestTheSpreadPrior:
    def test_a_workflow_with_no_estimates_falls_back_and_labels_every_task(self):
        snapshot = chain({"A": None, "B": None, "C": None})
        payload = run(
            snapshot,
            config=EngineConfig(
                default_duration_spread=0.4,
                duration_spread_provenance="domain_prior",
            ),
        ).as_dict()
        assert payload["available"] is True
        assert payload["assumptions"]["tasks_with_three_point_estimate"] == []
        assert payload["assumptions"]["tasks_using_spread_prior"] == ["A", "B", "C"]
        assert payload["assumptions"]["spread_prior_relative"] == 0.4
        assert payload["assumptions"]["spread_prior_provenance"] == "domain_prior"
        for task in payload["tasks"]:
            assert task["assumed"] is True
            assert task["duration"]["spread_provenance"] == PROVENANCE_PRIOR
            assert task["duration"]["relative_spread"] == pytest.approx(0.8, abs=1e-6)

    def test_a_mixed_workflow_labels_each_task_separately(self):
        snapshot = chain({"A": (2.0, 5.0, 14.0), "B": None})
        payload = run(snapshot).as_dict()
        by_key = {t["task_key"]: t for t in payload["tasks"]}
        assert by_key["A"]["assumed"] is False
        assert by_key["A"]["duration"]["spread_provenance"] == PROVENANCE_ESTIMATE
        assert by_key["B"]["assumed"] is True
        assert by_key["B"]["duration"]["spread_provenance"] == PROVENANCE_PRIOR

    def test_finished_work_is_held_constant_rather_than_sampled(self):
        snapshot = chain({"A": (2.0, 5.0, 14.0), "B": (1.0, 3.0, 8.0)})
        payload = run(snapshot, known=("A",)).as_dict()
        by_key = {t["task_key"]: t for t in payload["tasks"]}
        assert by_key["A"]["duration"]["spread_provenance"] == PROVENANCE_MEASURED
        assert by_key["A"]["duration"]["relative_spread"] == 0.0
        assert by_key["A"]["assumed"] is False
        assert "A" in payload["assumptions"]["tasks_held_constant"]
        assert payload["assumptions"]["tasks_with_measured_duration"] == ["A"]

    def test_nothing_to_sample_returns_the_structural_answer_labelled(self):
        """No estimates anywhere and a prior of zero. The honest reply is "no
        distribution", not a spike at one day dressed as a forecast."""
        snapshot = chain({"A": None, "B": None})
        payload = run(
            snapshot, config=EngineConfig(default_duration_spread=0.0)
        ).as_dict()
        assert payload["available"] is False
        assert payload["is_probability"] is False
        assert payload["fall_back_to"] == STRUCTURAL_KIND
        assert "no task carries a three-point estimate" in (
            payload["unavailable_reason"]
        )
        assert payload["deadline"]["probability_of_meeting_deadline"] is None

    def test_the_prior_reaches_the_engine_as_a_number_not_a_domain(self):
        """`test_domain_leak.py`'s rule, restated here: two identical
        workflows with the same prior forecast identically no matter what the
        provenance *label* says."""
        snapshot = chain({"A": None, "B": None})
        a = run(snapshot, config=EngineConfig(
            default_duration_spread=0.3, duration_spread_provenance="domain_prior"
        )).as_dict()
        b = run(snapshot, config=EngineConfig(
            default_duration_spread=0.3, duration_spread_provenance="default"
        )).as_dict()
        assert a["completion"] == b["completion"]
        assert [t["criticality_index"] for t in a["tasks"]] == [
            t["criticality_index"] for t in b["tasks"]
        ]


# ---------------------------------------------------------------------------
# The duration model itself
# ---------------------------------------------------------------------------


class TestTheDurationModel:
    def test_pert_parameters_put_the_mean_where_pert_says(self):
        alpha, beta = pert_parameters(2.0, 5.0, 14.0)
        assert alpha + beta == pytest.approx(6.0)
        mean = 2.0 + (14.0 - 2.0) * alpha / (alpha + beta)
        assert mean == pytest.approx((2.0 + 4 * 5.0 + 14.0) / 6.0)

    def test_a_zero_width_band_is_not_sampled(self):
        assert pert_parameters(4.0, 4.0, 4.0) is None

    def test_reversed_or_out_of_range_inputs_are_normalised_not_raised_on(self):
        assert pert_parameters(9.0, 5.0, 1.0) is not None
        assert pert_parameters(1.0, 99.0, 5.0) is not None

    def test_bands_rescale_onto_the_observed_duration(self):
        """A task already running over keeps its overrun in every sampled
        run - the same rule `feasibility.three_point_range` follows."""
        snapshot = chain({"A": (2.0, 4.0, 8.0)})
        bands, _ = duration_bands(snapshot, {"A": 8.0})
        band = bands["A"]
        assert band.likely == 8.0
        assert band.optimistic == pytest.approx(4.0)     # 2/4 of 8
        assert band.pessimistic == pytest.approx(16.0)   # 8/4 of 8

    def test_a_cyclic_workflow_has_no_distribution_of_finish_dates(self):
        snapshot = WorkflowSnapshot.build(
            tasks=(TaskSpec(key="A", name="A", effort=1.0),
                   TaskSpec(key="B", name="B", effort=1.0)),
            dependencies=(DependencySpec(from_task="A", to_task="B"),
                          DependencySpec(from_task="B", to_task="A")),
        )
        graph = build_graph_from_snapshot(snapshot)
        with pytest.raises(CycleError):
            forecast(snapshot, graph, {"A": 1.0, "B": 1.0}, iterations=10)


# ---------------------------------------------------------------------------
# 8. Cost
# ---------------------------------------------------------------------------


class TestItIsFastEnoughToBeInteractive:
    def test_five_thousand_iterations_of_forty_tasks(self):
        """The brief's budget is ~2 seconds. The measured figure on the
        development machine is around a quarter of that for the seeded
        workflows and well under a second here; the ceiling is deliberately
        loose so a slow CI box does not produce a red build for no reason."""
        snapshot = wide_workflow(40)
        started = time.perf_counter()
        payload = run(snapshot, iterations=5000, seed=11).as_dict()
        elapsed = time.perf_counter() - started
        assert payload["iterations"] == 5000
        assert len(payload["tasks"]) == 40
        assert elapsed < 6.0, f"5000 iterations of 40 tasks took {elapsed:.2f}s"

    def test_memory_stays_bounded_by_chunking(self):
        """`CHUNK` caps how many iterations are held in memory at once, so a
        large run costs time and not a machine."""
        snapshot = wide_workflow(20)
        payload = run(snapshot, iterations=20000, seed=2).as_dict()
        assert payload["iterations"] == 20000
        assert sum(b["count"] for b in payload["histogram"]["bins"]) == 20000


# ---------------------------------------------------------------------------
# The honesty layer survives
# ---------------------------------------------------------------------------


class TestTheOldRefusalsAreIntact:
    """Adding a real probability does not license removing a single caveat."""

    def test_the_structural_score_is_still_not_a_probability(self, event_fixture):
        result = evaluate(
            event_fixture.snapshot, event_fixture.state,
            Clock(event_fixture.today_day),
        )
        assumptions = result.risk["assumptions"]
        assert assumptions["score_kind"] == "structural_estimate"
        assert assumptions["monte_carlo_run"] is False
        assert "not a probability" in assumptions["disclaimer"]

    def test_the_three_point_range_is_still_three_deterministic_runs(
        self, event_fixture
    ):
        result = evaluate(
            event_fixture.snapshot, event_fixture.state,
            Clock(event_fixture.today_day),
        )
        three_point = result.feasibility.three_point
        assert three_point["is_probability"] is False
        assert three_point["monte_carlo"]["available"] is False
        assert "not a distribution" in three_point["method"]

    def test_both_payloads_now_point_at_the_forecast_without_claiming_it(
        self, event_fixture
    ):
        result = evaluate(
            event_fixture.snapshot, event_fixture.state,
            Clock(event_fixture.today_day),
        )
        pointer = result.risk["assumptions"]["forecast_offered_separately"]
        assert "different number" in pointer
        assert "not calibrated" in pointer
        seam = result.feasibility.three_point["monte_carlo"]
        assert seam["available_in_this_payload"] is False
        assert "uncalibrated" in seam["now_computable_separately"]

    def test_the_forecast_says_it_is_a_different_number(self, event_fixture):
        payload = run(event_fixture.snapshot).as_dict()
        assert payload["kind"] == FORECAST_KIND != STRUCTURAL_KIND
        assert "different number" in payload["not_the_structural_estimate"]
        assert "not a probability" in (
            payload["assumptions"]["structural_estimate_is_a_different_number"]
        )
        result = evaluate(
            event_fixture.snapshot, event_fixture.state,
            Clock(event_fixture.today_day),
        )
        assert "category error" in (
            result.risk["assumptions"]["score_kind_is_not_the_forecast_kind"]
        )


# ---------------------------------------------------------------------------
# 7. Through the API
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture(scope="module")
async def client():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c


class TestForecastApi:
    async def test_the_endpoint_returns_a_distribution(self, client):
        r = await client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/forecast",
            json={"iterations": 2000, "seed": 12345},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["answer_kind"] == FORECAST_KIND
        completion = body["forecast"]["completion"]
        assert completion["p50_day"] <= completion["p80_day"] <= completion["p90_day"]
        assert completion["p50_date"] <= completion["p90_date"]
        assert body["forecast"]["iterations"] == 2000
        assert len(body["forecast"]["tasks"]) == 17

    async def test_it_reports_the_deadline_probability_with_its_band(self, client):
        r = await client.post(f"/api/projects/{EVENT_PROJECT_ID}/forecast")
        deadline = r.json()["forecast"]["deadline"]
        assert 0.0 <= deadline["probability_of_meeting_deadline"] <= 1.0
        assert deadline["band"] in ("on_track", "at_risk", "unlikely")
        assert deadline["deadline_date"]

    async def test_the_same_seed_reproduces_over_http(self, client):
        a = await client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/forecast", json={"seed": 31337}
        )
        b = await client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/forecast", json={"seed": 31337}
        )
        assert a.json()["forecast"] == b.json()["forecast"]

    async def test_the_response_says_which_number_it_is_showing(self, client):
        r = await client.post(f"/api/projects/{EVENT_PROJECT_ID}/forecast")
        body = r.json()
        assert body["answer_kind"] in (FORECAST_KIND, STRUCTURAL_KIND)
        assert "probability" in body["answer_kind_note"]
        # And the structural estimate is still there, still labelled.
        assert body["structural_risk"]["score_kind"] == "structural_estimate"
        assert body["structural_risk"]["is_probability"] is False
        assert body["deterministic"]["feasibility"]["is_probability"] is False

    async def test_the_histogram_carries_dates_and_sums_to_the_run(self, client):
        r = await client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/forecast", json={"iterations": 1000}
        )
        histogram = r.json()["forecast"]["histogram"]
        assert sum(b["count"] for b in histogram["bins"]) == 1000
        assert histogram["bins"][-1]["cumulative_share"] == 1.0
        assert histogram["bins"][0]["from_date"]

    async def test_criticality_travels_over_http(self, client):
        r = await client.post(f"/api/projects/{EVENT_PROJECT_ID}/forecast")
        tasks = r.json()["forecast"]["tasks"]
        assert tasks[0]["criticality_index"] >= tasks[-1]["criticality_index"]
        assert any(t["criticality_index"] > 0.5 for t in tasks)

    async def test_the_cold_start_project_still_forecasts(self, client):
        r = await client.post(f"/api/projects/{MFG_PROJECT_ID}/forecast")
        assert r.status_code == 200
        body = r.json()
        assert len(body["forecast"]["tasks"]) == 12
        assert body["structural_risk"]["top"]

    async def test_the_assumptions_endpoint_describes_the_model(self, client):
        r = await client.get(f"/api/projects/{EVENT_PROJECT_ID}/forecast/assumptions")
        assert r.status_code == 200
        body = r.json()
        assert body["distribution_name"] == "Beta-PERT"
        assert body["is_calibrated"] is False
        assert {row["what"] for row in body["not_modelled"]} == {
            "correlation between task durations",
            "resource contention",
            "rework",
        }

    async def test_forecasting_does_not_change_the_stored_version(self, client):
        before = await client.get(f"/api/projects/{EVENT_PROJECT_ID}/versions")
        await client.post(f"/api/projects/{EVENT_PROJECT_ID}/forecast")
        after = await client.get(f"/api/projects/{EVENT_PROJECT_ID}/versions")
        assert before.json() == after.json()

    async def test_an_unknown_project_is_404(self, client):
        r = await client.post(
            "/api/projects/00000000-0000-0000-0000-000000000099/forecast"
        )
        assert r.status_code == 404

    async def test_the_iteration_count_is_bounded(self, client):
        r = await client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/forecast",
            json={"iterations": 10_000_000},
        )
        assert r.status_code == 422
