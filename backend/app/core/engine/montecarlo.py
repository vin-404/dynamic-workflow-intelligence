"""
Capability 2, Layer B - a seeded Monte Carlo forecast over the three-point
estimates the tasks already carry.

`feasibility.py` says, four times over, that three deterministic schedule runs
are not a distribution and that the `monte_carlo` seam is deliberately empty.
This module fills the seam. It does **not** repeal a single one of those
sentences:

* `risk.py`'s Layer-A score is still a *structural estimate*, still not a
  probability, and is still the only answer available when there is nothing to
  sample. Nothing here changes a number it produces.
* `feasibility.three_point_range` is still three deterministic runs and still
  reports `is_probability: false`.
* What this module produces **is** a probability - and an *uncalibrated* one.
  It is a probability under a stated model, not a validated forecast, and the
  payload says exactly what it would take to become the latter.

What it does
------------
Sample every task's duration `iterations` times, run the same CPM forward and
backward pass `cpm.schedule` runs, and report

* P50 / P80 / P90 completion days and a completion-day histogram,
* the probability of finishing on or before the deadline,
* and, per task, its **criticality index**: the fraction of iterations in
  which it lands on the critical path. That is the rigorous version of "this
  task is at risk of becoming a bottleneck", and it is the point of the whole
  exercise - a task with slack today and a criticality index of 0.7 is a
  bottleneck three times out of four.

The model, stated once here and again in every payload
------------------------------------------------------
**Beta-PERT**, the standard three-point distribution in project scheduling.
For a task estimated (o, m, p) it is a Beta on the interval [o, p] with

    alpha = 1 + L * (m - o) / (p - o)
    beta  = 1 + L * (p - m) / (p - o)      with L = 4

which gives mean `(o + 4m + p) / 6` and mode exactly `m`. Chosen over the
alternatives on purpose:

* **Triangular** is also fully determined by (o, m, p) and is cheaper, but it
  puts far too much mass near o and p - and those are the two numbers an
  estimator states least confidently. Beta-PERT keeps the same three points
  and concentrates mass around the mode.
* **Lognormal** models the long right tail of real delays better, but it has
  no upper bound and cannot be fitted from three points without inventing a
  parameter. We would be choosing a shape the estimate does not contain.

Beta-PERT's own cost is stated in the payload: it is **bounded above by the
pessimistic estimate**, so a task cannot take longer than its worst case. Real
tasks can. That makes this forecast optimistic, and `L = 4` is an assumption,
not a measurement.

Purity
------
Pure, like the rest of `core/`: no I/O, no clock, no framework, no module-level
mutable state, and no domain. The spread prior arrives as a *number* on
`EngineConfig`, never as a domain name. Randomness comes from a
`random.Random(seed)` instance created per call, so the same seed gives
byte-identical output and two concurrent calls cannot interfere.

There is deliberately **no numpy here**. `backend/tests/test_core_purity.py`
allows `core/` exactly one third-party dependency, `networkx`, and that test is
an invariant rather than a formality. The simulation is instead vectorised
column-major in the standard library - one `map()` pass per graph edge over a
whole chunk of iterations at a time, rather than one Python loop per
iteration - which runs 5,000 iterations of a 40-task workflow in about a
quarter of a second. See the module's decision note in the final report.
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass
from operator import add, sub
from typing import Any, Iterable, Mapping, Sequence

import networkx as nx

from backend.app.core.engine.graph import CycleError
from backend.app.core.workflow import EngineConfig, WorkflowSnapshot

#: What this payload is, stated in the payload so nobody has to infer it. The
#: counterpart to `risk.SCORE_KIND`, and deliberately a different string: a
#: caller must never be able to mistake one for the other.
FORECAST_KIND = "monte_carlo_probability"

#: What the caller gets instead when there is nothing to sample.
STRUCTURAL_KIND = "structural_estimate"

DISTRIBUTION = "beta_pert"
PERT_LAMBDA = 4.0

FORECAST_DISCLAIMER = (
    "This IS a probability, and it is an uncalibrated one. It is the fraction "
    "of simulated runs in which the workflow finished on or before the "
    "deadline, given the model stated in `assumptions`. It is not a validated "
    "forecast: nothing in this system has yet compared a forecast to what "
    "actually happened."
)

INDEPENDENCE_NOTE = (
    "Task durations are sampled INDEPENDENTLY of one another. This is "
    "optimistic, and knowingly so. Real delays correlate: the week the "
    "supplier is late is the week the reviewer is on leave, and one slipping "
    "task is evidence that its neighbours will slip too. Independent sampling "
    "lets those correlated bad runs cancel out, so the true spread is wider "
    "than the one reported here and P80/P90 are nearer than they look."
)

RESOURCE_CONTENTION_NOTE = (
    "Resource contention is NOT simulated. Every iteration runs the same "
    "resource-blind CPM pass the rest of the engine runs, so two tasks "
    "assigned to the same person may run concurrently in a sampled run. "
    "Solving that exactly is resource-constrained project scheduling, which "
    "this system does not claim to solve. The effect is another source of "
    "optimism."
)

WHAT_WOULD_CALIBRATE_IT = (
    "Recorded actual durations from completed work, compared against the "
    "estimates that preceded them. That would give a measured spread per task "
    "class instead of an assumed one, a measured correlation between tasks "
    "instead of an assumed independence, and - the actual test of a forecast "
    "- reliability curves showing whether things this engine called 80% "
    "likely happened about 80% of the time. Until then, treat the number as "
    "the model's opinion, not as evidence."
)

BAND_NOTE = (
    "Band labels are cut points on a continuum, not categories. 0.79 and 0.81 "
    "differ by two runs in a hundred, not by a kind. The label is never shown "
    "without the number it came from."
)

#: Per-task spread provenance. Exactly one of these is reported per task.
PROVENANCE_ESTIMATE = "three_point_estimate"
PROVENANCE_PRIOR = "spread_prior"
PROVENANCE_MEASURED = "measured_actual"

#: Iterations simulated at once. Bounds peak memory to a few megabytes no
#: matter how large `iterations` is, and is fixed so that the result depends
#: only on the seed and the iteration count.
CHUNK = 2048

#: Slack at or below this counts as "on the critical path", scaled by the
#: project's own size. `cpm.schedule` uses a flat 1e-9; float error over a
#: forty-task chain is around 1e-14, so both are comfortable.
CRITICAL_TOLERANCE = 1e-9


# ---------------------------------------------------------------------------
# The duration model
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class DurationBand:
    """One task's sampling interval, and where its width came from."""

    task_key: str
    task_name: str
    optimistic: float
    likely: float
    pessimistic: float
    provenance: str
    #: True when the width is an assumption rather than a measurement - i.e.
    #: it came from the configured spread prior, not from the task's own
    #: three-point estimate. Reported per task, never averaged away.
    assumed: bool

    @property
    def relative_spread(self) -> float:
        if self.likely <= 0:
            return 0.0
        return (self.pessimistic - self.optimistic) / self.likely

    @property
    def is_degenerate(self) -> bool:
        return (self.pessimistic - self.optimistic) <= 1e-12

    def as_dict(self) -> dict:
        return {
            "optimistic_days": round(self.optimistic, 4),
            "likely_days": round(self.likely, 4),
            "pessimistic_days": round(self.pessimistic, 4),
            "relative_spread": round(self.relative_spread, 4),
            "spread_provenance": self.provenance,
            "assumed": self.assumed,
        }


