"""
Changing requirements, as a first-class capability.

The problem statement asks for a platform that detects *changing requirements*.
Every other tool on the market answers that by flagging a link between a
requirement and a ticket and asking a human to go and look. This module answers
the question the human was going to ask anyway: **what does this re-wording
cost, who loses work they have already finished, does the deadline survive, and
what is the replan.**

Four things keep it honest, and they are the whole design:

1. **`must_redo` versus `must_recheck`.** `core.engine.staleness` separates work
   that consumed an artifact which is now wrong from work that merely comes
   after it. That separation is the difference between a useful alert and
   "your whole project is red", and this module surfaces the *path* that put
   each task in its list, not just the membership.

2. **The report applies nothing.** It computes over the immutable snapshot and
   returns a real, unapplied `Scenario`. `test_requirements.py` asserts the
   base version's content hash is identical before and after and that no
   `WorkflowVersion` was written.

3. **The replan is expressed in the closed mutation algebra.** No eighteenth
   mutation kind was added. A requirement change is
   `REQUIREMENT_VERSION_BUMP`, which the algebra already defines as "bump the
   wording and reset the completed work this invalidates" - plus, when the
   author scopes the change, `TASK_STATUS_SET` mutations that put back the
   statuses their judgement spares. The scenario goes through
   `services.scenarios`, so `evaluate`, `diff` and `apply` all work on it with
   no special path (ARCHITECTURE E).

4. **The one thing it cannot do, it says it cannot do.** The graph knows what
   *consumed* the requirement. It does not know whether the new wording
   changes what was consumed. Every report is explicitly the blast radius of a
   change *assuming the meaning moved materially*, and no language model is
   asked to decide otherwise. Every number below comes from graph reachability,
   task effort, and the same deterministic scheduler used everywhere else.
"""
from __future__ import annotations

import difflib
import uuid
from typing import Any, Iterable, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.engine.graph import build_graph_from_snapshot
from backend.app.core.engine.staleness import stale_report, stale_tasks
from backend.app.core.mutations import MutationKind
from backend.app.core.workflow import (
    TaskStatus,
    WorkflowSnapshot,
    WorkflowState,
)
from backend.app.models import RequirementRevision, User, WorkflowVersion
from backend.app.services import scenarios as SC
from backend.app.services import versions as V
from backend.app.services.versions import NotFound

__all__ = [
    "NotFound",
    "OptionError",
    "ChangeOption",
    "list_requirements",
    "impact",
    "compare",
    "apply_change",
    "history",
    "diff_versions",
]


class OptionError(Exception):
    """A proposed change is not expressible against this requirement.

    Routers map this to 422. Like every other refusal in this codebase the
    reason is the feature: "T99 never consumed R2, so no re-wording of R2 can
    invalidate it" is a sentence somebody can act on.
    """


# ---------------------------------------------------------------------------
# The assumptions block. Stated once, attached to everything this module emits.
# ---------------------------------------------------------------------------


def _assumptions(
    *,
    scoped: bool,
    text_changed: bool,
    seeds: Sequence[str],
    scoped_out: Sequence[str],
) -> dict:
    """What this report rests on, and what it could not assess.

    Same shape and the same spirit as `feasibility.three_point`'s assumptions
    and `evaluate`'s `unavailable_checks`: the caveats travel with the numbers
    rather than living in a document nobody opens.
    """
    unavailable = [
        {
            "check": "does_the_new_wording_actually_invalidate_this_work",
            "why": (
                "Deciding whether a re-worded requirement changes what a task "
                "relied on is a reading of two sentences, not a property of "
                "the graph. Nothing here reads the texts, and no language "
                "model was asked to - the LLM has no authority over any "
                "number in this report."
            ),
            "would_unlock_it": (
                "A per-task record of which clause of the requirement each "
                "task consumed, or a human marking the affected tasks - which "
                "is what the `invalidates` scoping on an option is for."
            ),
        },
        {
            "check": "how_much_of_an_unfinished_task_survives",
            "why": (
                "Work in progress is in the blast radius, but how much of a "
                "half-done task a re-wording destroys is not something the "
                "graph knows. It is therefore reported separately and never "
                "counted as wasted."
            ),
            "would_unlock_it": (
                "Percent-complete on in-flight tasks, which this system does "
                "not collect."
            ),
        },
        {
            "check": "what_a_recheck_costs",
            "why": (
                "`must_recheck` tasks are listed but not costed. A recheck may "
                "cost nothing at all or may cost the whole task, and guessing "
                "which would put an invented number next to real ones."
            ),
            "would_unlock_it": (
                "An explicit recheck-effort estimate per task, or observed "
                "rework actuals from past requirement changes."
            ),
        },
        {
            "check": "when_the_redone_work_gets_re-scheduled",
            "why": (
                "The critical-path scheduler derives every task's duration "
                "from its authored effort regardless of status, so work that "
                "is already finished still occupies its full span in the "
                "projection. Re-opening it therefore does not lengthen the "
                "critical path, and `schedule_impact.delta_days` can be zero "
                "while real days of effort have to be spent again. The lost "
                "effort is real and is reported under `wasted_effort`; what "
                "this model cannot tell you is when the redone work lands in "
                "the calendar."
            ),
            "would_unlock_it": (
                "A scheduler that compresses completed work out of the "
                "remaining plan and re-inserts re-opened work at today's "
                "date. That would change what `analyze` means for every "
                "other capability in the system, so it was not done quietly "
                "inside a requirement report."
            ),
        },
        {
            "check": "whether_this_change_forces_other_requirements_to_change",
            "why": (
                "The model links requirements to tasks, not to each other, so "
                "a knock-on change to a second requirement is invisible here."
            ),
            "would_unlock_it": (
                "Requirement-to-requirement links, which the data model does "
                "not have and which this phase did not add."
            ),
        },
    ]

    block: dict[str, Any] = {
        "material_change_is_a_human_judgement": (
            "This is the blast radius of a change *assuming* the "
            "requirement's meaning moved materially. It is computed from the "
            "dependency graph, which records what consumed the requirement - "
            "not from the two texts, which it does not read. Whether the new "
            "wording actually invalidates the work below is your call, and "
            "nothing in this system makes it for you."
        ),
        "must_redo_vs_must_recheck": (
            "`must_redo` is reachable from the consuming tasks along edges "
            "marked `consumes`: that work consumed an artifact which is now "
            "wrong. `must_recheck` is merely downstream in time. The "
            "separation is only as good as the `consumes` flags on the "
            "dependencies - an edge nobody marked as consuming lands its task "
            "in `must_recheck` instead."
        ),
        "redo_costs_what_doing_cost": (
            "Cost of redoing assumes redoing a task costs the same effort as "
            "doing it did. Rework is often cheaper because the ground is "
            "familiar and sometimes dearer because something has to be "
            "unpicked first. No rework actuals are recorded anywhere in this "
            "system, so parity is assumed and said out loud."
        ),
        "wasted_days_counts_completed_work_only": (
            "`wasted_days` counts effort on tasks whose status is done. Work "
            "in progress is inside the blast radius and is reported as "
            "`in_flight_days`, but it is never counted as wasted."
        ),
        "not_started_work_is_not_new_cost": (
            "Blast-radius effort on tasks that had not started was always in "
            "the plan. It is reported so the reach of the change is visible, "
            "and excluded from `additional_effort_days`, which counts only "
            "the effort this change adds."
        ),
        "schedule_impact_is_deterministic": (
            "The new finish date is one run of the same critical-path "
            "scheduler used everywhere else, over the replanned workflow, at "
            "the same clock and the same effort model. It is a projection, "
            "not a probability, and carries no confidence level."
        ),
        "no_language_model_is_involved": (
            "Every number here comes from deterministic code: graph "
            "reachability over the `consumes` edges, task effort as authored, "
            "and two runs of the scheduler."
        ),
        "nothing_was_applied": (
            "This report changed nothing. The replan is a stored but "
            "unapplied Scenario; the base version's content hash is returned "
            "before and after so you can check that rather than trust it."
        ),
        "seeds_used": list(seeds),
        "scoped_by_a_human": scoped,
        "text_actually_changed": text_changed,
        "unavailable": unavailable,
    }

    if scoped:
        block["scoping_is_your_judgement_not_ours"] = (
            "You told us this wording spares "
            f"{len(scoped_out)} task(s) that consumed the old one, so they "
            "are excluded from the blast radius and their statuses are "
            "restored by the replan. That exclusion is your assertion about "
            "meaning; the graph would have included them."
        )
        block["restored_statuses_do_not_restore_actuals"] = (
            "Putting a spared task's status back does not restore the "
            "observed duration the bump dropped, so a later analysis of the "
            "applied version will treat that task as having no recorded "
            "actual."
        )
    if not text_changed:
        block["wording_is_unchanged"] = (
            "The proposed wording is identical to the current one. The report "
            "below is what the change *would* cost if the meaning had moved; "
            "as written it costs nothing, because nothing changed."
        )
    return block


