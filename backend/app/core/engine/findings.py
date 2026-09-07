"""
What a detector emits.

A `Finding` is never a bare score (ARCHITECTURE D.2). It carries the raw
numbers it reasoned from, the root cause rather than the symptom, an impact
that is a **visible formula** with both operands exposed, and an explanation
templated from that evidence. The Narrator may later rephrase an explanation
for the user; it may never originate a finding.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import IntEnum
from types import MappingProxyType
from typing import Any


class Tier(IntEnum):
    """How much evidence a detector needs before it can say anything.

    Surfacing this is what makes cold start honest (ARCHITECTURE D.1): a
    brand-new project gets a genuinely useful Tier-0 analysis plus a plain
    statement of what the other tiers would need.
    """

    STRUCTURAL = 0      # tasks + dependencies + effort only
    STATEFUL = 1        # + statuses, dates, assignments
    HISTORICAL = 2      # + an event log
    CROSS_PROJECT = 3   # + actuals from past projects


#: Human labels, used in `unavailable_checks` and in the UI.
TIER_NAMES = MappingProxyType({
    Tier.STRUCTURAL: "structural",
    Tier.STATEFUL: "stateful",
    Tier.HISTORICAL: "historical",
    Tier.CROSS_PROJECT: "cross-project",
})

TIER_REQUIRES = MappingProxyType({
    Tier.STRUCTURAL: "tasks, dependencies and effort",
    Tier.STATEFUL: "task statuses and assignments",
    Tier.HISTORICAL: "an event log of status transitions",
    Tier.CROSS_PROJECT: "actuals from completed past projects",
})

TIER_UNLOCKED_BY = MappingProxyType({
    Tier.STRUCTURAL: "Add tasks and dependencies.",
    Tier.STATEFUL: "Set a status on your tasks as work progresses.",
    Tier.HISTORICAL: "Record status changes; they accumulate as you work.",
    Tier.CROSS_PROJECT: "Complete a project; its actuals feed the next one.",
})


LOW = "low"
MEDIUM = "medium"
HIGH = "high"
SEVERITIES = (LOW, MEDIUM, HIGH)


@dataclass(frozen=True, slots=True)
class Impact:
    """Impact as an arithmetic identity, not a model output.

        impact = magnitude x (1 + downstream_affected)

    Both operands travel with the score, so a PMO lead or a judge can
    recompute it by hand from the two numbers already on screen. That is
    deliberate and it is why there is no learned impact model.

    `magnitude_kind` matters: at Tier 1 and above it is **days already lost**,
    measured from evidence. At Tier 0 there is no history, so it is **days of
    work exposed** to the structural weakness. Conflating the two would be the
    kind of quiet dishonesty this project is trying to avoid, so the unit is
    named in the payload.
    """

    magnitude: float
    downstream_affected: int
    magnitude_kind: str = "observed_delay_days"
    magnitude_label: str = "days lost"

    FORMULA = "impact = magnitude x (1 + downstream_affected)"

    @property
    def score(self) -> float:
        return self.magnitude * (1 + self.downstream_affected)

    def as_dict(self) -> dict:
        return {
            "score": self.score,
            "magnitude": self.magnitude,
            "magnitude_kind": self.magnitude_kind,
            "magnitude_label": self.magnitude_label,
            "downstream_affected": self.downstream_affected,
            "formula": self.FORMULA,
            "worked": (
                f"{self.magnitude:g} {self.magnitude_label} x "
                f"(1 + {self.downstream_affected} downstream) = {self.score:g}"
            ),
        }

    @classmethod
    def observed(cls, days_lost: float, downstream: int) -> "Impact":
        return cls(
            magnitude=days_lost,
            downstream_affected=downstream,
            magnitude_kind="observed_delay_days",
            magnitude_label="days lost",
        )

    @classmethod
    def exposed(cls, days_at_risk: float, downstream: int) -> "Impact":
        return cls(
            magnitude=days_at_risk,
            downstream_affected=downstream,
            magnitude_kind="exposed_days",
            magnitude_label="days of work exposed",
        )


@dataclass(frozen=True, slots=True)
class Suppression:
    """One detector may silence another's finding only with a stated reason,
    recorded on the finding itself (ARCHITECTURE D.2). A suppressed finding is
    kept and returned separately, never dropped silently."""

    by: str
    reason: str

    def as_dict(self) -> dict:
        return {"by": self.by, "reason": self.reason}


@dataclass(frozen=True, slots=True)
class Finding:
    kind: str
    tier: Tier
    severity: str
    #: The tasks this finding is about. For a resource-level finding, the queue.
    task_ids: tuple[str, ...]
    #: The cause, not the symptom. A task key or a resource key.
    root_cause: str | None
    #: The raw numbers and timestamps reasoned from. Never empty.
    evidence: dict[str, Any]
    impact: Impact
    downstream_affected: tuple[str, ...]
    suggested_action: str
    #: Templated from the evidence above, in the engine, deterministically.
    explanation: str
    suppressed: Suppression | None = None

    def __post_init__(self) -> None:
        if not self.evidence:
            raise ValueError(
                f"{self.kind}: a finding must carry the evidence it reasoned "
                f"from, never a bare score"
            )
        if self.severity not in SEVERITIES:
            raise ValueError(f"{self.kind}: severity {self.severity!r} is not one of {SEVERITIES}")
        if not self.explanation:
            raise ValueError(f"{self.kind}: a finding must explain itself")

    @property
    def impact_score(self) -> float:
        return self.impact.score

    @property
    def is_suppressed(self) -> bool:
        return self.suppressed is not None

    def with_suppression(self, by: str, reason: str) -> "Finding":
        from dataclasses import replace

        return replace(self, suppressed=Suppression(by=by, reason=reason))

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "tier": int(self.tier),
            "tier_name": TIER_NAMES[Tier(self.tier)],
            "severity": self.severity,
            "task_ids": list(self.task_ids),
            "root_cause": self.root_cause,
            "evidence": dict(self.evidence),
            "impact_score": self.impact.score,
            "impact": self.impact.as_dict(),
            "downstream_affected": list(self.downstream_affected),
            "suggested_action": self.suggested_action,
            "explanation": self.explanation,
            "suppressed": self.suppressed.as_dict() if self.suppressed else None,
        }


def rank(findings: list[Finding]) -> list[Finding]:
    """Highest impact first, then the larger magnitude, then a stable tie-break
    on kind and root cause so the order is deterministic across runs."""
    return sorted(
        findings,
        key=lambda f: (
            -f.impact.score,
            -f.impact.magnitude,
            f.kind,
            f.root_cause or "",
        ),
    )
