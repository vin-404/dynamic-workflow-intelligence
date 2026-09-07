"""
Persisting an analysis.

An `AnalysisRun` records `engine_version` + `input_hash` alongside the result,
which is what makes a stored analysis *reproducible and comparable* rather
than a screenshot (ARCHITECTURE A.4, E). Two runs with the same pair must have
the same numbers; a different pair explains why they differ.

Writing an `AnalysisRun` is the only write an analysis endpoint performs, and
it touches no workflow state. That distinction is the contract rule in
ARCHITECTURE E and it is asserted in `test_analysis_runs.py`.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.engine.evaluate import EvaluationResult
from backend.app.models import AnalysisRun, Finding


async def record(
    db: AsyncSession,
    project_id: uuid.UUID,
    result: EvaluationResult,
    *,
    subject_type: str,
    subject_id: uuid.UUID,
    params: dict | None = None,
    reuse_identical: bool = True,
) -> AnalysisRun:
    """Store an evaluation.

    `reuse_identical` returns the existing run when the same subject has
    already been analysed at the same `engine_version` and `input_hash`. The
    result is deterministic, so writing a second identical row would add noise
    to the history rather than information.
    """
    if reuse_identical:
        existing = (
            await db.execute(
                select(AnalysisRun)
                .where(
                    AnalysisRun.subject_type == subject_type,
                    AnalysisRun.subject_id == subject_id,
                    AnalysisRun.engine_version == result.engine_version,
                    AnalysisRun.input_hash == result.input_hash,
                )
                .order_by(AnalysisRun.created_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if existing is not None:
            return existing

    payload = result.as_dict()
    run = AnalysisRun(
        project_id=project_id,
        subject_type=subject_type,
        subject_id=subject_id,
        engine_version=result.engine_version,
        input_hash=result.input_hash,
        params={
            **(params or {}),
            "config": payload["config"],
            "effort_model": payload["effort_model"],
            "checks_run": payload["checks_run"],
        },
        schedule_json=payload["schedule"],
        risk_json=payload["risk"],
        scores_json={
            "planned_end": payload["planned_end"],
            "projected_end": payload["projected_end"],
            "slip_days": payload["slip_days"],
            "critical_path": payload["critical_path"],
            "finding_counts_by_tier": payload["finding_counts_by_tier"],
            "schedulable": payload["schedulable"],
        },
        feasibility_json=payload["feasibility"],
        tier_reached=payload["tier_reached"],
        unavailable_checks=payload["unavailable_checks"],
    )
    db.add(run)
    await db.flush()

    for finding in result.findings + result.suppressed_findings:
        d = finding.to_dict()
        db.add(Finding(
            analysis_run_id=run.id,
            kind=d["kind"],
            tier=d["tier"],
            severity=d["severity"],
            task_keys=d["task_ids"],
            root_cause=d["root_cause"],
            evidence_json={
                **d["evidence"],
                "impact": d["impact"],
                "suppressed": d["suppressed"],
            },
            impact_score=d["impact_score"],
            downstream_affected=d["downstream_affected"],
            suggested_action=d["suggested_action"],
            explanation=d["explanation"],
        ))
    await db.flush()
    return run


async def get(db: AsyncSession, run_id: uuid.UUID) -> dict:
    """Read a stored run back, findings included."""
    from sqlalchemy.orm import selectinload

    run = (
        await db.execute(
            select(AnalysisRun)
            .where(AnalysisRun.id == run_id)
            .options(selectinload(AnalysisRun.findings))
        )
    ).scalar_one_or_none()
    if run is None:
        from backend.app.services.versions import NotFound

        raise NotFound(f"Analysis run {run_id} not found")
    return serialise(run)


async def list_for_project(
    db: AsyncSession, project_id: uuid.UUID, limit: int = 20
) -> list[dict]:
    rows = (
        await db.execute(
            select(AnalysisRun)
            .where(AnalysisRun.project_id == project_id)
            .order_by(AnalysisRun.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    return [
        {
            "id": str(r.id),
            "subject_type": r.subject_type,
            "subject_id": str(r.subject_id),
            "engine_version": r.engine_version,
            "input_hash": r.input_hash,
            "tier_reached": r.tier_reached,
            "scores": r.scores_json,
            "feasibility": r.feasibility_json,
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]


def serialise(run: AnalysisRun) -> dict:
    return {
        "id": str(run.id),
        "project_id": str(run.project_id),
        "subject_type": run.subject_type,
        "subject_id": str(run.subject_id),
        "engine_version": run.engine_version,
        "input_hash": run.input_hash,
        "params": run.params,
        "schedule": run.schedule_json,
        "risk": run.risk_json,
        "scores": run.scores_json,
        "feasibility": run.feasibility_json,
        "tier_reached": run.tier_reached,
        "unavailable_checks": run.unavailable_checks,
        "created_at": run.created_at.isoformat(),
        "findings": [
            {
                "kind": f.kind,
                "tier": f.tier,
                "severity": f.severity,
                "task_ids": f.task_keys,
                "root_cause": f.root_cause,
                "evidence": f.evidence_json,
                "impact_score": f.impact_score,
                "downstream_affected": f.downstream_affected,
                "suggested_action": f.suggested_action,
                "explanation": f.explanation,
            }
            for f in sorted(run.findings, key=lambda f: -f.impact_score)
        ],
    }
