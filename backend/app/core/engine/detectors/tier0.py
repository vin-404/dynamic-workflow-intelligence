"""
Tier 0 - structural detectors.

These need only tasks, dependencies and effort. They are what makes a
brand-new project a useful analysis instead of an empty one (ARCHITECTURE
D.1): the first thing a judge does is create their own project, and at that
moment there are no statuses, no events and no actuals.

Because there is no history, impact magnitudes here are **days of work
exposed** to the weakness, not days already lost. The unit is named in every
payload so the two can never be confused.
"""
from __future__ import annotations

import networkx as nx

from backend.app.core.engine.detectors.context import DetectorContext
from backend.app.core.engine.findings import HIGH, LOW, MEDIUM, Finding, Impact, Tier
from backend.app.core.engine.graph import find_cycles, transitive_redundant_edges
from backend.app.core.workflow import ConstraintKind


def cycles(ctx: DetectorContext) -> list[Finding]:
    """A circular dependency, reported with the actual cycle.

    Cheap robustness, and the first thing anyone asks about. The authoring API
    refuses to create one, so this is the safety net for data that arrived any
    other way.
    """
    found = find_cycles(ctx.graph)
    out: list[Finding] = []
    for cycle in found:
        chain = " -> ".join(list(cycle) + [cycle[0]])
        out.append(Finding(
            kind="dependency_cycle",
            tier=Tier.STRUCTURAL,
            severity=HIGH,
            task_ids=tuple(cycle),
            root_cause=cycle[0],
            evidence={
                "cycle": list(cycle),
                "cycle_length": len(cycle),
                "chain": chain,
            },
            impact=Impact.exposed(
                days_at_risk=sum(ctx.duration(k) for k in cycle),
                downstream=len(cycle),
            ),
            downstream_affected=tuple(sorted(cycle)),
            suggested_action=(
                f"Break the cycle {chain} by removing one of its dependencies. "
                f"Until then the workflow cannot be scheduled at all."
            ),
            explanation=(
                f"These {len(cycle)} tasks depend on each other in a loop "
                f"({chain}), so no task in it can ever start. This is not a "
                f"delay, it is an impossible plan."
            ),
        ))
    return out


def deadline_infeasible(ctx: DetectorContext) -> list[Finding]:
    """The plan does not fit the deadline, on structure alone.

    Visible with zero history, which is what makes it a strong cold-start
    beat. Reported as a verdict and a margin, never as a probability.
    """
    deadline = ctx.snapshot.deadline_day
    if deadline is None:
        return []
    end = ctx.schedule["project_end"]
    overshoot = end - deadline
    if overshoot <= 1e-9:
        return []

    critical = tuple(ctx.schedule["critical"])
    return [Finding(
        kind="deadline_infeasible",
        tier=Tier.STRUCTURAL,
        severity=HIGH,
        task_ids=critical,
        root_cause=critical[-1] if critical else None,
        evidence={
            "projected_end_day": end,
            "deadline_day": deadline,
            "overshoot_days": overshoot,
            "critical_path": list(critical),
            "critical_path_length": len(critical),
        },
        impact=Impact.exposed(days_at_risk=overshoot, downstream=len(critical)),
        downstream_affected=critical,
        suggested_action=(
            f"The plan finishes {overshoot:.0f} days after the deadline before "
            f"anything has gone wrong. Shorten the critical path, add "
            f"capacity to it, or move the deadline - the arithmetic will not "
            f"resolve itself."
        ),
        explanation=(
            f"The critical path is {len(critical)} tasks long and finishes on "
            f"day {end:.0f}, against a deadline of day {deadline:.0f}. That is "
            f"infeasible by {overshoot:.0f} days on structure alone, with no "
            f"delay assumed anywhere."
        ),
    )]


