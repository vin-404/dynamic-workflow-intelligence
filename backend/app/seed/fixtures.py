"""
Seed fixtures - two projects in genuinely different domains.

This replaces the prototype's `scenario.py`, where a single campus event was
*the* product as module-level mutable globals. Here a domain is data, a
fixture is a function that returns a fresh immutable snapshot, and there are
two of them:

* `event_operations_fixture()` - the migrated campus symposium. **Has event
  history**, so it reaches Tier 2 and reproduces the prototype's planted
  bottlenecks and its accuracy numbers exactly.
* `hardware_manufacturing_fixture()` - a pilot production line. **No history
  at all**, so it exercises the cold-start path: Tier-0 structural analysis
  plus an honest statement of what cannot be assessed yet. It also carries the
  constraints that make the optimizer refuse to cheat.

Nothing in `core/` can see the `DomainFixture` attached to a project: it is
context for the LLM and defaults for the UI, never an engine input
(ARCHITECTURE A.3).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Mapping

from backend.app.core.workflow import (
    AssignmentSpec,
    CalendarSpec,
    ConstraintKind,
    ConstraintSpec,
    DependencySpec,
    DepType,
    EventRecord,
    RequirementSpec,
    ResourceSpec,
    TaskSpec,
    TaskStatus,
    WorkflowSnapshot,
    WorkflowState,
)

STANDARD_CALENDAR = CalendarSpec(key="standard", working_days=(0, 1, 2, 3, 4))


@dataclass(frozen=True)
class DomainFixture:
    """A `Domain` row. Seeded domains are just rows; users create their own."""

    key: str
    name: str
    description: str
    vocabulary_hints: tuple[str, ...] = ()
    task_templates: tuple[dict, ...] = ()
    duration_variance_prior: float = 0.25


@dataclass(frozen=True)
class LabelledFinding:
    """One problem this fixture is known to contain.

    Labelling every finding a fixture legitimately produces - not only the
    three faults planted for the original demo - is what makes precision and
    recall mean something. Recall against a partial label set flatters the
    detectors; precision against one punishes them for being right about
    something nobody wrote down.

    `planted=True` marks a fault authored deliberately to be found. The rest
    are structural facts of the fixture that the Tier-0 detectors correctly
    identify.
    """

    kind: str
    root_cause: str
    description: str
    planted: bool = False

    @property
    def ref(self) -> tuple[str, str]:
        return (self.kind, self.root_cause)


@dataclass(frozen=True)
class MemberFixture:
    email: str
    name: str
    role: str = "editor"


@dataclass(frozen=True)
class ProjectFixture:
    key: str
    name: str
    description: str
    goal: str
    start_date: date
    today_day: float
    domain: DomainFixture
    snapshot: WorkflowSnapshot
    state: WorkflowState
    members: tuple[MemberFixture, ...] = ()
    #: Every problem this fixture is known to contain, for the detector
    #: precision/recall harness.
    labelled: tuple[LabelledFinding, ...] = ()
    owner_email: str = "owner@example.com"

    @property
    def planted(self) -> tuple[LabelledFinding, ...]:
        """The subset authored deliberately as faults to be found."""
        return tuple(f for f in self.labelled if f.planted)

    @property
    def labelled_refs(self) -> set[tuple[str, str]]:
        return {f.ref for f in self.labelled}


# ---------------------------------------------------------------------------
# Fixture 1 - event operations. Migrated from the prototype, with history.
# ---------------------------------------------------------------------------

EVENT_OPERATIONS = DomainFixture(
    key="event_operations",
    name="Event Operations",
    description=(
        "Multi-team events: a fixed date, many parallel workstreams, and "
        "approvals that gate everything downstream."
    ),
    vocabulary_hints=("venue", "vendor", "sponsor", "attendee", "run sheet"),
    task_templates=(
        {"name": "Define scope and date", "effort": 2},
        {"name": "Draft budget", "effort": 3},
        {"name": "Budget approval", "effort": 2, "divisible": False},
        {"name": "Book venue", "effort": 2},
        {"name": "Dry run", "effort": 1},
    ),
    duration_variance_prior=0.3,
)

#: (key, name, effort, resource) - one assignment each, so the effort model is
#: a no-op for this fixture and its original arithmetic is preserved (D-14).
_EVENT_TASKS = [
    ("T01", "Define event scope & date",      2, "anitha"),
    ("T02", "Draft budget",                   3, "ravi"),
    ("T03", "Budget approval",                2, "deepa"),
    ("T04", "Book auditorium",                2, "suresh"),
    ("T05", "Shortlist catering & AV vendors", 3, "suresh"),
    ("T06", "Vendor contracts",               4, "ravi"),
    ("T07", "Sponsor deck",                   3, "karthik"),
    ("T08", "Sponsor outreach",               5, "karthik"),
    ("T09", "Sponsor confirmations",          4, "nisha"),
    ("T10", "Brand guidelines",               2, "priya"),
    ("T11", "Posters & social creatives",     4, "priya"),
    ("T12", "Registration site",              5, "arjun"),
    ("T13", "Speaker invites",                4, "anitha"),
    ("T14", "Speaker confirmations",          5, "anitha"),
    ("T15", "Schedule finalisation",          2, "anitha"),
    ("T16", "Print & install signage",        3, "suresh"),
    ("T17", "Dry run",                        1, "anitha"),
]

#: (from, to, consumes) - `consumes=True` was the prototype's 'artifact' edge:
#: the successor consumes something the predecessor produced, so a requirement
#: change invalidates it. `False` was 'temporal': ordering only.
_EVENT_DEPS = [
    ("T01", "T02", True),
    ("T02", "T03", True),
    ("T01", "T04", False),
    ("T03", "T04", False),
    ("T03", "T05", False),
    ("T05", "T06", True),
    ("T01", "T07", True),
    ("T07", "T08", True),
    ("T08", "T09", True),
    ("T01", "T10", True),
    ("T10", "T11", True),
    ("T09", "T11", True),
    ("T10", "T12", True),
    ("T01", "T13", False),
    ("T03", "T13", False),
    ("T13", "T14", True),
    ("T14", "T15", True),
    ("T04", "T15", False),
    ("T11", "T16", True),
    ("T15", "T17", True),
    ("T16", "T17", False),
    ("T12", "T17", False),
    ("T06", "T17", False),
]

#: Teams cap throughput below the sum of their members - marketing has two
#: people but can only run one of these workstreams at a time. That gap is the
#: planted contention bottleneck, and it is why `capacity` lives on the
#: roll-up resource (decision D-16).
_EVENT_TEAMS = [
    ("org", "Programme", 2),
    ("fin", "Finance", 1),
    ("fac", "Facilities", 1),
    ("mkt", "Marketing", 1),
    ("spon", "Sponsorship", 1),
]

_EVENT_PEOPLE = [
    ("anitha", "Anitha", "org"),
    ("ravi", "Ravi", "fin"),
    ("deepa", "Deepa", "fin"),
    ("suresh", "Suresh", "fac"),
    ("karthik", "Karthik", "spon"),
    ("nisha", "Nisha", "spon"),
    ("priya", "Priya", "mkt"),
    ("arjun", "Arjun", "mkt"),
]

_EVENT_STATUS = {
    "T01": TaskStatus.DONE,
    "T02": TaskStatus.DONE,
    "T03": TaskStatus.IN_REVIEW,
    "T04": TaskStatus.NOT_STARTED,
    "T05": TaskStatus.NOT_STARTED,
    "T06": TaskStatus.NOT_STARTED,
    "T07": TaskStatus.DONE,
    "T08": TaskStatus.DONE,
    "T09": TaskStatus.DONE,
    "T10": TaskStatus.DONE,
    "T11": TaskStatus.NOT_STARTED,
    "T12": TaskStatus.NOT_STARTED,
    "T13": TaskStatus.NOT_STARTED,
    "T14": TaskStatus.NOT_STARTED,
    "T15": TaskStatus.NOT_STARTED,
    "T16": TaskStatus.NOT_STARTED,
    "T17": TaskStatus.NOT_STARTED,
}

_EVENT_EVENTS = [
    (0.0,  "T01", "Anitha",  TaskStatus.NOT_STARTED, TaskStatus.IN_PROGRESS),
    (2.0,  "T01", "Anitha",  TaskStatus.IN_PROGRESS, TaskStatus.DONE),
    (2.0,  "T02", "Ravi",    TaskStatus.NOT_STARTED, TaskStatus.IN_PROGRESS),
    (5.0,  "T02", "Ravi",    TaskStatus.IN_PROGRESS, TaskStatus.DONE),
    (5.0,  "T03", "Deepa",   TaskStatus.NOT_STARTED, TaskStatus.IN_REVIEW),
    (2.0,  "T07", "Karthik", TaskStatus.NOT_STARTED, TaskStatus.IN_PROGRESS),
    (5.0,  "T07", "Karthik", TaskStatus.IN_PROGRESS, TaskStatus.DONE),
    (5.0,  "T08", "Karthik", TaskStatus.NOT_STARTED, TaskStatus.IN_PROGRESS),
    (9.0,  "T08", "Karthik", TaskStatus.IN_PROGRESS, TaskStatus.DONE),
    (9.0,  "T09", "Nisha",   TaskStatus.NOT_STARTED, TaskStatus.IN_PROGRESS),
    (13.0, "T09", "Nisha",   TaskStatus.IN_PROGRESS, TaskStatus.DONE),
    (2.0,  "T10", "Priya",   TaskStatus.NOT_STARTED, TaskStatus.IN_PROGRESS),
    (4.0,  "T10", "Priya",   TaskStatus.IN_PROGRESS, TaskStatus.DONE),
]

_EVENT_REQUIREMENTS = [
    ("R1", "Single-day event, 400 attendees", ("T02", "T04", "T05", "T12")),
    ("R2", "Signage and creatives in English only", ("T10", "T11", "T16")),
    ("R3", "On-site only, no streaming", ("T05", "T12", "T17")),
]

#: Everything this fixture is known to contain. The three `planted=True`
#: entries are the faults the original prototype authored deliberately and
#: measured recall against; the rest are structural facts of the same
#: workflow, which the Tier-0 detectors correctly identify.
_EVENT_LABELLED = (
    # -- the three planted faults, preserved verbatim from the prototype
    LabelledFinding(
        "stalled_in_review", "T03",
        "budget approval stalled in review for 9 days (critical path)",
        planted=True,
    ),
    LabelledFinding(
        "resource_contention", "mkt",
        "marketing has 2 ready tasks (T11, T12) against capacity 1",
        planted=True,
    ),
    LabelledFinding(
        "ready_but_idle", "T12",
        "registration site unblocked for 10 days, never started",
        planted=True,
    ),
    # -- consequences of those faults, at other tiers
    LabelledFinding(
        "critical_path_blocker", "T03",
        "T03 is the earliest unfinished zero-slack task, so it is the root "
        "cause of every blocked task behind it",
    ),
    LabelledFinding(
        "projected_vs_planned_finish", "T03",
        "T03 running 7 days over its estimate is what makes the projection "
        "day 26 against a planned day 22",
    ),
    # -- structural facts of the workflow, findable with no history at all
    LabelledFinding(
        "single_point_of_failure", "T01",
        "T01 gates five workstreams directly: scope, budget, sponsorship, "
        "brand and speakers",
    ),
    LabelledFinding(
        "single_point_of_failure", "T03",
        "budget approval gates facilities, vendors and the speaker track",
    ),
    LabelledFinding(
        "deadline_infeasible", "T17",
        "day 26 projected against a day 24 deadline: infeasible by 2 days",
    ),
    LabelledFinding(
        "resource_overallocated", "suresh",
        "Suresh is scheduled on T04 and T05 in the same window with capacity 1",
    ),
    LabelledFinding(
        "redundant_dependency", "T01->T04",
        "already implied by T01 -> T02 -> T03 -> T04",
    ),
    LabelledFinding(
        "redundant_dependency", "T01->T13",
        "already implied by T01 -> T02 -> T03 -> T13",
    ),
)


def event_operations_fixture() -> ProjectFixture:
    """The migrated campus symposium: 17 tasks, 8 people in 5 teams, event
    history back to day 0, three planted bottlenecks.

    Every number the prototype's regression suite asserts is reproduced here:
    planned finish day 22, projected day 26, slip 4, a 7-task critical path,
    exactly 4 findings over 3 root causes.
    """
    tasks = tuple(
        TaskSpec(
            key=key,
            name=name,
            effort=float(effort),
            # An approval is a single signature: it cannot be parallelised.
            divisible=(key != "T03"),
        )
        for key, name, effort, _ in _EVENT_TASKS
    )
    deps = tuple(
        DependencySpec(from_task=u, to_task=v, dep_type=DepType.FS, consumes=c)
        for u, v, c in _EVENT_DEPS
    )
    resources = tuple(
        ResourceSpec(key=k, name=n, kind="team", capacity=c,
                     calendar_key=STANDARD_CALENDAR.key)
        for k, n, c in _EVENT_TEAMS
    ) + tuple(
        ResourceSpec(key=k, name=n, kind="person", capacity=1, parent_key=team,
                     calendar_key=STANDARD_CALENDAR.key)
        for k, n, team in _EVENT_PEOPLE
    )
    assignments = tuple(
        AssignmentSpec(task_key=key, resource_key=who)
        for key, _, _, who in _EVENT_TASKS
    )
    requirements = tuple(
        RequirementSpec(key=k, text=t, version_no=1, consumed_by=by)
        for k, t, by in _EVENT_REQUIREMENTS
    )
    constraints = (
        ConstraintSpec(
            kind=ConstraintKind.MANDATORY_TASK,
            target="T03",
            reason="Spending cannot be committed without an approved budget.",
        ),
        ConstraintSpec(
            kind=ConstraintKind.NON_DIVISIBLE_TASK,
            target="T03",
            reason="A single approval signature; more approvers does not make it faster.",
        ),
        ConstraintSpec(
            kind=ConstraintKind.IMMUTABLE_DEPENDENCY,
            target=ConstraintSpec.dependency_target("T02", "T03"),
            reason="You cannot approve a budget that has not been drafted.",
        ),
        ConstraintSpec(
            kind=ConstraintKind.MANDATORY_TASK,
            target="T17",
            reason="The dry run is the go/no-go gate for the event.",
        ),
    )

    snapshot = WorkflowSnapshot.build(
        tasks=tasks,
        dependencies=deps,
        resources=resources,
        assignments=assignments,
        requirements=requirements,
        constraints=constraints,
        calendars=(STANDARD_CALENDAR,),
        deadline_day=24.0,
    )
    state = WorkflowState(
        statuses=dict(_EVENT_STATUS),
        events=tuple(
            EventRecord(day=d, task_key=t, actor=a, from_status=f, to_status=to)
            for d, t, a, f, to in _EVENT_EVENTS
        ),
    )
    return ProjectFixture(
        key="campus-symposium",
        name="Campus Tech Symposium",
        description="Annual campus tech symposium - 17 tasks across 5 teams",
        goal="Run a single-day 400-attendee symposium without slipping the date.",
        start_date=date(2026, 9, 1),
        today_day=14.0,
        domain=EVENT_OPERATIONS,
        snapshot=snapshot,
        state=state,
        members=(
            MemberFixture("owner@example.com", "Programme Lead", "owner"),
            MemberFixture("ravi@example.com", "Ravi", "editor"),
            MemberFixture("priya@example.com", "Priya", "editor"),
            MemberFixture("viewer@example.com", "Sponsor Liaison", "viewer"),
        ),
        labelled=_EVENT_LABELLED,
    )


# ---------------------------------------------------------------------------
# Fixture 2 - hardware manufacturing. No history at all: the cold start.
# ---------------------------------------------------------------------------

HARDWARE_MANUFACTURING = DomainFixture(
    key="hardware_manufacturing",
    name="Hardware Manufacturing",
    description=(
        "Physical product introduction: long-lead tooling, shared test "
        "equipment, and certification gates that legally cannot be skipped."
    ),
    vocabulary_hints=("tooling", "line", "cell", "certification", "pilot run"),
    task_templates=(
        {"name": "Finalise specification", "effort": 3},
        {"name": "Order tooling", "effort": 8},
        {"name": "Safety certification", "effort": 5, "divisible": False},
        {"name": "Pilot run", "effort": 2},
    ),
    duration_variance_prior=0.4,
)

_MFG_TASKS = [
    ("M01", "Finalise cell specification",  3, "meera", True),
    ("M02", "Source cells from supplier",   5, "vikram", True),
    ("M03", "Qualify supplier",             4, "lena", True),
    ("M04", "Design pack enclosure",        6, "meera", True),
    ("M05", "Order and receive tooling",    8, "vikram", True),
    ("M06", "Assemble prototype pack",      4, "tan", True),
    ("M07", "Thermal test",                 3, "testrig", False),
    ("M08", "Electrical test",              3, "testrig", False),
    ("M09", "Safety certification",         5, "lena", False),
    ("M10", "Line layout",                  4, "tan", True),
    ("M11", "Operator training",            3, "vikram", True),
    ("M12", "Pilot run",                    2, "tan", True),
]

_MFG_DEPS = [
    ("M01", "M02", True),
    ("M01", "M03", False),
    ("M03", "M02", False),
    ("M01", "M04", True),
    ("M04", "M05", True),
    ("M02", "M06", True),
    ("M05", "M06", True),
    # Redundant: M04 -> M05 -> M06 already orders these. Transitive reduction
    # should find and drop it, provably without moving the finish date.
    ("M04", "M06", True),
    ("M06", "M07", True),
    ("M06", "M08", True),
    ("M07", "M09", True),
    ("M08", "M09", True),
    ("M01", "M10", False),
    ("M10", "M11", False),
    ("M09", "M12", True),
    ("M11", "M12", False),
]

_MFG_RESOURCES = [
    # key, name, kind, capacity, parent
    ("eng", "Engineering", "team", 2, None),
    ("ops", "Operations", "team", 1, None),
    ("qa", "Quality", "team", 1, None),
    ("meera", "Meera", "person", 1, "eng"),
    ("tan", "Tan", "person", 1, "eng"),
    ("vikram", "Vikram", "person", 1, "ops"),
    ("lena", "Lena", "person", 1, "qa"),
    ("testrig", "Environmental test rig", "equipment", 1, None),
]

_MFG_SKILLS = {
    "meera": ("mechanical", "electrical"),
    "tan": ("mechanical", "assembly"),
    "vikram": ("supply-chain", "assembly"),
    "lena": ("quality", "certification"),
    "testrig": ("thermal", "electrical-test"),
}

_MFG_REQUIREMENTS = [
    ("RQ1", "Pack must deliver 4.8 kWh usable at 25 C", ("M01", "M04", "M07")),
    ("RQ2", "Enclosure IP67, no active cooling", ("M04", "M06", "M07")),
    ("RQ3", "Certified to UN38.3 before any customer shipment", ("M09", "M12")),
]


#: This fixture plants nothing in the "stalled task" sense - it has no history
#: at all. Everything labelled here is a structural fact of the plan, findable
#: at Tier 0, which is exactly the cold-start case the tiering exists for.
_MFG_LABELLED = (
    LabelledFinding(
        "deadline_infeasible", "M12",
        "day 31 projected against a day 26 deadline: infeasible by 5 days "
        "before anything has gone wrong",
    ),
    LabelledFinding(
        "single_point_of_failure", "M01",
        "the cell specification gates sourcing, supplier qualification, "
        "enclosure design and line layout",
    ),
    LabelledFinding(
        "zero_slack_chain", "M01",
        "8 of 12 tasks have zero slack, so the plan has almost no capacity to "
        "absorb a delay anywhere",
    ),
    LabelledFinding(
        "resource_overallocated", "vikram",
        "Vikram is scheduled on sourcing and tooling in overlapping windows "
        "with capacity 1",
    ),
    LabelledFinding(
        "resource_overallocated", "testrig",
        "the thermal and electrical tests are both booked on the single test "
        "rig in the same window",
    ),
    LabelledFinding(
        "redundant_dependency", "M01->M02",
        "already implied by M01 -> M03 -> M02",
    ),
    LabelledFinding(
        "redundant_dependency", "M04->M06",
        "already implied by M04 -> M05 -> M06",
    ),
)


def hardware_manufacturing_fixture() -> ProjectFixture:
    """A pilot production line with **no event history and no statuses**.

    This is the cold-start case a judge creates by hand: the engine can still
    schedule it, still find its structural problems, and must say plainly what
    it cannot assess. It is also where the optimizer's guardrails bite - the
    safety certification is mandatory, non-divisible, and its gate on the
    pilot run is immutable, so "just delete the slow task" is unavailable.
    """
    tasks = tuple(
        TaskSpec(
            key=key,
            name=name,
            effort=float(effort),
            divisible=divisible,
            required_skills=_MFG_SKILLS.get(who, ()),
        )
        for key, name, effort, who, divisible in _MFG_TASKS
    )
    deps = tuple(
        DependencySpec(from_task=u, to_task=v, dep_type=DepType.FS, consumes=c)
        for u, v, c in _MFG_DEPS
    )
    resources = tuple(
        ResourceSpec(
            key=k,
            name=n,
            kind=kind,
            capacity=cap,
            parent_key=parent,
            skills=_MFG_SKILLS.get(k, ()),
            calendar_key=STANDARD_CALENDAR.key,
        )
        for k, n, kind, cap, parent in _MFG_RESOURCES
    )
    assignments = tuple(
        AssignmentSpec(task_key=key, resource_key=who)
        for key, _, _, who, _ in _MFG_TASKS
    )
    requirements = tuple(
        RequirementSpec(key=k, text=t, version_no=1, consumed_by=by)
        for k, t, by in _MFG_REQUIREMENTS
    )
    constraints = (
        ConstraintSpec(
            kind=ConstraintKind.MANDATORY_TASK,
            target="M09",
            reason="UN38.3 safety certification is a legal precondition to shipping.",
        ),
        ConstraintSpec(
            kind=ConstraintKind.NON_DIVISIBLE_TASK,
            target="M09",
            reason="A certification body runs one assessment; adding staff does not shorten it.",
        ),
        ConstraintSpec(
            kind=ConstraintKind.IMMUTABLE_DEPENDENCY,
            target=ConstraintSpec.dependency_target("M09", "M12"),
            reason="No pilot output may leave the site before certification passes.",
        ),
        ConstraintSpec(
            kind=ConstraintKind.NON_DIVISIBLE_TASK,
            target="M07",
            reason="One environmental chamber; the thermal soak runs end to end.",
        ),
        ConstraintSpec(
            kind=ConstraintKind.NON_DIVISIBLE_TASK,
            target="M08",
            reason="Single test rig, single harness.",
        ),
        ConstraintSpec(
            kind=ConstraintKind.MANDATORY_TASK,
            target="M12",
            reason="The pilot run is the deliverable.",
        ),
        ConstraintSpec(
            kind=ConstraintKind.MIN_DURATION,
            target="M05",
            value=6.0,
            reason="Tooling vendor's contractual minimum lead time is 6 days.",
        ),
    )

    snapshot = WorkflowSnapshot.build(
        tasks=tasks,
        dependencies=deps,
        resources=resources,
        assignments=assignments,
        requirements=requirements,
        constraints=constraints,
        calendars=(STANDARD_CALENDAR,),
        # Projected finish is day 31, so this is infeasible by 5 days on
        # structure alone - visible with zero history.
        deadline_day=26.0,
    )
    return ProjectFixture(
        key="battery-pilot-line",
        name="Battery Pack Pilot Line",
        description="Pilot line for a 4.8 kWh battery pack - 12 tasks, shared test rig",
        goal="Reach a certified pilot run before the customer design freeze.",
        start_date=date(2026, 10, 5),
        today_day=0.0,
        domain=HARDWARE_MANUFACTURING,
        snapshot=snapshot,
        # No statuses, no events. Cold start, stated honestly.
        state=WorkflowState.empty(snapshot),
        members=(
            MemberFixture("owner@example.com", "Programme Lead", "owner"),
            MemberFixture("meera@example.com", "Meera", "editor"),
            MemberFixture("lena@example.com", "Lena", "viewer"),
        ),
        labelled=_MFG_LABELLED,
    )


# ---------------------------------------------------------------------------

FIXTURE_BUILDERS = {
    "campus-symposium": event_operations_fixture,
    "battery-pilot-line": hardware_manufacturing_fixture,
}

DOMAINS = (EVENT_OPERATIONS, HARDWARE_MANUFACTURING)


def all_fixtures() -> tuple[ProjectFixture, ...]:
    """Fresh instances every call - fixtures are functions, not globals."""
    return tuple(build() for build in FIXTURE_BUILDERS.values())


def fixture(key: str) -> ProjectFixture:
    if key not in FIXTURE_BUILDERS:
        raise KeyError(f"unknown fixture {key!r}; have {sorted(FIXTURE_BUILDERS)}")
    return FIXTURE_BUILDERS[key]()


# ---------------------------------------------------------------------------
# Import samples - Phase 11.
#
# Not a domain and not a workflow fixture: a real-shaped file that ships with
# the product so a demo can import something without a network call. It is
# listed here because this module is the inventory of what ships, but nothing
# else about it is like the fixtures above - it is never seeded, no project is
# built from it at startup, and neither demo domain reads it. The file itself
# lives beside the importer that parses it, in
# `backend/app/ingest/samples/`.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ImportSampleFixture:
    """One bundled file, and what a reader should look for in its preview."""

    name: str
    title: str
    description: str
    #: Which front door of the importer this file is for: "jira" or "csv".
    source: str
    #: File name inside `backend/app/ingest/samples/`.
    filename: str
    #: Claims about the file. Every one of these is asserted by
    #: `backend/tests/test_ingest.py`, so the list cannot quietly become
    #: marketing copy.
    demonstrates: tuple[str, ...] = ()


IMPORT_SAMPLES: tuple[ImportSampleFixture, ...] = (
    ImportSampleFixture(
        name="jira-delivery-platform",
        title="Shipment tracking rebuild (Jira export)",
        description=(
            "An anonymised Jira issue export for a fifteen-issue delivery "
            "programme: fourteen issues that import, three rows that cannot, "
            "and a blocking-link structure with a real critical path."
        ),
        source="jira",
        filename="jira-delivery-platform.csv",
        demonstrates=(
            "Four identically-named 'Outward issue link (Blocks)' columns, up "
            "to four of them used on a single row - the case csv.DictReader "
            "silently collapses to one.",
            "Both link directions in one file: outward 'blocks' on DLV-6, "
            "inward 'is blocked by' on DLV-12 and DLV-14.",
            "Three rows that cannot be mapped, for three different reasons: "
            "no issue key, a duplicate issue key, and story points typed as "
            "'TBD'.",
            "A link to DLV-99, which is not in the export, reported as a "
            "dropped dependency rather than an invented task.",
            "A customised status ('Awaiting Copy') with no equivalent of ours, "
            "resolved through its Jira status category and labelled as such.",
            "An issue estimated in seconds rather than story points (DLV-10), "
            "and one estimated not at all (DLV-12), whose effort is defaulted "
            "and said to be defaulted.",
            "A quoted description containing a newline, so the reported record "
            "number and physical line number genuinely differ.",
            "A critical path of DLV-1, DLV-2, DLV-3, DLV-5, DLV-11, DLV-12, "
            "DLV-13, DLV-14 that finishes after the deadline the due dates "
            "imply.",
            "DLV-11 as a convergence bottleneck with six predecessors, and "
            "one assignee holding more than half the programme's effort at "
            "capacity 1.",
        ),
    ),
)


def import_sample(name: str) -> ImportSampleFixture:
    for sample in IMPORT_SAMPLES:
        if sample.name == name:
            return sample
    raise KeyError(
        f"unknown import sample {name!r}; have "
        f"{sorted(s.name for s in IMPORT_SAMPLES)}"
    )
