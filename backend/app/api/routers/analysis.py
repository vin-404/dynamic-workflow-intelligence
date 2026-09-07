"""
Analysis - Capability 1, and the read side of everything else.

Contract rule (ARCHITECTURE E): analysis endpoints are **pure reads over an
immutable snapshot**. Nothing in this router writes workflow state.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.limits import bounded
from backend.app.api.deps import project_role_guard
from backend.app.core.engine.risk import RiskWeights
from backend.app.db import get_db
from backend.app.settings import settings
from backend.app.services import analysis_runs, intelligence, versions as V

router = APIRouter(
    prefix="/api/projects/{project_id}",
    tags=["analysis"],
    dependencies=[project_role_guard],
)


class AnalyzeIn(BaseModel):
    version_id: uuid.UUID | None = None


class RequirementImpactIn(BaseModel):
    requirement_key: str
    version_id: uuid.UUID | None = None


class RiskWeightsIn(BaseModel):
    """Every weight is optional; anything omitted keeps its default. The
    response echoes whatever was used."""

    slack_ratio: float | None = None
    downstream_fan_out: float | None = None
    criticality_proximity: float | None = None
    deadline_pressure: float | None = None
    resource_pressure: float | None = None
    duration_uncertainty: float | None = None
    predecessor_health: float | None = None
    remaining_chain_depth: float | None = None
    assignment_gap: float | None = None

    def to_weights(self) -> RiskWeights | None:
        given = {
            k: v for k, v in self.model_dump().items() if v is not None
        }
        return RiskWeights(**given) if given else None


class RiskIn(BaseModel):
    version_id: uuid.UUID | None = None
    weights: RiskWeightsIn | None = None


@router.post("/analyze")
async def analyze(
    project_id: uuid.UUID,
    payload: AnalyzeIn | None = None,
    db: AsyncSession = Depends(get_db),
):
    """`evaluate(W)`: schedule, findings with evidence, feasibility verdict,
    the tier the evidence reached, and an explicit list of what could not be
    assessed and why."""
    try:
        return await bounded(
            intelligence.analyze(
                db, project_id, payload.version_id if payload else None
            ),
            settings.ANALYZE_TIMEOUT_SECONDS,
            "Analyzing this workflow",
            "A workflow large enough to hit this is worth reporting.",
        )
    except V.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/analyze")
async def analyze_get(
    project_id: uuid.UUID,
    version_id: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Same as POST. Analysis is a read, so it is available as one."""
    try:
        return await intelligence.analyze(db, project_id, version_id)
    except V.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/risk")
async def risk_get(
    project_id: uuid.UUID,
    version_id: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Per-task risk with every factor, weight, value and reason.

    A **structural estimate**, not a probability: the payload says so, and
    carries the assumptions the estimate rests on.
    """
    try:
        return await intelligence.risk(db, project_id, version_id)
    except V.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/risk")
async def risk_post(
    project_id: uuid.UUID,
    payload: RiskIn | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Same, with your own weights. Move them and watch the ranking change -
    that is the point of exposing them (ARCHITECTURE H, risk #5)."""
    try:
        return await intelligence.risk(
            db,
            project_id,
            payload.version_id if payload else None,
            payload.weights.to_weights() if payload and payload.weights else None,
        )
    except V.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/requirement-impact")
async def requirement_impact(
    project_id: uuid.UUID,
    payload: RequirementImpactIn,
    db: AsyncSession = Depends(get_db),
):
    """What a requirement change invalidates: work that must be redone
    because it consumed something now wrong, versus work merely downstream."""
    try:
        return await intelligence.requirement_impact(
            db, project_id, payload.requirement_key, payload.version_id
        )
    except V.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/accuracy")
async def accuracy(
    project_id: uuid.UUID,
    version_id: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Detector precision/recall against the fixture's planted faults.

    A project with no labelled faults says so rather than reporting a score.
    """
    try:
        return await intelligence.get_accuracy(db, project_id, version_id)
    except V.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/analysis-runs")
async def list_analysis_runs(
    project_id: uuid.UUID,
    limit: int = 20,
    db: AsyncSession = Depends(get_db),
):
    """History of analyses for this project, newest first. Each row carries
    the engine version and input hash that produced it."""
    try:
        await V.get_project(db, project_id)
    except V.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    return await analysis_runs.list_for_project(db, project_id, limit)