# ---------------------------------------------------------------------------
# Small deterministic helpers
# ---------------------------------------------------------------------------


def _d(value: float | None) -> float | None:
    """Round away float noise so two identical costs compare equal."""
    return None if value is None else round(float(value), 6)


def _words(text: str) -> list[str]:
    return text.split()


def text_diff(before: str, after: str) -> dict:
    """A word-level diff of two wordings.

    Presentation only - nothing downstream reads it, and in particular no
    number in the impact report is derived from how much of the text changed.
    Size of a text edit is not evidence about meaning.
    """
    a, b = _words(before), _words(after)
    matcher = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    removed: list[str] = []
    added: list[str] = []
    segments: list[dict] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            segments.append({"op": "equal", "text": " ".join(a[i1:i2])})
            continue
        if tag in ("replace", "delete"):
            removed.extend(a[i1:i2])
            segments.append({"op": "removed", "text": " ".join(a[i1:i2])})
        if tag in ("replace", "insert"):
            added.extend(b[j1:j2])
            segments.append({"op": "added", "text": " ".join(b[j1:j2])})
    return {
        "identical": before == after,
        "before": before,
        "after": after,
        "removed_words": removed,
        "added_words": added,
        "segments": segments,
        "similarity": round(matcher.ratio(), 6),
        "note": (
            "A word-level diff, for reading. No cost in this report is "
            "derived from it: how much of a sentence changed says nothing "
            "reliable about how much of the meaning did."
        ),
    }


def _resource_labels(snapshot: WorkflowSnapshot) -> dict[str, str]:
    by_key = snapshot.resource_by_key
    out: dict[str, str] = {}
    for r in snapshot.resources:
        parent = by_key.get(r.parent_key) if r.parent_key else None
        out[r.key] = f"{r.name} ({parent.name})" if parent else r.name
    return out


def _reason_sentence(key: str, reason: dict) -> str:
    """Why this task is in the list it is in, as one readable line."""
    via = reason.get("via")
    if via == "seed":
        return f"{key} consumed this requirement directly."
    path = " -> ".join(reason.get("path", (key,)))
    if via == "consuming":
        source = reason.get("consumed_from")
        return (
            f"{key} consumed output from {source}, along the consuming chain "
            f"{path}."
        )
    edge = (
        "a consuming edge from work that is itself only downstream"
        if reason.get("final_edge_consumes")
        else "an ordering dependency"
    )
    return (
        f"{key} is scheduled after {reason.get('follows')} via {edge} "
        f"({path}); nothing it consumed is known to be wrong."
    )


# ---------------------------------------------------------------------------
# Options - one proposed wording, optionally scoped by a human
# ---------------------------------------------------------------------------


class ChangeOption:
    """One candidate wording.

    `invalidates` is the human judgement the graph cannot make: "this wording
    only affects the signage tasks, not the venue ones". It must be a subset of
    the tasks that actually consumed the requirement, because no re-wording can
    invalidate work that never consumed it. Left as `None`, the whole
    consumption set is used and the report says so.
    """

    __slots__ = ("text", "invalidates", "label")

    def __init__(
        self,
        text: str,
        invalidates: Iterable[str] | None = None,
        label: str = "",
    ) -> None:
        self.text = text
        self.invalidates = None if invalidates is None else tuple(invalidates)
        self.label = label

    @classmethod
    def parse(cls, raw: Any, index: int) -> "ChangeOption":
        if isinstance(raw, str):
            return cls(text=raw, label=f"Option {index + 1}")
        if isinstance(raw, ChangeOption):
            return cls(
                raw.text, raw.invalidates, raw.label or f"Option {index + 1}"
            )
        if isinstance(raw, dict):
            if "text" not in raw:
                raise OptionError(
                    f"Option {index + 1} has no `text`. An option is either a "
                    f"string, or an object with `text` and optionally "
                    f"`invalidates` and `label`."
                )
            return cls(
                text=str(raw["text"]),
                invalidates=raw.get("invalidates"),
                label=str(raw.get("label") or f"Option {index + 1}"),
            )
        raise OptionError(
            f"Option {index + 1} is a {type(raw).__name__}; options are "
            f"strings or objects with a `text` field."
        )

    def resolve_seeds(self, consumed_by: Sequence[str], key: str) -> tuple[str, ...]:
        if self.invalidates is None:
            return tuple(sorted(consumed_by))
        unknown = sorted(set(self.invalidates) - set(consumed_by))
        if unknown:
            raise OptionError(
                f"{', '.join(unknown)} never consumed {key}, so no re-wording "
                f"of it can invalidate them. `invalidates` must be a subset "
                f"of {', '.join(sorted(consumed_by)) or '(nothing)'}."
            )
        return tuple(sorted(set(self.invalidates)))


# ---------------------------------------------------------------------------
# The replan, in the closed algebra
# ---------------------------------------------------------------------------