def pert_parameters(
    optimistic: float, likely: float, pessimistic: float,
    lam: float = PERT_LAMBDA,
) -> tuple[float, float] | None:
    """Beta-PERT `(alpha, beta)` for a three-point estimate.

    Returns `None` when the interval has no width, which is the caller's cue
    to treat the duration as known rather than to sample a degenerate Beta.
    Bad input (optimistic above pessimistic, a mode outside the interval) is
    normalised rather than raised on: a forecast is not the place to reject a
    workflow the scheduler already accepted.
    """
    lo = min(optimistic, likely, pessimistic)
    hi = max(optimistic, likely, pessimistic)
    if hi - lo <= 1e-12:
        return None
    mode = min(max(likely, lo), hi)
    alpha = 1.0 + lam * (mode - lo) / (hi - lo)
    beta = 1.0 + lam * (hi - mode) / (hi - lo)
    return alpha, beta


def duration_bands(
    snapshot: WorkflowSnapshot,
    durations: Mapping[str, float],
    config: EngineConfig | None = None,
    known_duration_keys: Iterable[str] = (),
) -> tuple[dict[str, DurationBand], dict]:
    """Per-task sampling intervals, and the assumptions block behind them.

    `durations` is the *observed* duration the rest of the engine is already
    projecting with, so the middle of this distribution reconciles with the
    number on screen rather than being a fourth figure. Each task's band is
    the shape of its three-point estimate rescaled onto that observed
    duration, exactly as `feasibility.three_point_range` rescales it - a task
    already running over keeps its overrun in every sampled run.

    Three provenances, and each task reports its own:

    * `three_point_estimate` - the estimator wrote o/m/p. Measured.
    * `spread_prior` - they did not, so the configured relative spread is
      applied and the task is labelled `assumed`.
    * `measured_actual` - the work is finished, so its duration is known and
      is not sampled at all.
    """
    from backend.app.core.engine.effort import three_point_durations

    cfg = config or EngineConfig()
    per_task, spread_assumptions = three_point_durations(snapshot, cfg)
    known = set(known_duration_keys)

    bands: dict[str, DurationBand] = {}
    with_estimate: list[str] = []
    from_prior: list[str] = []
    measured: list[str] = []

    for task in snapshot.tasks:
        base = float(durations.get(task.key, 0.0))
        name = task.name
        if task.key in known:
            measured.append(task.key)
            bands[task.key] = DurationBand(
                task_key=task.key, task_name=name,
                optimistic=base, likely=base, pessimistic=base,
                provenance=PROVENANCE_MEASURED, assumed=False,
            )
            continue

        band = per_task.get(task.key)
        if band is None:
            from_prior.append(task.key)
            bands[task.key] = DurationBand(
                task_key=task.key, task_name=name,
                optimistic=base, likely=base, pessimistic=base,
                provenance=PROVENANCE_PRIOR, assumed=True,
            )
            continue

        likely = band["likely"] or 1.0
        scale = base / likely
        if task.has_three_point:
            with_estimate.append(task.key)
            provenance, assumed = PROVENANCE_ESTIMATE, False
        else:
            from_prior.append(task.key)
            provenance, assumed = PROVENANCE_PRIOR, True
        bands[task.key] = DurationBand(
            task_key=task.key, task_name=name,
            optimistic=band["optimistic"] * scale,
            likely=base,
            pessimistic=band["pessimistic"] * scale,
            provenance=provenance,
            assumed=assumed,
        )

    assumptions = {
        "effort_model": spread_assumptions["effort_model"],
        "spread_prior_relative": cfg.default_duration_spread,
        "spread_prior_provenance": cfg.duration_spread_provenance,
        "tasks_with_three_point_estimate": sorted(with_estimate),
        "tasks_using_spread_prior": sorted(from_prior),
        "tasks_with_measured_duration": sorted(measured),
        "spread_provenance_is_per_task": True,
        "spread_provenance_note": (
            "Every task reports the provenance of its own spread. A task "
            "whose spread came from the prior rather than from an estimate is "
            "marked `assumed: true`, and its contribution to this "
            "distribution is an assumption, not a measurement."
        ),
    }
    return bands, assumptions


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TaskForecast:
    task_key: str
    task_name: str
    #: Fraction of iterations in which this task had zero slack.
    criticality_index: float
    iterations_on_critical_path: int
    mean_duration_days: float
    band: DurationBand

    def as_dict(self) -> dict:
        return {
            "task_key": self.task_key,
            "task_name": self.task_name,
            "criticality_index": round(self.criticality_index, 4),
            "iterations_on_critical_path": self.iterations_on_critical_path,
            "mean_duration_days": round(self.mean_duration_days, 4),
            "duration": self.band.as_dict(),
            "assumed": self.band.assumed,
            "criticality_means": (
                "the fraction of simulated runs in which this task was on the "
                "critical path - zero slack, so a slip in it moved the finish "
                "date"
            ),
        }


