"""
`evaluate(W)` - the second primitive, and the one all four capabilities are
made of (ARCHITECTURE A.0):

    Capability 1 = evaluate(W)
    Capability 2 = evaluate(W) projected forward under uncertainty
    Capability 3 = evaluate(apply(W, D)) diffed against evaluate(W)
    Capability 4 = search over D, scoring each candidate with evaluate()

Pure: no I/O, no ORM, no framework, no clock of its own, and no domain. If you
find yourself writing a second scheduler for simulation or optimization, the
answer is a second call to this function.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from backend.app.core.engine import effort as effort_model
from backend.app.core.engine.cpm import schedule
from backend.app.core.engine.detectors import (
    DetectorContext,
    available_tier,
    run_all,
    unavailable_checks,
)
from backend.app.core.engine.feasibility import ThreePoint, statement, three_point_range
from backend.app.core.engine.findings import Finding, Tier
from backend.app.core.engine.graph import build_graph_from_snapshot, find_cycles
from backend.app.core.engine.risk import RiskWeights, score_tasks
from backend.app.core.engine.risk import summarise as summarise_risk
from backend.app.core.workflow import (
    Clock,
    EngineConfig,
    WorkflowSnapshot,
    WorkflowState,
)

#: Bumped whenever a change would alter numeric output. Persisted on every
#: AnalysisRun, so a stored result can be told apart from a fresh one.
ENGINE_VERSION = "2.3.0-phase4"

def _empty_schedule(durations: dict[str, float]) -> dict:
    """A schedule-shaped object for a workflow that cannot be scheduled.

    Every consumer can then read `schedule["critical"]` without a special
    case, and an unschedulable graph cannot take a page down.
    """
    return {
        "ES": {}, "EF": {}, "LS": {}, "LF": {},
        "slack": {}, "critical": [],
        "project_end": 0.0,
        "durations": dict(durations),
    }


@dataclass
class Feasibility:
    """P0 reports a verdict and a margin, never a probability
    (ARCHITECTURE D.6). An invented percentage is the fastest way to lose a
    technical judge, so there isn't one.
    """

    verdict: str                     # feasible | infeasible | no_deadline_set
    deadline_day: float | None
    projected_end_day: float
    margin_days: float | None        # positive = slack against the deadline
    statement: str
    #: Three deterministic schedule runs, not a distribution. Never a
    #: probability - see `core/engine/feasibility.py`.
    three_point: dict | None = None

    def as_dict(self) -> dict:
        return {
            "verdict": self.verdict,
            "deadline_day": self.deadline_day,
            "projected_end_day": self.projected_end_day,
            "margin_days": self.margin_days,
            "statement": self.statement,
            "three_point": self.three_point,
            "is_probability": False,
        }


@dataclass
class EvaluationResult:
    engine_version: str
    input_hash: str
    schedule: dict
    baseline_schedule: dict
    findings: list[Finding]
    suppressed_findings: list[Finding]
    feasibility: Feasibility
    effort_model: dict
    config: dict
    tier_reached: int
    #: Non-empty only when some resource has an unavailable window. Carries
    #: the per-task adjustment and the statement that it is an approximation.
    resource_unavailability: dict = field(default_factory=dict)
    checks_run: list[str] = field(default_factory=list)
    unavailable_checks: list[dict] = field(default_factory=list)
    schedulable: bool = True
    cycles: list[list[str]] = field(default_factory=list)
    risk: dict[str, Any] = field(default_factory=dict)

    @property
    def projected_end(self) -> float:
        return self.schedule["project_end"]

    @property
    def planned_end(self) -> float:
        return self.baseline_schedule["project_end"]

    @property
    def slip_days(self) -> float:
        return self.projected_end - self.planned_end

    def findings_by_tier(self) -> dict[int, list[Finding]]:
        out: dict[int, list[Finding]] = {}
        for finding in self.findings:
            out.setdefault(int(finding.tier), []).append(finding)
        return out

    def as_dict(self) -> dict:
        """A stable, JSON-safe projection. This is what the domain-leak test
        compares byte for byte, and what an `AnalysisRun` stores."""
        return {
            "engine_version": self.engine_version,
            "input_hash": self.input_hash,
            "schedulable": self.schedulable,
            "cycles": [list(c) for c in self.cycles],
            "planned_end": self.planned_end,
            "projected_end": self.projected_end,
            "slip_days": self.slip_days,
            "critical_path": list(self.schedule["critical"]),
            "schedule": {
                "ES": dict(self.schedule["ES"]),
                "EF": dict(self.schedule["EF"]),
                "LS": dict(self.schedule["LS"]),
                "LF": dict(self.schedule["LF"]),
                "slack": dict(self.schedule["slack"]),
                "durations": dict(self.schedule["durations"]),
                "project_end": self.schedule["project_end"],
            },
            "findings": [f.to_dict() for f in self.findings],
            "suppressed_findings": [f.to_dict() for f in self.suppressed_findings],
            "finding_counts_by_tier": {
                str(tier): len(items)
                for tier, items in sorted(self.findings_by_tier().items())
            },
            "feasibility": self.feasibility.as_dict(),
            "effort_model": self.effort_model,
            "config": self.config,
            "tier_reached": self.tier_reached,
            "resource_unavailability": self.resource_unavailability,
            "checks_run": list(self.checks_run),
            "unavailable_checks": self.unavailable_checks,
            "risk": self.risk,
        }


def _feasibility(
    snapshot: WorkflowSnapshot,
    projected_end: float,
    three_point: ThreePoint | None = None,
) -> Feasibility:
    deadline = snapshot.deadline_day
    margin = None if deadline is None else deadline - projected_end
    verdict = (
        "no_deadline_set" if deadline is None
        else "feasible" if margin >= 0
        else "infeasible"
    )
    return Feasibility(
        verdict=verdict,
        deadline_day=deadline,
        projected_end_day=projected_end,
        margin_days=margin,
        statement=statement(verdict, projected_end, deadline, margin, three_point),
        three_point=three_point.as_dict() if three_point else None,
    )


def evaluate(
    snapshot: WorkflowSnapshot,
    state: WorkflowState | None = None,
    clock: Clock | None = None,
    config: EngineConfig | None = None,
    weights: RiskWeights | None = None,
) -> EvaluationResult:
    """Schedule the workflow, detect what is wrong with it, and say how far
    the evidence reached.

    `state=None` means cold start: every task not started, no history. That is
    a first-class case, not an error - it is what a judge creating their own
    project will hit, and it still returns real structural findings plus an
    explicit list of what cannot be assessed yet.

    A cyclic workflow does not raise. It returns `schedulable=False`, the
    cycles, and a `dependency_cycle` finding - which is far more useful to a
    UI than an exception, and means a bad graph cannot take the page down.
    """
    st = state if state is not None else WorkflowState.empty(snapshot)
    clk = clock or Clock()
    cfg = config or EngineConfig()

    G = build_graph_from_snapshot(snapshot)
    planned, model = effort_model.planned_durations(snapshot, cfg)

    cycles = find_cycles(G)
    if cycles:
        ctx = DetectorContext(
            graph=G,
            schedule=_empty_schedule(planned),
            snapshot=snapshot,
            state=st,
            clock=clk,
            config=cfg,
        )
        from backend.app.core.engine.detectors import tier0

        return EvaluationResult(
            engine_version=ENGINE_VERSION,
            input_hash=snapshot.content_hash(),
            schedule=_empty_schedule(planned),
            baseline_schedule=_empty_schedule(planned),
            findings=tier0.cycles(ctx),
            suppressed_findings=[],
            feasibility=Feasibility(
                verdict="unschedulable",
                deadline_day=snapshot.deadline_day,
                projected_end_day=0.0,
                margin_days=None,
                statement=(
                    "This workflow contains a circular dependency, so it has "
                    "no finish date to compare against a deadline. Break the "
                    "cycle first."
                ),
            ),
            effort_model=model.as_dict(),
            config=cfg.as_dict(),
            tier_reached=int(Tier.STRUCTURAL),
            checks_run=["dependency_cycle"],
            unavailable_checks=unavailable_checks(Tier.STRUCTURAL),
            schedulable=False,
            cycles=cycles,
        )

    observed = effort_model.observed_durations(snapshot, st, clk, cfg)
    baseline = schedule(G, planned)
    current = schedule(G, observed)

    # Resource unavailability is applied against the resource-blind schedule,
    # in one pass, and reported as the approximation it is.
    adjusted, unavailability = effort_model.apply_unavailability(
        snapshot, observed, current
    )
    if unavailability:
        current = schedule(G, adjusted)
    # The slip detector needs both, and a detector only ever sees `ctx`.
    current_with_baseline = {
        **current,
        "baseline_project_end": baseline["project_end"],
    }

    three_point = three_point_range(snapshot, G, adjusted if unavailability else observed, cfg)

    tier = available_tier(st)
    ctx = DetectorContext(
        graph=G,
        schedule=current_with_baseline,
        snapshot=snapshot,
        state=st,
        clock=clk,
        config=cfg,
    )
    active, suppressed, ran = run_all(ctx, tier)

    # Capability 2, Layer A. Pure arithmetic over the schedule already
    # computed, so it costs the optimizer nothing extra per candidate.
    risks, risk_assumptions = score_tasks(
        snapshot, st, clk, current, cfg, weights or RiskWeights()
    )

    return EvaluationResult(
        engine_version=ENGINE_VERSION,
        input_hash=snapshot.content_hash(),
        schedule=current,
        baseline_schedule=baseline,
        findings=active,
        suppressed_findings=suppressed,
        feasibility=_feasibility(snapshot, current["project_end"], three_point),
        effort_model=model.as_dict(),
        config=cfg.as_dict(),
        tier_reached=int(tier),
        resource_unavailability=unavailability,
        checks_run=ran,
        unavailable_checks=unavailable_checks(tier),
        risk={**summarise_risk(risks), "assumptions": risk_assumptions},
    )