def _replan_mutations(
    snapshot: WorkflowSnapshot,
    state: WorkflowState,
    requirement_key: str,
    new_text: str,
    to_version: int,
    seeds: Sequence[str],
    consumed_by: Sequence[str],
) -> tuple[list[dict], list[str]]:
    """The implied change, expressed in the seventeen kinds and nothing else.

    `REQUIREMENT_VERSION_BUMP` already carries the whole semantics: it bumps
    the wording *and* resets the completed work the change invalidates, so the
    effort re-enters the schedule. That is the mutation, and there is exactly
    one of it.

    When a human has scoped the change - "this wording spares T16" - the bump
    would still reset T16, because the applier derives its own seeds from the
    requirement's full consumption set and cannot be told otherwise without
    adding an eighteenth kind. So the scoping is expressed as what it is: the
    bump, followed by `TASK_STATUS_SET` putting the spared tasks back. The
    scenario then reads exactly as the decision was made, which is better than
    a mutation with a hidden argument.
    """
    G = build_graph_from_snapshot(snapshot)
    full_redo = set(stale_tasks(G, set(consumed_by))["must_redo"])
    scoped_redo = set(stale_tasks(G, set(seeds))["must_redo"])

    mutations: list[dict] = [{
        "kind": MutationKind.REQUIREMENT_VERSION_BUMP.value,
        "payload": {
            "requirement_key": requirement_key,
            "text": new_text,
            "version_no": to_version,
        },
    }]

    spared = sorted(
        k for k in (full_redo - scoped_redo) if state.is_done(k)
    )
    for key in spared:
        mutations.append({
            "kind": MutationKind.TASK_STATUS_SET.value,
            "payload": {"key": key, "status": state.status_of(key).value},
        })
    return mutations, spared


# ---------------------------------------------------------------------------
# Listing
# ---------------------------------------------------------------------------


async def _revision_summary(
    db: AsyncSession, project_id: uuid.UUID
) -> dict[str, dict]:
    rows = (
        await db.execute(
            select(RequirementRevision)
            .where(RequirementRevision.project_id == project_id)
            .order_by(RequirementRevision.version_no)
        )
    ).scalars().all()
    out: dict[str, dict] = {}
    for row in rows:
        bucket = out.setdefault(row.requirement_key, {
            "recorded_revisions": 0,
            "first_recorded_version": row.version_no,
            "latest_recorded_version": row.version_no,
            "last_changed_at": None,
            "last_changed_by": "",
        })
        bucket["recorded_revisions"] += 1
        bucket["latest_recorded_version"] = max(
            bucket["latest_recorded_version"], row.version_no
        )
        if not row.backfilled:
            bucket["last_changed_at"] = row.created_at.isoformat()
            bucket["last_changed_by"] = row.changed_by or "unattributed"
    return out


async def list_requirements(
    db: AsyncSession, project_id: uuid.UUID, version_id: uuid.UUID | None = None
) -> dict:
    """Every requirement, with what it currently costs to change and what its
    history looks like.

    The per-requirement numbers here are reachability and effort sums only -
    no scheduler runs - so listing twenty requirements is as cheap as listing
    one. Ask `.../change` for the schedule impact.
    """
    project, version, snapshot, state, _ = await V.load_context(
        db, project_id, version_id
    )
    G = build_graph_from_snapshot(snapshot)
    summaries = await _revision_summary(db, project.id)
    task_by_key = snapshot.task_by_key
    labels = _resource_labels(snapshot)
    assignees = snapshot.assignees_by_task

    rows = []
    for req in snapshot.requirements:
        stale = stale_tasks(G, set(req.consumed_by))
        redo = stale["must_redo"]
        done = [k for k in redo if state.is_done(k)]
        history_summary = summaries.get(req.key)
        rows.append({
            "key": req.key,
            "version_no": req.version_no,
            "text": req.text,
            "consumed_by": list(req.consumed_by),
            "consumed_by_count": len(req.consumed_by),
            "must_redo_count": len(redo),
            "must_recheck_count": len(stale["must_recheck"]),
            "completed_tasks_at_risk": done,
            "completed_days_at_risk": _d(
                sum(task_by_key[k].effort for k in done)
            ),
            "blast_radius_effort_days": _d(
                sum(task_by_key[k].effort for k in redo)
            ),
            "owners_affected": sorted({
                labels.get(r, r) for k in redo for r in assignees.get(k, ())
            }),
            "history": history_summary or {
                "recorded_revisions": 0,
                "first_recorded_version": None,
                "latest_recorded_version": None,
                "last_changed_at": None,
                "last_changed_by": "",
            },
            "history_note": (
                "No revision has been recorded through this system yet, so "
                "the current wording is all there is. It is not evidence that "
                "the requirement never changed."
                if not history_summary else ""
            ),
        })

    return {
        "project_id": str(project.id),
        "project_name": project.name,
        "version_id": str(version.id),
        "version_no": version.version_no,
        "content_hash": version.content_hash,
        "requirements": rows,
        "count": len(rows),
        "note": (
            "`completed_days_at_risk` is effort already finished that a "
            "change to this requirement would invalidate, assuming the "
            "change is material. Nothing here reads the requirement text."
        ),
    }


# ---------------------------------------------------------------------------
# The impact report
# ---------------------------------------------------------------------------


def _wasted_effort(
    snapshot: WorkflowSnapshot,
    state: WorkflowState,
    must_redo: Sequence[str],
) -> dict:
    """Days of completed work invalidated, and what redoing it costs.

    These are two different numbers and the row shows the arithmetic rather
    than the total asserting it: work that is finished and now void costs its
    effort **twice** - once already spent and lost, once to spend again.
    """
    task_by_key = snapshot.task_by_key
    rows = []
    wasted = 0.0
    in_flight = 0.0
    not_started = 0.0

    for key in must_redo:
        task = task_by_key[key]
        status = state.status_of(key)
        effort = float(task.effort)
        done = state.is_done(key)
        if done:
            wasted += effort
            arithmetic = (
                f"{key} is done: {effort:g}d already spent is now void, and "
                f"{effort:g}d must be spent again = {effort * 2:g}d of effort "
                f"for no progress."
            )
        elif status == TaskStatus.NOT_STARTED:
            not_started += effort
            arithmetic = (
                f"{key} had not started: its {effort:g}d was always in the "
                f"plan, so it is inside the blast radius but adds no new cost."
            )
        else:
            in_flight += effort
            arithmetic = (
                f"{key} is {status.value}: {effort:g}d of planned effort is "
                f"affected, but how much of it survives the change is not "
                f"something this system can tell you, so none of it is "
                f"counted as wasted."
            )
        rows.append({
            "key": key,
            "name": task.name,
            "status": status.value,
            "counts_as_wasted": done,
            "effort_days": _d(effort),
            "wasted_days": _d(effort if done else 0.0),
            "redo_days": _d(effort if done else 0.0),
            "arithmetic": arithmetic,
        })

    blast = wasted + in_flight + not_started
    return {
        "rows": rows,
        "completed_task_count": sum(1 for r in rows if r["counts_as_wasted"]),
        #: Effort already spent on finished work that this change invalidates.
        "wasted_days": _d(wasted),
        #: What it costs to do that finished work over again. Equal to
        #: `wasted_days` under the stated parity assumption - and reported as
        #: its own figure precisely so the assumption is visible rather than
        #: folded into a single total.
        "redo_cost_days": _d(wasted),
        #: The only genuinely new effort this change puts into the plan.
        "additional_effort_days": _d(wasted),
        #: In the blast radius, not counted as wasted.
        "in_flight_days": _d(in_flight),
        "not_yet_started_days": _d(not_started),
        "blast_radius_effort_days": _d(blast),
        "arithmetic": (
            f"{wasted:g}d of completed work invalidated + {wasted:g}d to redo "
            f"it = {wasted * 2:g}d of effort spent to stand still. A further "
            f"{in_flight:g}d is in flight and {not_started:g}d had not "
            f"started, giving a blast radius of {blast:g}d of planned effort."
        ),
    }


