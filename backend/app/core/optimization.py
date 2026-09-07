"""
Capability 4 - optimization as generate-and-verify search.

This is the capability most likely to be hand-waved, so it is a search loop and
nothing more mysterious than that (ARCHITECTURE D.5):

    1. generate candidates, each a real `Scenario` of typed mutations
    2. gate them against hard constraints, **before** anything is scored
    3. score every survivor with `core.evaluate()` - never with a model
    4. return the per-criterion table, the weights, and the rejections

Three properties this module is built around:

* **The scorer never calls the AI module.** It cannot: `core/` may not import
  it, and the purity test enforces that. In Phase 7 the LLM becomes a third
  candidate *source* and is scored by exactly this code.
* **The gates come first.** An unconstrained optimizer's best move is always
  "delete the slow task". Rejections are returned with the constraint cited,
  because a system that refuses and explains why is worth more than one that
  finds a miraculous improvement.
* **The search is bounded.** `max_candidates` and a caller-supplied
  `should_stop` - `core/` has no clock of its own, so the time budget is
  injected, the same way `Clock` is.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any, Callable, Iterable

import networkx as nx

from backend.app.core.engine.evaluate import EvaluationResult, evaluate
from backend.app.core.engine.graph import (
    build_graph_from_snapshot,
    find_cycles,
    transitive_redundant_edges,
)
from backend.app.core.mutations import (
    Mutation,
    MutationKind as K,
    Rejection,
    ValidationResult,
    apply_all,
    validate_all,
)
from backend.app.core.simulation import Scenario, _compare
from backend.app.core.workflow import (
    Clock,
    ConstraintKind,
    DependencySpec,
    EngineConfig,
    WorkflowSnapshot,
    WorkflowState,
)


# ---------------------------------------------------------------------------
# Objectives
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ObjectiveWeights:
    """Weights are **inputs** and are echoed in every response.

    A single blended number with invisible weights is exactly what this reset
    is meant to eliminate (ARCHITECTURE H, risk #5), so the per-criterion
    table is always returned alongside the total and the total is never
    returned on its own.
    """

    expected_completion: float = 0.35
    feasibility_margin: float = 0.20
    peak_resource_overload: float = 0.15
    structural_risk: float = 0.15
    dependency_complexity: float = 0.10
    parallelization: float = 0.05

    def as_dict(self) -> dict[str, float]:
        return {
            "expected_completion": self.expected_completion,
            "feasibility_margin": self.feasibility_margin,
            "peak_resource_overload": self.peak_resource_overload,
            "structural_risk": self.structural_risk,
            "dependency_complexity": self.dependency_complexity,
            "parallelization": self.parallelization,
        }

    @property
    def total(self) -> float:
        return sum(self.as_dict().values())


@dataclass(frozen=True, slots=True)
class Budget:
    """Never unbounded. `should_stop` is supplied by the caller because
    `core/` has no clock of its own."""

    max_candidates: int = 40
    max_seconds: float | None = 5.0

    def as_dict(self) -> dict:
        return {
            "max_candidates": self.max_candidates,
            "max_seconds": self.max_seconds,
        }


@dataclass(frozen=True, slots=True)
class Criterion:
    name: str
    before: float
    after: float
    delta: float
    #: Normalised improvement in [-1, 1]. Positive is always better, whichever
    #: direction the raw number moves.
    improvement: float
    weight: float
    better: str          # "lower" | "higher"
    unit: str
    explanation: str

    @property
    def contribution(self) -> float:
        return self.weight * self.improvement

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "before": round(self.before, 4),
            "after": round(self.after, 4),
            "delta": round(self.delta, 4),
            "improvement": round(self.improvement, 4),
            "weight": self.weight,
            "contribution": round(self.contribution, 4),
            "better": self.better,
            "unit": self.unit,
            "explanation": self.explanation,
        }


@dataclass(frozen=True, slots=True)
class Score:
    criteria: tuple[Criterion, ...]

    @property
    def total(self) -> float:
        return sum(c.contribution for c in self.criteria)

    def as_dict(self) -> dict:
        return {
            "total": round(self.total, 4),
            "formula": "total = sum(weight_i * improvement_i)",
            "note": (
                "The total is a ranking aid, not a measurement. The "
                "per-criterion table below is the result; read that."
            ),
            "criteria": [c.as_dict() for c in self.criteria],
        }


@dataclass
class Candidate:
    name: str
    generator: str
    rationale: str
    mutations: tuple[Mutation, ...]
    origin: str = "heuristic_proposal"
    #: Populated once evaluated.
    score: Score | None = None
    comparison: dict[str, Any] = field(default_factory=dict)
    rejections: tuple[Rejection, ...] = ()
    evaluated: bool = False
    #: Set when the candidate changes how much work there is, rather than only
    #: its sequence or allocation. Priced in the open, never buried.
    effort_delta: float = 0.0

    @property
    def rejected(self) -> bool:
        return bool(self.rejections)

    @property
    def scope_change(self) -> bool:
        return abs(self.effort_delta) > 1e-9

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "generator": self.generator,
            "origin": self.origin,
            "rationale": self.rationale,
            "mutations": [m.as_dict() for m in self.mutations],
            "mutation_summary": [m.describe() for m in self.mutations],
            "rejected": self.rejected,
            "scope_change": self.scope_change,
            "effort_delta_days": round(self.effort_delta, 4),
            "scope_change_note": (
                f"This candidate changes total effort by "
                f"{self.effort_delta:+.1f} day(s): it does a different amount "
                f"of work, not the same work differently."
                if self.scope_change else None
            ),
            "constraint_violations": [r.as_dict() for r in self.rejections],
            "evaluated": self.evaluated,
            "scores": self.score.as_dict() if self.score else None,
            "deltas": self.comparison.get("projected_completion", {}),
            "comparison": self.comparison,
        }


# ---------------------------------------------------------------------------
# Hard constraint gates - run BEFORE scoring
# ---------------------------------------------------------------------------


def _lineage(mutations: Iterable[Mutation]) -> dict[str, set[str]]:
    """Original task key -> the keys that now carry its work.

    A `TASK_SPLIT` replaces `T02` with `T02.1` and `T02.2`, and rewires every
    predecessor to every part and every part to every successor. So the work
    is still there and the ordering is still there - only the endpoint names
    changed. Without tracking that, the gates would refuse a split of a
    mandatory task, and refuse a split of any task on an immutable
    dependency, reporting "this candidate drops T02 -> T03" when the candidate
    did no such thing. A misleading refusal is worse than none.
    """
    out: dict[str, set[str]] = {}

    def resolve(key: str) -> set[str]:
        return out.get(key, {key})

    for mutation in mutations:
        if mutation.kind is K.TASK_SPLIT:
            key = str(mutation.payload["key"])
            parts = int(mutation.payload["parts"])
            part_keys = list(
                mutation.payload.get("part_keys")
                or [f"{key}.{i + 1}" for i in range(parts)]
            )
            out[key] = set(part_keys)
        elif mutation.kind is K.TASK_MERGE:
            into = str(mutation.payload["into_key"])
            for key in mutation.payload["keys"]:
                out[str(key)] = {into}
        elif mutation.kind is K.TASK_ADD:
            out.setdefault(str(mutation.payload["key"]), set())
            out[str(mutation.payload["key"])] = {str(mutation.payload["key"])}

    # Collapse chains (split then merge).
    for key in list(out):
        resolved: set[str] = set()
        frontier = set(out[key])
        while frontier:
            current = frontier.pop()
            nxt = out.get(current)
            if nxt and nxt != {current}:
                frontier |= nxt
            else:
                resolved.add(current)
        out[key] = resolved
    return out


def gate(
    base: WorkflowSnapshot,
    base_state: WorkflowState,
    candidate: WorkflowSnapshot,
    mutations: Iterable[Mutation],
) -> tuple[Rejection, ...]:
    """Refuse a candidate that breaks something the user declared inviolable.

    The mutation validator already refuses most of these one mutation at a
    time. This is the second gate, run against the **materialised** result,
    because a composition of individually-valid mutations can still land
    somewhere forbidden - and because "total effort may not silently
    decrease" is only checkable once everything has been applied.

    Every rejection cites the constraint and the reason on record. That is the
    demo beat: asked to optimize freely, the system declines to remove the
    budget approval and says why.
    """
    out: list[Rejection] = []
    mutations = list(mutations)
    base_keys = set(base.task_keys)
    candidate_keys = set(candidate.task_keys)
    lineage = _lineage(mutations)

    def carriers(key: str) -> set[str]:
        """The keys that now carry `key`'s work, if any still exist."""
        return {k for k in lineage.get(key, {key}) if k in candidate_keys}

    # 1. MANDATORY_TASK cannot be removed. Splitting it is not removing it -
    #    the work is still there, divided - and `TASK_SPLIT` already refuses
    #    a task carrying a NON_DIVISIBLE_TASK constraint, which is the right
    #    tool for "this one must stay whole".
    for constraint in base.constraints_of(ConstraintKind.MANDATORY_TASK):
        if constraint.target not in base_keys:
            continue
        if not carriers(constraint.target):
            out.append(Rejection(
                kind="CANDIDATE",
                reason=(
                    f"This candidate removes {constraint.target}, which is a "
                    f"mandatory task."
                ),
                constraint=ConstraintKind.MANDATORY_TASK.value,
                constraint_reason=constraint.reason,
            ))

    # 2. IMMUTABLE_DEPENDENCY cannot be dropped. The *relationship* has to
    #    survive, not the literal pair of names: if either endpoint was split,
    #    the ordering is preserved when every carrier of the predecessor still
    #    precedes every carrier of the successor.
    candidate_edges = set(candidate.dependency_by_edge)
    reachable = None
    for constraint in base.constraints_of(ConstraintKind.IMMUTABLE_DEPENDENCY):
        if "->" not in constraint.target:
            continue
        left, right = constraint.target.split("->", 1)
        if (left, right) not in base.dependency_by_edge:
            continue

        left_carriers = carriers(left)
        right_carriers = carriers(right)
        if not left_carriers or not right_carriers:
            preserved = False
        elif all(
            (a, b) in candidate_edges
            for a in left_carriers for b in right_carriers
        ):
            preserved = True
        else:
            # Fall back to reachability: an indirect path still enforces the
            # ordering, which is what the constraint is protecting.
            if reachable is None:
                reachable = build_graph_from_snapshot(candidate)
            preserved = all(
                a != b and nx.has_path(reachable, a, b)
                for a in left_carriers for b in right_carriers
            )

        if not preserved:
            out.append(Rejection(
                kind="CANDIDATE",
                reason=(
                    f"This candidate breaks the ordering {left} -> {right}, "
                    f"which is an immutable dependency."
                ),
                constraint=ConstraintKind.IMMUTABLE_DEPENDENCY.value,
                constraint_reason=constraint.reason,
            ))

    # 3. NON_DIVISIBLE_TASK cannot be split.
    for mutation in mutations:
        if mutation.kind is not K.TASK_SPLIT:
            continue
        target = mutation.payload.get("key")
        if target and not base.is_divisible(str(target)):
            out.append(Rejection(
                kind="CANDIDATE",
                reason=f"This candidate splits {target}, which cannot be divided.",
                constraint=ConstraintKind.NON_DIVISIBLE_TASK.value,
                constraint_reason=base.constraint_reason(
                    ConstraintKind.NON_DIVISIBLE_TASK, str(target)
                ) or "The task is marked non-divisible.",
            ))

    # 4. Skill requirements must be satisfied by any reassignment.
    for task in candidate.tasks:
        required = set(task.required_skills)
        if not required:
            continue
        assignees = candidate.assignees_by_task.get(task.key, ())
        if not assignees:
            continue
        covered: set[str] = set()
        for resource_key in assignees:
            resource = candidate.resource_by_key.get(resource_key)
            if resource is not None:
                covered |= set(resource.skills)
        if not required & covered:
            out.append(Rejection(
                kind="CANDIDATE",
                reason=(
                    f"This candidate assigns {task.key} to "
                    f"{', '.join(assignees)}, who lack the skills it requires "
                    f"({', '.join(sorted(required))})."
                ),
                constraint="SKILL_REQUIREMENT",
                constraint_reason=(
                    f"{task.key} requires {', '.join(sorted(required))}."
                ),
            ))

    # 5. FIXED_ASSIGNMENT must survive.
    for constraint in base.constraints_of(ConstraintKind.FIXED_ASSIGNMENT):
        target = constraint.target.split(":")[0]
        keys = carriers(target)
        if not keys:
            continue
        before = set(base.assignees_by_task.get(target, ()))
        after: set[str] = set()
        for key in keys:
            after |= set(candidate.assignees_by_task.get(key, ()))
        if before and not before <= after:
            out.append(Rejection(
                kind="CANDIDATE",
                reason=f"This candidate reassigns {target}, whose assignment is fixed.",
                constraint=ConstraintKind.FIXED_ASSIGNMENT.value,
                constraint_reason=constraint.reason,
            ))

    # 6. MIN_DURATION floors must hold. A split divides the effort across
    #    parts, so the floor applies to the parts' total - splitting a task
    #    with a contractual lead time does not shorten the lead time.
    for constraint in base.constraints_of(ConstraintKind.MIN_DURATION):
        if constraint.value is None:
            continue
        keys = carriers(constraint.target)
        if not keys:
            continue
        total = sum(
            candidate.task_by_key[k].effort
            for k in keys if k in candidate.task_by_key
        )
        if total < constraint.value - 1e-9:
            out.append(Rejection(
                kind="CANDIDATE",
                reason=(
                    f"This candidate leaves {constraint.target} at {total:g} "
                    f"day(s) of effort, below its {constraint.value:g}-day "
                    f"minimum."
                ),
                constraint=ConstraintKind.MIN_DURATION.value,
                constraint_reason=constraint.reason,
            ))

    # 7. Total effort may not decrease without an explicit justification. A
    #    *restructuring* changes sequence and allocation, not the work itself,
    #    and without this gate the optimizer's best move is always to do less.
    before_effort = base.total_effort()
    after_effort = candidate.total_effort()
    justified = any(
        m.kind in (K.TASK_EFFORT_SET, K.TASK_REMOVE, K.TASK_MERGE)
        for m in mutations
    )
    if after_effort < before_effort - 1e-9 and not justified:
        out.append(Rejection(
            kind="CANDIDATE",
            reason=(
                f"This candidate reduces total effort from {before_effort:g} "
                f"to {after_effort:g} days without changing any task's effort "
                f"explicitly. Restructuring changes sequence and allocation, "
                f"not the amount of work."
            ),
            constraint="TOTAL_EFFORT_CONSERVATION",
            constraint_reason=(
                "An optimizer that may quietly do less work will always "
                "'find' an improvement."
            ),
        ))

    return tuple(out)


# ---------------------------------------------------------------------------
# Deterministic candidate generators - no LLM anywhere
# ---------------------------------------------------------------------------


def _protected_edges(snapshot: WorkflowSnapshot) -> set[tuple[str, str]]:
    out: set[tuple[str, str]] = set()
    for c in snapshot.constraints_of(ConstraintKind.IMMUTABLE_DEPENDENCY):
        if "->" in c.target:
            left, right = c.target.split("->", 1)
            out.add((left, right))
    return out


def gen_transitive_reduction(
    snapshot: WorkflowSnapshot, state: WorkflowState, result: EvaluationResult
) -> list[Candidate]:
    """Remove dependencies implied by a longer path.

    Provably safe: the ordering they encode already exists, so the finish date
    cannot move. The most satisfying candidate to demonstrate, and the easiest
    to verify by hand.
    """
    G = build_graph_from_snapshot(snapshot)
    protected = _protected_edges(snapshot)
    redundant = [e for e in transitive_redundant_edges(G) if e not in protected]
    if not redundant:
        return []

    out = [Candidate(
        name="Remove all redundant dependencies",
        generator="transitive_reduction",
        rationale=(
            f"{len(redundant)} dependency edge(s) are already implied by "
            f"longer paths, so removing them cannot change the finish date - "
            f"it only makes the graph easier to reason about."
        ),
        mutations=tuple(
            Mutation(K.DEPENDENCY_REMOVE, {"from_task": u, "to_task": v})
            for u, v in redundant
        ),
    )]
    if len(redundant) > 1:
        for u, v in redundant:
            out.append(Candidate(
                name=f"Remove redundant dependency {u} -> {v}",
                generator="transitive_reduction",
                rationale=f"{u} -> {v} is already implied by a longer path.",
                mutations=(
                    Mutation(K.DEPENDENCY_REMOVE, {"from_task": u, "to_task": v}),
                ),
            ))
    return out


def gen_parallelize_zero_slack(
    snapshot: WorkflowSnapshot, state: WorkflowState, result: EvaluationResult
) -> list[Candidate]:
    """Split divisible zero-slack tasks so their parts run side by side.

    Only zero-slack tasks: splitting a task with slack shortens nothing and
    complicates the graph. Only divisible ones - `is_divisible` already
    accounts for the NON_DIVISIBLE_TASK constraint, so an approval or a
    single-signature review is never proposed here.
    """
    sched = result.schedule
    out: list[Candidate] = []
    for key in sched["critical"]:
        if not snapshot.is_divisible(key):
            continue
        effort = snapshot.task_by_key[key].effort
        if effort < 2:
            continue
        for parts in (2, 3):
            if effort / parts < 1:
                continue
            out.append(Candidate(
                name=f"Split {key} across {parts} people",
                generator="parallelize_zero_slack",
                rationale=(
                    f"{key} is on the critical path with {effort:g} days of "
                    f"divisible work and zero slack. Splitting it into "
                    f"{parts} parallel parts shortens the chain without "
                    f"changing the total work."
                ),
                mutations=(
                    Mutation(K.TASK_SPLIT, {"key": key, "parts": parts}),
                ),
            ))
    return out


def gen_drop_soft_ordering(
    snapshot: WorkflowSnapshot, state: WorkflowState, result: EvaluationResult
) -> list[Candidate]:
    """Drop `consumes = false` ordering edges no constraint protects.

    An ordering edge says "do this after that" without any artifact passing
    between them. Some are real sequencing; some are habit. This proposes
    dropping the ones on the critical path and lets the score say whether it
    helped - it never claims the edge was pointless.
    """
    protected = _protected_edges(snapshot)
    sched = result.schedule
    critical = set(sched["critical"])
    out: list[Candidate] = []
    for dep in snapshot.dependencies:
        if dep.consumes or dep.edge in protected:
            continue
        if dep.to_task not in critical and dep.from_task not in critical:
            continue
        out.append(Candidate(
            name=f"Drop the soft ordering {dep.from_task} -> {dep.to_task}",
            generator="drop_soft_ordering",
            rationale=(
                f"{dep.from_task} -> {dep.to_task} is ordering only - no "
                f"artifact passes between them - and nothing protects it. If "
                f"the sequence is habit rather than necessity, these can run "
                f"in parallel."
            ),
            mutations=(
                Mutation(K.DEPENDENCY_REMOVE, {
                    "from_task": dep.from_task, "to_task": dep.to_task,
                }),
            ),
        ))
    return out


def gen_resource_levelling(
    snapshot: WorkflowSnapshot, state: WorkflowState, result: EvaluationResult
) -> list[Candidate]:
    """Move work from an overloaded resource to an idle one with the skills.

    Driven by the `resource_overallocated` findings the engine already
    produced, so the optimizer works from the same evidence the user sees.
    """
    sched = result.schedule
    load: dict[str, int] = {}
    for task_key, assignees in snapshot.assignees_by_task.items():
        for resource_key in assignees:
            load[resource_key] = load.get(resource_key, 0) + 1

    out: list[Candidate] = []
    overloaded = [
        f for f in list(result.findings) + list(result.suppressed_findings)
        if f.kind == "resource_overallocated"
    ]
    for finding in overloaded:
        for task_key in finding.task_ids:
            task = snapshot.task_by_key.get(task_key)
            if task is None:
                continue
            current = list(snapshot.assignees_by_task.get(task_key, ()))
            if not current:
                continue
            required = set(task.required_skills)
            for candidate_resource in snapshot.resources:
                if candidate_resource.key in current:
                    continue
                if candidate_resource.kind == "team":
                    continue
                if required and not required & set(candidate_resource.skills):
                    continue
                if load.get(candidate_resource.key, 0) >= load.get(current[0], 0):
                    continue
                out.append(Candidate(
                    name=(
                        f"Move {task_key} from "
                        f"{snapshot.resource_by_key[current[0]].name} to "
                        f"{candidate_resource.name}"
                    ),
                    generator="resource_levelling",
                    rationale=(
                        f"{finding.evidence['resource_name']} is scheduled for "
                        f"{finding.evidence['peak_concurrent_tasks']} tasks at "
                        f"once against capacity "
                        f"{finding.evidence['capacity']}. "
                        f"{candidate_resource.name} has "
                        f"{load.get(candidate_resource.key, 0)} task(s) and "
                        f"the skills this one needs."
                    ),
                    mutations=(
                        Mutation(K.ASSIGNMENT_REMOVE, {
                            "task_key": task_key, "resource_key": current[0],
                        }),
                        Mutation(K.ASSIGNMENT_ADD, {
                            "task_key": task_key,
                            "resource_key": candidate_resource.key,
                        }),
                    ),
                ))
    return out


def gen_resequence_contended(
    snapshot: WorkflowSnapshot, state: WorkflowState, result: EvaluationResult
) -> list[Candidate]:
    """Sequence two tasks that contend for the same resource.

    This *adds* a dependency, which usually makes a schedule longer - so it is
    proposed only where a resource is genuinely overloaded, and the score
    decides whether trading completion for a feasible resource plan is worth
    it. The CPM schedule is resource-blind, so this is how a resource-feasible
    ordering gets onto the table at all without claiming to solve RCPSP.
    """
    G = build_graph_from_snapshot(snapshot)
    sched = result.schedule
    out: list[Candidate] = []

    for finding in list(result.findings) + list(result.suppressed_findings):
        if finding.kind != "resource_overallocated":
            continue
        overlapping = list(finding.task_ids)
        if len(overlapping) < 2:
            continue
        # Sequence the tighter task first.
        ordered = sorted(overlapping, key=lambda k: sched["slack"].get(k, 0.0))
        first, second = ordered[0], ordered[1]
        if (first, second) in snapshot.dependency_by_edge:
            continue
        probe = snapshot.evolve(
            dependencies=snapshot.dependencies + (
                DependencySpec(from_task=first, to_task=second, consumes=False),
            )
        )
        if find_cycles(build_graph_from_snapshot(probe)):
            continue
        out.append(Candidate(
            name=f"Sequence {first} before {second}",
            generator="resequence_contended",
            rationale=(
                f"{finding.evidence['resource_name']} cannot do {first} and "
                f"{second} at once. Sequencing them makes the plan "
                f"resource-feasible; the table below shows what that costs in "
                f"completion."
            ),
            mutations=(
                Mutation(K.DEPENDENCY_ADD, {
                    "from_task": first, "to_task": second, "consumes": False,
                }),
            ),
        ))
    del G
    return out


def gen_drop_bottleneck_tasks(
    snapshot: WorkflowSnapshot, state: WorkflowState, result: EvaluationResult
) -> list[Candidate]:
    """Propose deleting the tasks that are holding the project up.

    Opt-in only, via `aggressive=True` - this is what "optimize with no
    limits" means. It exists for two reasons:

    1. It is the honest answer to a user who asks for the fastest possible
       plan and has *not* marked anything mandatory. Removing scope is a real
       option and pretending otherwise is paternalistic.
    2. Where the user *has* marked something mandatory, this is what produces
       the refusal: the candidate is generated, the gate rejects it, and the
       response carries the constraint and the reason on record. An optimizer
       that never proposes the cheat never demonstrates that it will not take
       it.

    Any candidate here that reduces total effort is flagged `scope_change` so
    the trade is priced in the open rather than buried in the score.
    """
    sched = result.schedule
    out: list[Candidate] = []
    ranked = sorted(
        (k for k in sched["critical"] if k in snapshot.task_by_key),
        key=lambda k: -sched["durations"].get(k, 0.0),
    )
    for key in ranked[:5]:
        task = snapshot.task_by_key[key]
        mandatory = snapshot.is_mandatory(key)
        out.append(Candidate(
            name=f"Drop {key} entirely",
            generator="drop_bottleneck_tasks",
            rationale=(
                f"{key} ({task.name}) is on the critical path for "
                f"{sched['durations'][key]:.0f} days. Removing it is the "
                f"largest available reduction - and it is a scope change, not "
                f"a restructuring."
                + (
                    " This task is marked mandatory, so this candidate is "
                    "expected to be refused."
                    if mandatory else ""
                )
            ),
            mutations=(Mutation(K.TASK_REMOVE, {"key": key}),),
        ))
    return out


def generators() -> tuple[Callable, ...]:
    """A tuple, not a module-level list: `core/` holds no mutable module
    state. Phase 7 adds the LLM Proposer as a third *source*, passed into
    `optimize()` - it does not get its own path through here."""
    return (
        gen_transitive_reduction,
        gen_parallelize_zero_slack,
        gen_drop_soft_ordering,
        gen_resource_levelling,
        gen_resequence_contended,
    )


def generate(
    snapshot: WorkflowSnapshot,
    state: WorkflowState,
    result: EvaluationResult,
    aggressive: bool = False,
) -> list[Candidate]:
    """Every deterministic candidate. `aggressive` adds the scope-cutting
    generator, which is how "optimize with no limits" is expressed."""
    active = generators()
    if aggressive:
        active = active + (gen_drop_bottleneck_tasks,)
    out: list[Candidate] = []
    seen: set[tuple] = set()
    for generator in active:
        for candidate in generator(snapshot, state, result):
            signature = tuple(
                (m.kind.value, tuple(sorted(m.payload.items(), key=str)))
                for m in candidate.mutations
            )
            if signature in seen:
                continue
            seen.add(signature)
            out.append(candidate)
    return out


# ---------------------------------------------------------------------------
# Scoring - decomposed, never a bare blended number
# ---------------------------------------------------------------------------


def _peak_overload(result: EvaluationResult) -> float:
    return float(sum(
        f.evidence.get("overflow", 0)
        for f in list(result.findings) + list(result.suppressed_findings)
        if f.kind == "resource_overallocated"
    ))


def _dependency_complexity(snapshot: WorkflowSnapshot) -> float:
    tasks = max(len(snapshot.tasks), 1)
    return len(snapshot.dependencies) / tasks


def _structural_risk(result: EvaluationResult) -> float:
    return float(sum(t["score"] for t in result.risk.get("tasks", [])))


def _parallelization(snapshot: WorkflowSnapshot, result: EvaluationResult) -> float:
    """Average concurrency: total work divided by elapsed time. 1.0 means
    strictly serial."""
    end = result.schedule["project_end"]
    if end <= 0:
        return 0.0
    return sum(result.schedule["durations"].values()) / end


def _improvement(before: float, after: float, better: str) -> float:
    scale = max(abs(before), 1.0)
    raw = (before - after) if better == "lower" else (after - before)
    return max(-1.0, min(1.0, raw / scale))


def score_candidate(
    base_snapshot: WorkflowSnapshot,
    base_result: EvaluationResult,
    candidate_snapshot: WorkflowSnapshot,
    candidate_result: EvaluationResult,
    weights: ObjectiveWeights,
) -> Score:
    """Six criteria, each with its raw before/after, its direction, its weight
    and a sentence saying what moved."""
    def margin(result: EvaluationResult) -> float:
        value = result.feasibility.margin_days
        return 0.0 if value is None else value

    specs = [
        (
            "expected_completion",
            base_result.projected_end, candidate_result.projected_end,
            "lower", "days", weights.expected_completion,
        ),
        (
            "feasibility_margin",
            margin(base_result), margin(candidate_result),
            "higher", "days against the deadline", weights.feasibility_margin,
        ),
        (
            "peak_resource_overload",
            _peak_overload(base_result), _peak_overload(candidate_result),
            "lower", "tasks over capacity at the peak",
            weights.peak_resource_overload,
        ),
        (
            "structural_risk",
            _structural_risk(base_result), _structural_risk(candidate_result),
            "lower", "summed task risk (structural estimate)",
            weights.structural_risk,
        ),
        (
            "dependency_complexity",
            _dependency_complexity(base_snapshot),
            _dependency_complexity(candidate_snapshot),
            "lower", "dependencies per task", weights.dependency_complexity,
        ),
        (
            "parallelization",
            _parallelization(base_snapshot, base_result),
            _parallelization(candidate_snapshot, candidate_result),
            "higher", "average concurrent tasks", weights.parallelization,
        ),
    ]

    criteria: list[Criterion] = []
    for name, before, after, better, unit, weight in specs:
        delta = after - before
        improvement = _improvement(before, after, better)
        if abs(delta) < 1e-9:
            explanation = f"unchanged at {before:.2f} {unit}."
        else:
            direction = "better" if improvement > 0 else "worse"
            explanation = (
                f"{before:.2f} -> {after:.2f} {unit} ({delta:+.2f}), "
                f"{direction}; {better} is better."
            )
        criteria.append(Criterion(
            name=name, before=before, after=after, delta=delta,
            improvement=improvement, weight=weight, better=better,
            unit=unit, explanation=explanation,
        ))
    return Score(criteria=tuple(criteria))


# ---------------------------------------------------------------------------
# The search
# ---------------------------------------------------------------------------


@dataclass
class OptimizationResult:
    base: EvaluationResult
    candidates: list[Candidate]
    rejected: list[Candidate]
    recommended: Candidate | None
    #: The best candidate that does the *same work* differently, rather than
    #: less of it. "Same work, faster" strictly dominates "less work, faster"
    #: for most users, but preferring one over the other is the user's call -
    #: so both are returned rather than one being quietly ranked first.
    recommended_same_scope: Candidate | None
    weights: ObjectiveWeights
    budget: Budget
    generated: int
    evaluated: int
    stopped_early: bool
    stop_reason: str
    aggressive: bool = False

    def as_dict(self) -> dict:
        return {
            "current": {
                "projected_end_day": self.base.projected_end,
                "feasibility": self.base.feasibility.as_dict(),
                "scores": {
                    "expected_completion": self.base.projected_end,
                    "feasibility_margin": self.base.feasibility.margin_days or 0.0,
                    "peak_resource_overload": _peak_overload(self.base),
                    "structural_risk": _structural_risk(self.base),
                },
                "engine_version": self.base.engine_version,
                "input_hash": self.base.input_hash,
            },
            "weights": self.weights.as_dict(),
            "weights_total": self.weights.total,
            "budget": self.budget.as_dict(),
            "generated": self.generated,
            "evaluated": self.evaluated,
            "stopped_early": self.stopped_early,
            "stop_reason": self.stop_reason,
            "aggressive": self.aggressive,
            "recommended": (
                self.recommended.as_dict() if self.recommended else None
            ),
            "recommendation_reason": self._recommendation_reason(),
            "recommended_same_scope": (
                self.recommended_same_scope.as_dict()
                if self.recommended_same_scope else None
            ),
            "recommended_same_scope_note": (
                "The best candidate that changes how the work is sequenced or "
                "allocated without changing how much of it there is. Where "
                "this differs from `recommended`, the difference is a scope "
                "decision and it is yours to make, not ours."
            ),
            "candidates": [c.as_dict() for c in self.candidates],
            "rejected": [c.as_dict() for c in self.rejected],
            "note": (
                "Every candidate here is a real scenario of typed mutations, "
                "scored by the same engine that produced the current numbers. "
                "Rejected candidates are listed with the constraint that "
                "refused them."
            ),
        }

    def _recommendation_reason(self) -> str:
        if self.recommended is None:
            return (
                "No candidate improved on the current workflow under these "
                "weights. That is a result, not a failure."
            )
        c = self.recommended
        completion = next(
            (x for x in c.score.criteria if x.name == "expected_completion"),
            None,
        )
        parts = [f"{c.name}: {c.rationale}"]
        if completion is not None and abs(completion.delta) > 1e-9:
            pct = (
                abs(completion.delta) / max(completion.before, 1) * 100
            )
            parts.append(
                f"Expected completion moves from day {completion.before:.0f} "
                f"to day {completion.after:.0f} ({completion.delta:+.0f} days, "
                f"{pct:.0f}%)."
            )
        if c.scope_change:
            parts.append(
                f"Note that this is a scope change: total effort moves by "
                f"{c.effort_delta:+.1f} day(s)."
            )
        parts.append(
            f"{len(self.rejected)} candidate(s) were refused by a constraint."
        )
        return " ".join(parts)


def optimize(
    snapshot: WorkflowSnapshot,
    state: WorkflowState,
    clock: Clock | None = None,
    config: EngineConfig | None = None,
    weights: ObjectiveWeights | None = None,
    budget: Budget | None = None,
    should_stop: Callable[[], bool] | None = None,
    extra_candidates: Iterable[Candidate] = (),
    aggressive: bool = False,
) -> OptimizationResult:
    """Generate, gate, score, rank.

    `extra_candidates` is where Phase 7's LLM Proposer plugs in. It gets no
    shortcut: the same validation, the same constraint gates, the same
    deterministic scoring.

    The base workflow is evaluated **once** and shared across every candidate,
    so N candidates cost N+1 evaluations rather than 2N.
    """
    clk = clock or Clock()
    cfg = config or EngineConfig()
    w = weights or ObjectiveWeights()
    b = budget or Budget()
    stop = should_stop or (lambda: False)

    base_result = evaluate(snapshot, state, clk, cfg)

    pool = generate(snapshot, state, base_result, aggressive) + list(
        extra_candidates
    )
    generated = len(pool)

    accepted: list[Candidate] = []
    rejected: list[Candidate] = []
    evaluated = 0
    stopped_early = False
    stop_reason = "completed"

    for candidate in pool:
        if evaluated >= b.max_candidates:
            stopped_early = True
            stop_reason = (
                f"candidate budget reached ({b.max_candidates}); "
                f"{generated - evaluated} candidate(s) not evaluated"
            )
            break
        if stop():
            stopped_early = True
            stop_reason = (
                f"time budget reached ({b.max_seconds}s); "
                f"{generated - evaluated} candidate(s) not evaluated"
            )
            break

        # Semantic validation first: a mutation list that cannot even apply is
        # not a candidate.
        validation: ValidationResult = validate_all(
            snapshot, state, list(candidate.mutations)
        )
        if not validation.valid:
            rejected.append(replace(
                candidate, rejections=validation.rejections
            ))
            continue

        changed, changed_state, _ = apply_all(
            snapshot, state, list(candidate.mutations)
        )

        # Then the hard gates, still before anything is scored.
        violations = gate(snapshot, state, changed, candidate.mutations)
        if violations:
            rejected.append(replace(candidate, rejections=violations))
            continue

        candidate_result = evaluate(changed, changed_state, clk, cfg)
        evaluated += 1

        accepted.append(replace(
            candidate,
            evaluated=True,
            effort_delta=changed.total_effort() - snapshot.total_effort(),
            score=score_candidate(
                snapshot, base_result, changed, candidate_result, w
            ),
            comparison=_compare(base_result, candidate_result, snapshot, changed),
        ))

    accepted.sort(key=lambda c: (-c.score.total, c.name))
    recommended = next(
        (c for c in accepted if c.score.total > 1e-9), None
    )
    recommended_same_scope = next(
        (c for c in accepted if c.score.total > 1e-9 and not c.scope_change),
        None,
    )
    return OptimizationResult(
        base=base_result,
        candidates=accepted,
        rejected=rejected,
        recommended=recommended,
        recommended_same_scope=recommended_same_scope,
        weights=w,
        budget=b,
        generated=generated,
        evaluated=evaluated,
        stopped_early=stopped_early,
        stop_reason=stop_reason,
        aggressive=aggressive,
    )