def single_point_of_failure(ctx: DetectorContext) -> list[Finding]:
    """One task that many others wait on directly.

    High fan-out means a single slip radiates immediately rather than being
    absorbed. Structural, so it is visible before anything has slipped.
    """
    threshold = ctx.config.fan_out_threshold
    out: list[Finding] = []
    for key in ctx.task_keys:
        successors = sorted(ctx.graph.successors(key))
        if len(successors) < threshold:
            continue
        downstream = ctx.descendants[key]
        out.append(Finding(
            kind="single_point_of_failure",
            tier=Tier.STRUCTURAL,
            severity=HIGH if ctx.is_critical(key) else MEDIUM,
            task_ids=(key,),
            root_cause=key,
            evidence={
                "fan_out": len(successors),
                "threshold": threshold,
                "blocks_directly": successors,
                "total_downstream": len(downstream),
                "duration_days": ctx.duration(key),
                "slack_days": ctx.slack(key),
                "on_critical_path": ctx.is_critical(key),
                "assigned_to": ctx.who(key),
            },
            impact=Impact.exposed(
                days_at_risk=ctx.duration(key), downstream=len(downstream)
            ),
            downstream_affected=downstream,
            suggested_action=(
                f"{len(successors)} tasks start the moment {key} finishes. "
                f"Split it, start it earlier, or decouple the successors that "
                f"do not truly need its output."
            ),
            explanation=(
                f"{key} ({ctx.name(key)}) is a single point of failure: "
                f"{len(successors)} tasks depend on it directly and "
                f"{len(downstream)} sit behind it in total. It has "
                f"{ctx.slack(key):.0f} days of slack, so a slip here spreads "
                f"immediately rather than being absorbed."
            ),
        ))
    return out


def serial_chain_no_parallelism(ctx: DetectorContext) -> list[Finding]:
    """A long single-file run of work with nothing happening beside it.

    Every day of a serial chain is a day of calendar time, so a long one is a
    structural cap on how fast the project can possibly go - regardless of how
    many people are available.
    """
    threshold = ctx.config.serial_chain_threshold
    G = ctx.graph
    out: list[Finding] = []
    visited: set[str] = set()

    for key in ctx.task_keys:
        if key in visited:
            continue
        # Only start a chain where nothing single-file precedes it.
        preds = list(G.predecessors(key))
        if len(preds) == 1 and len(list(G.successors(preds[0]))) == 1:
            continue

        chain = [key]
        cursor = key
        while True:
            succs = list(G.successors(cursor))
            if len(succs) != 1:
                break
            nxt = succs[0]
            if len(list(G.predecessors(nxt))) != 1:
                break
            chain.append(nxt)
            cursor = nxt

        visited.update(chain)
        if len(chain) < threshold:
            continue

        total = sum(ctx.duration(k) for k in chain)
        downstream = ctx.descendants[chain[-1]]
        out.append(Finding(
            kind="serial_chain_no_parallelism",
            tier=Tier.STRUCTURAL,
            severity=MEDIUM,
            task_ids=tuple(chain),
            root_cause=chain[0],
            evidence={
                "chain": chain,
                "chain_length": len(chain),
                "threshold": threshold,
                "chain_duration_days": total,
                "project_end_day": ctx.schedule["project_end"],
                "share_of_project": (
                    total / ctx.schedule["project_end"]
                    if ctx.schedule["project_end"] else 0.0
                ),
                "on_critical_path": all(ctx.is_critical(k) for k in chain),
            },
            impact=Impact.exposed(days_at_risk=total, downstream=len(downstream)),
            downstream_affected=downstream,
            suggested_action=(
                f"{' -> '.join(chain)} runs strictly one after another for "
                f"{total:.0f} days with nothing in parallel. Look for a step "
                f"that could start on partial output, or split a divisible one."
            ),
            explanation=(
                f"{len(chain)} tasks run single-file from {chain[0]} to "
                f"{chain[-1]}, totalling {total:.0f} days - "
                f"{total / ctx.schedule['project_end']:.0%} of the whole "
                f"project. Nothing runs alongside them, so adding people "
                f"elsewhere cannot shorten this stretch."
            ),
        ))
    return out


