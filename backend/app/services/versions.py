"""
The DB <-> `core/` boundary for workflow snapshots.

This is the only place that knows both SQLAlchemy rows and
`core.workflow.WorkflowSnapshot`. Everything above it works in rows;
everything below it works in snapshots. `core/` never learns the database
exists.

It is also where integer working-days meet calendar dates: `day_to_date` and
`date_to_day` are called here and at the API edge, and nowhere inside `core/`.
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.core.workflow import (
    AssignmentSpec,
    CalendarSpec,
    Clock,
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
from backend.app.models import (
    Assignment,
    Calendar,
    Constraint,
    Dependency,
    Event,
    Project,
    Requirement,
    Resource,
    Task,
    WorkflowVersion,
)


class NotFound(Exception):
    """Raised when a project or version does not exist. Routers map it to 404."""


# ---------------------------------------------------------------------------
# Calendar boundary - the one place day offsets become dates
# ---------------------------------------------------------------------------


def day_to_date(start: date, day: float) -> str:
    return (start + timedelta(days=float(day))).isoformat()


def date_to_day(start: date, when: date | None) -> float | None:
    if when is None:
        return None
    return float((when - start).days)


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


async def get_project(db: AsyncSession, project_id: uuid.UUID) -> Project:
    row = (
        await db.execute(select(Project).where(Project.id == project_id))
    ).scalar_one_or_none()
    if row is None:
        raise NotFound(f"Project {project_id} not found")
    return row


async def get_version(
    db: AsyncSession, version_id: uuid.UUID
) -> WorkflowVersion:
    row = (
        await db.execute(
            select(WorkflowVersion).where(WorkflowVersion.id == version_id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise NotFound(f"Workflow version {version_id} not found")
    return row


async def get_current_version(
    db: AsyncSession, project_id: uuid.UUID
) -> WorkflowVersion:
    project = await get_project(db, project_id)
    if project.current_version_id is not None:
        return await get_version(db, project.current_version_id)
    latest = (
        await db.execute(
            select(WorkflowVersion)
            .where(WorkflowVersion.project_id == project_id)
            .order_by(WorkflowVersion.version_no.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if latest is None:
        raise NotFound(f"Project {project_id} has no workflow version yet")
    return latest


async def load_snapshot(
    db: AsyncSession, version_id: uuid.UUID
) -> WorkflowSnapshot:
    """Materialise an immutable snapshot from a version's rows.

    Note there is no `domain` argument and no domain field on the result. The
    engine's input schema has no domain at all - absent, not ignored.
    """
    version = (
        await db.execute(
            select(WorkflowVersion)
            .where(WorkflowVersion.id == version_id)
            .options(
                selectinload(WorkflowVersion.tasks),
                selectinload(WorkflowVersion.dependencies),
                selectinload(WorkflowVersion.resources),
                selectinload(WorkflowVersion.assignments),
                selectinload(WorkflowVersion.requirements),
                selectinload(WorkflowVersion.constraints),
                selectinload(WorkflowVersion.calendars),
            )
        )
    ).scalar_one_or_none()
    if version is None:
        raise NotFound(f"Workflow version {version_id} not found")

    return WorkflowSnapshot.build(
        tasks=[
            TaskSpec(
                key=t.key,
                name=t.name,
                description=t.description or "",
                effort=t.effort,
                divisible=t.divisible,
                priority=t.priority,
                optimistic=t.optimistic,
                likely=t.likely,
                pessimistic=t.pessimistic,
                required_skills=tuple(t.required_skills or ()),
            )
            for t in version.tasks
        ],
        dependencies=[
            DependencySpec(
                from_task=d.from_task,
                to_task=d.to_task,
                dep_type=DepType(d.dep_type),
                consumes=d.consumes,
            )
            for d in version.dependencies
        ],
        resources=[
            ResourceSpec(
                key=r.key,
                name=r.name,
                kind=r.kind,
                capacity=r.capacity,
                skills=tuple(r.skills or ()),
                calendar_key=r.calendar_key,
                parent_key=r.parent_key,
            )
            for r in version.resources
        ],
        assignments=[
            AssignmentSpec(
                task_key=a.task_key,
                resource_key=a.resource_key,
                allocation=a.allocation,
            )
            for a in version.assignments
        ],
        requirements=[
            RequirementSpec(
                key=r.key,
                text=r.text,
                version_no=r.version_no,
                consumed_by=tuple(r.consumed_by_task_keys or ()),
            )
            for r in version.requirements
        ],
        constraints=[
            ConstraintSpec(
                kind=ConstraintKind(c.kind),
                target=c.target,
                reason=c.reason or "",
                value=c.value,
            )
            for c in version.constraints
        ],
        calendars=[
            CalendarSpec(
                key=c.key,
                working_days=tuple(c.working_days or (0, 1, 2, 3, 4)),
                holidays=tuple(c.holidays or ()),
            )
            for c in version.calendars
        ],
        deadline_day=version.deadline_day,
    )


async def load_state(
    db: AsyncSession, project_id: uuid.UUID, version_id: uuid.UUID
) -> WorkflowState:
    """Observed state: statuses from the version's task rows, history from the
    project's append-only event log."""
    tasks = (
        await db.execute(select(Task).where(Task.version_id == version_id))
    ).scalars().all()
    events = (
        await db.execute(
            select(Event).where(Event.project_id == project_id).order_by(Event.day)
        )
    ).scalars().all()

    actuals: dict[str, float] = {}
    for t in tasks:
        if t.actual_start_day is not None and t.actual_end_day is not None:
            actuals[t.key] = float(t.actual_end_day - t.actual_start_day)

    return WorkflowState(
        statuses={t.key: TaskStatus(t.status) for t in tasks},
        events=tuple(
            EventRecord(
                day=e.day,
                task_key=e.task_key,
                actor=e.actor or "",
                from_status=TaskStatus(e.from_status),
                to_status=TaskStatus(e.to_status),
            )
            for e in events
        ),
        actual_durations=actuals,
    )


