"""
W - the immutable workflow snapshot, and the state/clock/config that come
with it.

This is the first of the four primitives in ARCHITECTURE A.0. Everything the
engine reasons about arrives through these types, and nothing here knows what
a domain is. There is deliberately **no domain field on any type in this
module** - not ignored, absent. `backend/tests/test_domain_leak.py` asserts
that two structurally identical workflows in different domains evaluate to
byte-identical output, which fails the moment someone smuggles one in.

Immutability is real, not conventional (decision D-12): sequences are tuples
and derived lookups are `MappingProxyType`, so the optimizer can evaluate
thousands of candidates against one base snapshot without any chance of
corrupting it.

Units: `effort` and every schedule quantity are **integer-friendly working
days**. Calendar dates exist only at the API boundary, produced by
`core.engine.calendar_.day_to_date`.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, replace
from enum import Enum
from types import MappingProxyType
from typing import Iterable, Mapping

# ---------------------------------------------------------------------------
# Vocabularies. Generic workflow semantics only - none of these are domains.
# ---------------------------------------------------------------------------


class TaskStatus(str, Enum):
    NOT_STARTED = "not_started"
    IN_PROGRESS = "in_progress"
    IN_REVIEW = "in_review"
    BLOCKED = "blocked"
    DONE = "done"


#: Statuses that count as finished work. A frozenset, so no module-level
#: mutable state (the prototype's `DONE = {"done"}` was a mutable global).
DONE_STATUSES: frozenset[TaskStatus] = frozenset({TaskStatus.DONE})

#: Statuses whose elapsed time can exceed the planned effort and therefore
#: feed the observed-duration bridge.
OPEN_STATUSES: frozenset[TaskStatus] = frozenset(
    {TaskStatus.IN_PROGRESS, TaskStatus.IN_REVIEW}
)


class DepType(str, Enum):
    """Finish-to-start, start-to-start, finish-to-finish."""

    FS = "FS"
    SS = "SS"
    FF = "FF"


class ConstraintKind(str, Enum):
    """Without these the optimizer cheats (ARCHITECTURE D.5 step 4)."""

    MANDATORY_TASK = "MANDATORY_TASK"
    IMMUTABLE_DEPENDENCY = "IMMUTABLE_DEPENDENCY"
    NON_DIVISIBLE_TASK = "NON_DIVISIBLE_TASK"
    FIXED_ASSIGNMENT = "FIXED_ASSIGNMENT"
    MIN_DURATION = "MIN_DURATION"


# ---------------------------------------------------------------------------
# Snapshot members
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TaskSpec:
    key: str
    name: str
    #: Work content in working days. Duration is derived from effort and the
    #: number of assignees by `core.engine.effort`, never stored.
    effort: float
    description: str = ""
    divisible: bool = True
    priority: int = 0
    #: Optional three-point estimate. When absent, callers fall back to a
    #: spread prior supplied through `EngineConfig`, and must say so.
    optimistic: float | None = None
    likely: float | None = None
    pessimistic: float | None = None
    required_skills: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.effort < 0:
            raise ValueError(f"task {self.key}: effort must be >= 0")

    @property
    def has_three_point(self) -> bool:
        return None not in (self.optimistic, self.likely, self.pessimistic)


@dataclass(frozen=True, slots=True)
class DependencySpec:
    from_task: str
    to_task: str
    dep_type: DepType = DepType.FS
    #: True marks an artifact dependency: the successor consumes something the
    #: predecessor produces, so a requirement change invalidates it. False is
    #: ordering only. This is the prototype's artifact/temporal edge kind,
    #: generalised (decision D-11).
    consumes: bool = False

    @property
    def edge(self) -> tuple[str, str]:
        return (self.from_task, self.to_task)


@dataclass(frozen=True, slots=True)
class ResourceSpec:
    """A person, a team, a machine, a budget line. `kind` is data, not an enum
    the engine branches on - that is what replaced `Department`."""

    key: str
    name: str
    kind: str = "person"
    capacity: int = 1
    skills: tuple[str, ...] = ()
    calendar_key: str | None = None
    #: Optional roll-up parent (a person in a team, a machine in a cell, a
    #: line item in a budget). Contention is measured against a resource's own
    #: capacity using the ready work of itself *and* its descendants, which is
    #: what lets a team cap total throughput below the sum of its members
    #: (decision D-16). Generic structure, not a domain concept.
    parent_key: str | None = None

    def __post_init__(self) -> None:
        if self.capacity < 0:
            raise ValueError(f"resource {self.key}: capacity must be >= 0")
        if self.parent_key == self.key:
            raise ValueError(f"resource {self.key}: cannot be its own parent")


@dataclass(frozen=True, slots=True)
class AssignmentSpec:
    task_key: str
    resource_key: str
    allocation: float = 1.0


@dataclass(frozen=True, slots=True)
class RequirementSpec:
    key: str
    text: str
    version_no: int = 1
    consumed_by: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ConstraintSpec:
    kind: ConstraintKind
    #: Task key, resource key, or "FROM->TO" for a dependency.
    target: str
    reason: str = ""
    value: float | None = None

    @staticmethod
    def dependency_target(from_task: str, to_task: str) -> str:
        return f"{from_task}->{to_task}"


@dataclass(frozen=True, slots=True)
class CalendarSpec:
    key: str
    #: Monday = 0 .. Sunday = 6.
    working_days: tuple[int, ...] = (0, 1, 2, 3, 4)
    holidays: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class EventRecord:
    """One append-only status transition. Feeds the Tier-2 detectors."""

    day: float
    task_key: str
    actor: str
    from_status: TaskStatus
    to_status: TaskStatus


# ---------------------------------------------------------------------------
# W
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class WorkflowSnapshot:
    """An immutable workflow. **No domain field, by design.**

    `deadline_day` is an integer working-day offset from the project start,
    like every other quantity in `core/`.
    """

    tasks: tuple[TaskSpec, ...]
    dependencies: tuple[DependencySpec, ...] = ()
    resources: tuple[ResourceSpec, ...] = ()
    assignments: tuple[AssignmentSpec, ...] = ()
    requirements: tuple[RequirementSpec, ...] = ()
    constraints: tuple[ConstraintSpec, ...] = ()
    calendars: tuple[CalendarSpec, ...] = ()
    deadline_day: float | None = None

    # -- construction -------------------------------------------------------

    @classmethod
    def build(
        cls,
        tasks: Iterable[TaskSpec],
        dependencies: Iterable[DependencySpec] = (),
        resources: Iterable[ResourceSpec] = (),
        assignments: Iterable[AssignmentSpec] = (),
        requirements: Iterable[RequirementSpec] = (),
        constraints: Iterable[ConstraintSpec] = (),
        calendars: Iterable[CalendarSpec] = (),
        deadline_day: float | None = None,
    ) -> "WorkflowSnapshot":
        """Normalising constructor: sorts every collection into a canonical
        order so that two structurally identical workflows produce the same
        `content_hash` regardless of insertion order."""
        return cls(
            tasks=tuple(sorted(tasks, key=lambda t: t.key)),
            dependencies=tuple(
                sorted(dependencies, key=lambda d: (d.from_task, d.to_task))
            ),
            resources=tuple(sorted(resources, key=lambda r: r.key)),
            assignments=tuple(
                sorted(assignments, key=lambda a: (a.task_key, a.resource_key))
            ),
            requirements=tuple(sorted(requirements, key=lambda r: r.key)),
            constraints=tuple(
                sorted(constraints, key=lambda c: (c.kind.value, c.target))
            ),
            calendars=tuple(sorted(calendars, key=lambda c: c.key)),
            deadline_day=deadline_day,
        )

    def evolve(self, **changes) -> "WorkflowSnapshot":
        """Return a new snapshot. The only way to 'change' a snapshot."""
        return replace(self, **changes)

    # -- lookups (immutable views) -----------------------------------------

    @property
    def task_keys(self) -> tuple[str, ...]:
        return tuple(t.key for t in self.tasks)

    @property
    def task_by_key(self) -> Mapping[str, TaskSpec]:
        return MappingProxyType({t.key: t for t in self.tasks})

    @property
    def resource_by_key(self) -> Mapping[str, ResourceSpec]:
        return MappingProxyType({r.key: r for r in self.resources})

    @property
    def requirement_by_key(self) -> Mapping[str, RequirementSpec]:
        return MappingProxyType({r.key: r for r in self.requirements})

    @property
    def assignees_by_task(self) -> Mapping[str, tuple[str, ...]]:
        out: dict[str, list[str]] = {t.key: [] for t in self.tasks}
        for a in self.assignments:
            out.setdefault(a.task_key, []).append(a.resource_key)
        return MappingProxyType({k: tuple(sorted(v)) for k, v in out.items()})

    @property
    def tasks_by_resource(self) -> Mapping[str, tuple[str, ...]]:
        out: dict[str, list[str]] = {r.key: [] for r in self.resources}
        for a in self.assignments:
            out.setdefault(a.resource_key, []).append(a.task_key)
        return MappingProxyType({k: tuple(sorted(v)) for k, v in out.items()})

    @property
    def dependency_by_edge(self) -> Mapping[tuple[str, str], DependencySpec]:
        return MappingProxyType({d.edge: d for d in self.dependencies})

    @property
    def resource_members(self) -> Mapping[str, tuple[str, ...]]:
        """resource key -> its own key plus every descendant key, so a
        roll-up resource's load can be computed in one lookup."""
        children: dict[str, list[str]] = {}
        for r in self.resources:
            if r.parent_key:
                children.setdefault(r.parent_key, []).append(r.key)

        def walk(key: str) -> list[str]:
            out = [key]
            for child in children.get(key, ()):
                out.extend(walk(child))
            return out

        return MappingProxyType({r.key: tuple(sorted(walk(r.key))) for r in self.resources})

    def constraints_of(self, kind: ConstraintKind) -> tuple[ConstraintSpec, ...]:
        return tuple(c for c in self.constraints if c.kind == kind)

    def is_divisible(self, task_key: str) -> bool:
        """A task is divisible only if its own flag allows it *and* no
        NON_DIVISIBLE_TASK constraint protects it."""
        task = self.task_by_key.get(task_key)
        if task is None or not task.divisible:
            return False
        return not any(
            c.target == task_key
            for c in self.constraints_of(ConstraintKind.NON_DIVISIBLE_TASK)
        )

    # -- identity -----------------------------------------------------------

    def to_canonical(self) -> dict:
        """A stable, sorted, JSON-safe projection. This is what gets hashed
        and what the domain-leak test compares."""

        def task(t: TaskSpec) -> dict:
            return {
                "key": t.key,
                "name": t.name,
                "description": t.description,
                "effort": t.effort,
                "divisible": t.divisible,
                "priority": t.priority,
                "optimistic": t.optimistic,
                "likely": t.likely,
                "pessimistic": t.pessimistic,
                "required_skills": list(t.required_skills),
            }

        return {
            "tasks": [task(t) for t in self.tasks],
            "dependencies": [
                {
                    "from_task": d.from_task,
                    "to_task": d.to_task,
                    "dep_type": d.dep_type.value,
                    "consumes": d.consumes,
                }
                for d in self.dependencies
            ],
            "resources": [
                {
                    "key": r.key,
                    "name": r.name,
                    "kind": r.kind,
                    "capacity": r.capacity,
                    "skills": list(r.skills),
                    "calendar_key": r.calendar_key,
                    "parent_key": r.parent_key,
                }
                for r in self.resources
            ],
            "assignments": [
                {
                    "task_key": a.task_key,
                    "resource_key": a.resource_key,
                    "allocation": a.allocation,
                }
                for a in self.assignments
            ],
            "requirements": [
                {
                    "key": r.key,
                    "text": r.text,
                    "version_no": r.version_no,
                    "consumed_by": list(r.consumed_by),
                }
                for r in self.requirements
            ],
            "constraints": [
                {
                    "kind": c.kind.value,
                    "target": c.target,
                    "reason": c.reason,
                    "value": c.value,
                }
                for c in self.constraints
            ],
            "calendars": [
                {
                    "key": c.key,
                    "working_days": list(c.working_days),
                    "holidays": list(c.holidays),
                }
                for c in self.calendars
            ],
            "deadline_day": self.deadline_day,
        }

    def content_hash(self) -> str:
        """SHA-256 over the canonical projection.

        Phase 3 asserts this is unchanged after a scenario is evaluated - that
        is how "the original workflow remains unchanged" stops being a promise
        and becomes a test.
        """
        blob = json.dumps(self.to_canonical(), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# State, clock, config - the other three arguments to evaluate()
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class WorkflowState:
    """Everything observed *about* a snapshot, rather than planned in it.

    Separating this from `W` is what makes the tiering in ARCHITECTURE D.1
    expressible: a brand-new project has a snapshot and an empty state, and
    the engine can say so honestly instead of returning nothing.
    """

    statuses: Mapping[str, TaskStatus] = field(default_factory=dict)
    events: tuple[EventRecord, ...] = ()
    #: Observed durations for work already in flight, keyed by task.
    actual_durations: Mapping[str, float] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "statuses", MappingProxyType(dict(self.statuses)))
        object.__setattr__(
            self, "actual_durations", MappingProxyType(dict(self.actual_durations))
        )
        object.__setattr__(self, "events", tuple(self.events))

    @classmethod
    def empty(cls, snapshot: WorkflowSnapshot) -> "WorkflowState":
        """The cold-start state: every task not started, no history at all."""
        return cls(statuses={t.key: TaskStatus.NOT_STARTED for t in snapshot.tasks})

    def status_of(self, task_key: str) -> TaskStatus:
        return self.statuses.get(task_key, TaskStatus.NOT_STARTED)

    def is_done(self, task_key: str) -> bool:
        return self.status_of(task_key) in DONE_STATUSES

    @property
    def has_statuses(self) -> bool:
        """True once any task has moved off `not_started` - the Tier-1 gate."""
        return any(s != TaskStatus.NOT_STARTED for s in self.statuses.values())

    @property
    def has_history(self) -> bool:
        """The Tier-2 gate."""
        return len(self.events) > 0

    @property
    def last_event_day(self) -> Mapping[str, float]:
        out: dict[str, float] = {}
        for e in self.events:
            out[e.task_key] = max(out.get(e.task_key, 0.0), e.day)
        return MappingProxyType(out)


