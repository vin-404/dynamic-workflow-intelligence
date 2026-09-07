"""
Intelligence service - the DB <-> engine adapter.

It loads a snapshot, calls `core.engine.evaluate()`, and serialises the result
for the API. Every number in what it returns came out of `core/`; this layer
adds calendar dates, resource names and task names, and nothing else.

The two prototype helpers that used to live here are gone for good reasons:

* `_compute_dept_capacity` guessed a department's capacity from the count of
  distinct owners. Capacity is now an explicit `Resource.capacity`, so there
  is nothing to guess.
* `_compute_observed_durations` moved into `core.engine.effort` as
  `observed_durations`, where it belongs: it is engine arithmetic, and putting
  it in a DB service made it untestable without a database.
"""
from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.engine import evaluate as core_evaluate
from backend.app.core.engine import stale_tasks
from backend.app.core.engine.graph import build_graph_from_snapshot
from backend.app.core.engine.risk import RiskWeights
from backend.app.core.workflow import EngineConfig, WorkflowSnapshot
from backend.app.services import analysis_runs, versions as V
from backend.app.services.versions import NotFound  # re-exported for routers

__all__ = [
    "NotFound",
    "get_workflow",
    "analyze",
    "risk",
    "requirement_impact",
    "get_accuracy",
]


def _resource_labels(snapshot: WorkflowSnapshot) -> dict[str, str]:
    """resource key -> "Name (Parent)" for presentation only."""
    by_key = snapshot.resource_by_key
    out: dict[str, str] = {}
    for r in snapshot.resources:
        parent = by_key.get(r.parent_key) if r.parent_key else None
        out[r.key] = f"{r.name} ({parent.name})" if parent else r.name
    return out


def _serialise_workflow(project, version, snapshot, state) -> dict:
    """The authoring view: the graph as the user built it, no analysis."""
    labels = _resource_labels(snapshot)
    assignees = snapshot.assignees_by_task
    return {
        "project_id": str(project.id),
        "project_name": project.name,
        "goal": project.goal,
        "project_start": project.start_date.isoformat(),
        "deadline": project.deadline.isoformat() if project.deadline else None,
        "deadline_day": snapshot.deadline_day,
        "today_day": project.today_day,
        "version": {
            "id": str(version.id),
            "version_no": version.version_no,
            "parent_version_id": (
                str(version.parent_version_id) if version.parent_version_id else None
            ),
            "content_hash": version.content_hash,
            "is_draft": version.is_draft,
            "note": version.note,
            "created_at": version.created_at.isoformat(),
        },
        "tasks": [
            {
                "key": t.key,
                "name": t.name,
                "description": t.description,
                "effort": t.effort,
                "divisible": t.divisible,
                "priority": t.priority,
                "optimistic": t.optimistic,
                "likely": t.likely,
                "pessimistic": t.pessimistic,
                "required_skills": list(t.required_skills),
                "status": state.status_of(t.key).value,
                "assignees": [
                    {"key": k, "label": labels.get(k, k)}
                    for k in assignees.get(t.key, ())
                ],
            }
            for t in snapshot.tasks
        ],
        "dependencies": [
            {
                "from_task": d.from_task,
                "to_task": d.to_task,
                "dep_type": d.dep_type.value,
                "consumes": d.consumes,
            }
            for d in snapshot.dependencies
        ],
        "resources": [
            {
                "key": r.key,
                "name": r.name,
                "kind": r.kind,
                "capacity": r.capacity,
                "skills": list(r.skills),
                "parent_key": r.parent_key,
                "label": labels[r.key],
            }
            for r in snapshot.resources
        ],
        "requirements": [
            {
                "key": r.key,
                "version_no": r.version_no,
                "text": r.text,
                "consumed_by": list(r.consumed_by),
            }
            for r in snapshot.requirements
        ],
        "constraints": [
            {
                "kind": c.kind.value,
                "target": c.target,
                "reason": c.reason,
                "value": c.value,
            }
            for c in snapshot.constraints
        ],
    }


async def get_workflow(
    db: AsyncSession, project_id: uuid.UUID, version_id: uuid.UUID | None = None
) -> dict:
    project, version, snapshot, state, _ = await V.load_context(
        db, project_id, version_id
    )
    return _serialise_workflow(project, version, snapshot, state)


