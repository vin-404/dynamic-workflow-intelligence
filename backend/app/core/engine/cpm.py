"""
Critical Path Method - the schedule, and the before/after diff.

Moved verbatim from the prototype `engine.py` (phase 1). Everything here is
deterministic arithmetic on a DAG. No ML, no LLM. That is deliberate:
schedule claims have to be auditable.
"""
from __future__ import annotations

import networkx as nx

from backend.app.core.engine.graph import CycleError


def schedule(G: nx.DiGraph, durations: dict[str, float]) -> dict:
    """CPM forward + backward pass -> ES/EF/LS/LF, slack, critical path."""
    if not nx.is_directed_acyclic_graph(G):
        raise CycleError(list(nx.simple_cycles(G)))

    order = list(nx.topological_sort(G))

    ES, EF = {}, {}
    for n in order:                                        # forward pass
        ES[n] = max((EF[p] for p in G.predecessors(n)), default=0)
        EF[n] = ES[n] + durations[n]

    project_end = max(EF.values(), default=0)

    LF, LS = {}, {}
    for n in reversed(order):                              # backward pass
        LF[n] = min((LS[s] for s in G.successors(n)), default=project_end)
        LS[n] = LF[n] - durations[n]

    slack = {n: LS[n] - ES[n] for n in order}
    return {
        "ES": ES, "EF": EF, "LS": LS, "LF": LF,
        "slack": slack,
        "critical": [n for n in order if abs(slack[n]) < 1e-9],
        "project_end": project_end,
        "durations": dict(durations),
    }


def diff(before: dict, after: dict) -> dict:
    moved = {}
    for n, es in after["ES"].items():
        prev = before["ES"].get(n)
        if prev is not None and abs(prev - es) > 1e-9:
            moved[n] = {"from": prev, "to": es, "delta": es - prev}

    b, a = set(before["critical"]), set(after["critical"])
    slack_consumed = {
        n: before["slack"][n] - after["slack"][n]
        for n in after["slack"]
        if n in before["slack"] and after["slack"][n] < before["slack"][n] - 1e-9
    }
    return {
        "project_end_before": before["project_end"],
        "project_end_after": after["project_end"],
        "project_end_delta": after["project_end"] - before["project_end"],
        "tasks_moved": moved,
        "critical_path_changed": before["critical"] != after["critical"],
        "newly_critical": sorted(a - b),
        "no_longer_critical": sorted(b - a),
        "slack_consumed": slack_consumed,
    }


def apply_delay(durations: dict, task_id: str, extra_days: float) -> dict:
    out = dict(durations)
    out[task_id] = out[task_id] + extra_days
    return out