async def load_context(
    db: AsyncSession, project_id: uuid.UUID, version_id: uuid.UUID | None = None
) -> tuple[Project, WorkflowVersion, WorkflowSnapshot, WorkflowState, Clock]:
    """Everything `evaluate()` needs, in one call."""
    project = await get_project(db, project_id)
    version = (
        await get_version(db, version_id)
        if version_id is not None
        else await get_current_version(db, project_id)
    )
    snapshot = await load_snapshot(db, version.id)
    state = await load_state(db, project_id, version.id)
    return project, version, snapshot, state, Clock(project.today_day)


# ---------------------------------------------------------------------------
# Writing - a version is written once and never updated in place
# ---------------------------------------------------------------------------


async def next_version_no(db: AsyncSession, project_id: uuid.UUID) -> int:
    rows = (
        await db.execute(
            select(WorkflowVersion.version_no).where(
                WorkflowVersion.project_id == project_id
            )
        )
    ).scalars().all()
    return (max(rows) + 1) if rows else 1


async def write_version(
    db: AsyncSession,
    project_id: uuid.UUID,
    snapshot: WorkflowSnapshot,
    *,
    statuses: dict[str, TaskStatus] | None = None,
    parent_version_id: uuid.UUID | None = None,
    created_from_scenario_id: uuid.UUID | None = None,
    note: str = "",
    is_draft: bool = True,
) -> WorkflowVersion:
    """Persist a snapshot as a brand new immutable version.

    Never mutates an existing version. The caller decides whether to move the
    project pointer, because that is the act of "applying".
    """
    version = WorkflowVersion(
        project_id=project_id,
        version_no=await next_version_no(db, project_id),
        parent_version_id=parent_version_id,
        created_from_scenario_id=created_from_scenario_id,
        note=note,
        content_hash=snapshot.content_hash(),
        is_draft=is_draft,
        deadline_day=snapshot.deadline_day,
    )
    db.add(version)
    await db.flush()

    st = statuses or {}
    for t in snapshot.tasks:
        db.add(Task(
            version_id=version.id,
            key=t.key,
            name=t.name,
            description=t.description,
            effort=t.effort,
            optimistic=t.optimistic,
            likely=t.likely,
            pessimistic=t.pessimistic,
            divisible=t.divisible,
            priority=t.priority,
            required_skills=list(t.required_skills),
            status=st.get(t.key, TaskStatus.NOT_STARTED).value,
        ))
    for d in snapshot.dependencies:
        db.add(Dependency(
            version_id=version.id,
            from_task=d.from_task,
            to_task=d.to_task,
            dep_type=d.dep_type.value,
            consumes=d.consumes,
        ))
    for r in snapshot.resources:
        db.add(Resource(
            version_id=version.id,
            key=r.key,
            name=r.name,
            kind=r.kind,
            capacity=r.capacity,
            skills=list(r.skills),
            parent_key=r.parent_key,
            calendar_key=r.calendar_key,
        ))
    for a in snapshot.assignments:
        db.add(Assignment(
            version_id=version.id,
            task_key=a.task_key,
            resource_key=a.resource_key,
            allocation=a.allocation,
        ))
    for rq in snapshot.requirements:
        db.add(Requirement(
            version_id=version.id,
            key=rq.key,
            version_no=rq.version_no,
            text=rq.text,
            consumed_by_task_keys=list(rq.consumed_by),
        ))
    for c in snapshot.constraints:
        db.add(Constraint(
            version_id=version.id,
            kind=c.kind.value,
            target=c.target,
            reason=c.reason,
            value=c.value,
        ))
    for cal in snapshot.calendars:
        db.add(Calendar(
            version_id=version.id,
            key=cal.key,
            working_days=list(cal.working_days),
            holidays=list(cal.holidays),
        ))

    await db.flush()
    return version


