"""
Intelligence service — bridge between PostgreSQL and engine.py.

Loads project data from the database, converts it into the format
engine.py expects (plain dicts + lists), runs deterministic computations,
and returns structured results.

engine.py is NEVER modified. This service adapts around it.
"""
from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.models import (
    Project, Task, Dependency, Event, Requirement, RequirementConsumer,
    DepartmentCapacity,
)

# Import the untouched engine
import engine as E


async def _load_project(db: AsyncSession, project_id: uuid.UUID) -> Project:
    result = await db.execute(
        select(Project).where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()
    if project is None:
        raise ValueError(f"Project {project_id} not found")
    return project


async def _load_project_data(db: AsyncSession, project_id: uuid.UUID) -> dict:
    """Load all project data from DB and convert to engine-compatible format."""
    project = await _load_project(db, project_id)

    # Load tasks
    tasks_result = await db.execute(
        select(Task).where(Task.project_id == project_id)
    )
    tasks_rows = tasks_result.scalars().all()

    # Load dependencies
    deps_result = await db.execute(
        select(Dependency).where(Dependency.project_id == project_id)
    )
    deps_rows = deps_result.scalars().all()

    # Load events
    events_result = await db.execute(
        select(Event).where(Event.project_id == project_id).order_by(Event.day)
    )
    events_rows = events_result.scalars().all()

    # Load requirements with consumers
    reqs_result = await db.execute(
        select(Requirement)
        .where(Requirement.project_id == project_id)
        .options(selectinload(Requirement.consumers))
    )
    reqs_rows = reqs_result.scalars().all()

    # Convert to engine format
    tasks_dict = {}
    status_dict = {}
    for t in tasks_rows:
        tasks_dict[t.task_code] = {
            "name": t.name,
            "dept": t.department,
            "owner": t.owner,
            "duration": t.planned_duration,
        }
        status_dict[t.task_code] = t.status

    deps_list = [
        (d.predecessor_code, d.successor_code, d.kind)
        for d in deps_rows
    ]

    events_list = [
        {
            "day": e.day,
            "task": e.task_code,
            "actor": e.actor,
            "frm": e.from_status,
            "to": e.to_status,
        }
        for e in events_rows
    ]

    requirements_dict = {}
    for r in reqs_rows:
        requirements_dict[r.req_code] = {
            "version": r.version,
            "text": r.text,
            "consumed_by": [c.task_code for c in r.consumers],
        }

    # Load department capacities from DB
    cap_result = await db.execute(
        select(DepartmentCapacity).where(DepartmentCapacity.project_id == project_id)
    )
    cap_rows = cap_result.scalars().all()
    if cap_rows:
        dept_capacity = {c.department: c.capacity for c in cap_rows}
    else:
        # Fallback: compute from unique owners if no explicit capacity
        dept_capacity = _compute_dept_capacity(tasks_rows)

    return {
        "project": project,
        "tasks": tasks_dict,
        "status": status_dict,
        "deps": deps_list,
        "events": events_list,
        "requirements": requirements_dict,
        "dept_capacity": dept_capacity,
        "today_day": project.today_day,
        "project_start": project.start_date,
    }


def _compute_dept_capacity(tasks_rows: list[Task]) -> dict[str, int]:
    """Estimate department capacity as the count of unique owners in each dept."""
    dept_owners: dict[str, set] = {}
    for t in tasks_rows:
        dept_owners.setdefault(t.department, set()).add(t.owner)
    return {dept: len(owners) for dept, owners in dept_owners.items()}


def _compute_observed_durations(
    tasks_dict: dict, status_dict: dict, events_list: list, today_day: float
) -> tuple[dict, dict]:
    """Compute planned and observed durations from task data and events.

    For stalled tasks (in_review or in_progress), we add the time they've been
    sitting beyond their planned duration.
    """
    planned = {tid: float(t["duration"]) for tid, t in tasks_dict.items()}
    observed = dict(planned)

    for tid, st in status_dict.items():
        if st in ("in_review", "in_progress"):
            # Find when this task started its current status
            last_event_day = 0.0
            for e in events_list:
                if e["task"] == tid:
                    last_event_day = max(last_event_day, e["day"])

            # Time spent = today - when task entered current state
            time_in_state = today_day - last_event_day
            if time_in_state > planned[tid]:
                observed[tid] = time_in_state

    return planned, observed


async def get_project_state(db: AsyncSession, project_id: uuid.UUID) -> dict:
    """Full project state — schedule, bottlenecks, everything the dashboard needs."""
    data = await _load_project_data(db, project_id)
    project = data["project"]

    G = E.build_graph(data["tasks"], data["deps"])
    planned_dur, observed_dur = _compute_observed_durations(
        data["tasks"], data["status"], data["events"], data["today_day"]
    )

    baseline = E.schedule(G, planned_dur)
    current = E.schedule(G, observed_dur)

    bottlenecks = E.detect(
        G, current, data["status"], data["events"],
        data["dept_capacity"], data["today_day"]
    )

    # Build task rows
    task_rows = []
    for tid in sorted(G.nodes):
        t = G.nodes[tid]
        task_rows.append({
            "task_code": tid,
            "name": t["name"],
            "department": t["dept"],
            "owner": t["owner"],
            "planned_duration": t["duration"],
            "status": data["status"][tid],
            "es": current["ES"][tid],
            "ef": current["EF"][tid],
            "ls": current["LS"][tid],
            "lf": current["LF"][tid],
            "slack": current["slack"][tid],
            "critical": tid in current["critical"],
            "start_date": E.day_to_date(project.start_date, current["ES"][tid]),
            "end_date": E.day_to_date(project.start_date, current["EF"][tid]),
            "depends_on": sorted(G.predecessors(tid)),
        })

    edges = [
        {"source": u, "target": v, "kind": G.edges[u, v]["kind"]}
        for u, v in G.edges
    ]

    requirements = [
        {
            "req_code": k,
            "version": v["version"],
            "text": v["text"],
            "consumed_by": v["consumed_by"],
        }
        for k, v in data["requirements"].items()
    ]

    return {
        "project_id": str(project.id),
        "project_name": project.name,
        "project_start": project.start_date.isoformat(),
        "today_day": data["today_day"],
        "planned_end": baseline["project_end"],
        "projected_end": current["project_end"],
        "planned_end_date": E.day_to_date(project.start_date, baseline["project_end"]),
        "projected_end_date": E.day_to_date(project.start_date, current["project_end"]),
        "slip_days": current["project_end"] - baseline["project_end"],
        "critical_path": current["critical"],
        "tasks": task_rows,
        "edges": edges,
        "departments": data["dept_capacity"],
        "bottlenecks": [b.to_dict() for b in bottlenecks],
        "requirements": requirements,
    }


async def simulate_delay(
    db: AsyncSession, project_id: uuid.UUID,
    task_code: str, extra_days: float
) -> dict:
    """Simulate what happens if a task slips by extra_days."""
    data = await _load_project_data(db, project_id)
    project = data["project"]

    G = E.build_graph(data["tasks"], data["deps"])
    _, observed_dur = _compute_observed_durations(
        data["tasks"], data["status"], data["events"], data["today_day"]
    )

    current = E.schedule(G, observed_dur)
    delayed = E.apply_delay(observed_dur, task_code, extra_days)
    after = E.schedule(G, delayed)
    d = E.diff(current, after)

    d["notify"] = sorted({G.nodes[t]["owner"] for t in d["tasks_moved"]})
    d["moved_detail"] = [
        {
            "task_code": t,
            "name": G.nodes[t]["name"],
            "department": G.nodes[t]["dept"],
            "owner": G.nodes[t]["owner"],
            "delta": m["delta"],
            "from_date": E.day_to_date(project.start_date, m["from"]),
            "to_date": E.day_to_date(project.start_date, m["to"]),
        }
        for t, m in sorted(d["tasks_moved"].items(), key=lambda kv: -kv[1]["delta"])
    ]
    d["end_date_before"] = E.day_to_date(project.start_date, d["project_end_before"])
    d["end_date_after"] = E.day_to_date(project.start_date, d["project_end_after"])

    return d


async def simulate_requirement_change(
    db: AsyncSession, project_id: uuid.UUID, req_code: str
) -> dict:
    """Simulate what happens if a requirement changes."""
    data = await _load_project_data(db, project_id)

    G = E.build_graph(data["tasks"], data["deps"])
    req = data["requirements"].get(req_code)
    if req is None:
        raise ValueError(f"Requirement {req_code} not found")

    st = E.stale_tasks(G, set(req["consumed_by"]))

    def rows(ids):
        return [
            {
                "task_code": t,
                "name": G.nodes[t]["name"],
                "department": G.nodes[t]["dept"],
                "owner": G.nodes[t]["owner"],
                "status": data["status"][t],
            }
            for t in ids
        ]

    return {
        "req_code": req_code,
        "text": req["text"],
        "from_version": req["version"],
        "to_version": req["version"] + 1,
        "directly_consumed_by": req["consumed_by"],
        "must_redo": rows(st["must_redo"]),
        "must_recheck": rows(st["must_recheck"]),
        "departments_hit": sorted({G.nodes[t]["dept"] for t in st["must_redo"]}),
        "wasted_days": sum(
            G.nodes[t]["duration"] for t in st["must_redo"]
            if data["status"][t] == "done"
        ),
    }


async def get_accuracy(db: AsyncSession, project_id: uuid.UUID) -> dict:
    """Check detector accuracy against planted ground truth (for demo verification)."""
    data = await _load_project_data(db, project_id)

    G = E.build_graph(data["tasks"], data["deps"])
    _, observed_dur = _compute_observed_durations(
        data["tasks"], data["status"], data["events"], data["today_day"]
    )

    current = E.schedule(G, observed_dur)
    bottlenecks = E.detect(
        G, current, data["status"], data["events"],
        data["dept_capacity"], data["today_day"]
    )

    detected = {b.root_cause for b in bottlenecks}

    # Ground truth is hardcoded for the demo scenario
    ground_truth = {
        "T03": "budget approval stalled in review for 9 days (critical path)",
        "MKT": "marketing has 2 ready tasks (T11, T12) against capacity 1",
        "T12": "registration site unblocked for 10 days, never started",
    }

    truth = set(ground_truth)
    tp = sorted(truth & detected)

    return {
        "planted": len(truth),
        "detected": len(detected),
        "true_positives": tp,
        "missed": sorted(truth - detected),
        "extra": sorted(detected - truth),
        "recall": len(tp) / len(truth) if truth else 0,
        "precision_vs_planted": len(tp) / len(detected) if detected else 0,
        "ground_truth": ground_truth,
    }