@dataclass(frozen=True, slots=True)
class Forecast:
    """A completion distribution, or an explicit refusal to invent one."""

    available: bool
    iterations: int
    seed: int
    percentile_days: dict[str, float]
    mean_day: float
    min_day: float
    max_day: float
    deadline_day: float | None
    probability_of_meeting_deadline: float | None
    iterations_meeting_deadline: int | None
    band: str | None
    histogram: dict
    tasks: tuple[TaskForecast, ...]
    assumptions: dict
    unavailable_reason: str = ""

    def as_dict(self) -> dict:
        payload: dict[str, Any] = {
            "kind": FORECAST_KIND,
            "available": self.available,
            "is_probability": self.available,
            "is_calibrated": False,
            "disclaimer": FORECAST_DISCLAIMER,
            "what_would_calibrate_it": WHAT_WOULD_CALIBRATE_IT,
            "not_the_structural_estimate": (
                "This is a different number from the Layer-A risk score. That "
                "one is a `structural_estimate` on a 0-1 scale and says how "
                "exposed a task is; this one is a probability and says how "
                "often something happened in simulation. Neither substitutes "
                "for the other, and a caller should never read a band label "
                "from one against a number from the other."
            ),
            "iterations": self.iterations,
            "seed": self.seed,
            "distribution": DISTRIBUTION,
            "completion": {
                **{f"p{name}_day": round(value, 4)
                   for name, value in self.percentile_days.items()},
                "mean_day": round(self.mean_day, 4),
                "earliest_day": round(self.min_day, 4),
                "latest_day": round(self.max_day, 4),
            },
            "deadline": {
                "deadline_day": self.deadline_day,
                "probability_of_meeting_deadline": (
                    None if self.probability_of_meeting_deadline is None
                    else round(self.probability_of_meeting_deadline, 4)
                ),
                "iterations_meeting_deadline": self.iterations_meeting_deadline,
                "band": self.band,
                "band_note": BAND_NOTE,
            },
            "histogram": self.histogram,
            "tasks": [t.as_dict() for t in self.tasks],
            "assumptions": self.assumptions,
        }
        if not self.available:
            payload["unavailable_reason"] = self.unavailable_reason
            payload["fall_back_to"] = STRUCTURAL_KIND
        return payload


