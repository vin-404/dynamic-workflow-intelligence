"""
Workflow Intelligence - core engine.

Pure. Imports no web framework, no ORM, no AI client, and performs no I/O.
Enforced by `backend/tests/test_core_purity.py`, which parses every module
under `core/` and fails on a forbidden import.

Everything here is deterministic arithmetic on a DAG. No ML, no LLM. That is
deliberate: schedule claims have to be auditable.

This package is the prototype `engine.py` moved (not reimplemented) into
`core/` and split by responsibility, plus the `evaluate()` primitive the four
capabilities are all expressed through.
"""
from backend.app.core.engine.calendar_ import day_to_date
from backend.app.core.engine.cpm import apply_delay, diff, schedule
from backend.app.core.engine.detectors import (
    Detector,
    DetectorContext,
    all_detectors,
    available_tier,
    run_all,
    unavailable_checks,
)
from backend.app.core.engine.detectors.tier1 import root_blocker
from backend.app.core.engine.effort import (
    EffortModel,
    apply_unavailability,
    duration_for,
    observed_durations,
    planned_durations,
    three_point_durations,
)
from backend.app.core.engine.evaluate import (
    ENGINE_VERSION,
    EvaluationResult,
    Feasibility,
    evaluate,
)
from backend.app.core.engine.findings import (
    HIGH,
    LOW,
    MEDIUM,
    Finding,
    Impact,
    Suppression,
    Tier,
    rank,
)
from backend.app.core.engine.graph import (
    CycleError,
    assert_acyclic,
    build_graph,
    build_graph_from_snapshot,
    find_cycles,
    transitive_redundant_edges,
)
from backend.app.core.engine.staleness import stale_tasks

__all__ = [
    # graph
    "CycleError",
    "build_graph",
    "build_graph_from_snapshot",
    "assert_acyclic",
    "find_cycles",
    "transitive_redundant_edges",
    # schedule
    "schedule",
    "diff",
    "apply_delay",
    # effort
    "EffortModel",
    "duration_for",
    "apply_unavailability",
    "planned_durations",
    "observed_durations",
    "three_point_durations",
    # findings
    "Finding",
    "Impact",
    "Suppression",
    "Tier",
    "rank",
    "LOW",
    "MEDIUM",
    "HIGH",
    # detectors
    "Detector",
    "DetectorContext",
    "all_detectors",
    "available_tier",
    "run_all",
    "unavailable_checks",
    "root_blocker",
    # staleness
    "stale_tasks",
    # the primitive
    "evaluate",
    "EvaluationResult",
    "Feasibility",
    "ENGINE_VERSION",
    # boundary
    "day_to_date",
]
