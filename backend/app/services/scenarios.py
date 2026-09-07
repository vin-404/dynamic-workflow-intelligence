"""
Scenarios, in the database.

A `Scenario` row is a base version plus an ordered list of typed `Mutation`
rows. Evaluating one writes nothing but an `AnalysisRun`; **only `apply()`
writes workflow state**, and it does so by creating a *new* immutable
`WorkflowVersion` and moving the project pointer. The parent version survives
untouched (ARCHITECTURE A.2, B.2).

That single write path is what makes "the LLM cannot mutate the database" a
structural fact rather than a policy: an LLM proposal is a `Scenario` row with
`origin="llm_proposal"` and `status="pending"`, and a human has to call apply.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.core import mutations as MUT
from backend.app.core.simulation import Scenario as CoreScenario
from backend.app.core.simulation import SimulationResult, simulate, summarise
from backend.app.core.workflow import EngineConfig
from backend.app.models import Mutation, Scenario, WorkflowVersion
from backend.app.services import analysis_runs, versions as V
from backend.app.services.versions import NotFound

#: Scenario origins. `user_whatif` is a person asking a question;
#: `heuristic_proposal` is Phase 5's optimizer; `llm_proposal` is Phase 7's
#: Proposer. All three go through exactly the same validation and the same
#: apply path - the LLM gets no shortcut.
ORIGINS = ("user_whatif", "heuristic_proposal", "llm_proposal")

STATUS_PENDING = "pending"
STATUS_VALIDATED = "validated"
STATUS_REJECTED = "rejected"
STATUS_APPLIED = "applied"


class Invalid(Exception):
    """A mutation or scenario failed semantic validation. Routers map this to
    422 and show `result` verbatim - the reasons are the feature."""

    def __init__(self, result: MUT.ValidationResult):
        self.result = result
        super().__init__("; ".join(r.reason for r in result.rejections))


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------


async def get_row(db: AsyncSession, scenario_id: uuid.UUID) -> Scenario:
    row = (
        await db.execute(
            select(Scenario)
            .where(Scenario.id == scenario_id)
            .options(selectinload(Scenario.mutations))
            # The session is configured with expire_on_commit=False, so an
            # already-identity-mapped Scenario keeps the `mutations` collection
            # it was first loaded with - and a mutation appended since would be
            # invisible. populate_existing forces the reload.
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if row is None:
        raise NotFound(f"Scenario {scenario_id} not found")
    return row


def _core_mutations(row: Scenario) -> list[MUT.Mutation]:
    return [
        MUT.Mutation(MUT.MutationKind(m.kind), dict(m.payload or {}))
        for m in sorted(row.mutations, key=lambda m: m.seq)
    ]


async def load_core_scenario(
    db: AsyncSession, scenario_id: uuid.UUID
) -> tuple[Scenario, CoreScenario, uuid.UUID]:
    """The DB row, the pure `core` value it maps to, and its project id."""
    row = await get_row(db, scenario_id)
    snapshot = await V.load_snapshot(db, row.base_version_id)
    state = await V.load_state(db, row.project_id, row.base_version_id)
    return row, CoreScenario(
        base=snapshot,
        base_state=state,
        mutations=tuple(_core_mutations(row)),
        name=row.name,
        origin=row.origin,
        rationale=row.rationale or "",
    ), row.project_id


def serialise(row: Scenario) -> dict:
    return {
        "id": str(row.id),
        "project_id": str(row.project_id),
        "base_version_id": str(row.base_version_id),
        "name": row.name,
        "origin": row.origin,
        "status": row.status,
        "rationale": row.rationale,
        "rejection_reason": row.rejection_reason,
        "created_at": row.created_at.isoformat(),
        "mutations": [
            {
                "seq": m.seq,
                "kind": m.kind,
                "payload": dict(m.payload or {}),
                "created_by": m.created_by,
                "describes": MUT.Mutation(
                    MUT.MutationKind(m.kind), dict(m.payload or {})
                ).describe(),
            }
            for m in sorted(row.mutations, key=lambda m: m.seq)
        ],
    }


async def list_for_project(
    db: AsyncSession, project_id: uuid.UUID
) -> list[dict]:
    rows = (
        await db.execute(
            select(Scenario)
            .where(Scenario.project_id == project_id)
            .options(selectinload(Scenario.mutations))
            .order_by(Scenario.created_at.desc())
        )
    ).scalars().all()
    return [serialise(r) for r in rows]


# ---------------------------------------------------------------------------
# Writing scenarios (never workflow state)
# ---------------------------------------------------------------------------


async def create(
    db: AsyncSession,
    project_id: uuid.UUID,
    *,
    name: str = "",
    base_version_id: uuid.UUID | None = None,
    origin: str = "user_whatif",
    rationale: str = "",
    mutations: list[dict] | None = None,
) -> Scenario:
    """Create a scenario against a base version.

    Mutations may be supplied up front; each is validated in order against the
    materialised state so that "add a task then depend on it" works and the
    reverse is rejected. A scenario that does not validate is still *stored*,
    with `status="rejected"` and the reason on the row - a rejected proposal
    the user can read is worth more than a silent failure.
    """
    if origin not in ORIGINS:
        raise Invalid(MUT.ValidationResult.failed(MUT.Rejection(
            kind="SCENARIO",
            reason=f"origin must be one of {', '.join(ORIGINS)}, got {origin!r}",
        )))

    base = (
        await V.get_version(db, base_version_id)
        if base_version_id is not None
        else await V.get_current_version(db, project_id)
    )
    if base.project_id != project_id:
        raise Invalid(MUT.ValidationResult.failed(MUT.Rejection(
            kind="SCENARIO",
            reason="The base version belongs to a different project.",
        )))

    row = Scenario(
        project_id=project_id,
        base_version_id=base.id,
        name=name or "Untitled scenario",
        origin=origin,
        status=STATUS_PENDING,
        rationale=rationale,
    )
    db.add(row)
    await db.flush()

    if mutations:
        parsed = [MUT.Mutation.from_dict(m) for m in mutations]
        snapshot = await V.load_snapshot(db, base.id)
        state = await V.load_state(db, project_id, base.id)
        result = MUT.validate_all(snapshot, state, parsed)
        for seq, mutation in enumerate(parsed, start=1):
            db.add(Mutation(
                scenario_id=row.id,
                seq=seq,
                kind=mutation.kind.value,
                payload=dict(mutation.payload),
                created_by=origin,
            ))
        row.status = STATUS_VALIDATED if result.valid else STATUS_REJECTED
        row.rejection_reason = (
            "" if result.valid
            else "; ".join(r.reason for r in result.rejections)
        )
        await db.flush()

    await db.commit()
    return await get_row(db, row.id)


async def add_mutation(
    db: AsyncSession, scenario_id: uuid.UUID, payload: dict
) -> Scenario:
    """Append one typed mutation, validated against the scenario as it stands.

    Raises `Invalid` with user-readable reasons rather than storing something
    that cannot be evaluated. This is where a cycle, a missing reference or a
    constraint violation is caught.
    """
    row, core, _ = await load_core_scenario(db, scenario_id)
    if row.status == STATUS_APPLIED:
        raise Invalid(MUT.ValidationResult.failed(MUT.Rejection(
            kind="SCENARIO",
            reason="This scenario has already been applied and is now history.",
        )))

    mutation = MUT.Mutation.from_dict(payload)
    snapshot, state, _ = core.materialize() if core.mutations else (
        core.base, core.base_state, []
    )
    result = MUT.validate(snapshot, state, mutation)
    if not result.valid:
        raise Invalid(result)

    db.add(Mutation(
        scenario_id=row.id,
        seq=len(row.mutations) + 1,
        kind=mutation.kind.value,
        payload=dict(mutation.payload),
        created_by=row.origin,
    ))
    row.status = STATUS_VALIDATED
    row.rejection_reason = ""
    await db.commit()
    return await get_row(db, scenario_id)


async def remove_mutation(
    db: AsyncSession, scenario_id: uuid.UUID, seq: int
) -> Scenario:
    row = await get_row(db, scenario_id)
    target = next((m for m in row.mutations if m.seq == seq), None)
    if target is None:
        raise NotFound(f"Scenario {scenario_id} has no mutation {seq}")
    await db.delete(target)
    await db.flush()
    # Re-sequence so `seq` stays a dense ordering.
    for i, m in enumerate(
        sorted((m for m in row.mutations if m.seq != seq), key=lambda m: m.seq),
        start=1,
    ):
        m.seq = i
    await db.commit()
    return await get_row(db, scenario_id)


async def delete(db: AsyncSession, scenario_id: uuid.UUID) -> None:
    row = await get_row(db, scenario_id)
    if row.status == STATUS_APPLIED:
        raise Invalid(MUT.ValidationResult.failed(MUT.Rejection(
            kind="SCENARIO",
            reason=(
                "An applied scenario is the provenance of a workflow version "
                "and cannot be deleted."
            ),
        )))
    await db.delete(row)
    await db.commit()


# ---------------------------------------------------------------------------
# Evaluating - a pure read plus one AnalysisRun
# ---------------------------------------------------------------------------


async def evaluate_scenario(
    db: AsyncSession,
    scenario_id: uuid.UUID,
    config: EngineConfig | None = None,
    persist: bool = True,
) -> dict:
    """Materialise the scenario, evaluate it, diff it against its base.

    Writes nothing except an `AnalysisRun`. The response carries the base
    version's content hash captured before *and* after evaluation, so the
    caller can verify the original workflow is unchanged rather than take our
    word for it.
    """
    row, core, project_id = await load_core_scenario(db, scenario_id)
    project = await V.get_project(db, project_id)
    from backend.app.core.workflow import Clock

    result: SimulationResult = simulate(core, Clock(project.today_day), config)

    if not result.validation.valid:
        row.status = STATUS_REJECTED
        row.rejection_reason = "; ".join(
            r.reason for r in result.validation.rejections
        )
    elif row.status != STATUS_APPLIED:
        row.status = STATUS_VALIDATED
        row.rejection_reason = ""

    run_id = None
    if persist and result.validation.valid:
        run = await analysis_runs.record(
            db,
            project_id,
            result.after,
            subject_type="scenario",
            subject_id=row.id,
            params={
                "today_day": project.today_day,
                "base_version_id": str(row.base_version_id),
                "mutations": result.mutations,
            },
        )
        run_id = str(run.id)
    await db.commit()

    payload = result.as_dict()
    payload.update({
        "scenario": serialise(await get_row(db, scenario_id)),
        "analysis_run_id": run_id,
        "summary": summarise(result),
        "project_start": project.start_date.isoformat(),
        "projected_end_date_before": V.day_to_date(
            project.start_date, result.base.projected_end
        ),
        "projected_end_date_after": V.day_to_date(
            project.start_date, result.after.projected_end
        ),
    })
    return payload


async def diff(
    db: AsyncSession,
    scenario_id: uuid.UUID,
    against_version_id: uuid.UUID | None = None,
    config: EngineConfig | None = None,
) -> dict:
    """Compare a scenario against its base, or against any other version.

    Comparing against a different version re-bases the scenario for the
    comparison only; the stored scenario is untouched.
    """
    row, core, project_id = await load_core_scenario(db, scenario_id)
    if against_version_id is not None and against_version_id != row.base_version_id:
        other = await V.get_version(db, against_version_id)
        if other.project_id != project_id:
            raise Invalid(MUT.ValidationResult.failed(MUT.Rejection(
                kind="SCENARIO",
                reason="That version belongs to a different project.",
            )))
        from dataclasses import replace

        core = replace(
            core,
            base=await V.load_snapshot(db, other.id),
            base_state=await V.load_state(db, project_id, other.id),
        )

    project = await V.get_project(db, project_id)
    from backend.app.core.workflow import Clock

    result = simulate(core, Clock(project.today_day), config)
    return {
        "scenario_id": str(scenario_id),
        "against_version_id": str(against_version_id or row.base_version_id),
        "validation": result.validation.as_dict(),
        "comparison": result.comparison,
        "summary": summarise(result),
        "base_unchanged": result.base_unchanged,
        "base_version_hash": result.base_hash_before,
        "scenario_hash": result.after_hash,
    }


# ---------------------------------------------------------------------------
# Applying - THE ONLY WRITE TO WORKFLOW STATE
# ---------------------------------------------------------------------------


async def apply_scenario(
    db: AsyncSession, scenario_id: uuid.UUID, note: str = ""
) -> dict:
    """Promote a scenario to a new immutable `WorkflowVersion`.

    This is the only function in the codebase that writes workflow state, and
    it is only ever reached by an explicit user action. It creates a *new*
    version whose parent is the base and moves the project pointer; the parent
    survives with its content hash intact, which is what makes apply
    reversible and the history real.
    """
    row, core, project_id = await load_core_scenario(db, scenario_id)
    if row.status == STATUS_APPLIED:
        raise Invalid(MUT.ValidationResult.failed(MUT.Rejection(
            kind="SCENARIO", reason="This scenario has already been applied.",
        )))
    if not row.mutations:
        raise Invalid(MUT.ValidationResult.failed(MUT.Rejection(
            kind="SCENARIO",
            reason="This scenario has no mutations, so there is nothing to apply.",
        )))

    validation = core.validate()
    if not validation.valid:
        row.status = STATUS_REJECTED
        row.rejection_reason = "; ".join(r.reason for r in validation.rejections)
        await db.commit()
        raise Invalid(validation)

    base_version = await V.get_version(db, row.base_version_id)
    base_hash_before = base_version.content_hash

    snapshot, state, _ = core.materialize()
    new_version = await V.write_version(
        db,
        project_id,
        snapshot,
        statuses=dict(state.statuses),
        parent_version_id=base_version.id,
        created_from_scenario_id=row.id,
        note=note or f"Applied scenario: {row.name}",
        is_draft=False,
    )
    project = await V.get_project(db, project_id)
    project.current_version_id = new_version.id
    row.status = STATUS_APPLIED
    await db.commit()

    # Re-read the parent to prove it was not touched.
    base_after = await V.get_version(db, base_version.id)
    return {
        "scenario_id": str(row.id),
        "applied": True,
        "new_version": {
            "id": str(new_version.id),
            "version_no": new_version.version_no,
            "parent_version_id": str(base_version.id),
            "content_hash": new_version.content_hash,
            "note": new_version.note,
        },
        "parent_version": {
            "id": str(base_after.id),
            "version_no": base_after.version_no,
            "content_hash": base_after.content_hash,
            "unchanged": base_after.content_hash == base_hash_before,
        },
        "project_current_version_id": str(project.current_version_id),
    }


# ---------------------------------------------------------------------------
# One-shot what-if, for the panel that asks a single question
# ---------------------------------------------------------------------------


async def what_if(
    db: AsyncSession,
    project_id: uuid.UUID,
    mutations: list[dict],
    *,
    name: str = "What-if",
    base_version_id: uuid.UUID | None = None,
    keep: bool = True,
    config: EngineConfig | None = None,
) -> dict:
    """Create a scenario, evaluate it, and return the diff in one call.

    This is what the what-if panel drives, and it is how the prototype's
    `POST /simulate/delay` comes back - as `TASK_DELAY_ADD` against a real
    scenario rather than as a second, separate code path.

    `keep=False` discards the scenario after evaluating, for a throwaway
    question the user does not want in their history.

    Validation happens *before* anything is written, so a refused question
    raises with the full structured rejection - the cited constraint and the
    reason on record included - rather than a flattened string. That citation
    is the whole point of the refusal: "M09 is mandatory" is much weaker than
    "M09 is mandatory because UN38.3 certification is a legal precondition to
    shipping".
    """
    base = (
        await V.get_version(db, base_version_id)
        if base_version_id is not None
        else await V.get_current_version(db, project_id)
    )
    parsed = [MUT.Mutation.from_dict(m) for m in mutations]
    snapshot = await V.load_snapshot(db, base.id)
    state = await V.load_state(db, project_id, base.id)
    result = MUT.validate_all(snapshot, state, parsed)
    if not result.valid:
        raise Invalid(result)

    row = await create(
        db,
        project_id,
        name=name,
        base_version_id=base.id,
        origin="user_whatif",
        mutations=mutations,
    )
    payload = await evaluate_scenario(db, row.id, config)
    if not keep:
        await delete(db, row.id)
        payload["scenario"]["discarded"] = True
    return payload
