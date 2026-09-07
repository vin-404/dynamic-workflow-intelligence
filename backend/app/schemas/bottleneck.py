from __future__ import annotations

from typing import Any
from pydantic import BaseModel


class BottleneckRead(BaseModel):
    kind: str
    tasks: list[str]
    root_cause: str | None
    evidence: dict[str, Any]
    attributed_delay_days: float
    downstream_affected: list[str]
    suggested_action: str
    severity: str
    impact_score: float
