"""
The compact workflow projection.

The model gets task ids, names, effort, dependencies, assignees, slack, the
deadline and the current findings - **not** the full graph (ARCHITECTURE B.4).
A 200-task project must not blow the context window, and a model that has been
handed evidence it does not need is a model with more to hallucinate about.

Tasks and resources are referenced by key throughout, which is also what makes
the mutations the model emits directly checkable.
"""
from __future__ import annotations

import json
from typing import Any

from backend.app.core.engine.evaluate import EvaluationResult
from backend.app.core.workflow import WorkflowSnapshot, WorkflowState

#: Above this, the projection lists only the tasks that matter - critical
#: path, findings, and anything with little slack - plus a count of the rest.
COMPACT_ABOVE = 40
#: Hard ceiling once compaction is on. A single workflow-wide finding can name
#: every task, which would otherwise put the whole graph back in the prompt.
MAX_TASKS_SENT = 80
#: Only the findings that actually rank are worth pulling context in for.
MAX_FINDINGS_CONSIDERED = 12


def project(
    snapshot: WorkflowSnapshot,
    state: WorkflowState,
    result: EvaluationResult | None = None,
    domain_name: str | None = None,
    domain_hints: list[str] | None = None,
    max_findings: int = 8,
) -> dict[str, Any]:
    """Everything the model needs and nothing else.

    `domain_name` and `domain_hints` are the *only* place a domain appears in
    this system outside the UI. They reach the prompt and never the engine
    (ARCHITECTURE A.3).
    """
    sched = result.schedule if result else None
    keep = _tasks_worth_sending(snapshot, result)

    tasks = []
    for task in snapshot.tasks:
        if task.key not in keep:
            continue
        entry: dict[str, Any] = {
            "key": task.key,
            "name": task.name,
            "effort_days": task.effort,
            "divisible": task.divisible,
            "status": state.status_of(task.key).value,
            "assignees": list(snapshot.assignees_by_task.get(task.key, ())),
        }
        if sched:
            entry["slack_days"] = round(sched["slack"].get(task.key, 0.0), 1)
            entry["on_critical_path"] = task.key in sched["critical"]
        if task.required_skills:
            entry["required_skills"] = list(task.required_skills)
        tasks.append(entry)

    payload: dict[str, Any] = {
        "tasks": tasks,
        "dependencies": [
            {
                "from": d.from_task,
                "to": d.to_task,
                # `consumes` is the difference between "reorder freely" and
                # "this would invalidate work", so the model needs it.
                "consumes": d.consumes,
            }
            for d in snapshot.dependencies
            if d.from_task in keep and d.to_task in keep
        ],
        "resources": [
            {
                "key": r.key,
                "name": r.name,
                "kind": r.kind,
                "capacity": r.capacity,
                "skills": list(r.skills),
                "part_of": r.parent_key,
            }
            for r in snapshot.resources
        ],
        "constraints": [
            {"kind": c.kind.value, "target": c.target, "reason": c.reason}
            for c in snapshot.constraints
        ],
        "deadline_day": snapshot.deadline_day,
        "total_tasks": len(snapshot.tasks),
        "tasks_shown": len(tasks),
    }

    if len(tasks) < len(snapshot.tasks):
        payload["note"] = (
            f"{len(snapshot.tasks) - len(tasks)} task(s) with ample slack and "
            f"no findings were omitted to keep this compact."
        )

    if result is not None:
        payload["analysis"] = {
            "projected_end_day": result.projected_end,
            "planned_end_day": result.planned_end,
            "slip_days": result.slip_days,
            "critical_path": list(result.schedule["critical"]),
            "feasibility": {
                "verdict": result.feasibility.verdict,
                "margin_days": result.feasibility.margin_days,
            },
            "evidence_tier": result.tier_reached,
            "findings": [
                {
                    "kind": f.kind,
                    "root_cause": f.root_cause,
                    "severity": f.severity,
                    "impact": f.impact_score,
                    "explanation": f.explanation,
                }
                for f in result.findings[:max_findings]
            ],
        }

    if domain_name:
        payload["domain_context"] = {
            "name": domain_name,
            "vocabulary": list(domain_hints or []),
            "note": (
                "Context for phrasing and for what kinds of restructuring are "
                "plausible. The scheduling engine never sees this."
            ),
        }
    return payload


def _tasks_worth_sending(
    snapshot: WorkflowSnapshot, result: EvaluationResult | None
) -> set[str]:
    keys = set(snapshot.task_keys)
    if len(keys) <= COMPACT_ABOVE or result is None:
        return keys

    critical = set(result.schedule["critical"]) & keys
    slack = result.schedule["slack"]

    keep: set[str] = set(critical)
    for finding in result.findings[:MAX_FINDINGS_CONSIDERED]:
        keep.update(finding.task_ids[:5])
        keep.update(finding.downstream_affected[:5])
    tight = sorted(keys, key=lambda k: slack.get(k, 0.0))[: COMPACT_ABOVE // 2]
    keep.update(tight)
    keep &= keys

    if len(keep) <= MAX_TASKS_SENT:
        return keep

    # Over the ceiling. The critical path stays whole - it is the answer to
    # "what is the bottleneck" - and the remaining slots go to the tightest
    # slack, deterministically, with the key breaking ties.
    room = MAX_TASKS_SENT - len(critical)
    if room <= 0:
        return critical
    rest = sorted(keep - critical, key=lambda k: (slack.get(k, 0.0), k))
    return critical | set(rest[:room])


def render(payload: dict[str, Any]) -> str:
    """Deterministic JSON, so the same workflow always produces the same
    prompt hash and therefore the same cache key."""
    return json.dumps(payload, sort_keys=True, indent=None, separators=(",", ":"))