# ---------------------------------------------------------------------------
# The simulation
# ---------------------------------------------------------------------------


def _percentile(ordered: Sequence[float], q: float) -> float:
    """Linear interpolation between order statistics.

    Monotone in `q` by construction, which is what makes P50 <= P80 <= P90 a
    fact about the function rather than a hope about the data.
    """
    if not ordered:
        return 0.0
    if len(ordered) == 1:
        return float(ordered[0])
    pos = (len(ordered) - 1) * (q / 100.0)
    lo = int(math.floor(pos))
    hi = min(lo + 1, len(ordered) - 1)
    return float(ordered[lo] + (ordered[hi] - ordered[lo]) * (pos - lo))


def _band_for(probability: float) -> str:
    """Three labels, and never shown without the number (see `BAND_NOTE`)."""
    if probability >= 0.80:
        return "on_track"
    if probability >= 0.50:
        return "at_risk"
    return "unlikely"


def _histogram(ordered: Sequence[float], max_bins: int = 24) -> dict:
    if not ordered:
        return {"bins": [], "bin_count": 0, "bin_width_days": 0.0,
                "method": "no completion samples to bin."}
    low, high = float(ordered[0]), float(ordered[-1])
    total = len(ordered)
    if high - low <= 1e-12:
        return {
            "bins": [{
                "from_day": round(low, 4), "to_day": round(high, 4),
                "count": total, "share": 1.0, "cumulative_share": 1.0,
            }],
            "bin_count": 1,
            "bin_width_days": 0.0,
            "method": (
                "Every run finished on the same day, so there is one bin. "
                "That happens when no task has any spread to sample."
            ),
        }
    bins = max(1, min(max_bins, total))
    width = (high - low) / bins
    counts = [0] * bins
    for value in ordered:
        index = int((value - low) / width)
        if index >= bins:
            index = bins - 1
        counts[index] += 1

    out = []
    running = 0
    for i, count in enumerate(counts):
        running += count
        out.append({
            "from_day": round(low + i * width, 4),
            "to_day": round(low + (i + 1) * width, 4),
            "count": count,
            "share": round(count / total, 4),
            "cumulative_share": round(running / total, 4),
        })
    return {
        "bins": out,
        "bin_count": bins,
        "bin_width_days": round(width, 4),
        "method": (
            f"{bins} equal-width bins spanning the sampled range, "
            f"{low:.2f} to {high:.2f} days. Counts are runs, not weights."
        ),
    }


