"""
Capability 3 - what-if simulation, as `evaluate(apply(W, D))` diffed against
`evaluate(W)`.

There is no second scheduler here. A scenario is materialised in memory and
handed to the same `evaluate()` that Capability 1 uses, which is the whole
point of the spine (ARCHITECTURE A.0): if simulation had its own scheduling
code, the two would drift and only one of them would be right.

A separately testable service inside `core/`, not logic embedded in an API
handler. Nothing in this module performs I/O, so what-if **physically cannot**
mutate real state.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from backend.app.core.engine.cpm import diff as schedule_diff
from backend.app.core.engine.evaluate import EvaluationResult, evaluate
from backend.app.core.mutations import (
    Mutation,
    ValidationResult,
    apply_all,
    validate_all,
)
from backend.app.core.workflow import (
    Clock,
    EngineConfig,
    WorkflowSnapshot,
    WorkflowState,
)


@dataclass(frozen=True, slots=True)
class Scenario:
    """`base + an ordered list of typed mutations`.

    Cheap, ephemeral, disposable, and it never touches the base. The base is
    an immutable snapshot and every applier returns a new one, so "the
    original workflow remains unchanged" is a property of the types rather
    than a promise in a docstring - and it is asserted on the content hash by
    `test_simulation.py`.
    """

    base: WorkflowSnapshot
    base_state: WorkflowState
    mutations: tuple[Mutation, ...] = ()
    name: str = ""
    origin: str = "user_whatif"
    rationale: str = ""

    def with_mutation(self, mutation: Mutation) -> "Scenario":
        from dataclasses import replace

        return replace(self, mutations=self.mutations + (mutation,))

    def validate(self) -> ValidationResult:
        return validate_all(self.base, self.base_state, list(self.mutations))

    def materialize(self) -> tuple[WorkflowSnapshot, WorkflowState, list[Mutation]]:
        """Base + mutations, in memory. Returns the new pair and the inverse
        list, so a scenario can be undone by replaying it backwards."""
        return apply_all(self.base, self.base_state, list(self.mutations))


@dataclass
class SimulationResult:
    scenario_name: str
    origin: str
    #: The base's content hash, captured before and after evaluation. If these
    #: two differ, the immutability guarantee is broken.
    base_hash_before: str
    base_hash_after: str
    after_hash: str
    base: EvaluationResult
    after: EvaluationResult
    validation: ValidationResult
    mutations: list[dict] = field(default_factory=list)
    inverse_mutations: list[dict] = field(default_factory=list)
    comparison: dict[str, Any] = field(default_factory=dict)

    @property
    def base_unchanged(self) -> bool:
        return self.base_hash_before == self.base_hash_after

    def as_dict(self) -> dict:
        return {
            "scenario_name": self.scenario_name,
            "origin": self.origin,
            "validation": self.validation.as_dict(),
            "mutations": self.mutations,
            "inverse_mutations": self.inverse_mutations,
            "base_version_hash": self.base_hash_before,
            "base_version_hash_after_evaluation": self.base_hash_after,
            "base_unchanged": self.base_unchanged,
            "scenario_hash": self.after_hash,
            "base": self.base.as_dict(),
            "after": self.after.as_dict(),
            "comparison": self.comparison,
        }


def _overload_by_resource(result: EvaluationResult) -> dict[str, dict]:
    """Peak concurrent demand per resource, from the overload findings."""
    out: dict[str, dict] = {}
    for finding in list(result.findings) + list(result.suppressed_findings):
        if finding.kind != "resource_overallocated":
            continue
        out[str(finding.root_cause)] = {
            "capacity": finding.evidence["capacity"],
            "peak_concurrent_tasks": finding.evidence["peak_concurrent_tasks"],
            "overflow": finding.evidence["overflow"],
            "resource_name": finding.evidence["resource_name"],
        }
    return out


def _finding_refs(result: EvaluationResult) -> dict[tuple[str, str], Any]:
    return {
        (f.kind, str(f.root_cause)): f for f in result.findings
    }


def _compare(
    before: EvaluationResult,
    after: EvaluationResult,
    base: WorkflowSnapshot,
    changed: WorkflowSnapshot,
) -> dict:
    """The diff payload ARCHITECTURE D.3 specifies, in full.

    Every number here comes from two `evaluate()` calls. Nothing is estimated
    and nothing is narrated.
    """
    sched = schedule_diff(before.schedule, after.schedule)

    before_refs = _finding_refs(before)
    after_refs = _finding_refs(after)
    created = [after_refs[k].to_dict() for k in after_refs.keys() - before_refs.keys()]
    removed = [before_refs[k].to_dict() for k in before_refs.keys() - after_refs.keys()]
    still = sorted(before_refs.keys() & after_refs.keys())

    moved = [
        {
            "task": key,
            "name": (changed.task_by_key.get(key) or base.task_by_key[key]).name,
            "from_day": m["from"],
            "to_day": m["to"],
            "delta_days": m["delta"],
        }
        for key, m in sorted(
            sched["tasks_moved"].items(), key=lambda kv: -kv[1]["delta"]
        )
    ]

    overload_before = _overload_by_resource(before)
    overload_after = _overload_by_resource(after)

    tasks_added = sorted(set(changed.task_keys) - set(base.task_keys))
    tasks_removed = sorted(set(base.task_keys) - set(changed.task_keys))
    edges_before = set(base.dependency_by_edge)
    edges_after = set(changed.dependency_by_edge)

    return {
        "projected_completion": {
            "before_day": before.projected_end,
            "after_day": after.projected_end,
            "delta_days": after.projected_end - before.projected_end,
            "direction": (
                "earlier" if after.projected_end < before.projected_end
                else "later" if after.projected_end > before.projected_end
                else "unchanged"
            ),
        },
        "tasks_moved": moved,
        "tasks_moved_count": len(moved),
        "slack_consumed": sched["slack_consumed"],
        "slack_consumed_total_days": sum(sched["slack_consumed"].values()),
        "critical_path": {
            "before": list(before.schedule["critical"]),
            "after": list(after.schedule["critical"]),
            "changed": sched["critical_path_changed"],
            "newly_critical": sched["newly_critical"],
            "no_longer_critical": sched["no_longer_critical"],
        },
        "findings": {
            "before_count": len(before.findings),
            "after_count": len(after.findings),
            "created": created,
            "removed": removed,
            "unchanged": [f"{kind}@{root}" for kind, root in still],
        },
        "resource_overload": {
            "before": overload_before,
            "after": overload_after,
            "resolved": sorted(overload_before.keys() - overload_after.keys()),
            "introduced": sorted(overload_after.keys() - overload_before.keys()),
        },
        "feasibility": {
            "before": before.feasibility.as_dict(),
            "after": after.feasibility.as_dict(),
            "margin_delta_days": (
                after.feasibility.margin_days - before.feasibility.margin_days
                if (
                    after.feasibility.margin_days is not None
                    and before.feasibility.margin_days is not None
                )
                else None
            ),
            "verdict_changed": (
                before.feasibility.verdict != after.feasibility.verdict
            ),
        },
        "structure": {
            "tasks_added": tasks_added,
            "tasks_removed": tasks_removed,
            "dependencies_added": [
                list(e) for e in sorted(edges_after - edges_before)
            ],
            "dependencies_removed": [
                list(e) for e in sorted(edges_before - edges_after)
            ],
            "total_effort_before": base.total_effort(),
            "total_effort_after": changed.total_effort(),
            "total_effort_delta": changed.total_effort() - base.total_effort(),
        },
        "effort_model": after.effort_model,
    }


def simulate(
    scenario: Scenario,
    clock: Clock | None = None,
    config: EngineConfig | None = None,
) -> SimulationResult:
    """Evaluate a scenario and diff it against its base.

    Writes nothing. Returns the base's content hash captured before *and*
    after the evaluation, so "the original workflow is provably unchanged" is
    something the caller can check rather than trust.
    """
    clk = clock or Clock()
    cfg = config or EngineConfig()

    hash_before = scenario.base.content_hash()
    validation = scenario.validate()

    if not validation.valid:
        # A rejected scenario still returns the base evaluation, so the UI can
        # show "here is where you are, and here is why we will not do that".
        base_result = evaluate(scenario.base, scenario.base_state, clk, cfg)
        return SimulationResult(
            scenario_name=scenario.name,
            origin=scenario.origin,
            base_hash_before=hash_before,
            base_hash_after=scenario.base.content_hash(),
            after_hash=hash_before,
            base=base_result,
            after=base_result,
            validation=validation,
            mutations=[m.as_dict() for m in scenario.mutations],
            comparison={},
        )

    changed, changed_state, inverses = scenario.materialize()
    base_result = evaluate(scenario.base, scenario.base_state, clk, cfg)
    after_result = evaluate(changed, changed_state, clk, cfg)

    return SimulationResult(
        scenario_name=scenario.name,
        origin=scenario.origin,
        base_hash_before=hash_before,
        base_hash_after=scenario.base.content_hash(),
        after_hash=changed.content_hash(),
        base=base_result,
        after=after_result,
        validation=validation,
        mutations=[m.as_dict() for m in scenario.mutations],
        inverse_mutations=[m.as_dict() for m in inverses],
        comparison=_compare(base_result, after_result, scenario.base, changed),
    )


def summarise(result: SimulationResult) -> str:
    """A deterministic, template-rendered one-liner.

    This is the Narrator's fallback under `NullProvider`: the engine can always
    describe its own result, so language is never a capability the LLM adds.
    """
    if not result.validation.valid:
        reasons = "; ".join(r.reason for r in result.validation.rejections)
        return f"Not simulated: {reasons}"

    c = result.comparison["projected_completion"]
    parts = [
        f"{len(result.mutations)} change(s) move projected completion from day "
        f"{c['before_day']:.0f} to day {c['after_day']:.0f} "
        f"({c['delta_days']:+.0f} days)."
    ]
    moved = result.comparison["tasks_moved_count"]
    if moved:
        parts.append(f"{moved} task(s) shift.")
    created = len(result.comparison["findings"]["created"])
    removed = len(result.comparison["findings"]["removed"])
    if removed:
        parts.append(f"{removed} finding(s) resolved.")
    if created:
        parts.append(f"{created} new finding(s) appear.")
    feas = result.comparison["feasibility"]
    if feas["verdict_changed"]:
        parts.append(
            f"Feasibility goes from {feas['before']['verdict']} to "
            f"{feas['after']['verdict']}."
        )
    effort_delta = result.comparison["structure"]["total_effort_delta"]
    if abs(effort_delta) > 1e-9:
        parts.append(f"Total effort changes by {effort_delta:+.1f} days.")
    parts.append("The base workflow is unchanged.")
    return " ".join(parts)
