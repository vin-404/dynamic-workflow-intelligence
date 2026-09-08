"""
What the import would create, and what it would refuse to.

The preview is the whole safety story of this feature. An import is a bulk
write built almost entirely out of inference - a foreign status mapped onto
ours, a story point read as a day, an absent estimate defaulted - and the only
honest way to ship that is to show every one of those decisions before
anything is written, in the caller's own words.

Cycle detection is a call into `core.engine.graph`, not a second algorithm.
The importer builds the snapshot it would create and asks the same
`find_cycles` the rest of the platform asks; an import that would produce a
graph the scheduler cannot schedule is refused here rather than discovered
later by a 500 in `analyze`.
"""
from __future__ import annotations

from backend.app.core.engine.graph import build_graph_from_snapshot, find_cycles
from backend.app.ingest.plan import ImportPlan


def find_import_cycles(plan: ImportPlan) -> list[dict]:
    """Cycles the imported dependencies would introduce, named as task paths.

    Each cycle is returned as a closed path - `A -> B -> C -> A` - because a
    list of three keys does not read as a loop, and the link cell that closes
    it is named so the user knows which row to fix.
    """
    snapshot = plan.snapshot()
    graph = build_graph_from_snapshot(snapshot)
    out: list[dict] = []
    for cycle in find_cycles(graph):
        closed = list(cycle) + [cycle[0]]
        edges = list(zip(closed, closed[1:]))
        evidence = [
            plan.edge_evidence[edge]
            for edge in edges
            if edge in plan.edge_evidence
        ]
        out.append(
            {
                "path": closed,
                "length": len(cycle),
                "message": (
                    f"{' -> '.join(closed)}: these blocking links form a loop, "
                    f"so no order satisfies all of them and nothing here can "
                    f"be scheduled."
                ),
                "from_rows": sorted({e["row"] for e in evidence}),
                "evidence": [
                    {
                        "row": e["row"],
                        "column": e["column"],
                        "raw": e["raw"],
                        "because": e["because"],
                    }
                    for e in evidence
                ],
            }
        )
    return sorted(out, key=lambda c: (c["length"], c["path"]))


def preview_payload(plan: ImportPlan, csv_sha256: str) -> dict:
    """The `POST /api/import/preview` body.

    `can_commit` is false only for things that make the result unusable: a
    cycle, or no tasks at all. Rejected rows deliberately do **not** block -
    a real export usually has a few, and refusing the other four hundred rows
    over them would make the feature useless. They are counted at the top of
    the payload instead, so nobody commits without seeing them.
    """
    cycles = find_import_cycles(plan)
    counts = plan.counts()

    blocking: list[str] = []
    if not plan.tasks:
        blocking.append(
            "No row in this file produced a task, so there is nothing to "
            "create. Check that the key column is mapped to the right header."
        )
    for cycle in cycles:
        blocking.append(cycle["message"])
    if plan.deadline is not None and plan.deadline < plan.start_date:
        blocking.append(
            f"The deadline ({plan.deadline.isoformat()}) is before the project "
            f"start ({plan.start_date.isoformat()}), which no schedule can "
            f"satisfy. Set start_date or deadline explicitly."
        )

    return {
        "source": plan.source,
        "csv_sha256": csv_sha256,
        "can_commit": not blocking,
        "blocking": blocking,
        "counts": counts,
        "would_create": {
            "project": {
                "start_date": plan.start_date.isoformat(),
                "deadline": plan.deadline.isoformat() if plan.deadline else None,
                "deadline_day": plan.deadline_day,
            },
            "tasks": [
                {
                    "key": t.key,
                    "name": t.name,
                    "description": t.description,
                    "effort": t.effort,
                    "status": plan.statuses[t.key].value,
                }
                for t in plan.tasks
            ],
            "dependencies": [
                {
                    "from_task": d.from_task,
                    "to_task": d.to_task,
                    "dep_type": d.dep_type.value,
                    "consumes": d.consumes,
                    "because": plan.edge_evidence.get(
                        (d.from_task, d.to_task), {}
                    ).get("because", ""),
                }
                for d in plan.dependencies
            ],
            "resources": [
                {
                    "key": r.key,
                    "name": r.name,
                    "kind": r.kind,
                    "capacity": r.capacity,
                    "task_count": sum(
                        1 for a in plan.assignments if a.resource_key == r.key
                    ),
                }
                for r in plan.resources
            ],
            "assignments": [
                {
                    "task_key": a.task_key,
                    "resource_key": a.resource_key,
                    "allocation": a.allocation,
                }
                for a in plan.assignments
            ],
        },
        "rows": plan.rows,
        "rejected_rows": plan.rejected_rows,
        "dropped_dependencies": plan.dropped_dependencies,
        "unmapped_columns": plan.unmapped_columns,
        "cycles": cycles,
        "assumptions": plan.assumptions(),
        "row_numbering": (
            "`row` counts CSV records with the header as row 1, which is the "
            "number a spreadsheet shows. `line` is the physical line, which "
            "differs when a quoted field contains a newline."
        ),
    }
