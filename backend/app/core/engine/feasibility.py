"""
Feasibility - a verdict and a margin, never a percentage.

ARCHITECTURE D.6 is unambiguous about this: until the simulation that produces
a probability exists, do not display one. So P0 reports:

* a **verdict** (`feasible` / `infeasible` / `no_deadline_set` /
  `unschedulable`) and the **margin in days**
* a **deterministic three-point range** - the same schedule run three times, at
  optimistic, likely and pessimistic task durations

Three schedule runs are not a distribution and this module never calls them
one. The `monte_carlo` block below is the seam where a real P(deadline) would
land, and it is deliberately empty: it reports `available: false` and what it
would need, rather than a number nobody can defend.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from backend.app.core.workflow import EngineConfig, WorkflowSnapshot

#: Named here so the string appears once and can be asserted against.
NOT_A_PROBABILITY = (
    "A range from three deterministic schedule runs. It is not a "
    "distribution and implies no likelihood: the pessimistic figure is what "
    "happens if every task takes its pessimistic duration, not a worst case "
    "with a confidence level attached."
)


@dataclass(frozen=True, slots=True)
class ThreePoint:
    optimistic_day: float
    likely_day: float
    pessimistic_day: float
    spread_days: float
    deadline_day: float | None
    verdicts: dict[str, str]
    assumptions: dict[str, Any]

    def as_dict(self) -> dict:
        return {
            "optimistic_day": self.optimistic_day,
            "likely_day": self.likely_day,
            "pessimistic_day": self.pessimistic_day,
            "spread_days": self.spread_days,
            "deadline_day": self.deadline_day,
            "verdicts": self.verdicts,
            "assumptions": self.assumptions,
            "is_probability": False,
            "method": NOT_A_PROBABILITY,
            "monte_carlo": {
                "available": False,
                "why": (
                    "A real P(deadline) needs task durations sampled from "
                    "calibrated distributions over many runs. Calibration "
                    "needs actuals from completed projects, which this system "
                    "does not collect yet."
                ),
                "what_it_would_report": (
                    "P(deadline) and each task's criticality index - the "
                    "fraction of runs in which it lands on the critical path."
                ),
                "why_not_faked": (
                    "An invented percentage is worse than no percentage: it "
                    "looks like evidence and is not."
                ),
            },
        }


def _verdict(end: float, deadline: float | None) -> str:
    if deadline is None:
        return "no_deadline_set"
    return "feasible" if end <= deadline else "infeasible"


def three_point_range(
    snapshot: WorkflowSnapshot,
    graph,
    observed: dict[str, float],
    config: EngineConfig | None = None,
) -> ThreePoint:
    """Run the schedule three times and report the range.

    The `likely` run uses the observed durations - the same ones the headline
    projection uses - so the middle of the range is exactly the number shown
    everywhere else, rather than a fourth figure nobody can reconcile.
    """
    from backend.app.core.engine.cpm import schedule
    from backend.app.core.engine.effort import three_point_durations

    cfg = config or EngineConfig()
    per_task, assumptions = three_point_durations(snapshot, cfg)

    def run(which: str) -> float:
        durations = {}
        for key, observed_days in observed.items():
            band = per_task.get(key)
            if band is None:
                durations[key] = observed_days
                continue
            likely = band["likely"] or 1.0
            # Scale the *observed* duration by the band's shape, so a task
            # already running over keeps its overrun in all three runs.
            durations[key] = observed_days * (band[which] / likely)
        return schedule(graph, durations)["project_end"]

    optimistic = run("optimistic")
    likely = schedule(graph, observed)["project_end"]
    pessimistic = run("pessimistic")
    deadline = snapshot.deadline_day

    return ThreePoint(
        optimistic_day=optimistic,
        likely_day=likely,
        pessimistic_day=pessimistic,
        spread_days=pessimistic - optimistic,
        deadline_day=deadline,
        verdicts={
            "optimistic": _verdict(optimistic, deadline),
            "likely": _verdict(likely, deadline),
            "pessimistic": _verdict(pessimistic, deadline),
        },
        assumptions={
            "spread_source": assumptions["spread_source"],
            "default_relative_spread": assumptions["default_relative_spread"],
            "tasks_with_three_point_estimate":
                assumptions["tasks_with_three_point_estimate"],
            "tasks_using_spread_prior":
                assumptions["tasks_using_spread_prior"],
            "durations_sampled_independently": False,
            "resource_contention_modelled": False,
            "rework_modelled": False,
            "note": (
                "Each run applies the same optimism or pessimism to every "
                "task at once. Real delays correlate, so a run where "
                "everything goes wrong together is a legitimate bound but not "
                "an expected case."
            ),
        },
    )


def statement(verdict: str, end: float, deadline: float | None,
              margin: float | None, three_point: ThreePoint | None) -> str:
    """The sentence a user reads. Days and a verdict; no percentage."""
    if verdict == "unschedulable":
        return (
            "This workflow contains a circular dependency, so it has no "
            "finish date to compare against a deadline. Break the cycle first."
        )
    if deadline is None:
        base = f"Projected finish is day {end:.0f}. No deadline is set, so " \
               f"there is nothing to be feasible against."
    elif margin is not None and margin >= 0:
        base = (
            f"Projected finish day {end:.0f} against deadline day "
            f"{deadline:.0f} -- feasible with {margin:.0f} days to spare."
        )
    else:
        base = (
            f"Projected finish day {end:.0f} against deadline day "
            f"{deadline:.0f} -- infeasible by {abs(margin or 0):.0f} days "
            f"without a change."
        )
    if three_point is None:
        return base
    return (
        f"{base} Running the same schedule at optimistic and pessimistic task "
        f"durations gives day {three_point.optimistic_day:.0f} to day "
        f"{three_point.pessimistic_day:.0f}."
    )
