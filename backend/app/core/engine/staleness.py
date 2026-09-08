"""Requirement staleness propagation.

Moved verbatim from the prototype `engine.py` (phase 1).
"""
from __future__ import annotations

import networkx as nx


def stale_tasks(G: nx.DiGraph, seeds: set[str]) -> dict:
    """A requirement changed.  `seeds` are the tasks that consumed it.

    must_redo    -- reachable from a seed along CONSUMING edges: this work
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
                if G.edges[u, v]["consumes"] and v not in must_redo:
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


# ---------------------------------------------------------------------------
# Why a task is in the list it is in
# ---------------------------------------------------------------------------
#
# `stale_tasks` above answers *which* tasks are affected and is unchanged.
# What follows answers *why*, which is what turns an alert into something a
# person can act on: "T06 must be redone because T02 consumed R1, T04 consumes
# T02's output, and T06 consumes T04's" is a sentence somebody can argue with.
# A bare membership list is not.
#
# Everything here is graph reachability. It says nothing about whether the new
# wording of the requirement actually invalidates the work - that is a human
# judgement and no function in this module makes it.

#: `reasons[key]["via"]` values.
VIA_SEED = "seed"
VIA_CONSUMING = "consuming"
VIA_DOWNSTREAM = "downstream"


def consuming_reasons(G: nx.DiGraph, seeds: set[str]) -> dict:
    """For every task reachable from `seeds` along **consuming** edges, the
    shortest consuming path that put it there.

    Breadth-first, so the path returned is the shortest chain of "this work
    consumed that work's output" from a task that consumed the requirement
    directly. Seeds themselves get a one-element path and `via=seed`.
    """
    reasons: dict[str, dict] = {}
    frontier: list[str] = []
    for key in sorted(seeds):
        if key not in G:
            continue
        reasons[key] = {
            "via": VIA_SEED,
            "path": (key,),
            "hops": 0,
            "consumed_from": None,
        }
        frontier.append(key)

    while frontier:
        nxt: list[str] = []
        for u in frontier:
            for v in sorted(G.successors(u)):
                if not G.edges[u, v]["consumes"] or v in reasons:
                    continue
                reasons[v] = {
                    "via": VIA_CONSUMING,
                    "path": reasons[u]["path"] + (v,),
                    "hops": reasons[u]["hops"] + 1,
                    "consumed_from": u,
                }
                nxt.append(v)
        frontier = nxt
    return reasons


def downstream_reasons(G: nx.DiGraph, must_redo: set[str]) -> dict:
    """For every task merely downstream of `must_redo`, the shortest path from
    the nearest invalidated task, and the edge kind of its final hop.

    A task lands here because it comes *after* work that has to be redone, not
    because it consumed anything now wrong. The final hop is reported so a
    reader can see whether the link is an ordering constraint or a consuming
    edge whose source is itself only downstream.
    """
    reasons: dict[str, dict] = {}
    frontier = sorted(k for k in must_redo if k in G)
    seen = set(frontier)
    depth = {k: (k,) for k in frontier}

    while frontier:
        nxt: list[str] = []
        for u in frontier:
            for v in sorted(G.successors(u)):
                if v in seen:
                    continue
                seen.add(v)
                depth[v] = depth[u] + (v,)
                nxt.append(v)
                if v in must_redo:
                    continue
                reasons[v] = {
                    "via": VIA_DOWNSTREAM,
                    "path": depth[v],
                    "hops": len(depth[v]) - 1,
                    "follows": u,
                    "final_edge_consumes": bool(G.edges[u, v]["consumes"]),
                }
        frontier = nxt
    return reasons


def stale_report(G: nx.DiGraph, seeds: set[str]) -> dict:
    """`stale_tasks` plus, for every affected task, the path that put it in
    its list.

    Additive: `must_redo` and `must_recheck` are exactly what `stale_tasks`
    returns, computed by calling it, so the two can never drift.
    """
    # `stale_tasks` walks successors and therefore requires every seed to be a
    # real node. It keeps that contract untouched; this report is the newer,
    # more forgiving entry point, so it filters first and says what it dropped
    # rather than raising at a caller that named a task which no longer exists.
    known = {k for k in seeds if k in G}
    base = stale_tasks(G, known)
    redo_reasons = consuming_reasons(G, known)
    recheck_reasons = downstream_reasons(G, set(base["must_redo"]))
    return {
        "seeds": sorted(k for k in seeds),
        "seeds_not_in_graph": sorted(k for k in seeds if k not in G),
        "must_redo": base["must_redo"],
        "must_recheck": base["must_recheck"],
        "reasons": {
            **{k: v for k, v in redo_reasons.items() if k in set(base["must_redo"])},
            **{
                k: v for k, v in recheck_reasons.items()
                if k in set(base["must_recheck"])
            },
        },
    }
