"""
Requirement change as a first-class capability: what a new wording would cost,
before anyone commits to it.

Owned by Agent REQUIRE (Phase 11 wave 2). Every route here is a read - the
impact report mutates nothing, and the replan it proposes comes back as an
unapplied scenario.

The one exception is `.../apply`, and it is deliberate. That route writes a
workflow version, so it is **not** on `deps.READS_THAT_POST` and stays behind
the `editor` guard like every other write in the application. It does not write
anything itself either: it promotes the report's scenario through
`services.scenarios.apply_scenario`, which is the only function in the codebase
that writes workflow state (ARCHITECTURE E).
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.deps import project_role_guard
from backend.app.api.identity import current_user
from backend.app.db import get_db
from backend.app.models import User
from backend.app.services import requirements as R
from backend.app.services import scenarios as SC
from backend.app.services import versions as V

router = APIRouter(
    prefix="/api/projects/{project_id}",
    tags=["requirements"],
    dependencies=[project_role_guard],
)


class RequirementOptionIn(BaseModel):
    """One candidate wording, optionally scoped.

    `invalidates` is the human judgement the graph cannot make - "this wording
    only affects the signage tasks, not the venue ones". Omit it and the whole
    consumption set is used. It must be a subset of the tasks that actually
    consumed the requirement: no re-wording can invalidate work that never
    consumed it, and asking for that is refused with the reason.
    """

    text: str
    invalidates: list[str] | None = None
    label: str = ""


class RequirementChangeIn(BaseModel):
    new_text: str
    version_id: uuid.UUID | None = None
    #: Scope the change, exactly as on a compare option.
    invalidates: list[str] | None = None
    #: Keep the replan scenario so it can be applied later. Off means the
    #: report is a throwaway question, like `what-if` with `keep=false`.
    keep_scenario: bool = True
    #: Recorded on the revision when this is an apply.
    note: str = ""

    def option(self) -> R.ChangeOption:
        return R.ChangeOption(self.new_text, self.invalidates)


class RequirementCompareIn(BaseModel):
    """Two or more proposed wordings of the same change.

    An option is a plain string, or an object with `text` and optionally
    `invalidates` and `label`. Plain strings are the documented contract and
    keep working; the object form exists because two wordings of the same
    requirement have **identical** graph-derived cost, so a comparison is only
    meaningful once somebody says which work each wording actually spares. The
    response says this out loud when every option ties.
    """

    options: list[str | RequirementOptionIn] = Field(min_length=2)
    version_id: uuid.UUID | None = None
    keep_scenarios: bool = True

    def as_options(self) -> list[R.ChangeOption]:
        out: list[R.ChangeOption] = []
        for i, raw in enumerate(self.options):
            if isinstance(raw, str):
                out.append(R.ChangeOption(raw, label=f"Option {i + 1}"))
            else:
                out.append(
                    R.ChangeOption(
                        raw.text,
                        raw.invalidates,
                        raw.label or f"Option {i + 1}",
                    )
                )
        return out


def _404(e: Exception) -> HTTPException:
    return HTTPException(status_code=404, detail=str(e))


def _422(e: Exception) -> HTTPException:
    return HTTPException(status_code=422, detail=str(e))


@router.get("/requirements")
async def list_requirements(
    project_id: uuid.UUID,
    version_id: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Every requirement, with what changing it would reach and a summary of
    its recorded history.

    Reachability and effort sums only - no scheduler runs - so this is cheap
    for any number of requirements. Ask `.../change` for a schedule impact.
    """
    try:
        return await R.list_requirements(db, project_id, version_id)
    except V.NotFound as e:
        raise _404(e)


@router.get("/requirements/{requirement_key}")
async def get_requirement(
    project_id: uuid.UUID,
    requirement_key: str,
    version_id: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
):
    """One requirement's current wording, consumers and history summary."""
    try:
        payload = await R.list_requirements(db, project_id, version_id)
    except V.NotFound as e:
        raise _404(e)
    row = next(
        (r for r in payload["requirements"] if r["key"] == requirement_key), None
    )
    if row is None:
        raise HTTPException(
            status_code=404, detail=f"Requirement {requirement_key} not found"
        )
    return {
        "project_id": payload["project_id"],
        "version_id": payload["version_id"],
        "version_no": payload["version_no"],
        "requirement": row,
        "note": payload["note"],
    }


