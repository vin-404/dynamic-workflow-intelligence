"""
Tier 1 - stateful detectors.

These need task statuses and assignments. They are the prototype's D1 and D2,
ported into the registry with **behaviour unchanged**: the root-cause walkback
and the resource-contention arithmetic are identical, and the regression suite
proves it.
"""
from __future__ import annotations

import networkx as nx

from backend.app.core.engine.detectors.context import DetectorContext
from backend.app.core.engine.findings import HIGH, MEDIUM, Finding, Impact, Tier
from backend.app.core.workflow import TaskStatus


def root_blocker(ctx: DetectorContext, task: str) -> str | None:
    """Earliest incomplete zero-slack ancestor -- the cause, not the symptom.

    This is the line that separates this product from a task board: a board
    shows you the blocked task, we name the blocker.
    """
    incomplete = [
        n for n in ctx.ancestors[task]
        if not ctx.is_done(n) and abs(ctx.slack(n)) < 1e-9
    ]
    if not incomplete:
        return None
    return min(incomplete, key=lambda n: ctx.schedule["ES"][n])


def critical_path_blocker(ctx: DetectorContext) -> list[Finding]:
    """Zero-slack work held up by an unfinished predecessor.

    Deduped to one finding per root cause, so ten blocked tasks behind one
    stalled approval report the approval once rather than ten times.
    """
    candidates: list[Finding] = []

    for key in ctx.task_keys:
        if ctx.is_done(key) or not ctx.is_critical(key):
            continue
        incomplete_preds = [
            p for p in ctx.graph.predecessors(key) if not ctx.is_done(p)
        ]
        if not incomplete_preds:
            continue
        cause = root_blocker(ctx, key) or incomplete_preds[0]
        if cause == key:
            continue

        downstream = ctx.descendants[cause]
        activity = ctx.last_event[cause] or ctx.ready_since(cause)
        held = round(ctx.clock.today_day - activity, 1)
        blocks = sorted(ctx.graph.successors(cause))

        candidates.append(Finding(
            kind="critical_path_blocker",
            tier=Tier.STATEFUL,
            severity=HIGH,
            task_ids=(cause,),
            root_cause=cause,
            evidence={
                "blocks_directly": blocks,
                "days_since_last_activity": held,
                "status": ctx.status(cause).value,
                "slack_days": ctx.slack(cause),
                "assigned_to": ctx.who(cause),
                "last_activity_day": activity,
            },
            impact=Impact.observed(
                days_lost=max(held, 0.0), downstream=len(downstream)
            ),
            downstream_affected=downstream,
            suggested_action=(
                f"Unblock {cause} ({ctx.who(cause)}) -- it is on the critical "
                f"path and {len(downstream)} downstream tasks cannot start."
            ),
            explanation=(
                f"{cause} ({ctx.name(cause)}) is the earliest unfinished "
                f"zero-slack task in this chain, so it is the cause rather "
                f"than a symptom. It is {ctx.status(cause).value}, has had no "
                f"activity for {held:.0f} days, and {len(downstream)} tasks "
                f"sit behind it."
            ),
        ))

    # dedupe: one finding per root cause
    seen: set[str | None] = set()
    out: list[Finding] = []
    for finding in candidates:
        if finding.root_cause in seen:
            continue
        seen.add(finding.root_cause)
        out.append(finding)
    return out


