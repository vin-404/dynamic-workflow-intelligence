"""Requirement staleness propagation.

Moved verbatim from the prototype `engine.py` (phase 1).
"""
from __future__ import annotations

import networkx as nx


def stale_tasks(G: nx.DiGraph, seeds: set[str]) -> dict:
    """A requirement changed.  `seeds` are the tasks that consumed it.

    must_redo    -- reachable from a seed along ARTIFACT edges: this work
                    consumed something that is now wrong.
    must_recheck -- merely downstream in time: probably fine, but a human
                    should look.

    Keeping these separate is the difference between a useful alert and
    "your whole project is red".
    """
    must_redo = set(seeds)
    frontier = set(seeds)
    while frontier:
        nxt = set()
        for u in frontier:
            for v in G.successors(u):
                if G.edges[u, v]["kind"] == "artifact" and v not in must_redo:
                    must_redo.add(v)
                    nxt.add(v)
        frontier = nxt

    downstream: set[str] = set()
    for n in must_redo:
        downstream |= nx.descendants(G, n)

    return {
        "must_redo": sorted(must_redo),
        "must_recheck": sorted(downstream - must_redo),
    }