def _schedule_impact(project, comparison: dict, payload: dict) -> dict:
    completion = comparison["projected_completion"]
    feas = comparison["feasibility"]
    before, after = feas["before"], feas["after"]
    deadline_day = after["deadline_day"]
    margin_before = before["margin_days"]
    margin_after = after["margin_days"]
    deadline_date = (
        project.deadline.isoformat() if project.deadline else None
    )
    survives = None if deadline_day is None else bool(margin_after >= 0)

    if deadline_day is None:
        sentence = (
            f"Projected finish moves from "
            f"{payload['projected_end_date_before']} to "
            f"{payload['projected_end_date_after']} "
            f"({completion['delta_days']:+g} days). No deadline is set, so "
            f"there is nothing for it to survive."
        )
    elif margin_after >= 0:
        sentence = (
            f"Projected finish moves from "
            f"{payload['projected_end_date_before']} to "
            f"{payload['projected_end_date_after']} "
            f"({completion['delta_days']:+g} days). The {deadline_date} "
            f"deadline still holds, with {margin_after:g} days to spare."
        )
    elif margin_before >= 0:
        sentence = (
            f"Projected finish moves from "
            f"{payload['projected_end_date_before']} to "
            f"{payload['projected_end_date_after']} "
            f"({completion['delta_days']:+g} days). The {deadline_date} "
            f"deadline held before this change and does not after it: it is "
            f"missed by {abs(margin_after):g} days."
        )
    else:
        sentence = (
            f"Projected finish moves from "
            f"{payload['projected_end_date_before']} to "
            f"{payload['projected_end_date_after']} "
            f"({completion['delta_days']:+g} days). The {deadline_date} "
            f"deadline was already missed by {abs(margin_before):g} days and "
            f"is now missed by {abs(margin_after):g}."
        )

    return {
        "projected_end_day_before": _d(completion["before_day"]),
        "projected_end_day_after": _d(completion["after_day"]),
        "delta_days": _d(completion["delta_days"]),
        "direction": completion["direction"],
        "projected_end_date_before": payload["projected_end_date_before"],
        "projected_end_date_after": payload["projected_end_date_after"],
        "deadline_day": deadline_day,
        "deadline_date": deadline_date,
        "deadline_survives": survives,
        "margin_days_before": _d(margin_before),
        "margin_days_after": _d(margin_after),
        "verdict_before": before["verdict"],
        "verdict_after": after["verdict"],
        "verdict_changed": feas["verdict_changed"],
        "critical_path_changed": comparison["critical_path"]["changed"],
        "newly_critical": comparison["critical_path"]["newly_critical"],
        "tasks_moved_count": comparison["tasks_moved_count"],
        "statement": sentence,
        "is_probability": False,
    }


def _who_needs_to_know(
    snapshot: WorkflowSnapshot,
    state: WorkflowState,
    must_redo: Sequence[str],
    must_recheck: Sequence[str],
) -> dict:
    """Owners of affected work, grouped by resource, with what each loses."""
    labels = _resource_labels(snapshot)
    assignees = snapshot.assignees_by_task
    task_by_key = snapshot.task_by_key
    by_key = snapshot.resource_by_key

    groups: dict[str, dict] = {}

    def bucket(resource_key: str) -> dict:
        resource = by_key.get(resource_key)
        return groups.setdefault(resource_key, {
            "resource_key": resource_key,
            "resource_name": resource.name if resource else resource_key,
            "label": labels.get(resource_key, resource_key),
            "kind": resource.kind if resource else "unknown",
            "must_redo": [],
            "must_recheck": [],
            "completed_work_lost_days": 0.0,
            "redo_days": 0.0,
            "blast_radius_effort_days": 0.0,
        })

    unassigned_redo: list[str] = []
    for key in must_redo:
        owners = assignees.get(key, ())
        task = task_by_key[key]
        status = state.status_of(key)
        done = state.is_done(key)
        row = {
            "key": key,
            "name": task.name,
            "status": status.value,
            "effort_days": _d(task.effort),
            "completed_and_lost": done,
        }
        if not owners:
            unassigned_redo.append(key)
            continue
        for resource_key in owners:
            g = bucket(resource_key)
            g["must_redo"].append(row)
            g["blast_radius_effort_days"] += float(task.effort)
            if done:
                g["completed_work_lost_days"] += float(task.effort)
                g["redo_days"] += float(task.effort)

    unassigned_recheck: list[str] = []
    for key in must_recheck:
        owners = assignees.get(key, ())
        task = task_by_key[key]
        row = {
            "key": key,
            "name": task.name,
            "status": state.status_of(key).value,
            "effort_days": _d(task.effort),
        }
        if not owners:
            unassigned_recheck.append(key)
            continue
        for resource_key in owners:
            bucket(resource_key)["must_recheck"].append(row)

    out = []
    for resource_key in sorted(groups):
        g = groups[resource_key]
        lost = g["completed_work_lost_days"]
        redo_n = len(g["must_redo"])
        recheck_n = len(g["must_recheck"])
        parts = []
        if lost:
            finished = ", ".join(
                r["key"] for r in g["must_redo"] if r["completed_and_lost"]
            )
            parts.append(
                f"loses {lost:g} day(s) of completed work ({finished}) and "
                f"has to do it again"
            )
        if redo_n:
            parts.append(
                f"has {redo_n} task(s) to redo, "
                f"{g['blast_radius_effort_days']:g} day(s) of effort"
            )
        if recheck_n:
            parts.append(f"has {recheck_n} task(s) to recheck")
        g["completed_work_lost_days"] = _d(lost)
        g["redo_days"] = _d(g["redo_days"])
        g["blast_radius_effort_days"] = _d(g["blast_radius_effort_days"])
        g["what_they_lose"] = (
            f"{g['label']} " + "; ".join(parts) + "."
            if parts else f"{g['label']} is unaffected."
        )
        out.append(g)

    return {
        "by_resource": out,
        "resource_count": len(out),
        "unassigned": {
            "must_redo": unassigned_redo,
            "must_recheck": unassigned_recheck,
            "note": (
                "These tasks are in the blast radius and have nobody assigned, "
                "so there is nobody to tell. That is a gap in the plan, not a "
                "gap in the report."
                if unassigned_redo or unassigned_recheck else ""
            ),
        },
    }