def _sample_chunk(
    order: Sequence[str],
    params: Mapping[str, tuple[float, float] | None],
    bands: Mapping[str, DurationBand],
    n: int,
    rng: random.Random,
) -> dict[str, list[float]]:
    """One chunk of sampled durations, column-major: a full column of `n`
    draws per task.

    Tasks are drawn in `order`, which is a fixed topological order, so the
    stream of draws - and therefore the whole result - is a function of the
    seed alone.
    """
    out: dict[str, list[float]] = {}
    beta = rng.betavariate
    for key in order:
        shape = params[key]
        if shape is None:
            out[key] = [bands[key].likely] * n
            continue
        alpha, beta_p = shape
        low = min(bands[key].optimistic, bands[key].likely, bands[key].pessimistic)
        high = max(bands[key].optimistic, bands[key].likely, bands[key].pessimistic)
        width = high - low
        out[key] = [low + width * beta(alpha, beta_p) for _ in range(n)]
    return out


def _run_chunk(
    order: Sequence[str],
    preds: Mapping[str, tuple[str, ...]],
    succs: Mapping[str, tuple[str, ...]],
    samples: Mapping[str, list[float]],
    n: int,
) -> tuple[list[float], dict[str, int], dict[str, float]]:
    """`cpm.schedule`'s forward and backward pass, run on whole columns.

    Identical arithmetic to `cpm.schedule` - ES is the max of predecessor EFs,
    LF the min of successor LSs, slack is LS - ES and a task is critical when
    that is zero - just applied to `n` iterations at once through `map()`
    instead of once per iteration through Python. With every spread set to
    zero this reproduces `cpm.schedule` exactly, which is asserted in
    `test_montecarlo.py`.
    """
    ES: dict[str, list[float]] = {}
    EF: dict[str, list[float]] = {}
    for node in order:                                      # forward pass
        parents = preds[node]
        if not parents:
            es = [0.0] * n
        else:
            it = iter(parents)
            es = list(EF[next(it)])
            for p in it:
                es = list(map(max, es, EF[p]))
        ES[node] = es
        EF[node] = list(map(add, es, samples[node]))

    project_end: list[float] = [0.0] * n
    for node in order:
        project_end = list(map(max, project_end, EF[node]))

    LS: dict[str, list[float]] = {}
    for node in reversed(order):                            # backward pass
        children = succs[node]
        if not children:
            lf = list(project_end)
        else:
            it = iter(children)
            lf = list(LS[next(it)])
            for s in it:
                lf = list(map(min, lf, LS[s]))
        LS[node] = list(map(sub, lf, samples[node]))

    tolerance = CRITICAL_TOLERANCE * max(1.0, max(project_end, default=1.0))
    critical: dict[str, int] = {}
    duration_totals: dict[str, float] = {}
    for node in order:
        ls, es = LS[node], ES[node]
        critical[node] = sum(1 for a, b in zip(ls, es) if a - b <= tolerance)
        duration_totals[node] = math.fsum(samples[node])
    return project_end, critical, duration_totals


