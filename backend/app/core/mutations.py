"""
D - the mutation algebra. The third primitive (ARCHITECTURE A.0, D.3).

This is the single most important contract in the system, because it is also
the *only* thing the LLM is permitted to emit. It is:

* **closed** - seventeen kinds and no escape hatch. "Restructure the project"
  is not expressible, which is the point.
* **typed** - each kind has a declared payload with required and optional
  fields, checked before anything semantic runs.
* **validated semantically, not just structurally** - a well-formed
  `DEPENDENCY_ADD` that creates a cycle, references a missing task, or
  violates a `Constraint` is rejected with a user-readable reason.
* **invertible** - every mutation can produce the mutation *list* that undoes
  it, which is what makes "discard this scenario" and undo trivial. A list,
  not a single mutation: removing a task bridges the dependencies around it,
  so undoing that removal has to re-add the task *and* drop the bridges.
  A single-mutation inverse looked tidier and was quietly wrong.

Applying a mutation returns a **new** `(snapshot, state)` pair. Nothing here
touches a database, and nothing here can modify the base it was given.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from enum import Enum
from types import MappingProxyType
from typing import Any, Callable, Mapping

from backend.app.core.workflow import (
    AssignmentSpec,
    ConstraintKind,
    DependencySpec,
    DepType,
    RequirementSpec,
    ResourceSpec,
    TaskSpec,
    TaskStatus,
    WorkflowSnapshot,
    WorkflowState,
)


class MutationKind(str, Enum):
    """The closed set. Anything a user or the LLM wants to express must
    decompose into these."""

    TASK_ADD = "TASK_ADD"
    TASK_REMOVE = "TASK_REMOVE"
    TASK_EFFORT_SET = "TASK_EFFORT_SET"
    TASK_DELAY_ADD = "TASK_DELAY_ADD"
    TASK_SPLIT = "TASK_SPLIT"
    TASK_MERGE = "TASK_MERGE"
    TASK_STATUS_SET = "TASK_STATUS_SET"
    TASK_PRIORITY_SET = "TASK_PRIORITY_SET"
    DEPENDENCY_ADD = "DEPENDENCY_ADD"
    DEPENDENCY_REMOVE = "DEPENDENCY_REMOVE"
    DEPENDENCY_TYPE_CHANGE = "DEPENDENCY_TYPE_CHANGE"
    ASSIGNMENT_ADD = "ASSIGNMENT_ADD"
    ASSIGNMENT_REMOVE = "ASSIGNMENT_REMOVE"
    RESOURCE_CAPACITY_SET = "RESOURCE_CAPACITY_SET"
    RESOURCE_UNAVAILABLE_WINDOW = "RESOURCE_UNAVAILABLE_WINDOW"
    DEADLINE_SET = "DEADLINE_SET"
    REQUIREMENT_VERSION_BUMP = "REQUIREMENT_VERSION_BUMP"


@dataclass(frozen=True, slots=True)
class Mutation:
    kind: MutationKind
    payload: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "payload", MappingProxyType(dict(self.payload)))

    def as_dict(self) -> dict:
        return {"kind": self.kind.value, "payload": dict(self.payload)}

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Mutation":
        kind = data.get("kind")
        try:
            parsed = MutationKind(kind)
        except ValueError:
            raise ValueError(
                f"{kind!r} is not a mutation this system can express. "
                f"The algebra is closed; valid kinds are: "
                f"{', '.join(k.value for k in MutationKind)}."
            )
        return cls(kind=parsed, payload=dict(data.get("payload") or {}))

    def describe(self) -> str:
        """One line, for a diff panel or a rejection message."""
        return _DESCRIBERS.get(self.kind, lambda p: "")(self.payload) or self.kind.value


@dataclass(frozen=True, slots=True)
class Rejection:
    """Why a mutation was refused. These reasons are a feature, not an error
    message - they are what a user reads when the platform declines to do
    something, and what the optimizer cites when it refuses to cheat."""

    kind: str
    reason: str
    #: Set when a `Constraint` is what forbade it, so the UI can quote it.
    constraint: str | None = None
    constraint_reason: str | None = None

    def as_dict(self) -> dict:
        return {
            "mutation": self.kind,
            "reason": self.reason,
            "constraint": self.constraint,
            "constraint_reason": self.constraint_reason,
        }


@dataclass(frozen=True, slots=True)
class ValidationResult:
    valid: bool
    rejections: tuple[Rejection, ...] = ()

    def as_dict(self) -> dict:
        return {
            "valid": self.valid,
            "rejections": [r.as_dict() for r in self.rejections],
        }

    @classmethod
    def ok(cls) -> "ValidationResult":
        return cls(valid=True)

    @classmethod
    def failed(cls, *rejections: Rejection) -> "ValidationResult":
        return cls(valid=False, rejections=tuple(rejections))


class MutationError(Exception):
    """Raised when `apply` is called with a mutation that does not validate.
    Callers should validate first; this is the backstop."""

    def __init__(self, result: ValidationResult):
        self.result = result
        super().__init__("; ".join(r.reason for r in result.rejections))


# ---------------------------------------------------------------------------
# Payload schemas - structural validation, before anything semantic
# ---------------------------------------------------------------------------

#: kind -> (required fields, optional fields)
def payload_schema() -> Mapping[MutationKind, tuple[tuple[str, ...], tuple[str, ...]]]:
    K = MutationKind
    return MappingProxyType({
        K.TASK_ADD: (("key", "name", "effort"),
                     ("description", "divisible", "priority", "optimistic",
                      "likely", "pessimistic", "required_skills",
                      "predecessors", "successors", "consumed_requirements",
                      "added_delay")),
        K.TASK_REMOVE: (("key",), ("bridge_dependencies",)),
        K.TASK_EFFORT_SET: (("key", "effort"), ()),
        K.TASK_DELAY_ADD: (("key",), ("extra_days", "total_delay_days")),
        K.TASK_SPLIT: (("key", "parts"), ("part_keys",)),
        K.TASK_MERGE: (("keys", "into_key"), ("name",)),
        K.TASK_STATUS_SET: (("key", "status"), ()),
        K.TASK_PRIORITY_SET: (("key", "priority"), ()),
        K.DEPENDENCY_ADD: (("from_task", "to_task"), ("dep_type", "consumes")),
        K.DEPENDENCY_REMOVE: (("from_task", "to_task"), ()),
        K.DEPENDENCY_TYPE_CHANGE: (("from_task", "to_task"),
                                   ("dep_type", "consumes")),
        K.ASSIGNMENT_ADD: (("task_key", "resource_key"), ("allocation",)),
        K.ASSIGNMENT_REMOVE: (("task_key", "resource_key"), ()),
        K.RESOURCE_CAPACITY_SET: (("resource_key", "capacity"), ()),
        K.RESOURCE_UNAVAILABLE_WINDOW: (("resource_key",),
                                        ("from_day", "to_day", "windows")),
        K.DEADLINE_SET: (("deadline_day",), ()),
        K.REQUIREMENT_VERSION_BUMP: (("requirement_key",), ("text", "version_no")),
    })


def _structural(mutation: Mutation) -> list[Rejection]:
    required, optional = payload_schema()[mutation.kind]
    allowed = set(required) | set(optional)
    out: list[Rejection] = []
    missing = [f for f in required if f not in mutation.payload]
    if missing:
        out.append(Rejection(
            kind=mutation.kind.value,
            reason=(
                f"{mutation.kind.value} needs {', '.join(missing)}. "
                f"Required: {', '.join(required)}."
            ),
        ))
    unknown = sorted(set(mutation.payload) - allowed)
    if unknown:
        out.append(Rejection(
            kind=mutation.kind.value,
            reason=(
                f"{mutation.kind.value} does not accept "
                f"{', '.join(unknown)}. Accepted: "
                f"{', '.join(sorted(allowed))}."
            ),
        ))
    return out


# ---------------------------------------------------------------------------
# Semantic validators. One per kind, each returning user-readable reasons.
# ---------------------------------------------------------------------------


def _missing_task(snapshot: WorkflowSnapshot, *keys: str) -> list[str]:
    known = set(snapshot.task_keys)
    return [k for k in keys if k not in known]


def _v_task_add(s: WorkflowSnapshot, st: WorkflowState, p) -> list[Rejection]:
    out: list[Rejection] = []
    if p["key"] in set(s.task_keys):
        out.append(Rejection("TASK_ADD",
                             f"A task with key {p['key']!r} already exists."))
    if float(p["effort"]) < 0:
        out.append(Rejection("TASK_ADD", "Effort cannot be negative."))
    refs = list(p.get("predecessors") or ()) + list(p.get("successors") or ())
    missing = _missing_task(s, *refs)
    if missing:
        out.append(Rejection(
            "TASK_ADD",
            f"Unknown task(s) referenced: {', '.join(sorted(missing))}.",
        ))
    unknown_reqs = [
        r for r in (p.get("consumed_requirements") or ())
        if r not in s.requirement_by_key
    ]
    if unknown_reqs:
        out.append(Rejection(
            "TASK_ADD",
            f"Unknown requirement(s): {', '.join(sorted(unknown_reqs))}.",
        ))
    return out


def _v_task_remove(s: WorkflowSnapshot, st: WorkflowState, p) -> list[Rejection]:
    key = p["key"]
    if missing := _missing_task(s, key):
        return [Rejection("TASK_REMOVE", f"Unknown task {missing[0]!r}.")]
    if s.is_mandatory(key):
        return [Rejection(
            "TASK_REMOVE",
            f"{key} is a mandatory task and cannot be removed.",
            constraint=ConstraintKind.MANDATORY_TASK.value,
            constraint_reason=s.constraint_reason(
                ConstraintKind.MANDATORY_TASK, key
            ),
        )]
    return []


def _v_task_effort_set(s: WorkflowSnapshot, st: WorkflowState, p) -> list[Rejection]:
    key = p["key"]
    if missing := _missing_task(s, key):
        return [Rejection("TASK_EFFORT_SET", f"Unknown task {missing[0]!r}.")]
    effort = float(p["effort"])
    if effort < 0:
        return [Rejection("TASK_EFFORT_SET", "Effort cannot be negative.")]
    floor = s.min_duration(key)
    if floor is not None and effort < floor:
        return [Rejection(
            "TASK_EFFORT_SET",
            f"{key} has a minimum duration of {floor:g} days; {effort:g} is "
            f"below it.",
            constraint=ConstraintKind.MIN_DURATION.value,
            constraint_reason=s.constraint_reason(
                ConstraintKind.MIN_DURATION, key
            ),
        )]
    return []


def _v_task_delay_add(s: WorkflowSnapshot, st: WorkflowState, p) -> list[Rejection]:
    key = p["key"]
    if missing := _missing_task(s, key):
        return [Rejection("TASK_DELAY_ADD", f"Unknown task {missing[0]!r}.")]
    if "extra_days" not in p and "total_delay_days" not in p:
        return [Rejection(
            "TASK_DELAY_ADD",
            "Give extra_days to add a delay, or total_delay_days to set it.",
        )]
    value = p.get("extra_days", p.get("total_delay_days"))
    if float(value) < 0:
        return [Rejection(
            "TASK_DELAY_ADD",
            "A delay cannot be negative. Use TASK_EFFORT_SET to shorten a task.",
        )]
    return []


def _v_task_split(s: WorkflowSnapshot, st: WorkflowState, p) -> list[Rejection]:
    key = p["key"]
    if missing := _missing_task(s, key):
        return [Rejection("TASK_SPLIT", f"Unknown task {missing[0]!r}.")]
    parts = int(p["parts"])
    if parts < 2:
        return [Rejection("TASK_SPLIT", "A split needs at least 2 parts.")]
    if not s.is_divisible(key):
        task = s.task_by_key[key]
        if not task.divisible:
            return [Rejection(
                "TASK_SPLIT",
                f"{key} is marked non-divisible and cannot be split. Some work "
                f"does not go faster with more people.",
            )]
        return [Rejection(
            "TASK_SPLIT",
            f"{key} cannot be split.",
            constraint=ConstraintKind.NON_DIVISIBLE_TASK.value,
            constraint_reason=s.constraint_reason(
                ConstraintKind.NON_DIVISIBLE_TASK, key
            ),
        )]
    part_keys = list(p.get("part_keys") or _split_keys(key, parts))
    if len(part_keys) != parts:
        return [Rejection(
            "TASK_SPLIT",
            f"{parts} parts requested but {len(part_keys)} part keys given.",
        )]
    clashes = sorted(set(part_keys) & set(s.task_keys) - {key})
    if clashes:
        return [Rejection(
            "TASK_SPLIT",
            f"Part key(s) already in use: {', '.join(clashes)}.",
        )]
    return []


def _v_task_merge(s: WorkflowSnapshot, st: WorkflowState, p) -> list[Rejection]:
    keys = list(p["keys"])
    if len(keys) < 2:
        return [Rejection("TASK_MERGE", "A merge needs at least 2 tasks.")]
    if missing := _missing_task(s, *keys):
        return [Rejection(
            "TASK_MERGE", f"Unknown task(s): {', '.join(sorted(missing))}."
        )]
    mandatory = [k for k in keys if s.is_mandatory(k) and k != p["into_key"]]
    if mandatory:
        return [Rejection(
            "TASK_MERGE",
            f"Merging would remove mandatory task(s) "
            f"{', '.join(mandatory)}. Merge into one of them instead.",
            constraint=ConstraintKind.MANDATORY_TASK.value,
            constraint_reason=s.constraint_reason(
                ConstraintKind.MANDATORY_TASK, mandatory[0]
            ),
        )]
    if p["into_key"] not in keys and p["into_key"] in set(s.task_keys):
        return [Rejection(
            "TASK_MERGE",
            f"{p['into_key']!r} already exists and is not one of the tasks "
            f"being merged.",
        )]
    return []


def _v_task_status_set(s: WorkflowSnapshot, st: WorkflowState, p) -> list[Rejection]:
    key = p["key"]
    if missing := _missing_task(s, key):
        return [Rejection("TASK_STATUS_SET", f"Unknown task {missing[0]!r}.")]
    try:
        TaskStatus(p["status"])
    except ValueError:
        return [Rejection(
            "TASK_STATUS_SET",
            f"{p['status']!r} is not a status. Valid: "
            f"{', '.join(x.value for x in TaskStatus)}.",
        )]
    return []


def _v_task_priority_set(s: WorkflowSnapshot, st: WorkflowState, p) -> list[Rejection]:
    if missing := _missing_task(s, p["key"]):
        return [Rejection("TASK_PRIORITY_SET", f"Unknown task {missing[0]!r}.")]
    return []


def _v_dependency_add(s: WorkflowSnapshot, st: WorkflowState, p) -> list[Rejection]:
    u, v = p["from_task"], p["to_task"]
    if u == v:
        return [Rejection("DEPENDENCY_ADD", "A task cannot depend on itself.")]
    if missing := _missing_task(s, u, v):
        return [Rejection(
            "DEPENDENCY_ADD",
            f"Unknown task(s): {', '.join(sorted(missing))}.",
        )]
    if (u, v) in s.dependency_by_edge:
        return [Rejection("DEPENDENCY_ADD", f"{u} -> {v} already exists.")]

    # Cycle check: the semantic one that a schema cannot catch.
    from backend.app.core.engine.graph import build_graph_from_snapshot, find_cycles

    probe = s.evolve(
        dependencies=s.dependencies + (DependencySpec(from_task=u, to_task=v),)
    )
    cycles = find_cycles(build_graph_from_snapshot(probe))
    if cycles:
        chain = " -> ".join(cycles[0] + [cycles[0][0]])
        return [Rejection(
            "DEPENDENCY_ADD",
            f"{u} -> {v} would create a circular dependency: {chain}.",
        )]
    return []


def _v_dependency_remove(s: WorkflowSnapshot, st: WorkflowState, p) -> list[Rejection]:
    u, v = p["from_task"], p["to_task"]
    if (u, v) not in s.dependency_by_edge:
        return [Rejection("DEPENDENCY_REMOVE", f"{u} -> {v} does not exist.")]
    if s.is_immutable_dependency(u, v):
        return [Rejection(
            "DEPENDENCY_REMOVE",
            f"{u} -> {v} is an immutable dependency and cannot be removed.",
            constraint=ConstraintKind.IMMUTABLE_DEPENDENCY.value,
            constraint_reason=s.constraint_reason(
                ConstraintKind.IMMUTABLE_DEPENDENCY,
                f"{u}->{v}",
            ),
        )]
    return []


def _v_dependency_type_change(
    s: WorkflowSnapshot, st: WorkflowState, p
) -> list[Rejection]:
    u, v = p["from_task"], p["to_task"]
    if (u, v) not in s.dependency_by_edge:
        return [Rejection("DEPENDENCY_TYPE_CHANGE", f"{u} -> {v} does not exist.")]
    if "dep_type" in p:
        try:
            DepType(p["dep_type"])
        except ValueError:
            return [Rejection(
                "DEPENDENCY_TYPE_CHANGE",
                f"{p['dep_type']!r} is not a dependency type. Valid: "
                f"{', '.join(x.value for x in DepType)}.",
            )]
    if "dep_type" not in p and "consumes" not in p:
        return [Rejection(
            "DEPENDENCY_TYPE_CHANGE",
            "Give at least one of dep_type or consumes to change.",
        )]
    existing = s.dependency_by_edge[(u, v)]
    if p.get("consumes") is False and existing.consumes and s.is_immutable_dependency(u, v):
        return [Rejection(
            "DEPENDENCY_TYPE_CHANGE",
            f"{u} -> {v} is protected, so it cannot be downgraded from an "
            f"artifact dependency to ordering only.",
            constraint=ConstraintKind.IMMUTABLE_DEPENDENCY.value,
            constraint_reason=s.constraint_reason(
                ConstraintKind.IMMUTABLE_DEPENDENCY, f"{u}->{v}"
            ),
        )]
    return []


def _v_assignment_add(s: WorkflowSnapshot, st: WorkflowState, p) -> list[Rejection]:
    task, res = p["task_key"], p["resource_key"]
    if missing := _missing_task(s, task):
        return [Rejection("ASSIGNMENT_ADD", f"Unknown task {missing[0]!r}.")]
    resource = s.resource_by_key.get(res)
    if resource is None:
        return [Rejection("ASSIGNMENT_ADD", f"Unknown resource {res!r}.")]
    if (task, res) in {(a.task_key, a.resource_key) for a in s.assignments}:
        return [Rejection(
            "ASSIGNMENT_ADD", f"{res} is already assigned to {task}."
        )]
    required = set(s.task_by_key[task].required_skills)
    if required and not required & set(resource.skills):
        return [Rejection(
            "ASSIGNMENT_ADD",
            f"{resource.name} does not have the skills {task} requires "
            f"({', '.join(sorted(required))}); they have "
            f"{', '.join(sorted(resource.skills)) or 'none recorded'}.",
        )]
    return []


def _v_assignment_remove(s: WorkflowSnapshot, st: WorkflowState, p) -> list[Rejection]:
    task, res = p["task_key"], p["resource_key"]
    if (task, res) not in {(a.task_key, a.resource_key) for a in s.assignments}:
        return [Rejection(
            "ASSIGNMENT_REMOVE", f"{res} is not assigned to {task}."
        )]
    for c in s.constraints_of(ConstraintKind.FIXED_ASSIGNMENT):
        if c.target in (task, f"{task}:{res}"):
            return [Rejection(
                "ASSIGNMENT_REMOVE",
                f"{task} has a fixed assignment and cannot be reassigned.",
                constraint=ConstraintKind.FIXED_ASSIGNMENT.value,
                constraint_reason=c.reason,
            )]
    return []


def _v_resource_capacity_set(
    s: WorkflowSnapshot, st: WorkflowState, p
) -> list[Rejection]:
    if p["resource_key"] not in s.resource_by_key:
        return [Rejection(
            "RESOURCE_CAPACITY_SET", f"Unknown resource {p['resource_key']!r}."
        )]
    if int(p["capacity"]) < 0:
        return [Rejection(
            "RESOURCE_CAPACITY_SET", "Capacity cannot be negative."
        )]
    return []


def _v_resource_unavailable_window(
    s: WorkflowSnapshot, st: WorkflowState, p
) -> list[Rejection]:
    if p["resource_key"] not in s.resource_by_key:
        return [Rejection(
            "RESOURCE_UNAVAILABLE_WINDOW",
            f"Unknown resource {p['resource_key']!r}.",
        )]

    if "windows" in p:
        for window in p["windows"]:
            if len(window) != 2:
                return [Rejection(
                    "RESOURCE_UNAVAILABLE_WINDOW",
                    f"Each window is a (from_day, to_day) pair; got {window!r}.",
                )]
            if float(window[1]) <= float(window[0]):
                return [Rejection(
                    "RESOURCE_UNAVAILABLE_WINDOW",
                    f"The window ends on day {window[1]} but starts on day "
                    f"{window[0]}.",
                )]
        return []

    if "from_day" not in p or "to_day" not in p:
        return [Rejection(
            "RESOURCE_UNAVAILABLE_WINDOW",
            "Give either from_day and to_day to add one window, or windows to "
            "replace the whole list.",
        )]
    if float(p["to_day"]) <= float(p["from_day"]):
        return [Rejection(
            "RESOURCE_UNAVAILABLE_WINDOW",
            f"The window ends on day {p['to_day']} but starts on day "
            f"{p['from_day']}.",
        )]
    return []


def _v_deadline_set(s: WorkflowSnapshot, st: WorkflowState, p) -> list[Rejection]:
    if p["deadline_day"] is not None and float(p["deadline_day"]) < 0:
        return [Rejection("DEADLINE_SET", "A deadline cannot be before day 0.")]
    return []


def _v_requirement_version_bump(
    s: WorkflowSnapshot, st: WorkflowState, p
) -> list[Rejection]:
    if p["requirement_key"] not in s.requirement_by_key:
        return [Rejection(
            "REQUIREMENT_VERSION_BUMP",
            f"Unknown requirement {p['requirement_key']!r}.",
        )]
    return []


# ---------------------------------------------------------------------------
# Appliers. Each returns a NEW (snapshot, state).
# ---------------------------------------------------------------------------

Pair = tuple[WorkflowSnapshot, WorkflowState]


def _split_keys(key: str, parts: int) -> list[str]:
    return [f"{key}.{i + 1}" for i in range(parts)]


def _a_task_add(s: WorkflowSnapshot, st: WorkflowState, p) -> Pair:
    task = TaskSpec(
        key=p["key"],
        name=p["name"],
        effort=float(p["effort"]),
        description=p.get("description", ""),
        divisible=bool(p.get("divisible", True)),
        priority=int(p.get("priority", 0)),
        optimistic=p.get("optimistic"),
        likely=p.get("likely"),
        pessimistic=p.get("pessimistic"),
        required_skills=tuple(p.get("required_skills") or ()),
        added_delay=float(p.get("added_delay") or 0.0),
    )
    deps = list(s.dependencies)
    for pred in p.get("predecessors") or ():
        deps.append(DependencySpec(from_task=pred, to_task=task.key))
    for succ in p.get("successors") or ():
        deps.append(DependencySpec(from_task=task.key, to_task=succ))
    consumes_reqs = set(p.get("consumed_requirements") or ())
    snapshot = WorkflowSnapshot.build(
        tasks=list(s.tasks) + [task],
        dependencies=deps,
        resources=s.resources,
        assignments=s.assignments,
        requirements=[
            replace(r, consumed_by=tuple(
                dict.fromkeys(list(r.consumed_by) + [task.key])
            )) if r.key in consumes_reqs else r
            for r in s.requirements
        ],
        constraints=s.constraints,
        calendars=s.calendars,
        deadline_day=s.deadline_day,
    )
    state = WorkflowState(
        statuses={**dict(st.statuses), task.key: TaskStatus.NOT_STARTED},
        events=st.events,
        actual_durations=st.actual_durations,
    )
    return snapshot, state


def _a_task_remove(s: WorkflowSnapshot, st: WorkflowState, p) -> Pair:
    key = p["key"]
    bridge = bool(p.get("bridge_dependencies", True))
    preds = [d.from_task for d in s.dependencies if d.to_task == key]
    succs = [d.to_task for d in s.dependencies if d.from_task == key]
    kept = [d for d in s.dependencies if key not in (d.from_task, d.to_task)]
    existing = {(d.from_task, d.to_task) for d in kept}
    bridged = []
    if bridge:
        # Reconnect around the hole, so removing a task does not silently drop
        # the ordering it was carrying.
        bridged = [
            DependencySpec(from_task=a, to_task=b)
            for a in preds for b in succs
            if (a, b) not in existing and a != b
        ]
    snapshot = WorkflowSnapshot.build(
        tasks=[t for t in s.tasks if t.key != key],
        dependencies=kept + bridged,
        resources=s.resources,
        assignments=[a for a in s.assignments if a.task_key != key],
        requirements=[
            replace(r, consumed_by=tuple(x for x in r.consumed_by if x != key))
            for r in s.requirements
        ],
        constraints=[c for c in s.constraints if c.target != key],
        calendars=s.calendars,
        deadline_day=s.deadline_day,
    )
    state = WorkflowState(
        statuses={k: v for k, v in st.statuses.items() if k != key},
        events=tuple(e for e in st.events if e.task_key != key),
        actual_durations={
            k: v for k, v in st.actual_durations.items() if k != key
        },
    )
    return snapshot, state


def _replace_task(s: WorkflowSnapshot, key: str, **changes) -> WorkflowSnapshot:
    return s.evolve(
        tasks=tuple(
            replace(t, **changes) if t.key == key else t for t in s.tasks
        )
    )


def _a_task_effort_set(s: WorkflowSnapshot, st: WorkflowState, p) -> Pair:
    return _replace_task(s, p["key"], effort=float(p["effort"])), st


def _a_task_delay_add(s: WorkflowSnapshot, st: WorkflowState, p) -> Pair:
    task = s.task_by_key[p["key"]]
    if "total_delay_days" in p:
        total = float(p["total_delay_days"])
    else:
        total = task.added_delay + float(p["extra_days"])
    return _replace_task(s, p["key"], added_delay=total), st


def _a_task_split(s: WorkflowSnapshot, st: WorkflowState, p) -> Pair:
    key = p["key"]
    parts = int(p["parts"])
    part_keys = list(p.get("part_keys") or _split_keys(key, parts))
    original = s.task_by_key[key]

    # Total effort is preserved: a split changes sequence and allocation, not
    # the amount of work. That is the difference between restructuring and
    # cheating (ARCHITECTURE D.5 step 4).
    each = original.effort / parts
    new_tasks = [
        replace(original, key=pk, name=f"{original.name} ({i + 1}/{parts})",
                effort=each)
        for i, pk in enumerate(part_keys)
    ]

    preds = [d for d in s.dependencies if d.to_task == key]
    succs = [d for d in s.dependencies if d.from_task == key]
    others = [
        d for d in s.dependencies if key not in (d.from_task, d.to_task)
    ]
    # Parts run in parallel: every predecessor feeds every part, and every
    # part feeds every successor.
    rewired = others + [
        replace(d, to_task=pk) for d in preds for pk in part_keys
    ] + [
        replace(d, from_task=pk) for d in succs for pk in part_keys
    ]

    assignments = [a for a in s.assignments if a.task_key != key]
    was_assigned = [a for a in s.assignments if a.task_key == key]
    for i, pk in enumerate(part_keys):
        if was_assigned:
            src = was_assigned[i % len(was_assigned)]
            assignments.append(replace(src, task_key=pk))

    snapshot = WorkflowSnapshot.build(
        tasks=[t for t in s.tasks if t.key != key] + new_tasks,
        dependencies=rewired,
        resources=s.resources,
        assignments=assignments,
        requirements=[
            replace(
                r,
                consumed_by=tuple(
                    x for x in r.consumed_by if x != key
                ) + (tuple(part_keys) if key in r.consumed_by else ()),
            )
            for r in s.requirements
        ],
        constraints=s.constraints,
        calendars=s.calendars,
        deadline_day=s.deadline_day,
    )
    status = st.status_of(key)
    statuses = {k: v for k, v in st.statuses.items() if k != key}
    statuses.update({pk: status for pk in part_keys})
    return snapshot, WorkflowState(
        statuses=statuses,
        events=tuple(e for e in st.events if e.task_key != key),
        actual_durations={
            k: v for k, v in st.actual_durations.items() if k != key
        },
    )


def _a_task_merge(s: WorkflowSnapshot, st: WorkflowState, p) -> Pair:
    keys = list(p["keys"])
    into = p["into_key"]
    merged_effort = sum(s.task_by_key[k].effort for k in keys)
    template = s.task_by_key.get(into) or s.task_by_key[keys[0]]
    merged = replace(
        template,
        key=into,
        name=p.get("name") or template.name,
        effort=merged_effort,
        # A merged task is only divisible if every part was.
        divisible=all(s.task_by_key[k].divisible for k in keys),
    )

    outside = set(s.task_keys) - set(keys)
    deps: list[DependencySpec] = []
    seen: set[tuple[str, str]] = set()
    for d in s.dependencies:
        u = into if d.from_task in keys else d.from_task
        v = into if d.to_task in keys else d.to_task
        if u == v or (u, v) in seen:
            continue
        seen.add((u, v))
        deps.append(replace(d, from_task=u, to_task=v))

    assignments: list[AssignmentSpec] = []
    seen_a: set[tuple[str, str]] = set()
    for a in s.assignments:
        task_key = into if a.task_key in keys else a.task_key
        if (task_key, a.resource_key) in seen_a:
            continue
        seen_a.add((task_key, a.resource_key))
        assignments.append(replace(a, task_key=task_key))

    snapshot = WorkflowSnapshot.build(
        tasks=[t for t in s.tasks if t.key not in keys] + [merged],
        dependencies=deps,
        resources=s.resources,
        assignments=assignments,
        requirements=[
            replace(
                r,
                consumed_by=tuple(dict.fromkeys(
                    into if x in keys else x for x in r.consumed_by
                )),
            )
            for r in s.requirements
        ],
        constraints=[
            replace(c, target=into) if c.target in keys else c
            for c in s.constraints
        ],
        calendars=s.calendars,
        deadline_day=s.deadline_day,
    )
    statuses = {k: v for k, v in st.statuses.items() if k not in keys}
    # A merged task is only done if every part was.
    statuses[into] = (
        TaskStatus.DONE
        if all(st.is_done(k) for k in keys)
        else TaskStatus.NOT_STARTED
    )
    del outside
    return snapshot, WorkflowState(
        statuses=statuses,
        events=tuple(e for e in st.events if e.task_key not in keys),
        actual_durations={
            k: v for k, v in st.actual_durations.items() if k not in keys
        },
    )


def _a_task_status_set(s: WorkflowSnapshot, st: WorkflowState, p) -> Pair:
    return s, WorkflowState(
        statuses={**dict(st.statuses), p["key"]: TaskStatus(p["status"])},
        events=st.events,
        actual_durations=st.actual_durations,
    )


def _a_task_priority_set(s: WorkflowSnapshot, st: WorkflowState, p) -> Pair:
    return _replace_task(s, p["key"], priority=int(p["priority"])), st


def _a_dependency_add(s: WorkflowSnapshot, st: WorkflowState, p) -> Pair:
    dep = DependencySpec(
        from_task=p["from_task"],
        to_task=p["to_task"],
        dep_type=DepType(p.get("dep_type", DepType.FS.value)),
        consumes=bool(p.get("consumes", False)),
    )
    return s.evolve(
        dependencies=tuple(
            sorted(s.dependencies + (dep,), key=lambda d: (d.from_task, d.to_task))
        )
    ), st


def _a_dependency_remove(s: WorkflowSnapshot, st: WorkflowState, p) -> Pair:
    edge = (p["from_task"], p["to_task"])
    return s.evolve(
        dependencies=tuple(d for d in s.dependencies if d.edge != edge)
    ), st


def _a_dependency_type_change(s: WorkflowSnapshot, st: WorkflowState, p) -> Pair:
    edge = (p["from_task"], p["to_task"])
    changes: dict[str, Any] = {}
    if "dep_type" in p:
        changes["dep_type"] = DepType(p["dep_type"])
    if "consumes" in p:
        changes["consumes"] = bool(p["consumes"])
    return s.evolve(
        dependencies=tuple(
            replace(d, **changes) if d.edge == edge else d
            for d in s.dependencies
        )
    ), st


def _a_assignment_add(s: WorkflowSnapshot, st: WorkflowState, p) -> Pair:
    a = AssignmentSpec(
        task_key=p["task_key"],
        resource_key=p["resource_key"],
        allocation=float(p.get("allocation", 1.0)),
    )
    return s.evolve(
        assignments=tuple(
            sorted(s.assignments + (a,),
                   key=lambda x: (x.task_key, x.resource_key))
        )
    ), st


def _a_assignment_remove(s: WorkflowSnapshot, st: WorkflowState, p) -> Pair:
    pair = (p["task_key"], p["resource_key"])
    return s.evolve(
        assignments=tuple(
            a for a in s.assignments
            if (a.task_key, a.resource_key) != pair
        )
    ), st


def _a_resource_capacity_set(s: WorkflowSnapshot, st: WorkflowState, p) -> Pair:
    key = p["resource_key"]
    return s.evolve(
        resources=tuple(
            replace(r, capacity=int(p["capacity"])) if r.key == key else r
            for r in s.resources
        )
    ), st


def _a_resource_unavailable_window(
    s: WorkflowSnapshot, st: WorkflowState, p
) -> Pair:
    key = p["resource_key"]

    def updated(existing: tuple[tuple[float, float], ...]):
        if "windows" in p:
            # Replace the whole list. This is the shape the inverse uses.
            return tuple(sorted(
                (float(w[0]), float(w[1])) for w in p["windows"]
            ))
        window = (float(p["from_day"]), float(p["to_day"]))
        return tuple(sorted(set(existing) | {window}))

    return s.evolve(
        resources=tuple(
            replace(r, unavailable_windows=updated(r.unavailable_windows))
            if r.key == key else r
            for r in s.resources
        )
    ), st


def _a_deadline_set(s: WorkflowSnapshot, st: WorkflowState, p) -> Pair:
    value = p["deadline_day"]
    return s.evolve(
        deadline_day=None if value is None else float(value)
    ), st


def _a_requirement_version_bump(s: WorkflowSnapshot, st: WorkflowState, p) -> Pair:
    key = p["requirement_key"]
    req = s.requirement_by_key[key]

    # A requirement change invalidates the work that consumed it. Anything
    # already done and now stale has to be redone, so its status resets and
    # its effort re-enters the schedule. That is what makes requirement churn
    # cost days instead of being a note in a document.
    from backend.app.core.engine.graph import build_graph_from_snapshot
    from backend.app.core.engine.staleness import stale_tasks

    G = build_graph_from_snapshot(s)
    stale = stale_tasks(G, set(req.consumed_by))
    redo = [k for k in stale["must_redo"] if st.is_done(k)]

    target_version = p.get("version_no")
    snapshot = s.evolve(
        requirements=tuple(
            replace(
                r,
                version_no=(
                    int(target_version) if target_version is not None
                    else r.version_no + 1
                ),
                text=p.get("text") or r.text,
            ) if r.key == key else r
            for r in s.requirements
        )
    )
    statuses = dict(st.statuses)
    for k in redo:
        statuses[k] = TaskStatus.NOT_STARTED
    return snapshot, WorkflowState(
        statuses=statuses,
        events=st.events,
        actual_durations={
            k: v for k, v in st.actual_durations.items() if k not in redo
        },
    )


# ---------------------------------------------------------------------------
# Inverses. Every mutation can undo itself - sometimes in more than one step.
# ---------------------------------------------------------------------------


def _i_task_add(s: WorkflowSnapshot, st: WorkflowState, p) -> Inverse:
    return (Mutation(MutationKind.TASK_REMOVE, {
        "key": p["key"], "bridge_dependencies": False,
    }),)


def _i_task_remove(s: WorkflowSnapshot, st: WorkflowState, p) -> Inverse:
    key = p["key"]
    task = s.task_by_key[key]
    preds = [d.from_task for d in s.dependencies if d.to_task == key]
    succs = [d.to_task for d in s.dependencies if d.from_task == key]
    existing = {
        d.edge for d in s.dependencies if key not in (d.from_task, d.to_task)
    }

    out: list[Mutation] = [Mutation(MutationKind.TASK_ADD, {
        "key": task.key,
        "name": task.name,
        "effort": task.effort,
        "description": task.description,
        "divisible": task.divisible,
        "priority": task.priority,
        "optimistic": task.optimistic,
        "likely": task.likely,
        "pessimistic": task.pessimistic,
        "required_skills": list(task.required_skills),
        "added_delay": task.added_delay,
        # Which requirements this task consumed, so a removal does not
        # silently sever the links that make requirement-change impact
        # computable.
        "consumed_requirements": [
            r.key for r in s.requirements if key in r.consumed_by
        ],
    })]
    # Re-add each edge explicitly rather than through TASK_ADD's
    # predecessors/successors shorthand, because that shorthand cannot carry
    # `dep_type` and `consumes` - and losing `consumes` would silently turn an
    # artifact dependency into ordering only, which changes what a requirement
    # change invalidates.
    for dep in s.dependencies:
        if key not in (dep.from_task, dep.to_task):
            continue
        out.append(Mutation(MutationKind.DEPENDENCY_ADD, {
            "from_task": dep.from_task,
            "to_task": dep.to_task,
            "dep_type": dep.dep_type.value,
            "consumes": dep.consumes,
        }))
    # The removal bridged predecessors to successors so the ordering it
    # carried was not silently lost. Undoing it has to drop those bridges, or
    # the graph gains edges nobody asked for.
    if p.get("bridge_dependencies", True):
        for a in preds:
            for b in succs:
                if a != b and (a, b) not in existing:
                    out.append(Mutation(MutationKind.DEPENDENCY_REMOVE, {
                        "from_task": a, "to_task": b,
                    }))
    # Assignments went with the task, so they come back with it.
    for assignment in s.assignments:
        if assignment.task_key == key:
            out.append(Mutation(MutationKind.ASSIGNMENT_ADD, {
                "task_key": key,
                "resource_key": assignment.resource_key,
                "allocation": assignment.allocation,
            }))
    return tuple(out)


def _i_task_effort_set(s: WorkflowSnapshot, st: WorkflowState, p) -> Inverse:
    return (Mutation(MutationKind.TASK_EFFORT_SET, {
        "key": p["key"], "effort": s.task_by_key[p["key"]].effort,
    }),)


def _i_task_delay_add(s: WorkflowSnapshot, st: WorkflowState, p) -> Inverse:
    return (Mutation(MutationKind.TASK_DELAY_ADD, {
        "key": p["key"],
        "total_delay_days": s.task_by_key[p["key"]].added_delay,
    }),)


def _i_task_split(s: WorkflowSnapshot, st: WorkflowState, p) -> Inverse:
    parts = int(p["parts"])
    part_keys = list(p.get("part_keys") or _split_keys(p["key"], parts))
    return (Mutation(MutationKind.TASK_MERGE, {
        "keys": part_keys,
        "into_key": p["key"],
        "name": s.task_by_key[p["key"]].name,
    }),)


def _i_task_merge(s: WorkflowSnapshot, st: WorkflowState, p) -> Inverse:
    keys = list(p["keys"])
    return (Mutation(MutationKind.TASK_SPLIT, {
        "key": p["into_key"], "parts": len(keys), "part_keys": keys,
    }),)


def _i_task_status_set(s: WorkflowSnapshot, st: WorkflowState, p) -> Inverse:
    return (Mutation(MutationKind.TASK_STATUS_SET, {
        "key": p["key"], "status": st.status_of(p["key"]).value,
    }),)


def _i_task_priority_set(s: WorkflowSnapshot, st: WorkflowState, p) -> Inverse:
    return (Mutation(MutationKind.TASK_PRIORITY_SET, {
        "key": p["key"], "priority": s.task_by_key[p["key"]].priority,
    }),)


def _i_dependency_add(s: WorkflowSnapshot, st: WorkflowState, p) -> Inverse:
    return (Mutation(MutationKind.DEPENDENCY_REMOVE, {
        "from_task": p["from_task"], "to_task": p["to_task"],
    }),)


def _i_dependency_remove(s: WorkflowSnapshot, st: WorkflowState, p) -> Inverse:
    dep = s.dependency_by_edge[(p["from_task"], p["to_task"])]
    return (Mutation(MutationKind.DEPENDENCY_ADD, {
        "from_task": dep.from_task,
        "to_task": dep.to_task,
        "dep_type": dep.dep_type.value,
        "consumes": dep.consumes,
    }),)


def _i_dependency_type_change(
    s: WorkflowSnapshot, st: WorkflowState, p
) -> Inverse:
    dep = s.dependency_by_edge[(p["from_task"], p["to_task"])]
    return (Mutation(MutationKind.DEPENDENCY_TYPE_CHANGE, {
        "from_task": dep.from_task,
        "to_task": dep.to_task,
        "dep_type": dep.dep_type.value,
        "consumes": dep.consumes,
    }),)


def _i_assignment_add(s: WorkflowSnapshot, st: WorkflowState, p) -> Inverse:
    return (Mutation(MutationKind.ASSIGNMENT_REMOVE, {
        "task_key": p["task_key"], "resource_key": p["resource_key"],
    }),)


def _i_assignment_remove(s: WorkflowSnapshot, st: WorkflowState, p) -> Inverse:
    existing = next(
        a for a in s.assignments
        if (a.task_key, a.resource_key) == (p["task_key"], p["resource_key"])
    )
    return (Mutation(MutationKind.ASSIGNMENT_ADD, {
        "task_key": existing.task_key,
        "resource_key": existing.resource_key,
        "allocation": existing.allocation,
    }),)


def _i_resource_capacity_set(
    s: WorkflowSnapshot, st: WorkflowState, p
) -> Inverse:
    return (Mutation(MutationKind.RESOURCE_CAPACITY_SET, {
        "resource_key": p["resource_key"],
        "capacity": s.resource_by_key[p["resource_key"]].capacity,
    }),)


def _i_resource_unavailable_window(
    s: WorkflowSnapshot, st: WorkflowState, p
) -> Inverse:
    """Restore the exact window list the resource had.

    Adding a window needs *removing* one to undo it, which "add a window"
    cannot express. Rather than invent a REMOVE_WINDOW kind used by nothing
    else, the same mutation accepts a whole `windows` list and replaces with
    it - so the inverse is "set it back to exactly what it was", which is
    exact whether the window was new or already present.
    """
    resource = s.resource_by_key[p["resource_key"]]
    return (Mutation(MutationKind.RESOURCE_UNAVAILABLE_WINDOW, {
        "resource_key": p["resource_key"],
        "windows": [list(w) for w in resource.unavailable_windows],
    }),)


def _i_deadline_set(s: WorkflowSnapshot, st: WorkflowState, p) -> Inverse:
    return (Mutation(MutationKind.DEADLINE_SET, {
        "deadline_day": s.deadline_day,
    }),)


def _i_requirement_version_bump(
    s: WorkflowSnapshot, st: WorkflowState, p
) -> Inverse:
    from backend.app.core.engine.graph import build_graph_from_snapshot
    from backend.app.core.engine.staleness import stale_tasks

    req = s.requirement_by_key[p["requirement_key"]]
    out: list[Mutation] = [Mutation(MutationKind.REQUIREMENT_VERSION_BUMP, {
        "requirement_key": req.key,
        "text": req.text,
        # A bump increments; the inverse has to *set*, or undoing a bump lands
        # on version 3 instead of version 1.
        "version_no": req.version_no,
    })]
    # The bump reset the status of completed work it invalidated, so the
    # inverse has to put those statuses back.
    G = build_graph_from_snapshot(s)
    stale = stale_tasks(G, set(req.consumed_by))
    for key in stale["must_redo"]:
        if st.is_done(key):
            out.append(Mutation(MutationKind.TASK_STATUS_SET, {
                "key": key, "status": st.status_of(key).value,
            }))
    return tuple(out)


# ---------------------------------------------------------------------------
# The handler table
# ---------------------------------------------------------------------------

Validator = Callable[[WorkflowSnapshot, WorkflowState, Mapping], list[Rejection]]
Applier = Callable[[WorkflowSnapshot, WorkflowState, Mapping], Pair]
Inverse = tuple[Mutation, ...]
Inverter = Callable[[WorkflowSnapshot, WorkflowState, Mapping], Inverse]


@dataclass(frozen=True, slots=True)
class Handler:
    validate: Validator
    apply: Applier
    inverse: Inverter


def handlers() -> Mapping[MutationKind, Handler]:
    """A function, not a module-level dict, because `core/` holds no mutable
    module state."""
    K = MutationKind
    return MappingProxyType({
        K.TASK_ADD: Handler(_v_task_add, _a_task_add, _i_task_add),
        K.TASK_REMOVE: Handler(_v_task_remove, _a_task_remove, _i_task_remove),
        K.TASK_EFFORT_SET: Handler(
            _v_task_effort_set, _a_task_effort_set, _i_task_effort_set),
        K.TASK_DELAY_ADD: Handler(
            _v_task_delay_add, _a_task_delay_add, _i_task_delay_add),
        K.TASK_SPLIT: Handler(_v_task_split, _a_task_split, _i_task_split),
        K.TASK_MERGE: Handler(_v_task_merge, _a_task_merge, _i_task_merge),
        K.TASK_STATUS_SET: Handler(
            _v_task_status_set, _a_task_status_set, _i_task_status_set),
        K.TASK_PRIORITY_SET: Handler(
            _v_task_priority_set, _a_task_priority_set, _i_task_priority_set),
        K.DEPENDENCY_ADD: Handler(
            _v_dependency_add, _a_dependency_add, _i_dependency_add),
        K.DEPENDENCY_REMOVE: Handler(
            _v_dependency_remove, _a_dependency_remove, _i_dependency_remove),
        K.DEPENDENCY_TYPE_CHANGE: Handler(
            _v_dependency_type_change, _a_dependency_type_change,
            _i_dependency_type_change),
        K.ASSIGNMENT_ADD: Handler(
            _v_assignment_add, _a_assignment_add, _i_assignment_add),
        K.ASSIGNMENT_REMOVE: Handler(
            _v_assignment_remove, _a_assignment_remove, _i_assignment_remove),
        K.RESOURCE_CAPACITY_SET: Handler(
            _v_resource_capacity_set, _a_resource_capacity_set,
            _i_resource_capacity_set),
        K.RESOURCE_UNAVAILABLE_WINDOW: Handler(
            _v_resource_unavailable_window, _a_resource_unavailable_window,
            _i_resource_unavailable_window),
        K.DEADLINE_SET: Handler(
            _v_deadline_set, _a_deadline_set, _i_deadline_set),
        K.REQUIREMENT_VERSION_BUMP: Handler(
            _v_requirement_version_bump, _a_requirement_version_bump,
            _i_requirement_version_bump),
    })


_DESCRIBERS: Mapping[MutationKind, Callable[[Mapping], str]] = MappingProxyType({
    MutationKind.TASK_ADD: lambda p: f"add task {p.get('key')}",
    MutationKind.TASK_REMOVE: lambda p: f"remove task {p.get('key')}",
    MutationKind.TASK_EFFORT_SET:
        lambda p: f"set {p.get('key')} effort to {p.get('effort')}d",
    MutationKind.TASK_DELAY_ADD:
        lambda p: (
            f"set {p.get('key')} delay to {p.get('total_delay_days')}d"
            if "total_delay_days" in p else
            f"delay {p.get('key')} by {p.get('extra_days')}d"
        ),
    MutationKind.TASK_SPLIT:
        lambda p: f"split {p.get('key')} into {p.get('parts')} parallel parts",
    MutationKind.TASK_MERGE:
        lambda p: f"merge {', '.join(p.get('keys', []))} into {p.get('into_key')}",
    MutationKind.TASK_STATUS_SET:
        lambda p: f"set {p.get('key')} to {p.get('status')}",
    MutationKind.TASK_PRIORITY_SET:
        lambda p: f"set {p.get('key')} priority to {p.get('priority')}",
    MutationKind.DEPENDENCY_ADD:
        lambda p: f"add {p.get('from_task')} -> {p.get('to_task')}",
    MutationKind.DEPENDENCY_REMOVE:
        lambda p: f"remove {p.get('from_task')} -> {p.get('to_task')}",
    MutationKind.DEPENDENCY_TYPE_CHANGE:
        lambda p: f"change {p.get('from_task')} -> {p.get('to_task')}",
    MutationKind.ASSIGNMENT_ADD:
        lambda p: f"assign {p.get('resource_key')} to {p.get('task_key')}",
    MutationKind.ASSIGNMENT_REMOVE:
        lambda p: f"unassign {p.get('resource_key')} from {p.get('task_key')}",
    MutationKind.RESOURCE_CAPACITY_SET:
        lambda p: f"set {p.get('resource_key')} capacity to {p.get('capacity')}",
    MutationKind.RESOURCE_UNAVAILABLE_WINDOW:
        lambda p: (
            f"{p.get('resource_key')} unavailability set to "
            f"{len(p['windows'])} window(s)" if "windows" in p else
            f"{p.get('resource_key')} unavailable days "
            f"{p.get('from_day')}-{p.get('to_day')}"
        ),
    MutationKind.DEADLINE_SET:
        lambda p: f"set deadline to day {p.get('deadline_day')}",
    MutationKind.REQUIREMENT_VERSION_BUMP:
        lambda p: f"bump requirement {p.get('requirement_key')}",
})


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def validate(
    snapshot: WorkflowSnapshot, state: WorkflowState, mutation: Mutation
) -> ValidationResult:
    """Structural then semantic. Never partial: a mutation is valid or it is
    rejected with reasons."""
    structural = _structural(mutation)
    if structural:
        return ValidationResult.failed(*structural)
    semantic = handlers()[mutation.kind].validate(snapshot, state, mutation.payload)
    if semantic:
        return ValidationResult.failed(*semantic)
    return ValidationResult.ok()


def apply(
    snapshot: WorkflowSnapshot, state: WorkflowState, mutation: Mutation
) -> Pair:
    """Apply one mutation, returning a new pair. Raises if it does not
    validate - callers should validate first and show the reason."""
    result = validate(snapshot, state, mutation)
    if not result.valid:
        raise MutationError(result)
    return handlers()[mutation.kind].apply(snapshot, state, mutation.payload)


def inverse(
    snapshot: WorkflowSnapshot, state: WorkflowState, mutation: Mutation
) -> Inverse:
    """The mutation list that undoes this one, computed **against the
    pre-apply state** - which is why it is a function of the snapshot, not of
    the mutation alone.

    A list because some undos need more than one step: undoing a task removal
    re-adds the task, drops the bridges the removal created, and restores its
    assignments.
    """
    return handlers()[mutation.kind].inverse(snapshot, state, mutation.payload)


def validate_all(
    snapshot: WorkflowSnapshot,
    state: WorkflowState,
    mutations: list[Mutation],
) -> ValidationResult:
    """Validate an ordered list by applying each in turn.

    Order matters: adding a task then depending on it is valid, and the
    reverse is not. Validating each against the base snapshot would wrongly
    reject the first.
    """
    s, st = snapshot, state
    rejections: list[Rejection] = []
    for i, mutation in enumerate(mutations):
        result = validate(s, st, mutation)
        if not result.valid:
            rejections.extend(
                replace(r, reason=f"mutation {i + 1}: {r.reason}")
                for r in result.rejections
            )
            break
        s, st = handlers()[mutation.kind].apply(s, st, mutation.payload)
    if rejections:
        return ValidationResult.failed(*rejections)
    return ValidationResult.ok()


def apply_all(
    snapshot: WorkflowSnapshot,
    state: WorkflowState,
    mutations: list[Mutation],
) -> tuple[WorkflowSnapshot, WorkflowState, list[Mutation]]:
    """Apply an ordered list. Returns the new pair and the inverse list,
    already ordered so that `apply_all(after, after_state, inverses)` returns
    to exactly the pair that was passed in.

    The base pair is never modified - snapshots are immutable and every
    applier returns a new one.
    """
    s, st = snapshot, state
    inverses: list[Mutation] = []
    for mutation in mutations:
        # Each mutation's undo steps go in front of the ones already
        # collected, so replaying the result undoes the list back to front.
        inverses = list(inverse(s, st, mutation)) + inverses
        s, st = apply(s, st, mutation)
    return s, st, inverses
