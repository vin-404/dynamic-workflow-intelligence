"""
Change and analysis records.

A `Scenario` is a base version plus an ordered list of typed mutations. It is
cheap, ephemeral and disposable, and evaluating one writes nothing except an
`AnalysisRun`. Only an explicit apply promotes it to a new `WorkflowVersion` -
that is the single write path to workflow state, and the reason the LLM can
never mutate the database (ARCHITECTURE B.2).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, Float, ForeignKey, Integer, JSON, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db import Base
from backend.app.models.base import created_at, pk


class Scenario(Base):
    __tablename__ = "scenarios"

    id: Mapped[uuid.UUID] = pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    base_version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("workflow_versions.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(255), default="")
    #: user_whatif | heuristic_proposal | llm_proposal
    origin: Mapped[str] = mapped_column(String(40), default="user_whatif")
    #: pending -> validated -> applied | rejected
    status: Mapped[str] = mapped_column(String(20), default="pending")
    rejection_reason: Mapped[str] = mapped_column(String(2000), default="")
    rationale: Mapped[str] = mapped_column(String(2000), default="")
    created_at: Mapped[datetime] = created_at()

    mutations: Mapped[list["Mutation"]] = relationship(
        "Mutation",
        back_populates="scenario",
        cascade="all, delete-orphan",
        order_by="Mutation.seq",
    )


class Mutation(Base):
    """One member of the closed algebra (ARCHITECTURE D.3). `payload` stays
    JSON: mutations are open-ended by nature and normalising them buys nothing.
    """

    __tablename__ = "mutations"

    id: Mapped[uuid.UUID] = pk()
    scenario_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("scenarios.id", ondelete="CASCADE"), nullable=False
    )
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(String(50), nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_by: Mapped[str] = mapped_column(String(80), default="user")

    scenario: Mapped["Scenario"] = relationship("Scenario", back_populates="mutations")


class AnalysisRun(Base):
    """A reproducible analysis. `engine_version` + `input_hash` are what let a
    stored result be compared with a fresh one, or told apart from it.
    """

    __tablename__ = "analysis_runs"

    id: Mapped[uuid.UUID] = pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    #: version | scenario
    subject_type: Mapped[str] = mapped_column(String(20), nullable=False)
    subject_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    engine_version: Mapped[str] = mapped_column(String(40), nullable=False)
    input_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    schedule_json: Mapped[dict] = mapped_column(JSON, default=dict)
    risk_json: Mapped[dict] = mapped_column(JSON, default=dict)
    scores_json: Mapped[dict] = mapped_column(JSON, default=dict)
    feasibility_json: Mapped[dict] = mapped_column(JSON, default=dict)
    tier_reached: Mapped[int] = mapped_column(Integer, default=0)
    unavailable_checks: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = created_at()

    findings: Mapped[list["Finding"]] = relationship(
        "Finding", back_populates="analysis_run", cascade="all, delete-orphan"
    )


class Finding(Base):
    __tablename__ = "findings"

    id: Mapped[uuid.UUID] = pk()
    analysis_run_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("analysis_runs.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(60), nullable=False)
    #: 0 structural | 1 stateful | 2 historical | 3 cross-project
    tier: Mapped[int] = mapped_column(Integer, default=0)
    severity: Mapped[str] = mapped_column(String(20), default="medium")
    task_keys: Mapped[list] = mapped_column(JSON, default=list)
    root_cause: Mapped[str | None] = mapped_column(String(100), nullable=True)
    #: The raw numbers and timestamps the finding reasoned from. Never a bare
    #: score.
    evidence_json: Mapped[dict] = mapped_column(JSON, default=dict)
    impact_score: Mapped[float] = mapped_column(Float, default=0.0)
    downstream_affected: Mapped[list] = mapped_column(JSON, default=list)
    suggested_action: Mapped[str] = mapped_column(String(2000), default="")
    explanation: Mapped[str] = mapped_column(String(2000), default="")

    analysis_run: Mapped["AnalysisRun"] = relationship(
        "AnalysisRun", back_populates="findings"
    )


class AIInteraction(Base):
    """Evidence that the model never had authority.

    Every call is logged with its role, prompt hash, schema and validation
    outcome, so "the LLM cannot write workflow state" is auditable rather than
    asserted.
    """

    __tablename__ = "ai_interactions"

    id: Mapped[uuid.UUID] = pk()
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="CASCADE"), nullable=True
    )
    #: interpreter | proposer | narrator
    role: Mapped[str] = mapped_column(String(30), nullable=False)
    provider: Mapped[str] = mapped_column(String(40), default="null")
    prompt_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    schema_name: Mapped[str] = mapped_column(String(80), default="")
    valid: Mapped[bool] = mapped_column(Boolean, default=False)
    repaired: Mapped[bool] = mapped_column(Boolean, default=False)
    rejection_reason: Mapped[str] = mapped_column(String(2000), default="")
    cached: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = created_at()