def zero_slack_chain(ctx: DetectorContext) -> list[Finding]:
    """The workflow has no absorbing capacity: too much of it is critical.

    A project where most tasks have zero slack has no shock absorber - the
    first slip anywhere becomes a slip everywhere.
    """
    keys = list(ctx.task_keys)
    if len(keys) < 3:
        return []
    critical = [k for k in keys if ctx.is_critical(k)]
    share = len(critical) / len(keys)
    if share < ctx.config.critical_share_threshold:
        return []

    total = sum(ctx.duration(k) for k in critical)
    return [Finding(
        kind="zero_slack_chain",
        tier=Tier.STRUCTURAL,
        severity=HIGH if share >= 0.75 else MEDIUM,
        task_ids=tuple(critical),
        root_cause=critical[0] if critical else None,
        evidence={
            "zero_slack_tasks": critical,
            "zero_slack_count": len(critical),
            "task_count": len(keys),
            "share_of_tasks": share,
            "threshold": ctx.config.critical_share_threshold,
            "chain_duration_days": total,
        },
        # The chain *is* the affected work, so counting it again as
        # "downstream" would square the same fact.
        impact=Impact.exposed(days_at_risk=total, downstream=0),
        downstream_affected=tuple(critical),
        suggested_action=(
            f"{len(critical)} of {len(keys)} tasks have zero slack, so almost "
            f"any delay moves the finish date. Create slack by shortening the "
            f"critical path or by relaxing the dependencies that force this "
            f"sequence."
        ),
        explanation=(
            f"{share:.0%} of the tasks in this workflow have zero slack "
            f"({len(critical)} of {len(keys)}). There is almost no absorbing "
            f"capacity anywhere: a one-day slip on any of them is a one-day "
            f"slip for the project."
        ),
    )]