@router.post("/requirements/{requirement_key}/change")
async def change(
    project_id: uuid.UUID,
    requirement_key: str,
    payload: RequirementChangeIn,
    db: AsyncSession = Depends(get_db),
):
    """What this re-wording would cost. **Applies nothing.**

    Returns `must_redo` versus `must_recheck` with the consuming path that put
    each task in its list; the days of completed work invalidated and what
    redoing them costs, with the arithmetic on the row; the new projected
    finish and whether the deadline survives; the owners of affected work
    grouped by resource with what each of them loses; the findings this change
    creates and clears; and a real, unapplied `Scenario` carrying the implied
    mutations, which the existing `evaluate`, `diff` and `apply` endpoints
    accept unchanged.

    It computes a blast radius, not a reading of two sentences: whether the new
    wording actually invalidates the work below is a human judgement, and the
    `assumptions` block says so first.
    """
    try:
        return await R.impact(
            db,
            project_id,
            requirement_key,
            payload.new_text,
            version_id=payload.version_id,
            option=payload.option(),
            keep_scenario=payload.keep_scenario,
        )
    except V.NotFound as e:
        raise _404(e)
    except R.OptionError as e:
        raise _422(e)
    except SC.Invalid as e:
        raise HTTPException(status_code=422, detail=e.result.as_dict())


@router.post("/requirements/{requirement_key}/compare")
async def compare(
    project_id: uuid.UUID,
    requirement_key: str,
    payload: RequirementCompareIn,
    db: AsyncSession = Depends(get_db),
):
    """Cost two or more proposed wordings against the same base. Applies
    nothing.

    Every option is evaluated against one immutable version, so the numbers are
    comparable by construction. Where the options differ only in wording they
    cost the same - the blast radius comes from the dependency graph, which the
    sentence does not change - and the response states that rather than
    inventing a difference. Scope an option with `invalidates` to make the
    comparison real.
    """
    try:
        return await R.compare(
            db,
            project_id,
            requirement_key,
            payload.as_options(),
            version_id=payload.version_id,
            keep_scenarios=payload.keep_scenarios,
        )
    except V.NotFound as e:
        raise _404(e)
    except R.OptionError as e:
        raise _422(e)
    except SC.Invalid as e:
        raise HTTPException(status_code=422, detail=e.result.as_dict())


@router.post("/requirements/{requirement_key}/apply")
async def apply_change(
    project_id: uuid.UUID,
    requirement_key: str,
    payload: RequirementChangeIn,
    db: AsyncSession = Depends(get_db),
    who: User | None = Depends(current_user),
):
    """Accept the change: bump the wording, replan, record the revision.

    The one route in this router that writes. It is **not** exempt from the
    role guard, so an enforcing deployment requires `editor` here while
    `.../change` and `.../compare` stay open to a viewer. The write itself goes
    through `scenarios.apply_scenario` - a new immutable version whose parent
    survives with its content hash intact.
    """
    try:
        return await R.apply_change(
            db,
            project_id,
            requirement_key,
            payload.new_text,
            version_id=payload.version_id,
            option=payload.option(),
            note=payload.note,
            actor=who,
        )
    except V.NotFound as e:
        raise _404(e)
    except R.OptionError as e:
        raise _422(e)
    except SC.Invalid as e:
        raise HTTPException(status_code=422, detail=e.result.as_dict())


@router.get("/requirements/{requirement_key}/history")
async def history(
    project_id: uuid.UUID,
    requirement_key: str,
    version_id: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Every recorded wording of this requirement, oldest first, with who
    changed it, when, the workflow version and scenario that made it current,
    and what the impact report claimed it would cost at the time.

    A row marked `backfilled` was reconstructed from a workflow snapshot rather
    than recorded as it happened, and carries no author. An empty list means no
    change has been applied through this API - not that the requirement never
    changed.
    """
    try:
        return await R.history(db, project_id, requirement_key, version_id)
    except V.NotFound as e:
        raise _404(e)


@router.get("/requirements/{requirement_key}/diff")
async def diff(
    project_id: uuid.UUID,
    requirement_key: str,
    from_version: int | None = None,
    to_version: int | None = None,
    base_version_id: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Diff two recorded wordings and cost that exact change.

    Defaults to the oldest recorded revision against the newest. The `impact`
    block is recomputed against the workflow as it stands now, so the
    consumption set then and the consumption set now are reported side by side
    and any drift between them is visible rather than absorbed.
    """
    try:
        return await R.diff_versions(
            db,
            project_id,
            requirement_key,
            from_version,
            to_version,
            base_version_id,
        )
    except V.NotFound as e:
        raise _404(e)
    except R.OptionError as e:
        raise _422(e)
