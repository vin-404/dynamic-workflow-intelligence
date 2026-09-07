"""
The detector registry.

A detector is a pure function `(DetectorContext) -> Finding[]` registered by
name with a **declared data tier** (ARCHITECTURE D.1, D.2). Declaring the tier
is what lets `evaluate()` answer two questions instead of one: what is wrong
with this workflow, and what could it not yet assess.

The registry is assembled by a function returning a tuple rather than by a
decorator writing into a module-level list, because `core/` holds no mutable
module state - that is enforced by `test_core_purity.py` and it is the
precondition for evaluating optimizer candidates concurrently.
"""
from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import Callable

from backend.app.core.engine.detectors import tier0, tier1, tier2
from backend.app.core.engine.detectors.context import DetectorContext
from backend.app.core.engine.findings import (
    TIER_REQUIRES,
    TIER_UNLOCKED_BY,
    Finding,
    Tier,
    rank,
)

DetectorFn = Callable[[DetectorContext], list[Finding]]


@dataclass(frozen=True, slots=True)
class Detector:
    name: str
    tier: Tier
    fn: DetectorFn
    #: One line, shown to the user when this check could not be run.
    detects: str

    def __call__(self, ctx: DetectorContext) -> list[Finding]:
        return self.fn(ctx)


def all_detectors() -> tuple[Detector, ...]:
    """Every detector, in tier order. Adding one is a single line here."""
    return (
        # -- Tier 0: structural. Always available, even on an empty history.
        Detector(
            "dependency_cycle", Tier.STRUCTURAL, tier0.cycles,
            "circular dependencies, reported with the actual cycle",
        ),
        Detector(
            "deadline_infeasible", Tier.STRUCTURAL, tier0.deadline_infeasible,
            "a plan that cannot meet its deadline on structure alone",
        ),
        Detector(
            "single_point_of_failure", Tier.STRUCTURAL,
            tier0.single_point_of_failure,
            "one task many others wait on directly",
        ),
        Detector(
            "serial_chain_no_parallelism", Tier.STRUCTURAL,
            tier0.serial_chain_no_parallelism,
            "long single-file runs of work with nothing beside them",
        ),
        Detector(
            "zero_slack_chain", Tier.STRUCTURAL, tier0.zero_slack_chain,
            "a workflow with too little slack to absorb any delay",
        ),
        Detector(
            "critical_path_single_owner", Tier.STRUCTURAL,
            tier0.critical_path_single_owner,
            "a critical path owned end to end by one person",
        ),
        Detector(
            "resource_overallocated", Tier.STRUCTURAL,
            tier0.resource_overallocated,
            "a resource the plan needs in more places at once than it can be",
        ),
        Detector(
            "unassigned_critical_task", Tier.STRUCTURAL,
            tier0.unassigned_critical_task,
            "critical-path work with nobody on it",
        ),
        Detector(
            "redundant_dependency", Tier.STRUCTURAL, tier0.redundant_dependency,
            "dependencies already implied by a longer path",
        ),
        Detector(
            "isolated_task", Tier.STRUCTURAL, tier0.isolated_task,
            "tasks connected to nothing in an otherwise connected workflow",
        ),
        # -- Tier 1: stateful. Needs statuses and assignments.
        Detector(
            "critical_path_blocker", Tier.STATEFUL, tier1.critical_path_blocker,
            "zero-slack work held up by an unfinished predecessor, named at "
            "its root cause",
        ),
        Detector(
            "resource_contention", Tier.STATEFUL, tier1.resource_contention,
            "more work ready right now than a resource can pick up",
        ),
        Detector(
            "projected_vs_planned_finish", Tier.STATEFUL,
            tier1.projected_vs_planned_finish,
            "a projection already later than the plan, and what is driving it",
        ),
        # -- Tier 2: historical. Needs the event log.
        Detector(
            "stalled_in_review", Tier.HISTORICAL, tier2.stalled_in_review,
            "work sitting in review with nothing happening to it",
        ),
        Detector(
            "ready_but_idle", Tier.HISTORICAL, tier2.ready_but_idle,
            "unblocked work nobody started, aged from when it became workable",
        ),
    )