async def analyze(
    db: AsyncSession,
    project_id: uuid.UUID,
    version_id: uuid.UUID | None = None,
    config: EngineConfig | None = None,
    persist: bool = True,
    weights: RiskWeights | None = None,
) -> dict:
    """Capability 1: `evaluate(W)`, serialised.

    A pure read over the immutable snapshot. The only row it writes is an
    `AnalysisRun` recording `engine_version` and `input_hash` so the result is
    reproducible and comparable - **no workflow state is touched**, which is
    the contract rule in ARCHITECTURE E.
    """
    project, version, snapshot, state, clock = await V.load_context(
        db, project_id, version_id
    )
    result = core_evaluate(snapshot, state, clock, config, weights)

    labels = _resource_labels(snapshot)
    assignees = snapshot.assignees_by_task
    task_by_key = snapshot.task_by_key
    sched = result.schedule

    task_rows = []
    for key in snapshot.task_keys:
        t = task_by_key[key]
        task_rows.append({
            "key": key,
            "name": t.name,
            "effort": t.effort,
            "duration": sched["durations"][key],
            "status": state.status_of(key).value,
            "assignees": [labels.get(k, k) for k in assignees.get(key, ())],
            "es": sched["ES"][key],
            "ef": sched["EF"][key],
            "ls": sched["LS"][key],
            "lf": sched["LF"][key],
            "slack": sched["slack"][key],
            "critical": key in sched["critical"],
            "start_date": V.day_to_date(project.start_date, sched["ES"][key]),
            "end_date": V.day_to_date(project.start_date, sched["EF"][key]),
            "depends_on": sorted(
                d.from_task for d in snapshot.dependencies if d.to_task == key
            ),
        })

    payload = result.as_dict()

    run_id = None
    if persist:
        run = await analysis_runs.record(
            db,
            project.id,
            result,
            subject_type="version",
            subject_id=version.id,
            params={"today_day": project.today_day},
        )
        run_id = str(run.id)
        await db.commit()

    payload.update({
        "analysis_run_id": run_id,
        "project_id": str(project.id),
        "project_name": project.name,
        "version_id": str(version.id),
        "version_no": version.version_no,
        "project_start": project.start_date.isoformat(),
        "today_day": project.today_day,
        "planned_end_date": V.day_to_date(project.start_date, result.planned_end),
        "projected_end_date": V.day_to_date(project.start_date, result.projected_end),
        "deadline_date": project.deadline.isoformat() if project.deadline else None,
        "tasks": task_rows,
        "resources": [
            {
                "key": r.key,
                "name": r.name,
                "label": labels[r.key],
                "kind": r.kind,
                "capacity": r.capacity,
                "parent_key": r.parent_key,
            }
            for r in snapshot.resources
        ],
        "edges": [
            {
                "source": d.from_task,
                "target": d.to_task,
                "dep_type": d.dep_type.value,
                "consumes": d.consumes,
            }
            for d in snapshot.dependencies
        ],
    })
    return payload


async def requirement_impact(
    db: AsyncSession,
    project_id: uuid.UUID,
    requirement_key: str,
    version_id: uuid.UUID | None = None,
) -> dict:
    """What a requirement change invalidates.

    `must_redo` is reachable along *consuming* edges: that work consumed
    something that is now wrong. `must_recheck` is merely downstream in time.
    Keeping them separate is the difference between a useful alert and
    "your whole project is red".
    """
    project, version, snapshot, state, _ = await V.load_context(
        db, project_id, version_id
    )
    req = snapshot.requirement_by_key.get(requirement_key)
    if req is None:
        raise NotFound(f"Requirement {requirement_key} not found")

    G = build_graph_from_snapshot(snapshot)
    st = stale_tasks(G, set(req.consumed_by))

    labels = _resource_labels(snapshot)
    assignees = snapshot.assignees_by_task
    task_by_key = snapshot.task_by_key

    def rows(keys):
        return [
            {
                "key": k,
                "name": task_by_key[k].name,
                "status": state.status_of(k).value,
                "assignees": [labels.get(r, r) for r in assignees.get(k, ())],
            }
            for k in keys
        ]

    resources_hit = sorted({
        labels.get(r, r)
        for k in st["must_redo"]
        for r in assignees.get(k, ())
    })

    return {
        "project_id": str(project.id),
        "version_id": str(version.id),
        "requirement_key": requirement_key,
        "text": req.text,
        "from_version": req.version_no,
        "to_version": req.version_no + 1,
        "directly_consumed_by": list(req.consumed_by),
        "must_redo": rows(st["must_redo"]),
        "must_recheck": rows(st["must_recheck"]),
        "resources_hit": resources_hit,
        #: Effort already spent on work that is now invalid.
        "wasted_days": sum(
            task_by_key[k].effort
            for k in st["must_redo"]
            if state.is_done(k)
        ),
    }