def forecast(
    snapshot: WorkflowSnapshot,
    graph: nx.DiGraph,
    durations: Mapping[str, float],
    config: EngineConfig | None = None,
    *,
    iterations: int = 5000,
    seed: int = 12345,
    known_duration_keys: Iterable[str] = (),
    percentiles: Sequence[int] = (50, 80, 90),
) -> Forecast:
    """Run `iterations` seeded schedule simulations and report the result.

    Raises `CycleError` on a cyclic graph, exactly as `cpm.schedule` does: a
    workflow with no finish date has no distribution of finish dates either.

    When no task has any spread to sample - no three-point estimates anywhere
    and a spread prior of zero - this returns `available=False` with the
    reason, rather than a distribution with all its mass on one day dressed up
    as a forecast. The caller is expected to fall back to the Layer-A
    structural estimate and say that is what it is doing.
    """
    if not nx.is_directed_acyclic_graph(graph):
        raise CycleError(list(nx.simple_cycles(graph)))

    cfg = config or EngineConfig()
    iterations = max(1, int(iterations))
    bands, band_assumptions = duration_bands(
        snapshot, durations, cfg, known_duration_keys
    )
    order = list(nx.topological_sort(graph))
    preds = {n: tuple(graph.predecessors(n)) for n in order}
    succs = {n: tuple(graph.successors(n)) for n in order}
    for key in order:
        if key not in bands:
            base = float(durations.get(key, 0.0))
            bands[key] = DurationBand(
                task_key=key, task_name=key,
                optimistic=base, likely=base, pessimistic=base,
                provenance=PROVENANCE_PRIOR, assumed=True,
            )

    params: dict[str, tuple[float, float] | None] = {}
    sampled_keys: list[str] = []
    for key in order:
        band = bands[key]
        shape = pert_parameters(band.optimistic, band.likely, band.pessimistic)
        if shape is None:
            params[key] = None
        else:
            params[key] = shape
            sampled_keys.append(key)

    assumptions = _assumptions(
        cfg, band_assumptions, iterations, seed, sampled_keys, order
    )
    deadline = snapshot.deadline_day

    if not sampled_keys:
        return Forecast(
            available=False,
            iterations=iterations,
            seed=seed,
            percentile_days={str(p): 0.0 for p in percentiles},
            mean_day=0.0, min_day=0.0, max_day=0.0,
            deadline_day=deadline,
            probability_of_meeting_deadline=None,
            iterations_meeting_deadline=None,
            band=None,
            histogram=_histogram([]),
            tasks=tuple(
                TaskForecast(
                    task_key=key,
                    task_name=bands[key].task_name,
                    criticality_index=0.0,
                    iterations_on_critical_path=0,
                    mean_duration_days=bands[key].likely,
                    band=bands[key],
                )
                for key in sorted(order)
            ),
            assumptions=assumptions,
            unavailable_reason=(
                "Nothing here has any spread to sample: no task carries a "
                "three-point estimate and the configured spread prior is "
                "zero, so every simulated run would be the deterministic "
                "schedule. A distribution with all of its mass on one day is "
                "not a forecast, so none is reported. Use the Layer-A "
                "structural estimate, and say that is what it is."
            ),
        )

    rng = random.Random(seed)
    completions: list[float] = []
    critical_totals = {key: 0 for key in order}
    duration_totals = {key: 0.0 for key in order}

    remaining = iterations
    while remaining > 0:
        n = min(CHUNK, remaining)
        remaining -= n
        samples = _sample_chunk(order, params, bands, n, rng)
        ends, critical, totals = _run_chunk(order, preds, succs, samples, n)
        completions.extend(ends)
        for key in order:
            critical_totals[key] += critical[key]
            duration_totals[key] += totals[key]

    completions.sort()
    total = len(completions)
    percentile_days = {str(p): _percentile(completions, p) for p in percentiles}

    met = None
    probability = None
    band_label = None
    if deadline is not None:
        met = sum(1 for value in completions if value <= deadline + 1e-9)
        probability = met / total
        band_label = _band_for(probability)

    tasks = tuple(
        TaskForecast(
            task_key=key,
            task_name=bands[key].task_name,
            criticality_index=critical_totals[key] / total,
            iterations_on_critical_path=critical_totals[key],
            mean_duration_days=duration_totals[key] / total,
            band=bands[key],
        )
        for key in sorted(order, key=lambda k: (-critical_totals[k], k))
    )

    return Forecast(
        available=True,
        iterations=total,
        seed=seed,
        percentile_days=percentile_days,
        mean_day=math.fsum(completions) / total,
        min_day=completions[0],
        max_day=completions[-1],
        deadline_day=deadline,
        probability_of_meeting_deadline=probability,
        iterations_meeting_deadline=met,
        band=band_label,
        histogram=_histogram(completions),
        tasks=tasks,
        assumptions=assumptions,
    )