@dataclass(frozen=True, slots=True)
class Clock:
    """The clock is an argument. `core/` never calls `datetime.now()` - that
    is both a purity requirement and what makes analysis reproducible."""

    today_day: float = 0.0


@dataclass(frozen=True, slots=True)
class EngineConfig:
    """Tunables. Every one of these is echoed back in the analysis payload so
    a reader can recompute the result by hand."""

    #: Days a task may sit ready-but-unstarted, or idle in review, before it
    #: is reported. The prototype's `idle_threshold`.
    idle_threshold: float = 4.0
    #: The honest effort model (ARCHITECTURE D.3):
    #: duration = effort / (1 + efficiency * (assignees - 1)).
    #: NOT effort / assignees.
    parallel_efficiency: float = 0.6
    #: Fallback relative spread when a task has no three-point estimate.
    #: Provenance is reported alongside it, never silently assumed.
    default_duration_spread: float = 0.25
    duration_spread_provenance: str = "default"
    #: Fan-out above which a task is reported as a single point of failure.
    fan_out_threshold: int = 3
    #: Serial chain length with no parallelism worth reporting.
    serial_chain_threshold: int = 4

    def as_dict(self) -> dict:
        return {
            "idle_threshold": self.idle_threshold,
            "parallel_efficiency": self.parallel_efficiency,
            "default_duration_spread": self.default_duration_spread,
            "duration_spread_provenance": self.duration_spread_provenance,
            "fan_out_threshold": self.fan_out_threshold,
            "serial_chain_threshold": self.serial_chain_threshold,
        }