def _headline(
    requirement_key: str,
    stale: dict,
    wasted: dict,
    who: dict,
    schedule: dict,
) -> str:
    redo = len(stale["must_redo"])
    recheck = len(stale["must_recheck"])
    owners = who["resource_count"]
    return (
        f"Assuming the new wording of {requirement_key} changes what it "
        f"means: {redo} task(s) invalid across {owners} owner(s), "
        f"{recheck} more to recheck. "
        f"{wasted['wasted_days']:g} day(s) of completed work lost, "
        f"{wasted['redo_cost_days']:g} day(s) to redo it. "
        f"{schedule['statement']}"
        + (f" {schedule['caveat']}" if schedule.get("caveat") else "")
    )


async def impact(
    db: AsyncSession,
    project_id: uuid.UUID,
    requirement_key: str,
    new_text: str,
    *,
    version_id: uuid.UUID | None = None,
    option: ChangeOption | None = None,
    scenario_name: str = "",
    keep_scenario: bool = True,
) -> dict:
    """What a re-wording would cost. Applies nothing.

    Returns the full report plus a real, unapplied `Scenario` the caller can
    inspect, diff, edit or apply through the endpoints that already exist.
    """
    project, version, snapshot, state, _ = await V.load_context(
        db, project_id, version_id
    )
    req = snapshot.requirement_by_key.get(requirement_key)
    if req is None:
        raise NotFound(f"Requirement {requirement_key} not found")

    opt = option or ChangeOption(new_text)
    seeds = opt.resolve_seeds(req.consumed_by, req.key)
    scoped = opt.invalidates is not None
    text_changed = (opt.text or req.text) != req.text
    proposed_text = opt.text or req.text

    G = build_graph_from_snapshot(snapshot)
    stale = stale_report(G, set(seeds))
    task_by_key = snapshot.task_by_key
    labels = _resource_labels(snapshot)
    assignees = snapshot.assignees_by_task

    hash_before = version.content_hash

    mutations, spared = _replan_mutations(
        snapshot,
        state,
        req.key,
        proposed_text,
        req.version_no + 1,
        seeds,
        req.consumed_by,
    )

    rationale = (
        f"Replan implied by re-wording {req.key} from v{req.version_no} to "
        f"v{req.version_no + 1}. Generated by deterministic code, not by a "
        f"language model. It assumes the new wording changes the "
        f"requirement's meaning materially - that judgement is the user's, "
        f"and this scenario is unapplied until they make it."
    )
    row = await SC.create(
        db,
        project.id,
        name=scenario_name or f"Requirement change: {req.key} -> v{req.version_no + 1}",
        base_version_id=version.id,
        origin="user_whatif",
        rationale=rationale,
        mutations=mutations,
    )
    sim = await SC.evaluate_scenario(db, row.id)
    if not keep_scenario:
        await SC.delete(db, row.id)

    comparison = sim.get("comparison") or {}
    validation = sim["validation"]

    def rows(keys: Sequence[str], include_wasted: bool) -> list[dict]:
        out = []
        for key in keys:
            task = task_by_key[key]
            reason = stale["reasons"].get(key, {})
            entry = {
                "key": key,
                "name": task.name,
                "status": state.status_of(key).value,
                "effort_days": _d(task.effort),
                "owners": [
                    {"key": r, "label": labels.get(r, r)}
                    for r in assignees.get(key, ())
                ],
                "reason": {
                    "via": reason.get("via"),
                    "path": list(reason.get("path", (key,))),
                    "hops": reason.get("hops", 0),
                    "consumed_from": reason.get("consumed_from"),
                    "follows": reason.get("follows"),
                    "final_edge_consumes": reason.get("final_edge_consumes"),
                    "sentence": _reason_sentence(key, reason),
                },
            }
            if include_wasted:
                done = state.is_done(key)
                entry["completed_and_lost"] = done
                entry["wasted_days"] = _d(task.effort if done else 0.0)
                entry["redo_days"] = _d(task.effort if done else 0.0)
            out.append(entry)
        return out

    wasted = _wasted_effort(snapshot, state, stale["must_redo"])
    who = _who_needs_to_know(
        snapshot, state, stale["must_redo"], stale["must_recheck"]
    )
    schedule = _schedule_impact(project, comparison, sim) if comparison else {
        "statement": "The replan did not validate, so there is no schedule to compare.",
        "delta_days": None,
        "deadline_survives": None,
        "is_probability": False,
    }

    # The scheduler does not shorten completed work, so re-opening it need not
    # move a single date even when days of effort are genuinely lost. Saying
    # that on the block itself is better than letting a zero read as "free".
    additional = wasted["additional_effort_days"] or 0.0
    delta = schedule.get("delta_days")
    schedule["rework_shows_as_calendar_slip"] = bool(delta)
    schedule["caveat"] = (
        f"{additional:g} day(s) of effort have to be spent again, and the "
        f"projected finish does not move. That is not the change being free: "
        f"this scheduler gives every task its full authored duration whatever "
        f"its status, so the plan already contained those days and re-opening "
        f"the work does not lengthen the critical path. Read the cost under "
        f"`wasted_effort`, not here."
        if additional and not delta else
        ""
    )

    findings = comparison.get("findings", {})
    scenario_id = sim["scenario"]["id"]

    # Re-read the base version to prove the report wrote nothing to it.
    base_after = await V.get_version(db, version.id)

    nothing_happened = not stale["must_redo"] and not stale["must_recheck"]

    report = {
        "project_id": str(project.id),
        "project_name": project.name,
        "version_id": str(version.id),
        "version_no": version.version_no,
        "engine_version": sim["base"]["engine_version"],
        "input_hash": sim["base"]["input_hash"],

        "requirement_key": req.key,
        "current_text": req.text,
        "proposed_text": proposed_text,
        "from_version": req.version_no,
        "to_version": req.version_no + 1,
        "text_changed": text_changed,
        "text_diff": text_diff(req.text, proposed_text),

        "directly_consumed_by": list(req.consumed_by),
        "seeds_used": list(seeds),
        "scoped": scoped,
        "scoped_out": sorted(set(req.consumed_by) - set(seeds)),
        "statuses_restored_by_scoping": spared,

        "blast_radius": {
            "must_redo_count": len(stale["must_redo"]),
            "must_recheck_count": len(stale["must_recheck"]),
            "tasks_in_project": len(snapshot.tasks),
            "share_of_project": _d(
                (len(stale["must_redo"]) + len(stale["must_recheck"]))
                / len(snapshot.tasks)
            ) if snapshot.tasks else 0.0,
            "owners_affected": who["resource_count"],
        },
        "must_redo": rows(stale["must_redo"], include_wasted=True),
        "must_recheck": rows(stale["must_recheck"], include_wasted=False),
        "wasted_effort": wasted,
        "schedule_impact": schedule,
        "who_needs_to_know": who,
        "findings": {
            "created": findings.get("created", []),
            "cleared": findings.get("removed", []),
            "created_count": len(findings.get("created", [])),
            "cleared_count": len(findings.get("removed", [])),
            "unchanged_count": len(findings.get("unchanged", [])),
            "before_count": findings.get("before_count"),
            "after_count": findings.get("after_count"),
        },

        "replan": {
            "scenario_id": scenario_id,
            "kept": keep_scenario,
            "status": sim["scenario"]["status"],
            "applied": False,
            "mutations": sim["scenario"]["mutations"],
            "inverse_mutations": sim.get("inverse_mutations", []),
            "validation": validation,
            "expressed_in": (
                "The closed mutation algebra, unchanged. A requirement change "
                "is REQUIREMENT_VERSION_BUMP; the optional TASK_STATUS_SET "
                "entries restore the statuses a scoped judgement spares. No "
                "eighteenth mutation kind was added."
            ),
            "inspect": (
                f"POST /api/scenarios/{scenario_id}/evaluate"
                if keep_scenario else None
            ),
            "diff": (
                f"GET /api/scenarios/{scenario_id}/diff"
                if keep_scenario else None
            ),
            "apply": (
                f"POST /api/scenarios/{scenario_id}/apply"
                if keep_scenario else None
            ),
            "discard": (
                f"DELETE /api/scenarios/{scenario_id}"
                if keep_scenario else None
            ),
            "kept_note": (
                "" if keep_scenario else
                "This report was asked for without keeping its scenario, so "
                "the replan above was evaluated and then discarded. Ask "
                "`.../change` for a scenario you can apply."
            ),
        },
        "analysis_run_id": sim.get("analysis_run_id"),
        "summary": sim.get("summary"),

        "base_version_hash_before": hash_before,
        "base_version_hash_after": base_after.content_hash,
        "base_unchanged": base_after.content_hash == hash_before,
        "applied": False,

        "statement": (
            _headline(req.key, stale, wasted, who, schedule)
            if not nothing_happened else
            f"Nothing consumes {req.key} and nothing follows work that does, "
            f"so re-wording it invalidates no work, wastes no completed "
            f"effort and moves no date. That is a real answer, not an empty "
            f"one: this requirement can be changed freely."
        ),
        "no_impact": nothing_happened,
        "assumptions": _assumptions(
            scoped=scoped,
            text_changed=text_changed,
            seeds=seeds,
            scoped_out=sorted(set(req.consumed_by) - set(seeds)),
        ),
    }
    return report