def _assumptions(
    cfg: EngineConfig,
    band_assumptions: dict,
    iterations: int,
    seed: int,
    sampled_keys: Sequence[str],
    order: Sequence[str],
) -> dict:
    """Everything the number rests on, in plain language.

    Written to be readable by somebody deciding whether to trust the figure,
    not by somebody who already agrees with it.
    """
    return {
        "kind": FORECAST_KIND,
        "distribution": DISTRIBUTION,
        "distribution_name": "Beta-PERT",
        "distribution_lambda": PERT_LAMBDA,
        "distribution_why": (
            "Beta-PERT is the standard three-point distribution in project "
            "scheduling. It is fitted exactly to the (optimistic, likely, "
            "pessimistic) numbers a task already carries - mode at `likely`, "
            "support [optimistic, pessimistic], mean (o + 4m + p) / 6 - so it "
            "adds no information the estimate does not contain. A triangular "
            "distribution is also exactly determined by those three points "
            "but puts far too much mass near the ends, which are the two "
            "numbers an estimator states least confidently. A lognormal "
            "models the long right tail of real delay better but has no upper "
            "bound and cannot be fitted from three points without inventing a "
            "parameter."
        ),
        "distribution_cost": (
            "Beta-PERT is bounded above by the pessimistic estimate, so no "
            "sampled run can take longer than the worst case somebody wrote "
            "down. Real projects exceed their worst case. The lambda of 4 is "
            "a convention, not a measurement."
        ),
        "iterations": iterations,
        "seed": seed,
        "reproducible": (
            f"Seeded with {seed}. The same workflow, the same iteration count "
            f"and the same seed reproduce this result exactly; nothing here "
            f"reads a clock or a global random state."
        ),
        "tasks_sampled": len(sampled_keys),
        "tasks_total": len(order),
        "tasks_held_constant": sorted(set(order) - set(sampled_keys)),
        "durations_sampled_independently": True,
        "independence_note": INDEPENDENCE_NOTE,
        "resource_contention_modelled": False,
        "resource_contention_note": RESOURCE_CONTENTION_NOTE,
        "rework_modelled": False,
        "rework_note": (
            "Rework is not simulated. A task that has to be redone appears "
            "here only through whatever its pessimistic estimate already "
            "allowed for."
        ),
        "calendar_modelled": False,
        "calendar_note": (
            "Everything is in integer-friendly working days, as everywhere "
            "else in the engine. Weekends and holidays enter only when a day "
            "offset is turned into a calendar date at the API boundary."
        ),
        "is_calibrated": False,
        "what_would_calibrate_it": WHAT_WOULD_CALIBRATE_IT,
        "criticality_index_definition": (
            "The fraction of iterations in which a task had zero slack. It is "
            "the rigorous form of `this task is at risk of becoming a "
            "bottleneck`: a task with slack in today's deterministic schedule "
            "and a criticality index of 0.7 is on the critical path in seven "
            "runs out of ten."
        ),
        "critical_path_definition": (
            "Zero slack in a given iteration, within a tolerance of "
            f"{CRITICAL_TOLERANCE:g} scaled by the project length - the same "
            "definition `cpm.schedule` uses."
        ),
        "structural_estimate_is_a_different_number": (
            "The Layer-A risk score is a `structural_estimate` on a 0-1 scale "
            "and remains what this system reports when there is nothing to "
            "sample. It is not a probability and this is not a ranking of "
            "exposure. Do not compare them."
        ),
        **band_assumptions,
    }
