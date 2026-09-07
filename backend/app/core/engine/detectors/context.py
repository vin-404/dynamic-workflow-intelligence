"""
The single argument every detector receives.

A detector is a pure function `(ctx) -> Finding[]` where `ctx` bundles the
graph, the schedule, the snapshot, the observed state, the clock and the
config (ARCHITECTURE D.2). Bundling them is what lets the registry call every
detector uniformly, and the derived lookups are computed once here rather than
once per detector.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from functools import cached_property
from typing import Mapping

import networkx as nx

from backend.app.core.workflow import (
    Clock,
    EngineConfig,
    TaskStatus,
    WorkflowSnapshot,
    WorkflowState,
)


@dataclass
class DetectorContext:
    graph: nx.DiGraph
    schedule: dict
    snapshot: WorkflowSnapshot
    state: WorkflowState
    clock: Clock
    config: EngineConfig

    # -- derived, computed once ---------------------------------------------

    @cached_property
    def task_keys(self) -> tuple[str, ...]:
        return self.snapshot.task_keys

    @cached_property
    def last_event(self) -> Mapping[str, float]:
        """Day of the most recent recorded transition per task, 0.0 if none."""
        seen = self.state.last_event_day
        return {key: seen.get(key, 0.0) for key in self.graph.nodes}

    @cached_property
    def descendants(self) -> Mapping[str, tuple[str, ...]]:
        return {
            key: tuple(sorted(nx.descendants(self.graph, key)))
            for key in self.graph.nodes
        }

    @cached_property
    def ancestors(self) -> Mapping[str, tuple[str, ...]]:
        return {
            key: tuple(sorted(nx.ancestors(self.graph, key)))
            for key in self.graph.nodes
        }

    @cached_property
    def resource_label(self) -> Mapping[str, str]:
        """resource key -> its name, with its roll-up parent when it has one.

        Every word in these labels comes from the user's own data. The engine
        never supplies domain vocabulary of its own.
        """
        by_key = self.snapshot.resource_by_key
        out: dict[str, str] = {}
        for r in self.snapshot.resources:
            parent = by_key.get(r.parent_key) if r.parent_key else None
            out[r.key] = f"{r.name}, {parent.name}" if parent else r.name
        return out

    @cached_property
    def assignees(self) -> Mapping[str, tuple[str, ...]]:
        return self.snapshot.assignees_by_task

    # -- helpers -------------------------------------------------------------

    def duration(self, key: str) -> float:
        return self.schedule["durations"].get(key, 0.0)

    def slack(self, key: str) -> float:
        return self.schedule["slack"].get(key, 0.0)

    def is_critical(self, key: str) -> bool:
        return abs(self.slack(key)) < 1e-9

    def is_done(self, key: str) -> bool:
        return self.state.is_done(key)

    def status(self, key: str) -> TaskStatus:
        return self.state.status_of(key)

    def is_ready(self, key: str) -> bool:
        """Every predecessor finished, so nothing structural is in the way."""
        return all(self.is_done(p) for p in self.graph.predecessors(key))

    def ready_since(self, key: str) -> float:
        """The day this task became workable = when its last predecessor closed.

        Using the task's own last event is wrong: a task nobody ever touched
        has no events, and "idle since day 0" would over-report.
        """
        preds = list(self.graph.predecessors(key))
        if not preds:
            return 0.0
        return max(self.last_event.get(p, 0.0) for p in preds)

    def who(self, key: str) -> str:
        """A human label for whoever is on a task, or "nobody"."""
        labels = [
            self.resource_label.get(r, r) for r in self.assignees.get(key, ())
        ]
        return "; ".join(labels) if labels else "nobody"

    def name(self, key: str) -> str:
        spec = self.snapshot.task_by_key.get(key)
        return spec.name if spec else key

    def resource_members(self, resource_key: str) -> set[str]:
        """A resource plus every descendant resource, so a team's load can be
        measured over its members' work."""
        return set(
            self.snapshot.resource_members.get(resource_key, (resource_key,))
        )