async def list_versions(
    db: AsyncSession, project_id: uuid.UUID
) -> list[WorkflowVersion]:
    return list(
        (
            await db.execute(
                select(WorkflowVersion)
                .where(WorkflowVersion.project_id == project_id)
                .order_by(WorkflowVersion.version_no)
            )
        ).scalars().all()
    )


async def ensure_draft(db: AsyncSession, project_id: uuid.UUID) -> WorkflowVersion:
    """The version authoring edits are allowed to touch.

    A draft version is editable in place (ARCHITECTURE E: "workflow authoring
    writes the project's draft version") -- otherwise typing a task name would
    mint a version per keystroke. A *sealed* version is never edited: it is
    cloned into a fresh draft and the project pointer moves, so the sealed
    version survives untouched.
    """
    version = await get_current_version(db, project_id)
    if version.is_draft:
        return version

    snapshot = await load_snapshot(db, version.id)
    state = await load_state(db, project_id, version.id)
    draft = await write_version(
        db,
        project_id,
        snapshot,
        statuses=dict(state.statuses),
        parent_version_id=version.id,
        note="Draft opened for editing",
        is_draft=True,
    )
    project = await get_project(db, project_id)
    project.current_version_id = draft.id
    await db.flush()
    return draft


async def refresh_hash(db: AsyncSession, version: WorkflowVersion) -> str:
    """Recompute the version's content hash after an authoring edit."""
    snapshot = await load_snapshot(db, version.id)
    version.content_hash = snapshot.content_hash()
    version.deadline_day = snapshot.deadline_day
    await db.flush()
    return version.content_hash


async def seal_version(
    db: AsyncSession, version: WorkflowVersion, note: str = ""
) -> WorkflowVersion:
    """Mark a draft as final. Sealed versions are immutable from here on."""
    version.is_draft = False
    if note:
        version.note = note
    await refresh_hash(db, version)
    return version
