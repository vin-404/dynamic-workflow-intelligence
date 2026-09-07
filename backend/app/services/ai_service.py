"""
The AI service layer: `ai/` meets the database, in the one direction allowed.

`ai/` never touches the database. This module is where an interpretation
becomes a **pending** `Scenario`, where a model proposal is handed to the
Phase-5 search as an extra candidate, and where every interaction is logged as
an `AIInteraction` row.

The one write this module performs is creating a pending scenario - the same
row a user's own what-if creates. Promoting one to a `WorkflowVersion` still
goes through `scenarios.apply_scenario()`, triggered by a person.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app import ai
from backend.app.core import mutations as MUT
from backend.app.core.engine import evaluate as core_evaluate
from backend.app.core.optimization import Budget, ObjectiveWeights
from backend.app.models import AIInteraction, Domain
from backend.app.services import scenarios, versions as V

#: One process-wide cache, so a rehearsed demo path is fast, free and cannot
#: fail live. Cleared between test modules by `reset_cache()`.
_CACHE = ai.ResponseCache()


def cache() -> ai.ResponseCache:
    return _CACHE


def reset_cache() -> None:
    global _CACHE
    _CACHE = ai.ResponseCache()


async def _log(
    db: AsyncSession,
    project_id: uuid.UUID | None,
    interaction: ai.Interaction | None,
) -> None:
    """Every call is recorded. This is the evidence that the model never had
    authority - role, prompt hash, schema, validation outcome, rejection."""
    if interaction is None:
        return
    db.add(AIInteraction(
        project_id=project_id,
        role=interaction.role,
        provider=interaction.provider,
        prompt_hash=interaction.prompt_hash,
        schema_name=interaction.schema_name,
        valid=interaction.valid,
        repaired=interaction.repaired,
        cached=interaction.cached,
        rejection_reason=interaction.rejection_reason,
    ))
    await db.flush()


async def _domain_context(
    db: AsyncSession, domain_id: uuid.UUID | None
) -> tuple[str | None, list[str]]:
    """The only place a domain leaves the database for anything but the UI -
    and it reaches a prompt, never the engine."""
    if domain_id is None:
        return None, []
    row = (
        await db.execute(select(Domain).where(Domain.id == domain_id))
    ).scalar_one_or_none()
    if row is None:
        return None, []
    return row.name, list(row.vocabulary_hints or [])


def provider() -> ai.AIProvider:
    return ai.get_provider()


async def status(db: AsyncSession) -> dict:
    """What the AI layer can currently do, stated plainly."""
    p = provider()
    return {
        "provider": p.name,
        "available": p.available,
        "model": ai.DEFAULT_MODEL if p.available else None,
        "roles": list(ai.ROLES),
        "cached_responses": len(_CACHE),
        "degraded_behaviour": {
            "interpreter": (
                "A labelled pattern matcher over the same shapes the what-if "
                "form offers. It refuses rather than guesses."
            ),
            "proposer": (
                "The five deterministic candidate generators, which are the "
                "primary source in either case."
            ),
            "narrator": "The engine's own templated explanations.",
        },
        # Which product capability depends on a model: none of them. Named
        # per capability with the mechanism that actually computes it, so the
        # claim can be checked against the code rather than believed.
        "capabilities_without_model": {
            "detect": "the deterministic detector registry",
            "predict": "the additive risk model over declared factors",
            "simulate": "the mutation algebra and the scheduling engine",
            "optimize": (
                "the deterministic candidate generators, the constraint "
                "gates and the per-criterion scoring"
            ),
        },
        "guarantees": [
            "The model has no write path. Its output becomes a pending "
            "scenario that a person must apply.",
            "The model is never the authority for a number. A narration "
            "containing a figure the engine did not produce is discarded.",
            "Only mutations from the closed algebra can be emitted, and each "
            "is validated and gated exactly as a hand-written one is.",
        ],
    }


# ---------------------------------------------------------------------------
# Interpreter
# ---------------------------------------------------------------------------


async def interpret(
    db: AsyncSession,
    project_id: uuid.UUID,
    utterance: str,
    version_id: uuid.UUID | None = None,
    keep: bool = True,
) -> dict:
    """Natural language in, a **pending scenario** out.

    Nothing is applied. The response carries the interpretation, the semantic
    validation result, and - when it validates - the id of a scenario the user
    can evaluate, edit or discard.
    """
    project, version, snapshot, state, clock = await V.load_context(
        db, project_id, version_id
    )
    result = core_evaluate(snapshot, state, clock)
    domain_name, hints = await _domain_context(db, project.domain_id)

    interpretation = ai.interpret(
        utterance,
        snapshot,
        state,
        provider(),
        result,
        domain_name,
        hints,
        cache=_CACHE,
    )
    await _log(db, project_id, interpretation.interaction)

    payload: dict[str, Any] = interpretation.as_dict()
    payload["project_id"] = str(project_id)
    payload["base_version_id"] = str(version.id)
    payload["scenario_id"] = None
    payload["applied"] = False

    if not interpretation.understood or not interpretation.mutations:
        payload["validation"] = {"valid": False, "rejections": []}
        await db.commit()
        return payload

    # Semantic validation happens here, not in `ai/`. A well-formed mutation
    # list can still be wrong - a cycle, a missing reference, a constraint.
    parsed = [MUT.Mutation.from_dict(m) for m in interpretation.mutations]
    validation = MUT.validate_all(snapshot, state, parsed)
    payload["validation"] = validation.as_dict()

    if not validation.valid:
        await db.commit()
        return payload

    if keep:
        row = await scenarios.create(
            db,
            project_id,
            name=interpretation.intent[:200] or "Interpreted request",
            base_version_id=version.id,
            origin="llm_proposal" if interpretation.method == "model" else "user_whatif",
            rationale=(
                f"Interpreted from: {utterance.strip()} "
                f"(method: {interpretation.method})"
            ),
            mutations=interpretation.mutations,
        )
        payload["scenario_id"] = str(row.id)
        payload["scenario"] = scenarios.serialise(row)

    await db.commit()
    return payload


# ---------------------------------------------------------------------------
# Proposer - a third candidate source, with no shortcut
# ---------------------------------------------------------------------------


async def proposals_for(
    db: AsyncSession,
    project_id: uuid.UUID,
    snapshot,
    state,
    result,
) -> tuple[list, dict]:
    """Model candidates for the optimizer, plus a note on what happened.

    Returns `Candidate` objects the Phase-5 search treats identically to its
    own: same validation, same constraint gates, same scoring.
    """
    project = await V.get_project(db, project_id)
    domain_name, hints = await _domain_context(db, project.domain_id)
    proposal_set = ai.propose(
        snapshot, state, result, provider(), domain_name, hints, cache=_CACHE
    )
    await _log(db, project_id, proposal_set.interaction)
    return list(proposal_set.candidates), {
        "available": proposal_set.available,
        "count": len(proposal_set.candidates),
        "note": proposal_set.note,
    }


# ---------------------------------------------------------------------------
# Narrator - presentation only
# ---------------------------------------------------------------------------


async def narrate_analysis(
    db: AsyncSession,
    project_id: uuid.UUID,
    version_id: uuid.UUID | None = None,
) -> dict:
    """Explain the current analysis in prose.

    The Narrator receives only engine output, and a narration containing a
    number the engine did not produce is discarded in favour of the engine's
    own wording.
    """
    project, version, snapshot, state, clock = await V.load_context(
        db, project_id, version_id
    )
    result = core_evaluate(snapshot, state, clock)

    payload = {
        "projected_end_day": result.projected_end,
        "planned_end_day": result.planned_end,
        "slip_days": result.slip_days,
        "feasibility": result.feasibility.as_dict(),
        "evidence_tier": result.tier_reached,
        "findings": [
            {
                "kind": f.kind,
                "root_cause": f.root_cause,
                "severity": f.severity,
                "impact_score": f.impact_score,
                "explanation": f.explanation,
                "suggested_action": f.suggested_action,
            }
            for f in result.findings[:6]
        ],
        "risk_bands": result.risk.get("band_counts", {}),
    }
    fallback = _engine_summary(result)

    narration = ai.narrate(
        payload,
        fallback,
        provider(),
        headline=f"{project.name}: {result.feasibility.verdict.replace('_', ' ')}",
        cache=_CACHE,
    )
    await _log(db, project_id, narration.interaction)
    await db.commit()

    out = narration.as_dict()
    out.update({
        "project_id": str(project_id),
        "version_id": str(version.id),
        "engine_version": result.engine_version,
        "input_hash": result.input_hash,
    })
    return out


def _engine_summary(result) -> str:
    """The engine describing its own result. Always available, and always the
    thing the Narrator is rephrasing rather than replacing."""
    parts = [result.feasibility.statement]
    if result.slip_days > 0:
        parts.append(
            f"That is {result.slip_days:.0f} day(s) later than planned."
        )
    if result.findings:
        worst = result.findings[0]
        parts.append(
            f"The largest single problem is {worst.kind.replace('_', ' ')} on "
            f"{worst.root_cause}: {worst.explanation}"
        )
        parts.append(worst.suggested_action)
    else:
        parts.append(
            f"No findings at evidence tier {result.tier_reached}."
        )
    return " ".join(parts)
