"""
Workflow authoring - the writes that build a workflow.

This is the API the builder needs and the repository did not have: create a
task, draw a dependency, add a resource, assign someone. Everything here
writes the project's **draft** version; a sealed version is cloned first, so
history is never edited (ARCHITECTURE A.2, E).

Validation failures return 422 with a human-readable reason, and a dependency
that would create a cycle returns the cycle itself. Those reasons are a
feature.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.engine.graph import build_graph_from_snapshot, find_cycles
from backend.app.core.workflow import DependencySpec
from backend.app.api.deps import project_role_guard
from backend.app.db import get_db
from backend.app.models import (
    Assignment,
    Constraint,
    Dependency,
    Event,
    Requirement,
    Resource,
    Task,
)
from backend.app.schemas.authoring import (
    AssignmentIn,
    ConstraintIn,
    DependencyIn,
    ResourceIn,
    TaskIn,
    TaskPatch,
)
from backend.app.services import intelligence, versions as V

router = APIRouter(
    prefix="/api/projects/{project_id}",
    tags=["workflow"],
    dependencies=[project_role_guard],
)


def _not_found(e: Exception):
    return HTTPException(status_code=404, detail=str(e))


async def _draft(db: AsyncSession, project_id: uuid.UUID):
    try:
        return await V.ensure_draft(db, project_id)
    except V.NotFound as e:
        raise _not_found(e)


async def _task_row(db: AsyncSession, version_id: uuid.UUID, key: str) -> Task:
    row = (
        await db.execute(
            select(Task).where(Task.version_id == version_id, Task.key == key)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail=f"Task {key} not found")
    return row


async def _known_resources(db: AsyncSession, version_id: uuid.UUID) -> set[str]:
    return set(
        (
            await db.execute(
                select(Resource.key).where(Resource.version_id == version_id)
            )
        ).scalars().all()
    )


async def _set_assignees(
    db: AsyncSession, version_id: uuid.UUID, task_key: str, resource_keys: list[str]
) -> None:
    known = await _known_resources(db, version_id)
    unknown = [k for k in resource_keys if k not in known]
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Unknown resource(s): {', '.join(sorted(unknown))}. "
                f"Add the resource before assigning it."
            ),
        )
    rows = (
        await db.execute(
            select(Assignment).where(
                Assignment.version_id == version_id,
                Assignment.task_key == task_key,
            )
        )
    ).scalars().all()
    for row in rows:
        await db.delete(row)
    await db.flush()
    for key in dict.fromkeys(resource_keys):
        db.add(Assignment(
            version_id=version_id, task_key=task_key, resource_key=key
        ))
    await db.flush()


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------


@router.get("/workflow")
async def get_workflow(
    project_id: uuid.UUID,
    version_id: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
):
    """The workflow as authored. No analysis, no scores - just the graph."""
    try:
        return await intelligence.get_workflow(db, project_id, version_id)
    except V.NotFound as e:
        raise _not_found(e)


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------


@router.post("/tasks", status_code=201)
async def create_task(
    project_id: uuid.UUID, payload: TaskIn, db: AsyncSession = Depends(get_db)
):
    version = await _draft(db, project_id)
    clash = (
        await db.execute(
            select(Task).where(
                Task.version_id == version.id, Task.key == payload.key
            )
        )
    ).scalar_one_or_none()
    if clash is not None:
        raise HTTPException(
            status_code=422,
            detail=f"A task with key {payload.key!r} already exists in this workflow.",
        )

    db.add(Task(
        version_id=version.id,
        key=payload.key,
        name=payload.name,
        description=payload.description,
        effort=payload.effort,
        optimistic=payload.optimistic,
        likely=payload.likely,
        pessimistic=payload.pessimistic,
        divisible=payload.divisible,
        priority=payload.priority,
        required_skills=list(payload.required_skills),
        status=payload.status.value,
    ))
    await db.flush()
    if payload.assignees:
        await _set_assignees(db, version.id, payload.key, payload.assignees)
    await V.refresh_hash(db, version)
    await db.commit()
    return await intelligence.get_workflow(db, project_id)


@router.patch("/tasks/{task_key}")
async def patch_task(
    project_id: uuid.UUID,
    task_key: str,
    payload: TaskPatch,
    db: AsyncSession = Depends(get_db),
):
    version = await _draft(db, project_id)
    row = await _task_row(db, version.id, task_key)

    data = payload.model_dump(exclude_unset=True)
    assignees = data.pop("assignees", None)
    if "status" in data and data["status"] is not None:
        new_status = data.pop("status")
        new_status = getattr(new_status, "value", new_status)
        if new_status != row.status:
            # Status changes are appended to the event log, which is what
            # unlocks the Tier-2 detectors as the project is actually worked.
            project = await V.get_project(db, project_id)
            db.add(Event(
                project_id=project_id,
                day=project.today_day,
                task_key=task_key,
                actor="user",
                from_status=row.status,
                to_status=new_status,
            ))
        row.status = new_status
    for field, value in data.items():
        if value is not None:
            setattr(row, field, value)

    await db.flush()
    if assignees is not None:
        await _set_assignees(db, version.id, task_key, assignees)
    await V.refresh_hash(db, version)
    await db.commit()
    return await intelligence.get_workflow(db, project_id)


@router.delete("/tasks/{task_key}")
async def delete_task(
    project_id: uuid.UUID, task_key: str, db: AsyncSession = Depends(get_db)
):
    version = await _draft(db, project_id)
    row = await _task_row(db, version.id, task_key)

    protected = (
        await db.execute(
            select(Constraint).where(
                Constraint.version_id == version.id,
                Constraint.kind == "MANDATORY_TASK",
                Constraint.target == task_key,
            )
        )
    ).scalar_one_or_none()
    if protected is not None:
        raise HTTPException(
            status_code=422,
            detail=(
                f"{task_key} is a mandatory task and cannot be removed. "
                f"Reason on record: {protected.reason}"
            ),
        )

    deps = (
        await db.execute(
            select(Dependency).where(
                Dependency.version_id == version.id,
                (Dependency.from_task == task_key)
                | (Dependency.to_task == task_key),
            )
        )
    ).scalars().all()
    for d in deps:
        await db.delete(d)
    assigns = (
        await db.execute(
            select(Assignment).where(
                Assignment.version_id == version.id,
                Assignment.task_key == task_key,
            )
        )
    ).scalars().all()
    for a in assigns:
        await db.delete(a)
    await db.delete(row)
    await db.flush()
    await V.refresh_hash(db, version)
    await db.commit()
    return await intelligence.get_workflow(db, project_id)


# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------


@router.post("/dependencies", status_code=201)
async def create_dependency(
    project_id: uuid.UUID, payload: DependencyIn, db: AsyncSession = Depends(get_db)
):
    """422 on a cycle, **with the cycle**, so the UI can point at it."""
    version = await _draft(db, project_id)

    if payload.from_task == payload.to_task:
        raise HTTPException(
            status_code=422, detail="A task cannot depend on itself."
        )

    keys = set(
        (
            await db.execute(select(Task.key).where(Task.version_id == version.id))
        ).scalars().all()
    )
    missing = [k for k in (payload.from_task, payload.to_task) if k not in keys]
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown task(s): {', '.join(sorted(missing))}.",
        )

    clash = (
        await db.execute(
            select(Dependency).where(
                Dependency.version_id == version.id,
                Dependency.from_task == payload.from_task,
                Dependency.to_task == payload.to_task,
            )
        )
    ).scalar_one_or_none()
    if clash is not None:
        raise HTTPException(
            status_code=422,
            detail=(
                f"{payload.from_task} -> {payload.to_task} already exists."
            ),
        )

    # Check the cycle before writing, not after.
    snapshot = await V.load_snapshot(db, version.id)
    probe = snapshot.evolve(
        dependencies=snapshot.dependencies + (
            DependencySpec(
                from_task=payload.from_task,
                to_task=payload.to_task,
                dep_type=payload.dep_type,
                consumes=payload.consumes,
            ),
        )
    )
    cycles = find_cycles(build_graph_from_snapshot(probe))
    if cycles:
        raise HTTPException(
            status_code=422,
            detail={
                "message": (
                    f"{payload.from_task} -> {payload.to_task} would create a "
                    f"circular dependency."
                ),
                "cycles": cycles,
            },
        )

    db.add(Dependency(
        version_id=version.id,
        from_task=payload.from_task,
        to_task=payload.to_task,
        dep_type=payload.dep_type.value,
        consumes=payload.consumes,
    ))
    await db.flush()
    await V.refresh_hash(db, version)
    await db.commit()
    return await intelligence.get_workflow(db, project_id)


@router.delete("/dependencies/{from_task}/{to_task}")
async def delete_dependency(
    project_id: uuid.UUID,
    from_task: str,
    to_task: str,
    db: AsyncSession = Depends(get_db),
):
    version = await _draft(db, project_id)
    row = (
        await db.execute(
            select(Dependency).where(
                Dependency.version_id == version.id,
                Dependency.from_task == from_task,
                Dependency.to_task == to_task,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(
            status_code=404, detail=f"{from_task} -> {to_task} not found"
        )

    protected = (
        await db.execute(
            select(Constraint).where(
                Constraint.version_id == version.id,
                Constraint.kind == "IMMUTABLE_DEPENDENCY",
                Constraint.target == f"{from_task}->{to_task}",
            )
        )
    ).scalar_one_or_none()
    if protected is not None:
        raise HTTPException(
            status_code=422,
            detail=(
                f"{from_task} -> {to_task} is an immutable dependency and "
                f"cannot be removed. Reason on record: {protected.reason}"
            ),
        )

    await db.delete(row)
    await db.flush()
    await V.refresh_hash(db, version)
    await db.commit()
    return await intelligence.get_workflow(db, project_id)


# ---------------------------------------------------------------------------
# Resources, assignments, requirements, constraints
# ---------------------------------------------------------------------------


@router.post("/resources", status_code=201)
async def create_resource(
    project_id: uuid.UUID, payload: ResourceIn, db: AsyncSession = Depends(get_db)
):
    version = await _draft(db, project_id)
    clash = (
        await db.execute(
            select(Resource).where(
                Resource.version_id == version.id, Resource.key == payload.key
            )
        )
    ).scalar_one_or_none()
    if clash is not None:
        raise HTTPException(
            status_code=422,
            detail=f"A resource with key {payload.key!r} already exists.",
        )
    if payload.parent_key:
        known = await _known_resources(db, version.id)
        if payload.parent_key not in known:
            raise HTTPException(
                status_code=422,
                detail=f"Unknown parent resource {payload.parent_key!r}.",
            )
    db.add(Resource(
        version_id=version.id,
        key=payload.key,
        name=payload.name,
        kind=payload.kind,
        capacity=payload.capacity,
        skills=list(payload.skills),
        parent_key=payload.parent_key,
        calendar_key=payload.calendar_key,
    ))
    await db.flush()
    await V.refresh_hash(db, version)
    await db.commit()
    return await intelligence.get_workflow(db, project_id)


@router.delete("/resources/{resource_key}")
async def delete_resource(
    project_id: uuid.UUID, resource_key: str, db: AsyncSession = Depends(get_db)
):
    version = await _draft(db, project_id)
    row = (
        await db.execute(
            select(Resource).where(
                Resource.version_id == version.id, Resource.key == resource_key
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(
            status_code=404, detail=f"Resource {resource_key} not found"
        )
    assigns = (
        await db.execute(
            select(Assignment).where(
                Assignment.version_id == version.id,
                Assignment.resource_key == resource_key,
            )
        )
    ).scalars().all()
    for a in assigns:
        await db.delete(a)
    children = (
        await db.execute(
            select(Resource).where(
                Resource.version_id == version.id,
                Resource.parent_key == resource_key,
            )
        )
    ).scalars().all()
    for c in children:
        c.parent_key = None
    await db.delete(row)
    await db.flush()
    await V.refresh_hash(db, version)
    await db.commit()
    return await intelligence.get_workflow(db, project_id)


@router.post("/tasks/{task_key}/assignments", status_code=201)
async def add_assignment(
    project_id: uuid.UUID,
    task_key: str,
    payload: AssignmentIn,
    db: AsyncSession = Depends(get_db),
):
    version = await _draft(db, project_id)
    await _task_row(db, version.id, task_key)
    known = await _known_resources(db, version.id)
    if payload.resource_key not in known:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown resource {payload.resource_key!r}.",
        )
    clash = (
        await db.execute(
            select(Assignment).where(
                Assignment.version_id == version.id,
                Assignment.task_key == task_key,
                Assignment.resource_key == payload.resource_key,
            )
        )
    ).scalar_one_or_none()
    if clash is None:
        db.add(Assignment(
            version_id=version.id,
            task_key=task_key,
            resource_key=payload.resource_key,
            allocation=payload.allocation,
        ))
        await db.flush()
    await V.refresh_hash(db, version)
    await db.commit()
    return await intelligence.get_workflow(db, project_id)


@router.delete("/tasks/{task_key}/assignments/{resource_key}")
async def remove_assignment(
    project_id: uuid.UUID,
    task_key: str,
    resource_key: str,
    db: AsyncSession = Depends(get_db),
):
    version = await _draft(db, project_id)
    row = (
        await db.execute(
            select(Assignment).where(
                Assignment.version_id == version.id,
                Assignment.task_key == task_key,
                Assignment.resource_key == resource_key,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Assignment not found")
    await db.delete(row)
    await db.flush()
    await V.refresh_hash(db, version)
    await db.commit()
    return await intelligence.get_workflow(db, project_id)


@router.post("/constraints", status_code=201)
async def create_constraint(
    project_id: uuid.UUID, payload: ConstraintIn, db: AsyncSession = Depends(get_db)
):
    """Constraints are the user's declaration of what may not be optimised
    away. They are inputs, not engine opinions."""
    version = await _draft(db, project_id)
    db.add(Constraint(
        version_id=version.id,
        kind=payload.kind.value,
        target=payload.target,
        reason=payload.reason,
        value=payload.value,
    ))
    await db.flush()
    await V.refresh_hash(db, version)
    await db.commit()
    return await intelligence.get_workflow(db, project_id)


@router.delete("/constraints/{kind}/{target:path}")
async def delete_constraint(
    project_id: uuid.UUID,
    kind: str,
    target: str,
    db: AsyncSession = Depends(get_db),
):
    """Withdraw a declaration.

    A constraint has no key of its own; it is identified the way the engine
    reads it, by `(kind, target)` on the draft - the same shape a dependency
    is deleted by. `target` is a path segment because a dependency target is
    written `FROM->TO` and an assignment `TASK:RESOURCE`. Like every
    authoring write this is guarded at the router: a viewer is refused.
    """
    version = await _draft(db, project_id)
    row = (
        await db.execute(
            select(Constraint).where(
                Constraint.version_id == version.id,
                Constraint.kind == kind,
                Constraint.target == target,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(
            status_code=404,
            detail=f"No {kind} constraint on {target} in the draft version.",
        )
    await db.delete(row)
    await db.flush()
    await V.refresh_hash(db, version)
    await db.commit()
    return await intelligence.get_workflow(db, project_id)


@router.post("/versions/seal")
async def seal_current_version(
    project_id: uuid.UUID, note: str = "", db: AsyncSession = Depends(get_db)
):
    """Freeze the draft. From here it is immutable and editing clones it."""
    try:
        version = await V.get_current_version(db, project_id)
    except V.NotFound as e:
        raise _not_found(e)
    await V.seal_version(db, version, note=note)
    await db.commit()
    return await intelligence.get_workflow(db, project_id)
