"""
Capability 2, Layer A - a transparent additive risk score.

Not ML. Not a probability. For each task the engine computes nine normalised
factors, multiplies each by a stated weight, and adds them up:

    risk = sum(w_i * f_i)

and returns **every** `f_i`, every `w_i`, the product, and a human-readable
reason for each (ARCHITECTURE D.4). The explanation is generated from the top
contributing factors, so a reader can see not just that a task is risky but
which of nine things made it so - and can recompute the number by hand.

Two things this module refuses to do:

* **It never calls the output a probability.** It is a *structural estimate*.
  A percentage would need a distribution the system does not have, and an
  invented percentage is the fastest way to lose a technical judge
  (ARCHITECTURE D.6). Monte Carlo and a real P(deadline) are Layer B / P1;
  `feasibility.py` leaves the seam and implements nothing fake.
* **It never hides an assumption.** Every response carries an `assumptions`
  block naming the duration spread it used, where that spread came from
  (`historical | domain_prior | default`), the evidence tier reached, and what
  is consequently unavailable.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

import networkx as nx

from backend.app.core.engine.findings import Tier
from backend.app.core.workflow import (
    Clock,
    EngineConfig,
    OPEN_STATUSES,
    WorkflowSnapshot,
    WorkflowState,
)

#: What the score is, stated in the payload so nobody has to infer it.
SCORE_KIND = "structural_estimate"
SCORE_DISCLAIMER = (
    "This is a structural estimate on a 0-1 scale, not a probability. It "
    "ranks tasks by how exposed they are, given the workflow's shape and the "
    "evidence available. It does not say how likely anything is."
)
FORMULA = "risk = sum(weight_i * factor_i)"


@dataclass(frozen=True, slots=True)
class RiskWeights:
    """Weights are **inputs**, and they are echoed in every response.

    They sum to 1.0 by default so the score lands on a 0-1 scale, which
    `test_risk.py` asserts. A caller who changes them gets a different score
    and sees exactly which weights produced it.
    """

    slack_ratio: float = 0.20
    downstream_fan_out: float = 0.15
    criticality_proximity: float = 0.12
    deadline_pressure: float = 0.13
    resource_pressure: float = 0.12
    duration_uncertainty: float = 0.08
    predecessor_health: float = 0.08
    remaining_chain_depth: float = 0.07
    assignment_gap: float = 0.05

    def as_dict(self) -> dict[str, float]:
        return {
            "slack_ratio": self.slack_ratio,
            "downstream_fan_out": self.downstream_fan_out,
            "criticality_proximity": self.criticality_proximity,
            "deadline_pressure": self.deadline_pressure,
            "resource_pressure": self.resource_pressure,
            "duration_uncertainty": self.duration_uncertainty,
            "predecessor_health": self.predecessor_health,
            "remaining_chain_depth": self.remaining_chain_depth,
            "assignment_gap": self.assignment_gap,
        }

    @property
    def total(self) -> float:
        return sum(self.as_dict().values())


@dataclass(frozen=True, slots=True)
class Factor:
    """One normalised signal, its weight, and why it reads the way it does."""

    name: str
    value: float          # 0..1, higher means more exposed
    weight: float
    reason: str
    #: The raw numbers behind `value`, so the normalisation is auditable.
    evidence: dict[str, Any]
    #: What evidence this factor needed. A factor that could not be measured
    #: reports 0.0 and says so, rather than guessing.
    tier: int = int(Tier.STRUCTURAL)
    available: bool = True

    @property
    def contribution(self) -> float:
        return self.weight * self.value

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "value": round(self.value, 4),
            "weight": self.weight,
            "contribution": round(self.contribution, 4),
            "reason": self.reason,
            "evidence": self.evidence,
            "tier": self.tier,
            "available": self.available,
        }


@dataclass(frozen=True, slots=True)
class TaskRisk:
    task_key: str
    task_name: str
    score: float
    band: str
    factors: tuple[Factor, ...]
    explanation: str

    def as_dict(self) -> dict:
        # The score shown is the sum of the *rounded* contributions, not the
        # rounded sum. They differ in the last decimal often enough that a
        # reader adding the column up gets a different number from the
        # headline - which is a small dishonesty in a product whose whole
        # claim is "recompute this yourself". Rounding once, at the point of
        # display, makes the arithmetic on screen exact.
        contributions = [round(f.contribution, 4) for f in self.factors]
        return {
            "task_key": self.task_key,
            "task_name": self.task_name,
            "score": round(sum(contributions), 4),
            "band": self.band,
            "score_kind": SCORE_KIND,
            "formula": FORMULA,
            "factors": [f.as_dict() for f in self.factors],
            "explanation": self.explanation,
            "top_factors": [
                f.name for f in sorted(
                    self.factors, key=lambda f: -f.contribution
                )[:3] if f.contribution > 0
            ],
        }


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def _band(score: float) -> str:
    """Three buckets, named as exposure rather than as likelihood."""
    if score >= 0.55:
        return "high"
    if score >= 0.30:
        return "moderate"
    return "low"


# ---------------------------------------------------------------------------
# The nine factors
# ---------------------------------------------------------------------------


def _slack_ratio(ctx, key: str) -> Factor:
    slack = ctx["slack"][key]
    duration = max(ctx["durations"][key], 1.0)
    ratio = slack / duration
    value = _clamp(1.0 - ratio)
    return Factor(
        name="slack_ratio",
        value=value,
        weight=ctx["weights"].slack_ratio,
        reason=(
            f"{slack:.0f} day(s) of slack against {duration:.0f} day(s) of "
            f"work (ratio {ratio:.2f}); "
            + ("no room to absorb a slip." if ratio < 0.25
               else "some room to absorb a slip.")
        ),
        evidence={"slack_days": slack, "duration_days": duration,
                  "ratio": round(ratio, 3)},
    )


def _downstream_fan_out(ctx, key: str) -> Factor:
    downstream = ctx["descendants"][key]
    total = max(len(ctx["task_keys"]) - 1, 1)
    value = _clamp(len(downstream) / total)
    return Factor(
        name="downstream_fan_out",
        value=value,
        weight=ctx["weights"].downstream_fan_out,
        reason=(
            f"blocks {len(downstream)} of {total} other task(s)"
            if downstream else "nothing waits on it."
        ),
        evidence={"downstream_count": len(downstream),
                  "other_task_count": total,
                  "blocks_directly": sorted(ctx["graph"].successors(key))},
    )


def _criticality_proximity(ctx, key: str) -> Factor:
    """Near-zero slack that is not yet zero: a task about to join the critical
    path is a different risk from one already on it."""
    slack = ctx["slack"][key]
    slacks = sorted(ctx["slack"].values())
    rank = slacks.index(slack)
    value = _clamp(1.0 - (rank / max(len(slacks) - 1, 1)))
    return Factor(
        name="criticality_proximity",
        value=value,
        weight=ctx["weights"].criticality_proximity,
        reason=(
            "already on the critical path." if slack <= 1e-9
            else f"{rank + 1}th-tightest slack of {len(slacks)} tasks."
        ),
        evidence={"slack_days": slack, "slack_rank": rank + 1,
                  "task_count": len(slacks),
                  "on_critical_path": slack <= 1e-9},
    )


def _deadline_pressure(ctx, key: str) -> Factor:
    deadline = ctx["deadline_day"]
    if deadline is None:
        return Factor(
            name="deadline_pressure",
            value=0.0,
            weight=ctx["weights"].deadline_pressure,
            reason="no deadline is set, so there is nothing to be late against.",
            evidence={"deadline_day": None},
            available=False,
        )
    late_finish = ctx["LF"][key]
    horizon = max(deadline, ctx["project_end"], 1.0)
    if late_finish > deadline:
        value = _clamp(0.6 + 0.4 * ((late_finish - deadline) / horizon))
        reason = (
            f"its latest allowable finish is day {late_finish:.0f}, already "
            f"past the day-{deadline:.0f} deadline."
        )
    else:
        margin = deadline - late_finish
        value = _clamp(1.0 - (margin / horizon)) * 0.6
        reason = (
            f"{margin:.0f} day(s) between its latest allowable finish and the "
            f"day-{deadline:.0f} deadline."
        )
    return Factor(
        name="deadline_pressure",
        value=value,
        weight=ctx["weights"].deadline_pressure,
        reason=reason,
        evidence={"late_finish_day": late_finish, "deadline_day": deadline,
                  "margin_days": deadline - late_finish},
    )


def _resource_pressure(ctx, key: str) -> Factor:
    """The assignee's committed load during *this task's* window.

    Measured against the resource's own capacity and its descendants' work, so
    a team that caps throughput below its headcount shows up here.
    """
    snapshot: WorkflowSnapshot = ctx["snapshot"]
    assignees = snapshot.assignees_by_task.get(key, ())
    if not assignees:
        return Factor(
            name="resource_pressure",
            value=0.0,
            weight=ctx["weights"].resource_pressure,
            reason="nobody is assigned, so there is no load to measure.",
            evidence={"assignees": []},
            available=False,
        )

    start, end = ctx["ES"][key], ctx["EF"][key]
    worst = 0.0
    detail: dict[str, Any] = {}
    for resource_key in assignees:
        resource = snapshot.resource_by_key.get(resource_key)
        if resource is None:
            continue
        members = set(snapshot.resource_members.get(resource_key, (resource_key,)))
        # Also count the load on any roll-up this resource belongs to.
        chain = [resource]
        parent = snapshot.resource_by_key.get(resource.parent_key or "")
        if parent is not None:
            chain.append(parent)
            members |= set(
                snapshot.resource_members.get(parent.key, (parent.key,))
            )
        for candidate in chain:
            candidate_members = set(snapshot.resource_members.get(
                candidate.key, (candidate.key,)
            ))
            overlapping = [
                other for other in ctx["task_keys"]
                if candidate_members & set(
                    snapshot.assignees_by_task.get(other, ())
                )
                and ctx["ES"][other] < end and ctx["EF"][other] > start
            ]
            demand = len(overlapping)
            capacity = max(candidate.capacity, 1)
            pressure = _clamp((demand - capacity) / capacity)
            if pressure >= worst:
                worst = pressure
                detail = {
                    "resource": candidate.key,
                    "resource_name": candidate.name,
                    "capacity": candidate.capacity,
                    "concurrent_tasks": demand,
                    "overlapping": sorted(overlapping),
                    "window": [start, end],
                }
    if not detail:
        detail = {"assignees": list(assignees)}
    reason = (
        f"{detail.get('resource_name', 'its assignee')} has "
        f"{detail.get('concurrent_tasks', 1)} task(s) scheduled in this window "
        f"against capacity {detail.get('capacity', 1)}."
    )
    return Factor(
        name="resource_pressure",
        value=worst,
        weight=ctx["weights"].resource_pressure,
        reason=reason,
        evidence=detail,
    )


def _duration_uncertainty(ctx, key: str) -> Factor:
    three_point = ctx["three_point"].get(key, {})
    likely = three_point.get("likely") or ctx["durations"][key]
    if likely <= 0:
        spread = 0.0
    else:
        spread = (
            three_point.get("pessimistic", likely)
            - three_point.get("optimistic", likely)
        ) / likely
    task = ctx["snapshot"].task_by_key[key]
    provenance = "three_point_estimate" if task.has_three_point else (
        ctx["spread_provenance"]
    )
    return Factor(
        name="duration_uncertainty",
        value=_clamp(spread),
        weight=ctx["weights"].duration_uncertainty,
        reason=(
            f"estimate spread is {spread:.0%} of the likely duration "
            f"(source: {provenance})."
        ),
        evidence={
            "optimistic": three_point.get("optimistic"),
            "likely": likely,
            "pessimistic": three_point.get("pessimistic"),
            "relative_spread": round(spread, 3),
            "provenance": provenance,
        },
        available=task.has_three_point or provenance != "default",
    )


def _predecessor_health(ctx, key: str) -> Factor:
    state: WorkflowState = ctx["state"]
    if not state.has_history:
        return Factor(
            name="predecessor_health",
            value=0.0,
            weight=ctx["weights"].predecessor_health,
            reason=(
                "no status history yet, so predecessor staleness cannot be "
                "measured."
            ),
            evidence={"has_history": False},
            tier=int(Tier.HISTORICAL),
            available=False,
        )

    incomplete = [
        p for p in ctx["graph"].predecessors(key) if not state.is_done(p)
    ]
    if not incomplete:
        return Factor(
            name="predecessor_health",
            value=0.0,
            weight=ctx["weights"].predecessor_health,
            reason="every predecessor is finished.",
            evidence={"incomplete_predecessors": []},
            tier=int(Tier.HISTORICAL),
        )

    last_event = state.last_event_day
    horizon = max(ctx["config"].idle_threshold * 3, 1.0)
    ages = {
        p: ctx["clock"].today_day - last_event.get(p, 0.0) for p in incomplete
    }
    worst_key = max(ages, key=lambda p: ages[p])
    value = _clamp(ages[worst_key] / horizon)
    return Factor(
        name="predecessor_health",
        value=value,
        weight=ctx["weights"].predecessor_health,
        reason=(
            f"{worst_key} is still {state.status_of(worst_key).value} with no "
            f"activity for {ages[worst_key]:.0f} day(s)."
        ),
        evidence={
            "incomplete_predecessors": sorted(incomplete),
            "worst": worst_key,
            "days_since_activity": round(ages[worst_key], 1),
            "reference_window_days": horizon,
        },
        tier=int(Tier.HISTORICAL),
    )


def _remaining_chain_depth(ctx, key: str) -> Factor:
    state: WorkflowState = ctx["state"]
    downstream = ctx["descendants"][key]
    remaining = sum(
        ctx["durations"][d] for d in downstream if not state.is_done(d)
    )
    total = max(ctx["project_end"], 1.0)
    value = _clamp(remaining / total)
    return Factor(
        name="remaining_chain_depth",
        value=value,
        weight=ctx["weights"].remaining_chain_depth,
        reason=(
            f"{remaining:.0f} day(s) of unfinished work sit behind it, "
            f"{value:.0%} of the whole schedule."
        ),
        evidence={"remaining_downstream_days": remaining,
                  "project_end_day": ctx["project_end"],
                  "downstream_count": len(downstream)},
    )


def _assignment_gap(ctx, key: str) -> Factor:
    assignees = ctx["snapshot"].assignees_by_task.get(key, ())
    critical = ctx["slack"][key] <= 1e-9
    if assignees:
        return Factor(
            name="assignment_gap",
            value=0.0,
            weight=ctx["weights"].assignment_gap,
            reason=f"assigned to {len(assignees)} resource(s).",
            evidence={"assignee_count": len(assignees)},
        )
    value = 1.0 if critical else 0.5
    return Factor(
        name="assignment_gap",
        value=value,
        weight=ctx["weights"].assignment_gap,
        reason=(
            "nobody is assigned, and it is on the critical path."
            if critical else "nobody is assigned."
        ),
        evidence={"assignee_count": 0, "on_critical_path": critical},
    )


def _factor_functions():
    """A tuple, not a module-level list: `core/` holds no mutable module
    state."""
    return (
        _slack_ratio,
        _downstream_fan_out,
        _criticality_proximity,
        _deadline_pressure,
        _resource_pressure,
        _duration_uncertainty,
        _predecessor_health,
        _remaining_chain_depth,
        _assignment_gap,
    )


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------


def _explain(task_key: str, task_name: str, score: float,
             factors: tuple[Factor, ...]) -> str:
    """Prose built from the top contributing factors, in the engine,
    deterministically. The Narrator may rephrase this; it may not originate
    it."""
    ranked = [f for f in sorted(factors, key=lambda f: -f.contribution)
              if f.contribution > 1e-9][:3]
    if not ranked:
        return (
            f"{task_key} ({task_name}) shows no structural exposure: it has "
            f"slack, nothing waits on it, and no deadline pressure."
        )
    reasons = " ".join(
        f"{f.name.replace('_', ' ').capitalize()}: {f.reason}" for f in ranked
    )
    return (
        f"{task_key} ({task_name}) scores {score:.2f} ({_band(score)} "
        f"exposure), driven mainly by "
        f"{', '.join(f.name.replace('_', ' ') for f in ranked)}. {reasons}"
    )


def score_tasks(
    snapshot: WorkflowSnapshot,
    state: WorkflowState,
    clock: Clock,
    sched: dict,
    config: EngineConfig | None = None,
    weights: RiskWeights | None = None,
) -> tuple[list[TaskRisk], dict]:
    """Score every task, and return the assumptions the scores rest on.

    Pure: the same inputs always give the same numbers, and there is nothing
    here the optimizer cannot afford to call per candidate.
    """
    from backend.app.core.engine.effort import three_point_durations
    from backend.app.core.engine.graph import build_graph_from_snapshot

    cfg = config or EngineConfig()
    w = weights or RiskWeights()
    G = build_graph_from_snapshot(snapshot)
    three_point, spread_assumptions = three_point_durations(snapshot, cfg)

    ctx = {
        "snapshot": snapshot,
        "state": state,
        "clock": clock,
        "config": cfg,
        "weights": w,
        "graph": G,
        "task_keys": list(snapshot.task_keys),
        "descendants": {
            key: tuple(sorted(nx.descendants(G, key))) for key in G.nodes
        },
        "ES": sched["ES"],
        "EF": sched["EF"],
        "LF": sched["LF"],
        "slack": sched["slack"],
        "durations": sched["durations"],
        "project_end": sched["project_end"],
        "deadline_day": snapshot.deadline_day,
        "three_point": three_point,
        "spread_provenance": cfg.duration_spread_provenance,
    }

    functions = _factor_functions()
    out: list[TaskRisk] = []
    for key in snapshot.task_keys:
        factors = tuple(fn(ctx, key) for fn in functions)
        score = sum(f.contribution for f in factors)
        name = snapshot.task_by_key[key].name
        out.append(TaskRisk(
            task_key=key,
            task_name=name,
            score=score,
            band=_band(score),
            factors=factors,
            explanation=_explain(key, name, score, factors),
        ))

    out.sort(key=lambda r: (-r.score, r.task_key))

    unavailable = sorted({
        f.name for risk in out for f in risk.factors if not f.available
    })
    assumptions = {
        "score_kind": SCORE_KIND,
        "disclaimer": SCORE_DISCLAIMER,
        "formula": FORMULA,
        "weights": w.as_dict(),
        "weights_total": w.total,
        "duration_spread": {
            "relative_spread": spread_assumptions["default_relative_spread"],
            "provenance": spread_assumptions["spread_source"],
            "tasks_with_three_point_estimate":
                spread_assumptions["tasks_with_three_point_estimate"],
            "tasks_using_spread_prior":
                spread_assumptions["tasks_using_spread_prior"],
        },
        "factors_unavailable": unavailable,
        "factors_unavailable_note": (
            "A factor that cannot be measured contributes 0 and says so, "
            "rather than being guessed at."
        ),
        "resource_contention_modelled": True,
        "rework_modelled": False,
        "monte_carlo_run": False,
        # Phase 11, additive. `monte_carlo_run` above stays false and
        # `what_would_make_this_a_probability` below is unchanged: this score
        # is still a structural estimate and this code path still samples
        # nothing. What changed is that a *separate* payload now exists, and
        # a reader of this one deserves to be told which is which.
        "forecast_offered_separately": (
            "POST /api/projects/{project_id}/forecast samples the tasks' "
            "three-point estimates and returns a probability of meeting the "
            "deadline plus a criticality index per task. That is a different "
            "number from this one, on a different scale, and it is not "
            "calibrated either - it is a probability under a stated model "
            "rather than a validated forecast. This score remains the answer "
            "when there is nothing to sample, and the forecast response says "
            "explicitly which of the two it is reporting."
        ),
        "score_kind_is_not_the_forecast_kind": (
            "structural_estimate ranks exposure given the shape of the "
            "workflow; monte_carlo_probability counts how often something "
            "happened in simulation. Reading a band from one against a number "
            "from the other is a category error."
        ),
        "what_would_make_this_a_probability": (
            "Sampling task durations from calibrated distributions over many "
            "runs, and reporting the fraction in which a task lands on the "
            "critical path (its criticality index). That needs historical "
            "variance this project does not have yet, so it is not offered."
        ),
    }
    return out, assumptions


def summarise(risks: list[TaskRisk], top: int = 5) -> dict:
    """The payload shape the API returns."""
    return {
        "tasks": [r.as_dict() for r in risks],
        "top": [r.as_dict() for r in risks[:top]],
        "band_counts": {
            band: sum(1 for r in risks if r.band == band)
            for band in ("high", "moderate", "low")
        },
    }
