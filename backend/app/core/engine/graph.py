"""Workflow graph construction and cycle reporting.

Moved verbatim from the prototype `engine.py` (phase 1). Everything here is
deterministic arithmetic on a DAG. No ML, no LLM. That is deliberate:
schedule claims have to be auditable.
"""
from __future__ import annotations

import networkx as nx


class CycleError(Exception):
    def __init__(self, cycles):
        self.cycles = cycles
        super().__init__(f"workflow contains circular dependencies: {cycles}")


def build_graph(tasks: dict, deps: list) -> nx.DiGraph:
    """deps entries are (predecessor, successor, kind) with kind in
    {'artifact', 'temporal'}.  'artifact' means the successor consumes
    something the predecessor produces -- that distinction drives staleness."""
    G = nx.DiGraph()
    for tid, t in tasks.items():
        G.add_node(tid, **t)
    for u, v, kind in deps:
        G.add_edge(u, v, kind=kind)
    return G