# ---------------------------------------------------------------------------
# Comparing wordings
# ---------------------------------------------------------------------------

#: The fields a comparison ranks on, cheapest first, in tie-break order.
_COST_FIELDS = (
    ("additional_effort_days", "days of new effort this change adds"),
    ("wasted_days", "days of completed work invalidated"),
    ("projected_end_delta_days", "days the projected finish moves"),
    ("blast_radius_effort_days", "days of planned effort inside the blast radius"),
    ("must_redo_count", "tasks that must be redone"),
    ("must_recheck_count", "tasks that must be rechecked"),
)


def _cost_of(report: dict) -> dict:
    wasted = report["wasted_effort"]
    return {
        "additional_effort_days": wasted["additional_effort_days"],
        "wasted_days": wasted["wasted_days"],
        "redo_cost_days": wasted["redo_cost_days"],
        "blast_radius_effort_days": wasted["blast_radius_effort_days"],
        "in_flight_days": wasted["in_flight_days"],
        "projected_end_delta_days": report["schedule_impact"].get("delta_days"),
        "must_redo_count": report["blast_radius"]["must_redo_count"],
        "must_recheck_count": report["blast_radius"]["must_recheck_count"],
        "owners_affected": report["blast_radius"]["owners_affected"],
        "deadline_survives": report["schedule_impact"].get("deadline_survives"),
        "scenario_id": report["replan"]["scenario_id"],
    }


def _sort_key(cost: dict) -> tuple:
    return tuple(
        (cost.get(field) if cost.get(field) is not None else 0.0)
        for field, _ in _COST_FIELDS
    )