#: Checks that exist as a design commitment but are not implemented yet. They
#: appear in `unavailable_checks` so the roadmap is visible to the user rather
#: than only to us, and so nothing here can be mistaken for something that ran
#: and found nothing.
PLANNED_CHECKS: tuple[tuple[Tier, str, str], ...] = (
    (Tier.HISTORICAL, "handoff_latency",
     "how long work waits between owners"),
    (Tier.HISTORICAL, "rework_loop",
     "tasks that returned to an earlier status more than once"),
    (Tier.CROSS_PROJECT, "chronic_underestimation",
     "estimates that are systematically low, calibrated from past actuals"),
    (Tier.CROSS_PROJECT, "per_resource_velocity",
     "how fast each resource actually completes work"),
    (Tier.CROSS_PROJECT, "calibrated_duration_variance",
     "a real duration spread instead of an assumed one"),
)


def available_tier(ctx_state) -> Tier:
    """How far the evidence reaches.

    Tier 0 always. Tier 1 once any task has moved off `not_started`. Tier 2
    once there is an event log. Tier 3 needs actuals from other projects,
    which this system does not collect yet, so it is never reached.
    """
    tier = Tier.STRUCTURAL
    if ctx_state.has_statuses:
        tier = Tier.STATEFUL
    if ctx_state.has_history:
        tier = Tier.HISTORICAL
    return tier


def unavailable_checks(reached: Tier) -> list[dict]:
    """Every check that could not run, with what it needs and why.

    This is the honest half of cold start. A fresh workflow gets real Tier-0
    findings *plus* this list, rather than an empty panel that implies nothing
    is wrong.
    """
    out: list[dict] = []
    by_tier: dict[Tier, list[str]] = {}

    for det in all_detectors():
        if det.tier > reached:
            by_tier.setdefault(det.tier, []).append(f"{det.name}: {det.detects}")
    for tier, name, detects in PLANNED_CHECKS:
        if tier > reached:
            by_tier.setdefault(tier, []).append(f"{name}: {detects} (not built yet)")

    for tier in sorted(by_tier):
        out.append({
            "tier": int(tier),
            "checks": by_tier[tier],
            "requires": TIER_REQUIRES[tier],
            "why": _WHY[tier],
            "unlocked_by": TIER_UNLOCKED_BY[tier],
        })
    return out


_WHY = MappingProxyType({
    Tier.STRUCTURAL: (
        "Structural analysis needs at least one task and one dependency."
    ),
    Tier.STATEFUL: (
        "No task has moved off not_started, so there is no way to tell which "
        "work is actually held up as opposed to merely scheduled later."
    ),
    Tier.HISTORICAL: (
        "Aging and staleness are measured from when a status changed. With no "
        "recorded history there is no elapsed time to measure."
    ),
    Tier.CROSS_PROJECT: (
        "Calibration needs actuals from outside this project. Until then the "
        "duration spread is an assumption, and it is labelled as one."
    ),
})


def run_all(
    ctx: DetectorContext,
    reached: Tier | None = None,
) -> tuple[list[Finding], list[Finding], list[str]]:
    """Run every detector the evidence supports.

    Returns `(active, suppressed, ran)`:

    * `active` - findings to act on, ranked by impact
    * `suppressed` - findings another detector fully accounts for, each
      carrying the reason it was suppressed. Kept rather than dropped, so a
      suppression is auditable.
    * `ran` - the names of the detectors that actually executed, so a caller
      can distinguish "checked and clean" from "never checked"
    """
    tier = reached if reached is not None else available_tier(ctx.state)

    findings: list[Finding] = []
    ran: list[str] = []
    for det in all_detectors():
        if det.tier > tier:
            continue
        ran.append(det.name)
        findings.extend(det(ctx))

    findings = tier2.suppress_idle_explained_by_contention(findings, ctx)

    active = rank([f for f in findings if not f.is_suppressed])
    suppressed = rank([f for f in findings if f.is_suppressed])
    return active, suppressed, ran


__all__ = [
    "Detector",
    "DetectorContext",
    "all_detectors",
    "available_tier",
    "run_all",
    "unavailable_checks",
    "PLANNED_CHECKS",
]