async def get_accuracy(
    db: AsyncSession, project_id: uuid.UUID, version_id: uuid.UUID | None = None
) -> dict:
    """Detector precision and recall against a fully labelled fixture.

    The prototype hardcoded three planted faults in this function and reported
    `precision_vs_planted`. That metric punished the detectors for being right
    about anything nobody had written down - and once the Tier-0 detectors
    landed, being right about eight more things would have "dropped precision"
    from 100% to 33%. So the fixtures now label **every** problem they are
    known to contain, and the numbers below mean what they say:

    * `planted_recall` - the headline: did we find the faults authored
      deliberately to be found?
    * `recall` - of everything this fixture is known to contain, how much did
      we find? A drop means a detector regressed.
    * `precision` - of everything we reported, how much was expected? A drop
      means a detector started firing spuriously.

    A project with no labels says so and reports no score, rather than
    inventing one.
    """
    from backend.app.seed.fixtures import FIXTURE_BUILDERS
    from backend.app.seed.loader import PROJECT_IDS

    project, version, snapshot, state, clock = await V.load_context(
        db, project_id, version_id
    )

    fixture_key = next(
        (k for k, pid in PROJECT_IDS.items() if pid == project.id), None
    )
    fixture = (
        FIXTURE_BUILDERS[fixture_key]()
        if fixture_key in FIXTURE_BUILDERS
        else None
    )

    result = core_evaluate(snapshot, state, clock)
    detected = {
        (f.kind, f.root_cause) for f in result.findings if f.root_cause
    }

    def ref_str(ref: tuple[str, str]) -> str:
        return f"{ref[0]}@{ref[1]}"

    if fixture is None or not fixture.labelled:
        return {
            "project_id": str(project.id),
            "has_labels": False,
            "labelled": 0,
            "detected": len(detected),
            "detections": sorted(ref_str(r) for r in detected),
            "note": (
                "No findings are labelled for this project, so precision and "
                "recall are undefined. Reporting a score here would be "
                "meaningless."
            ),
            "labels": [],
            "true_positives": [],
            "missed": [],
            "unexpected": sorted(ref_str(r) for r in detected),
            "recall": None,
            "precision": None,
            "planted": 0,
            "planted_found": [],
            "planted_recall": None,
        }

    labelled = fixture.labelled_refs
    planted = {f.ref for f in fixture.planted}
    tp = labelled & detected

    # The engine's own snapshot of what it could and could not check, so a
    # missed label can be read as "regressed" or "not yet unlockable".
    return {
        "project_id": str(project.id),
        "has_labels": True,
        "engine_version": result.engine_version,
        "tier_reached": result.tier_reached,
        "checks_run": result.checks_run,
        "labelled": len(labelled),
        "detected": len(detected),
        "true_positives": sorted(ref_str(r) for r in tp),
        "missed": sorted(ref_str(r) for r in labelled - detected),
        "unexpected": sorted(ref_str(r) for r in detected - labelled),
        "recall": len(tp) / len(labelled) if labelled else None,
        "precision": len(tp) / len(detected) if detected else None,
        "planted": len(planted),
        "planted_found": sorted(ref_str(r) for r in planted & detected),
        "planted_recall": (
            len(planted & detected) / len(planted) if planted else None
        ),
        "labels": [
            {
                "kind": f.kind,
                "root_cause": f.root_cause,
                "description": f.description,
                "planted": f.planted,
                "detected": f.ref in detected,
            }
            for f in fixture.labelled
        ],
    }


async def risk(
    db: AsyncSession,
    project_id: uuid.UUID,
    version_id: uuid.UUID | None = None,
    weights: RiskWeights | None = None,
    config: EngineConfig | None = None,
) -> dict:
    """Capability 2, Layer A: per-task risk with its factor decomposition.

    Weights are inputs and are echoed in the response, so "18% riskier" can
    never rest on numbers the reader cannot see (ARCHITECTURE H, risk #5).
    """
    project, version, snapshot, state, clock = await V.load_context(
        db, project_id, version_id
    )
    result = core_evaluate(snapshot, state, clock, config, weights)
    payload = dict(result.risk)
    payload.update({
        "project_id": str(project.id),
        "version_id": str(version.id),
        "engine_version": result.engine_version,
        "input_hash": result.input_hash,
        "tier_reached": result.tier_reached,
        "feasibility": result.feasibility.as_dict(),
        "projected_end_date": V.day_to_date(
            project.start_date, result.projected_end
        ),
        "three_point_dates": {
            band: V.day_to_date(project.start_date, day)
            for band, day in (
                ("optimistic", result.feasibility.three_point["optimistic_day"]),
                ("likely", result.feasibility.three_point["likely_day"]),
                ("pessimistic", result.feasibility.three_point["pessimistic_day"]),
            )
        } if result.feasibility.three_point else None,
    })
    return payload