async def compare(
    db: AsyncSession,
    project_id: uuid.UUID,
    requirement_key: str,
    options: Sequence[Any],
    *,
    version_id: uuid.UUID | None = None,
    keep_scenarios: bool = True,
) -> dict:
    """Cost two or more proposed wordings against the same base.

    **The honest part.** The blast radius of a requirement change comes from
    the dependency graph, and the graph does not change with the wording. So
    two plain strings cost exactly the same, and this function says so rather
    than manufacturing a difference out of how many words moved. A comparison
    only becomes real when the author says which work each wording actually
    spares - `{"text": ..., "invalidates": ["T10"]}` - because that is the one
    input the machine cannot supply.
    """
    if len(options) < 2:
        raise OptionError(
            "Comparing needs at least two options. With one wording, ask "
            "`.../change` instead."
        )

    parsed = [ChangeOption.parse(raw, i) for i, raw in enumerate(options)]

    project, version, snapshot, _, _ = await V.load_context(
        db, project_id, version_id
    )
    if requirement_key not in snapshot.requirement_by_key:
        raise NotFound(f"Requirement {requirement_key} not found")
    hash_before = version.content_hash

    entries = []
    for index, opt in enumerate(parsed):
        report = await impact(
            db,
            project.id,
            requirement_key,
            opt.text,
            version_id=version.id,
            option=opt,
            scenario_name=f"{requirement_key}: {opt.label}",
            keep_scenario=keep_scenarios,
        )
        entries.append({
            "index": index,
            "label": opt.label,
            "text": opt.text,
            "scoped": opt.invalidates is not None,
            "invalidates": list(opt.invalidates) if opt.invalidates else None,
            "cost": _cost_of(report),
            "statement": report["statement"],
            "impact": report,
        })

    costs = [e["cost"] for e in entries]
    ranking = sorted(entries, key=lambda e: (_sort_key(e["cost"]), e["index"]))
    best = _sort_key(ranking[0]["cost"])
    tied = [e["index"] for e in entries if _sort_key(e["cost"]) == best]
    identical = len({_sort_key(c) for c in costs}) == 1

    varies = []
    for field, description in _COST_FIELDS:
        values = [c.get(field) for c in costs]
        numeric = [v for v in values if isinstance(v, (int, float))]
        varies.append({
            "field": field,
            "means": description,
            "values": values,
            "differs": len(set(values)) > 1,
            "spread": (
                _d(max(numeric) - min(numeric)) if len(numeric) == len(values)
                else None
            ),
        })

    pairwise = []
    for a in range(len(entries)):
        for b in range(a + 1, len(entries)):
            ca, cb = costs[a], costs[b]
            redo_a = {r["key"] for r in entries[a]["impact"]["must_redo"]}
            redo_b = {r["key"] for r in entries[b]["impact"]["must_redo"]}
            pairwise.append({
                "a": a,
                "b": b,
                "additional_effort_days_delta": _d(
                    (cb["additional_effort_days"] or 0.0)
                    - (ca["additional_effort_days"] or 0.0)
                ),
                "wasted_days_delta": _d(
                    (cb["wasted_days"] or 0.0) - (ca["wasted_days"] or 0.0)
                ),
                "projected_end_delta_days_delta": _d(
                    (cb["projected_end_delta_days"] or 0.0)
                    - (ca["projected_end_delta_days"] or 0.0)
                ),
                "tasks_only_a_invalidates": sorted(redo_a - redo_b),
                "tasks_only_b_invalidates": sorted(redo_b - redo_a),
            })

    if identical:
        difference_statement = (
            "These options cost exactly the same, and that is the correct "
            "answer rather than a failure to distinguish them. The blast "
            "radius of a requirement change is computed from the dependency "
            "graph - which tasks consumed the requirement - and the graph "
            "does not change when the sentence does. Nothing here reads the "
            "two wordings, and deriving a cost from how much of the text "
            "moved would be an invented number. If one of these wordings "
            "genuinely spares work the other does not, say which tasks it "
            "spares by passing that option as "
            "{\"text\": \"...\", \"invalidates\": [\"T10\", ...]} - your "
            "judgement about meaning, our arithmetic about cost - and this "
            "comparison becomes real."
        )
    else:
        cheapest = ranking[0]
        dearest = ranking[-1]
        difference_statement = (
            f"{cheapest['label']} is the cheaper option: "
            f"{cheapest['cost']['additional_effort_days']:g} day(s) of new "
            f"effort against {dearest['cost']['additional_effort_days']:g} "
            f"for {dearest['label']}, and "
            f"{cheapest['cost']['must_redo_count']} task(s) invalidated "
            f"against {dearest['cost']['must_redo_count']}. Both were costed "
            f"against version {version.version_no} of this workflow, "
            f"unchanged between the two runs."
        )

    return {
        "project_id": str(project.id),
        "requirement_key": requirement_key,
        "base": {
            "version_id": str(version.id),
            "version_no": version.version_no,
            "content_hash": hash_before,
            "same_base_for_every_option": True,
        },
        "options": entries,
        "ranking": [
            {"index": e["index"], "label": e["label"], "cost": e["cost"]}
            for e in ranking
        ],
        "cheapest_option_index": None if len(tied) > 1 else ranking[0]["index"],
        "tied_option_indexes": tied if len(tied) > 1 else [],
        "tie": len(tied) > 1,
        "identical_cost": identical,
        "differences": {
            "varies": varies,
            "pairwise": pairwise,
            "statement": difference_statement,
        },
        "applied": False,
        "base_version_hash_before": hash_before,
        "base_version_hash_after": (
            await V.get_version(db, version.id)
        ).content_hash,
        "assumptions": _assumptions(
            scoped=any(o.invalidates is not None for o in parsed),
            text_changed=True,
            seeds=[],
            scoped_out=[],
        ),
    }


# ---------------------------------------------------------------------------
# History
# ---------------------------------------------------------------------------


def _serialise_revision(row: RequirementRevision) -> dict:
    return {
        "version_no": row.version_no,
        "text": row.text,
        "consumed_by": list(row.consumed_by_task_keys or ()),
        "changed_by": row.changed_by or "",
        "changed_by_user_id": (
            str(row.changed_by_user_id) if row.changed_by_user_id else None
        ),
        "attributed": bool(row.changed_by_user_id),
        "note": row.note or "",
        "workflow_version_id": (
            str(row.workflow_version_id) if row.workflow_version_id else None
        ),
        "scenario_id": str(row.scenario_id) if row.scenario_id else None,
        "backfilled": row.backfilled,
        "recorded_at": row.created_at.isoformat(),
        "impact_summary": row.impact_summary,
        "provenance_note": (
            "Reconstructed from the workflow snapshot, not recorded as it "
            "happened: this wording predates requirement history, so its "
            "author and the moment it was written are unknown."
            if row.backfilled else
            "Recorded when the change was applied, alongside the workflow "
            "version and the scenario that produced it."
        ),
    }


async def _revisions(
    db: AsyncSession, project_id: uuid.UUID, requirement_key: str
) -> list[RequirementRevision]:
    return list(
        (
            await db.execute(
                select(RequirementRevision)
                .where(
                    RequirementRevision.project_id == project_id,
                    RequirementRevision.requirement_key == requirement_key,
                )
                .order_by(RequirementRevision.version_no)
            )
        ).scalars().all()
    )


