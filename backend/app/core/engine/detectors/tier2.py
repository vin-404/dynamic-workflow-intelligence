"""
Tier 2 - historical detectors.

These measure elapsed time, so they need the event log: aging is the interval
between a recorded transition and now, and with no history there is no
interval to measure.

Both are the prototype's D3 and D4 ported unchanged, **including the
contention-age suppression**, which is deliberate temporal reasoning rather
than a bug: contention that began yesterday does not explain ten days of
idleness, so the two ages are compared instead of the finding being
blanket-dropped. Where suppression does apply, the reason is now recorded on
the finding rather than silently skipping it (ARCHITECTURE D.2).
"""
from __future__ import annotations

from backend.app.core.engine.detectors.context import DetectorContext
from backend.app.core.engine.findings import HIGH, MEDIUM, Finding, Impact, Tier
from backend.app.core.workflow import TaskStatus


def stalled_in_review(ctx: DetectorContext) -> list[Finding]:
    """Work sitting in review with nothing happening to it."""
    threshold = ctx.config.idle_threshold
    out: list[Finding] = []

    for key in ctx.task_keys:
        if ctx.status(key) != TaskStatus.IN_REVIEW:
            continue
        idle = ctx.clock.today_day - ctx.last_event[key]
        if idle < threshold:
            continue

        downstream = ctx.descendants[key]
        out.append(Finding(
            kind="stalled_in_review",
            tier=Tier.HISTORICAL,
            severity=HIGH,
            task_ids=(key,),
            root_cause=key,
            evidence={
                "days_idle": round(idle, 1),
                "threshold": threshold,
                "last_event_day": ctx.last_event[key],
                "today_day": ctx.clock.today_day,
                "assigned_to": ctx.who(key),
                "planned_days": ctx.snapshot.task_by_key[key].effort,
                "elapsed_days": ctx.duration(key),
            },
            impact=Impact.observed(
                days_lost=round(idle, 1), downstream=len(downstream)
            ),
            downstream_affected=downstream,
            suggested_action=(
                f"{key} has sat in review {idle:.0f} days with no activity. "
                f"Escalate to {ctx.who(key)}."
            ),
            explanation=(
                f"{key} ({ctx.name(key)}) entered review on day "
                f"{ctx.last_event[key]:.0f} and nothing has been recorded "
                f"against it since. That is {idle:.0f} days against a planned "
                f"{ctx.snapshot.task_by_key[key].effort:.0f}, and "
                f"{len(downstream)} tasks are behind it."
            ),
        ))
    return out


def ready_but_idle(ctx: DetectorContext) -> list[Finding]:
    """Unblocked work nobody started.

    Aging is measured from when the *last predecessor closed*, not from the
    task's own last event: a task nobody ever touched has no events, and "idle
    since day 0" would over-report every time.
    """
    threshold = ctx.config.idle_threshold
    out: list[Finding] = []

    for key in ctx.task_keys:
        if ctx.status(key) != TaskStatus.NOT_STARTED or not ctx.is_ready(key):
            continue
        since = ctx.ready_since(key)
        idle = ctx.clock.today_day - since
        if idle < threshold:
            continue

        downstream = ctx.descendants[key]
        out.append(Finding(
            kind="ready_but_idle",
            tier=Tier.HISTORICAL,
            severity=MEDIUM,
            task_ids=(key,),
            root_cause=key,
            evidence={
                "days_ready_unstarted": round(idle, 1),
                "ready_since_day": since,
                "today_day": ctx.clock.today_day,
                "threshold": threshold,
                "all_predecessors_done": True,
                "assigned_to": ctx.who(key),
                "slack_days": ctx.slack(key),
            },
            impact=Impact.observed(
                days_lost=round(idle, 1), downstream=len(downstream)
            ),
            downstream_affected=downstream,
            suggested_action=(
                f"{key} has been unblocked for {idle:.0f} days and nobody "
                f"started it. Confirm {ctx.who(key)} has it."
            ),
            explanation=(
                f"{key} ({ctx.name(key)}) became workable on day {since:.0f} "
                f"when its last predecessor closed, and it is still "
                f"not_started {idle:.0f} days later. It has "
                f"{ctx.slack(key):.0f} days of slack, so this is not yet "
                f"urgent, but it is unexplained."
            ),
        ))
    return out


def suppress_idle_explained_by_contention(
    findings: list[Finding],
    ctx: DetectorContext,
) -> list[Finding]:
    """Cross-detector suppression, with the reason recorded.

    A queue explains idleness only for as long as the queue has existed. A
    task idle for ten days is not explained by contention that started
    yesterday, so the two ages are compared rather than the finding being
    dropped outright. This is the prototype's insight, preserved exactly - and
    now the suppressed finding survives with its reason attached instead of
    disappearing.
    """
    contention_age: dict[str, float] = {}
    contention_by_task: dict[str, str] = {}
    for finding in findings:
        if finding.kind != "resource_contention":
            continue
        began = max(ctx.ready_since(k) for k in finding.task_ids)
        for key in finding.task_ids:
            contention_age[key] = ctx.clock.today_day - began
            contention_by_task[key] = finding.root_cause or "resource_contention"

    out: list[Finding] = []
    for finding in findings:
        if finding.kind != "ready_but_idle":
            out.append(finding)
            continue
        key = finding.root_cause
        idle = finding.evidence["days_ready_unstarted"]
        age = contention_age.get(key)
        if age is not None and idle <= age:
            out.append(finding.with_suppression(
                by="resource_contention",
                reason=(
                    f"{key} has been idle {idle:.0f} days and the queue on "
                    f"{contention_by_task[key]} has existed for {age:.0f} "
                    f"days, so the contention fully accounts for it. Reported "
                    f"once, as contention."
                ),
            ))
        else:
            out.append(finding)
    return out