def resource_overallocated(ctx: DetectorContext) -> list[Finding]:
    """A resource is scheduled to do more at once than its capacity allows.

    This is the structural sibling of Tier-1 contention. Contention asks "how
    many tasks are ready right now"; this asks "does the *plan* ever require
    this resource in more places at once than it can be", which needs no
    statuses at all.

    CPM is resource-blind by design (ARCHITECTURE H, risk #2): we compute the
    schedule without resource constraints and report the overload separately,
    rather than pretending to solve RCPSP.
    """
    sched = ctx.schedule
    breaches: list[tuple[str, tuple[str, ...], dict]] = []

    for resource in ctx.snapshot.resources:
        members = ctx.resource_members(resource.key)
        tasks = sorted(
            k for k in ctx.task_keys
            if members & set(ctx.assignees.get(k, ()))
        )
        if len(tasks) <= resource.capacity:
            continue

        # Sweep the scheduled windows to find the peak concurrent demand.
        boundaries = sorted({sched["ES"][k] for k in tasks} |
                            {sched["EF"][k] for k in tasks})
        peak, peak_at, peak_tasks = 0, None, ()
        for point in boundaries:
            concurrent = tuple(
                k for k in tasks
                if sched["ES"][k] <= point < sched["EF"][k]
            )
            if len(concurrent) > peak:
                peak, peak_at, peak_tasks = len(concurrent), point, concurrent
        if peak <= resource.capacity:
            continue

        overflow = peak - resource.capacity
        # Days that have to move: the work that cannot run in the peak window.
        excess_days = sum(
            sorted((ctx.duration(k) for k in peak_tasks))[:overflow]
        )
        downstream = tuple(sorted({
            d for k in peak_tasks for d in ctx.descendants[k]
        }))
        label = ctx.resource_label.get(resource.key, resource.name)

        breaches.append((resource.key, tuple(peak_tasks), {
            "resource": resource,
            "peak": peak,
            "peak_at": peak_at,
            "overflow": overflow,
            "excess_days": excess_days,
            "downstream": downstream,
            "label": label,
            "assigned_total": len(tasks),
        }))

    # A person's overload implies their team's, so reporting both is noise.
    # Report at the narrowest resource that actually breaches, and record the
    # roll-up as suppressed with the reason rather than dropping it silently.
    out: list[Finding] = []
    for key, peak_tasks, info in breaches:
        members = ctx.resource_members(key) - {key}
        narrower = next(
            (
                other for other, other_tasks, _ in breaches
                if other in members and set(other_tasks) >= set(peak_tasks)
            ),
            None,
        )
        resource = info["resource"]
        peak = info["peak"]
        peak_at = info["peak_at"]
        overflow = info["overflow"]
        excess_days = info["excess_days"]
        downstream = info["downstream"]
        label = info["label"]

        finding = Finding(
            kind="resource_overallocated",
            tier=Tier.STRUCTURAL,
            severity=HIGH if overflow > 1 else MEDIUM,
            task_ids=tuple(peak_tasks),
            root_cause=resource.key,
            evidence={
                "resource": resource.key,
                "resource_name": resource.name,
                "resource_kind": resource.kind,
                "capacity": resource.capacity,
                "peak_concurrent_tasks": peak,
                "overflow": overflow,
                "peak_starts_day": peak_at,
                "overlapping_tasks": list(peak_tasks),
                "assigned_tasks_total": info["assigned_total"],
                "note": (
                    "The schedule is computed resource-blind (CPM) and this "
                    "overload is reported separately. We level heuristically; "
                    "we do not claim an optimal resource-constrained schedule."
                ),
            },
            impact=Impact.exposed(
                days_at_risk=excess_days, downstream=len(downstream)
            ),
            downstream_affected=downstream,
            suggested_action=(
                f"The plan puts {peak} tasks on {label} at once from day "
                f"{peak_at:.0f}, against capacity {resource.capacity}. "
                f"Reschedule {overflow} of them, or raise the capacity."
            ),
            explanation=(
                f"{label} has capacity {resource.capacity} but the schedule "
                f"requires {peak} of its tasks to run simultaneously from day "
                f"{peak_at:.0f} ({', '.join(peak_tasks)}). About "
                f"{excess_days:.0f} days of that work has to move, which the "
                f"resource-blind schedule above does not yet account for."
            ),
        )
        if narrower is not None:
            narrow_label = ctx.resource_label.get(narrower, narrower)
            finding = finding.with_suppression(
                by="resource_overallocated",
                reason=(
                    f"The same overload is already reported against "
                    f"{narrow_label}, a member of {label}. Reporting the "
                    f"roll-up as well would double-count one problem."
                ),
            )
        out.append(finding)
    return out


def unassigned_critical_task(ctx: DetectorContext) -> list[Finding]:
    """Work on the critical path with nobody on it.

    Needs assignments, which exist in the snapshot rather than in observed
    state, so this is genuinely Tier 0: a freshly authored workflow can have
    this problem the moment it is drawn.
    """
    out: list[Finding] = []
    for key in ctx.schedule["critical"]:
        if ctx.assignees.get(key):
            continue
        downstream = ctx.descendants[key]
        out.append(Finding(
            kind="unassigned_critical_task",
            tier=Tier.STRUCTURAL,
            severity=HIGH,
            task_ids=(key,),
            root_cause=key,
            evidence={
                "on_critical_path": True,
                "slack_days": ctx.slack(key),
                "duration_days": ctx.duration(key),
                "starts_day": ctx.schedule["ES"][key],
                "assignee_count": 0,
                "required_skills": list(
                    ctx.snapshot.task_by_key[key].required_skills
                ),
            },
            impact=Impact.exposed(
                days_at_risk=ctx.duration(key), downstream=len(downstream)
            ),
            downstream_affected=downstream,
            suggested_action=(
                f"Assign someone to {key}. It is on the critical path with "
                f"zero slack and {len(downstream)} tasks behind it, and nobody "
                f"owns it."
            ),
            explanation=(
                f"{key} ({ctx.name(key)}) is on the critical path, starts on "
                f"day {ctx.schedule['ES'][key]:.0f} and runs "
                f"{ctx.duration(key):.0f} days, but has no assignee. Unowned "
                f"critical work is the most common way a plan quietly slips."
            ),
        ))
    return out