async def _ensure_baseline(
    db: AsyncSession,
    project_id: uuid.UUID,
    version: WorkflowVersion,
    req,
) -> RequirementRevision | None:
    """Record the wording that is current *now*, if history does not have it.

    Called immediately before a change is applied. Without it the history of a
    seeded or hand-authored project would start at v2 and the original wording
    would be lost at the exact moment somebody replaced it.
    """
    existing = (
        await db.execute(
            select(RequirementRevision).where(
                RequirementRevision.project_id == project_id,
                RequirementRevision.requirement_key == req.key,
                RequirementRevision.version_no == req.version_no,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing
    row = RequirementRevision(
        project_id=project_id,
        requirement_key=req.key,
        version_no=req.version_no,
        text=req.text,
        consumed_by_task_keys=list(req.consumed_by),
        workflow_version_id=version.id,
        changed_by_user_id=None,
        changed_by="",
        note=(
            "Original wording, recorded from the workflow snapshot when the "
            "first change to this requirement was applied."
        ),
        backfilled=True,
        impact_summary=None,
    )
    db.add(row)
    await db.flush()
    return row


async def history(
    db: AsyncSession,
    project_id: uuid.UUID,
    requirement_key: str,
    version_id: uuid.UUID | None = None,
) -> dict:
    """Every recorded wording of one requirement, oldest first."""
    project, version, snapshot, _, _ = await V.load_context(
        db, project_id, version_id
    )
    req = snapshot.requirement_by_key.get(requirement_key)
    if req is None:
        raise NotFound(f"Requirement {requirement_key} not found")

    rows = await _revisions(db, project.id, requirement_key)
    recorded = [_serialise_revision(r) for r in rows]
    known = {r["version_no"] for r in recorded}

    current = {
        "version_no": req.version_no,
        "text": req.text,
        "consumed_by": list(req.consumed_by),
        "workflow_version_id": str(version.id),
        "recorded_in_history": req.version_no in known,
    }
    return {
        "project_id": str(project.id),
        "requirement_key": req.key,
        "current": current,
        "revisions": recorded,
        "revision_count": len(recorded),
        "changes_recorded": sum(1 for r in recorded if not r["backfilled"]),
        "note": (
            "History starts when the first change is applied through "
            "`.../apply`: that is when the wording being replaced is captured "
            "alongside the new one. An empty list means no change has been "
            "applied here, not that the requirement never changed."
            if not recorded else
            "Each row is one wording of this requirement, with the workflow "
            "version and scenario that made it current. Rows marked "
            "`backfilled` were reconstructed from a snapshot and carry no "
            "author."
        ),
    }


async def diff_versions(
    db: AsyncSession,
    project_id: uuid.UUID,
    requirement_key: str,
    from_version: int | None = None,
    to_version: int | None = None,
    base_version_id: uuid.UUID | None = None,
) -> dict:
    """Diff two recorded wordings, and cost that exact change.

    The `impact` block is **recomputed against the workflow as it stands
    today**, not as it stood when the change happened. The tasks that consumed
    the requirement at the time are on the revision row, so the two consumption
    sets are reported side by side and any drift is visible rather than
    silently absorbed.
    """
    project, version, snapshot, _, _ = await V.load_context(
        db, project_id, base_version_id
    )
    req = snapshot.requirement_by_key.get(requirement_key)
    if req is None:
        raise NotFound(f"Requirement {requirement_key} not found")

    rows = {r.version_no: r for r in await _revisions(db, project.id, requirement_key)}
    if not rows:
        raise NotFound(
            f"No revision history recorded for {requirement_key}. History "
            f"begins with the first change applied through this API."
        )
    available = sorted(rows)
    lo = from_version if from_version is not None else available[0]
    hi = to_version if to_version is not None else available[-1]
    for label, value in (("from_version", lo), ("to_version", hi)):
        if value not in rows:
            raise NotFound(
                f"{requirement_key} has no recorded revision "
                f"v{value} ({label}). Recorded: "
                f"{', '.join(f'v{v}' for v in available)}."
            )

    a, b = rows[lo], rows[hi]
    consumed_then = set(a.consumed_by_task_keys or ())
    consumed_now = set(req.consumed_by)

    report = await impact(
        db,
        project.id,
        requirement_key,
        b.text,
        version_id=version.id,
        option=ChangeOption(b.text, label=f"v{lo} -> v{hi}"),
        scenario_name=f"{requirement_key}: v{lo} -> v{hi} recosted",
        keep_scenario=False,
    )

    return {
        "project_id": str(project.id),
        "requirement_key": requirement_key,
        "from_version": lo,
        "to_version": hi,
        "from": _serialise_revision(a),
        "to": _serialise_revision(b),
        "text_diff": text_diff(a.text, b.text),
        "recorded_impact": b.impact_summary,
        "recorded_impact_note": (
            "What the impact report claimed this change would cost, at the "
            "moment it was applied."
            if b.impact_summary else
            "No impact was recorded for this revision - it was backfilled "
            "from a snapshot rather than applied through this API."
        ),
        "consumed_by_then": sorted(consumed_then),
        "consumed_by_now": sorted(consumed_now),
        "consumption_drifted": consumed_then != consumed_now,
        "drift_note": (
            "The tasks that consume this requirement have changed since that "
            "revision, so the recomputed impact below is not the impact that "
            "change had at the time. It is what the same wording change would "
            "cost against today's workflow."
            if consumed_then != consumed_now else
            "The same tasks consume this requirement now as did then, so the "
            "recomputed impact is directly comparable."
        ),
        "impact": report,
        "impact_note": (
            f"Recomputed against workflow version {version.version_no} as it "
            f"stands now. Nothing was applied and no scenario was kept."
        ),
    }


# ---------------------------------------------------------------------------
# Applying - the one write, and it goes through the one write path
# ---------------------------------------------------------------------------


async def apply_change(
    db: AsyncSession,
    project_id: uuid.UUID,
    requirement_key: str,
    new_text: str,
    *,
    version_id: uuid.UUID | None = None,
    option: ChangeOption | None = None,
    note: str = "",
    actor: User | None = None,
) -> dict:
    """Accept a requirement change: bump the wording and replan.

    There is **no special apply path**. This computes the impact report,
    promotes that report's scenario through `scenarios.apply_scenario` - the
    only function in the codebase that writes workflow state - and then records
    the revision. The version this creates is indistinguishable from one
    created by applying the same scenario by hand from the scenarios API,
    because it is one.
    """
    project, version, snapshot, _, _ = await V.load_context(
        db, project_id, version_id
    )
    req = snapshot.requirement_by_key.get(requirement_key)
    if req is None:
        raise NotFound(f"Requirement {requirement_key} not found")

    report = await impact(
        db,
        project.id,
        requirement_key,
        new_text,
        version_id=version.id,
        option=option,
        scenario_name=(
            f"Requirement change applied: {req.key} -> v{req.version_no + 1}"
        ),
        keep_scenario=True,
    )
    scenario_id = uuid.UUID(report["replan"]["scenario_id"])

    # Capture the wording being replaced *before* the apply overwrites it.
    await _ensure_baseline(db, project.id, version, req)

    applied = await SC.apply_scenario(
        db,
        scenario_id,
        note=note or (
            f"Requirement {req.key} changed to v{req.version_no + 1}"
        ),
    )
    new_version_id = uuid.UUID(applied["new_version"]["id"])

    revision = RequirementRevision(
        project_id=project.id,
        requirement_key=req.key,
        version_no=req.version_no + 1,
        text=report["proposed_text"],
        consumed_by_task_keys=list(req.consumed_by),
        workflow_version_id=new_version_id,
        scenario_id=scenario_id,
        changed_by_user_id=actor.id if actor else None,
        changed_by=(
            f"{actor.name} <{actor.email}>" if actor else ""
        ),
        note=note,
        backfilled=False,
        impact_summary={
            "must_redo_count": report["blast_radius"]["must_redo_count"],
            "must_recheck_count": report["blast_radius"]["must_recheck_count"],
            "wasted_days": report["wasted_effort"]["wasted_days"],
            "redo_cost_days": report["wasted_effort"]["redo_cost_days"],
            "additional_effort_days":
                report["wasted_effort"]["additional_effort_days"],
            "projected_end_delta_days":
                report["schedule_impact"].get("delta_days"),
            "deadline_survives":
                report["schedule_impact"].get("deadline_survives"),
            "engine_version": report["engine_version"],
            "claimed_at_apply": True,
        },
    )
    db.add(revision)
    await db.commit()

    report["applied"] = True
    report["replan"]["applied"] = True
    report["replan"]["status"] = "applied"

    return {
        "applied": True,
        "project_id": str(project.id),
        "requirement_key": req.key,
        "from_version": req.version_no,
        "to_version": req.version_no + 1,
        "previous_text": req.text,
        "new_text": report["proposed_text"],
        "attributed_to": (
            f"{actor.name} <{actor.email}>" if actor else None
        ),
        "attribution_note": (
            "" if actor else
            "This instance did not identify the caller, so the change is "
            "recorded without an author rather than attributed to a guess."
        ),
        "new_version": applied["new_version"],
        "parent_version": applied["parent_version"],
        "scenario_id": str(scenario_id),
        "revision": _serialise_revision(revision),
        "impact": report,
        "note": (
            "Applied through the same `apply_scenario` path as every other "
            "workflow change. The parent version survives with its content "
            "hash intact, so this is reversible and the history is real."
        ),
    }
