"""Workflow graph construction and cycle reporting.

`build_graph` is the prototype's, with the edge attribute generalised from the
string `kind in {artifact, temporal}` to a `consumes: bool` plus a `dep_type`
(decision D-11). `stale_tasks` reads `consumes`; nothing reads `kind` any more.

Everything here is deterministic arithmetic on a DAG. No ML, no LLM. That is
deliberate: schedule claims have to be auditable.
"""
from __future__ import annotations

from typing import Iterable

import networkx as nx

from backend.app.core.workflow import (
    DependencySpec,
    DepType,
    WorkflowSnapshot,
)


class CycleError(Exception):
    def __init__(self, cycles):
        self.cycles = cycles
        super().__init__(f"workflow contains circular dependencies: {cycles}")


def _normalise_dep(dep) -> DependencySpec:
    """Accept a DependencySpec, or the prototype's `(pred, succ, kind)` tuple
    where kind was 'artifact' (consuming) or 'temporal' (ordering only)."""
    if isinstance(dep, DependencySpec):
        return dep
    from_task, to_task, kind = dep
    return DependencySpec(
        from_task=from_task,
        to_task=to_task,
        dep_type=DepType.FS,
        consumes=(kind == "artifact"),
    )


def build_graph(tasks: dict, deps: Iterable) -> nx.DiGraph:
    """Node per task carrying its attributes; edge per dependency carrying
    `consumes` and `dep_type`.

    `tasks` maps task key -> attribute dict. `deps` entries are either
    `DependencySpec`s or `(predecessor, successor, kind)` tuples.
    """
    G = nx.DiGraph()
    for tid, t in tasks.items():
        G.add_node(tid, **t)
    for raw in deps:
        d = _normalise_dep(raw)
        G.add_edge(
            d.from_task,
            d.to_task,
            consumes=d.consumes,
            dep_type=d.dep_type.value,
        )
    return G


def build_graph_from_snapshot(snapshot: WorkflowSnapshot) -> nx.DiGraph:
    """The snapshot-native builder. Nodes carry the `TaskSpec` itself under
    `spec` plus the flat fields the detectors read, so no detector has to know
    how a task was stored."""
    tasks = {
        t.key: {
            "spec": t,
            "name": t.name,
            "effort": t.effort,
            "divisible": t.divisible,
            "priority": t.priority,
        }
        for t in snapshot.tasks
    }
    G = build_graph(tasks, snapshot.dependencies)
    # A task with no dependencies at all must still be a node.
    for key in snapshot.task_keys:
        if key not in G:
            G.add_node(key, **tasks[key])
    return G


def assert_acyclic(G: nx.DiGraph) -> None:
    """Raise `CycleError` carrying the actual cycles, not just a boolean."""
    if not nx.is_directed_acyclic_graph(G):
        raise CycleError(list(nx.simple_cycles(G)))


def find_cycles(G: nx.DiGraph) -> list[list[str]]:
    """Non-raising cycle report, for validators that need a reason string."""
    if nx.is_directed_acyclic_graph(G):
        return []
    return [list(c) for c in nx.simple_cycles(G)]


def transitive_redundant_edges(G: nx.DiGraph) -> list[tuple[str, str]]:
    """Edges implied by a longer path, so removing them cannot change the
    schedule. The basis of the transitive-reduction optimizer candidate
    (ARCHITECTURE D.5) and of the redundant-dependency Tier-0 detector.

    An edge (u, v) is redundant when v is still reachable from u without it.
    """
    redundant: list[tuple[str, str]] = []
    for u, v in list(G.edges):
        stripped = G.copy()
        stripped.remove_edge(u, v)
        if nx.has_path(stripped, u, v):
            redundant.append((u, v))
    return sorted(redundant)