def resource_contention(ctx: DetectorContext) -> list[Finding]:
    """More work ready right now than a resource can pick up.

    Measured per resource against its own capacity, over the ready work of
    itself and its descendants - which is how a team caps throughput below the
    sum of its members (decision D-16).
    """
    out: list[Finding] = []

    for resource in ctx.snapshot.resources:
        members = ctx.resource_members(resource.key)
        ready = sorted(
            key for key in ctx.task_keys
            if ctx.status(key) == TaskStatus.NOT_STARTED
            and ctx.is_ready(key)
            and members & set(ctx.assignees.get(key, ()))
        )
        if len(ready) <= resource.capacity:
            continue

        downstream = tuple(sorted({
            d for key in ready for d in ctx.descendants[key]
        }))
        # Work that has to wait: everything queued except the one being worked.
        queued_days = round(
            sum(ctx.duration(k) for k in ready)
            - max(ctx.duration(k) for k in ready),
            1,
        )
        first = min(ready, key=lambda k: ctx.slack(k))
        label = ctx.resource_label.get(resource.key, resource.name)

        out.append(Finding(
            kind="resource_contention",
            tier=Tier.STATEFUL,
            severity=MEDIUM,
            task_ids=tuple(ready),
            root_cause=resource.key,
            evidence={
                "resource": resource.key,
                "resource_name": resource.name,
                "resource_kind": resource.kind,
                "capacity": resource.capacity,
                "ready_tasks": len(ready),
                "queue": list(ready),
                "min_slack_in_queue": min(ctx.slack(k) for k in ready),
                "queued_work_days": queued_days,
            },
            impact=Impact.observed(
                days_lost=queued_days, downstream=len(downstream)
            ),
            downstream_affected=downstream,
            suggested_action=(
                f"{label} has {len(ready)} tasks ready but capacity "
                f"{resource.capacity}. Start {first} first (lowest slack) or "
                f"add capacity."
            ),
            explanation=(
                f"{len(ready)} tasks ({', '.join(ready)}) are unblocked and "
                f"waiting on {label}, which has capacity {resource.capacity}. "
                f"About {queued_days:.0f} days of that work must queue. The "
                f"tightest is {first}, with "
                f"{min(ctx.slack(k) for k in ready):.0f} days of slack."
            ),
        ))
    return out


def projected_vs_planned_finish(ctx: DetectorContext) -> list[Finding]:
    """The project is already running later than it was planned to.

    Needs statuses, because the projection comes from observed durations. This
    is the headline number a delivery lead actually asks for, stated as a
    finding with its arithmetic attached.
    """
    baseline = ctx.schedule.get("baseline_project_end")
    if baseline is None:
        return []
    projected = ctx.schedule["project_end"]
    slip = projected - baseline
    if slip <= 1e-9:
        return []

    critical = tuple(ctx.schedule["critical"])
    stretched = sorted(
        (
            key for key in ctx.task_keys
            if ctx.duration(key) > ctx.snapshot.task_by_key[key].effort + 1e-9
        ),
        key=lambda k: -(ctx.duration(k) - ctx.snapshot.task_by_key[k].effort),
    )
    return [Finding(
        kind="projected_vs_planned_finish",
        tier=Tier.STATEFUL,
        severity=HIGH if slip >= 3 else MEDIUM,
        task_ids=tuple(stretched) or critical,
        root_cause=stretched[0] if stretched else None,
        evidence={
            "planned_end_day": baseline,
            "projected_end_day": projected,
            "slip_days": slip,
            "tasks_running_over": [
                {
                    "task": key,
                    "planned_days": ctx.snapshot.task_by_key[key].effort,
                    "observed_days": ctx.duration(key),
                    "over_by_days": (
                        ctx.duration(key) - ctx.snapshot.task_by_key[key].effort
                    ),
                }
                for key in stretched
            ],
            "critical_path": list(critical),
        },
        impact=Impact.observed(days_lost=slip, downstream=len(critical)),
        downstream_affected=critical,
        suggested_action=(
            f"The projection is {slip:.0f} days later than the plan, driven by "
            + (
                f"{stretched[0]} running "
                f"{ctx.duration(stretched[0]) - ctx.snapshot.task_by_key[stretched[0]].effort:.0f} "
                f"days over. Address that task before re-planning the rest."
                if stretched else
                "the current critical path."
            )
        ),
        explanation=(
            f"Planned finish was day {baseline:.0f}; the projection from "
            f"observed durations is day {projected:.0f}, a slip of "
            f"{slip:.0f} days. "
            + (
                f"{len(stretched)} task(s) are already running over their "
                f"planned effort, the largest being {stretched[0]}."
                if stretched else
                "No single task is over its estimate; the slip is structural."
            )
        ),
    )]
