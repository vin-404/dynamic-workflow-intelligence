"""
Capability 4 - optimization.

Every candidate returned here is a real `Scenario` that has already been
evaluated, so the user can inspect it, diff it, edit it or apply it through
the endpoints that already exist. There is no special path (ARCHITECTURE E).

The response always carries the per-criterion table and the weights that
produced the ranking. A single blended number with invisible weights is
exactly what this design is meant to eliminate.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.limits import bounded
from backend.app.core.optimization import Budget, ObjectiveWeights
from backend.app.db import get_db
from backend.app.services import optimization, versions as V
from backend.app.settings import settings

router = APIRouter(prefix="/api/projects/{project_id}", tags=["optimize"])


class ObjectivesIn(BaseModel):
    """Every weight is optional; anything omitted keeps its default, and
    whatever was used is echoed back."""

    expected_completion: float | None = None
    feasibility_margin: float | None = None
    peak_resource_overload: float | None = None
    structural_risk: float | None = None
    dependency_complexity: float | None = None
    parallelization: float | None = None

    def to_weights(self) -> ObjectiveWeights | None:
        given = {k: v for k, v in self.model_dump().items() if v is not None}
        return ObjectiveWeights(**given) if given else None


class BudgetIn(BaseModel):
    max_candidates: int = Field(default=40, ge=1, le=500)
    max_seconds: float | None = Field(default=5.0, ge=0.1, le=60.0)


class OptimizeIn(BaseModel):
    version_id: uuid.UUID | None = None
    objectives: ObjectivesIn | None = None
    budget: BudgetIn | None = None
    #: True is "optimize with no limits": it additionally proposes cutting
    #: scope. Those candidates are labelled `scope_change`, and where a
    #: constraint forbids one it comes back refused with the constraint cited.
    aggressive: bool = False
    #: False evaluates without storing the candidates as scenarios.
    persist_candidates: bool = True
    #: Whether to ask the LLM Proposer for extra candidates. With no model
    #: configured this changes nothing - the search runs on its deterministic
    #: generators either way.
    use_llm: bool = True


@router.post("/optimize")
async def optimize(
    project_id: uuid.UUID,
    payload: OptimizeIn | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Generate candidates, gate them, score them, rank them.

    Bounded by `max_candidates` and `max_seconds` and never unbounded; the
    response says whether it stopped early and why.
    """
    body = payload or OptimizeIn()
    budget = Budget(
        max_candidates=body.budget.max_candidates,
        max_seconds=body.budget.max_seconds,
    ) if body.budget else Budget()
    try:
        # Two ceilings, doing different jobs. `budget.max_seconds` is injected
        # into the pure search, which stops between candidates and returns the
        # partial ranked results it already has - that is the one that should
        # ever fire. The request deadline below is the backstop for everything
        # the search cannot see, and it is deliberately looser.
        return await bounded(
            optimization.optimize(
                db,
                project_id,
                body.version_id,
                weights=body.objectives.to_weights() if body.objectives else None,
                budget=budget,
                aggressive=body.aggressive,
                persist_candidates=body.persist_candidates,
                use_llm=body.use_llm,
            ),
            max(settings.OPTIMIZE_TIMEOUT_SECONDS, (budget.max_seconds or 0) + 10),
            "The search",
            "Lower max_candidates or max_seconds and try again.",
        )
    except V.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/optimize/objectives")
async def objectives(project_id: uuid.UUID):
    """The criteria and their default weights, so a UI can render the sliders
    without hardcoding them."""
    defaults = ObjectiveWeights()
    return {
        "weights": defaults.as_dict(),
        "weights_total": defaults.total,
        "criteria": [
            {
                "name": "expected_completion",
                "better": "lower",
                "unit": "days",
                "describes": "when the workflow is projected to finish",
            },
            {
                "name": "feasibility_margin",
                "better": "higher",
                "unit": "days against the deadline",
                "describes": "how much room there is before the deadline",
            },
            {
                "name": "peak_resource_overload",
                "better": "lower",
                "unit": "tasks over capacity at the peak",
                "describes": (
                    "how badly the plan needs a resource in more places at "
                    "once than it can be"
                ),
            },
            {
                "name": "structural_risk",
                "better": "lower",
                "unit": "summed task risk (structural estimate)",
                "describes": "total exposure across all tasks",
            },
            {
                "name": "dependency_complexity",
                "better": "lower",
                "unit": "dependencies per task",
                "describes": "how tangled the graph is",
            },
            {
                "name": "parallelization",
                "better": "higher",
                "unit": "average concurrent tasks",
                "describes": "how much work runs side by side",
            },
        ],
        "note": (
            "Weights are inputs. Move them and the ranking changes; the "
            "response always echoes the weights it used and the full "
            "per-criterion table."
        ),
    }