def redundant_dependency(ctx: DetectorContext) -> list[Finding]:
    """A dependency already implied by a longer path.

    Removing one provably cannot change the finish date, which makes this the
    optimizer's safest candidate and a satisfying thing to show. Impact is
    genuinely zero days - it costs clarity, not time - and saying so is more
    useful than inflating it.
    """
    out: list[Finding] = []
    protected = {
        c.target for c in
        ctx.snapshot.constraints_of(ConstraintKind.IMMUTABLE_DEPENDENCY)
    }
    for u, v in transitive_redundant_edges(ctx.graph):
        stripped = ctx.graph.copy()
        stripped.remove_edge(u, v)
        try:
            via = nx.shortest_path(stripped, u, v)
        except nx.NetworkXNoPath:      # pragma: no cover - defensive
            continue
        is_protected = f"{u}->{v}" in protected
        out.append(Finding(
            kind="redundant_dependency",
            tier=Tier.STRUCTURAL,
            severity=LOW,
            task_ids=(u, v),
            root_cause=f"{u}->{v}",
            evidence={
                "edge": [u, v],
                "implied_by_path": via,
                "consumes": ctx.graph.edges[u, v]["consumes"],
                "schedule_effect_days": 0.0,
                "constraint_protected": is_protected,
            },
            impact=Impact.exposed(days_at_risk=0.0, downstream=0),
            downstream_affected=(),
            suggested_action=(
                f"{u} -> {v} is already implied by {' -> '.join(via)}. "
                + (
                    "It is protected by an IMMUTABLE_DEPENDENCY constraint, so "
                    "leave it in place - it is documenting intent."
                    if is_protected else
                    "Removing it simplifies the graph and provably cannot move "
                    "the finish date."
                )
            ),
            explanation=(
                f"The dependency {u} -> {v} adds no ordering: {v} already "
                f"waits for {u} through {' -> '.join(via)}. It costs nothing "
                f"in days - it costs clarity, and it makes the graph harder to "
                f"reason about than it needs to be."
            ),
        ))
    return out


def isolated_task(ctx: DetectorContext) -> list[Finding]:
    """A task connected to nothing, in a workflow that has connections.

    Usually a half-finished edit rather than a real plan, and worth flagging
    before it silently drops out of every downstream calculation.
    """
    keys = list(ctx.task_keys)
    if len(keys) < 3 or ctx.graph.number_of_edges() == 0:
        return []
    out: list[Finding] = []
    for key in keys:
        if ctx.graph.degree(key) != 0:
            continue
        out.append(Finding(
            kind="isolated_task",
            tier=Tier.STRUCTURAL,
            severity=LOW,
            task_ids=(key,),
            root_cause=key,
            evidence={
                "predecessors": 0,
                "successors": 0,
                "duration_days": ctx.duration(key),
                "task_count": len(keys),
                "edge_count": ctx.graph.number_of_edges(),
            },
            impact=Impact.exposed(days_at_risk=ctx.duration(key), downstream=0),
            downstream_affected=(),
            suggested_action=(
                f"Connect {key} to the work it depends on or enables, or "
                f"remove it. As drawn it floats free of the plan."
            ),
            explanation=(
                f"{key} ({ctx.name(key)}) has no predecessors and no "
                f"successors while the rest of the workflow is connected. It "
                f"is scheduled at day 0 by default, which is almost certainly "
                f"not what was meant."
            ),
        ))
    return out
