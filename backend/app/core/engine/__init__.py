"""
Workflow Intelligence - core engine.

Pure. Imports no web framework, no ORM, no AI client, and performs no I/O.
Enforced by `backend/tests/test_core_purity.py`.

Everything here is deterministic arithmetic on a DAG. No ML, no LLM. That is
deliberate: schedule claims have to be auditable.

This package is the prototype `engine.py` moved (not reimplemented) into
`core/`, split by responsibility. The public surface below is the same set of
names the prototype exposed, so `import engine as E` becomes
`from backend.app.core import engine as E` with no other change.
"""
from backend.app.core.engine.calendar_ import day_to_date
from backend.app.core.engine.cpm import apply_delay, diff, schedule
from backend.app.core.engine.detectors import (
    DONE,
    Bottleneck,
    detect,
    root_blocker,
)
from backend.app.core.engine.graph import CycleError, build_graph
from backend.app.core.engine.staleness import stale_tasks

__all__ = [
    "CycleError",
    "build_graph",
    "schedule",
    "diff",
    "apply_delay",
    "stale_tasks",
    "Bottleneck",
    "detect",
    "root_blocker",
    "DONE",
    "day_to_date",
]
