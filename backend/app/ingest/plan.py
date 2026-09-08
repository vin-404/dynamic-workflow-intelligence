"""
One CSV, one pipeline, one plan.

`build_plan` is the whole importer. The Jira front door and the generic
front door differ only in which `ColumnMapping` they hand it, which is the
point: there is exactly one place where a row becomes a task, so the two
paths cannot drift apart and a fix to one is a fix to both.

The output is an `ImportPlan`: the specs that would be created, plus a full
account of what the file said and what this code did with it. Three
principles decide what lands where.

* **A row that cannot be mapped is reported, never dropped.** Every rejection
  carries its record number, its physical line, its raw content column by
  column, and a reason written for the person holding the file.
* **A missing value is defaulted and said so. A present-but-nonsense value is
  refused.** Those are different mistakes: nobody filled in an estimate, versus
  somebody typed `TBD` into a number. Defaulting the second would launder a
  typo into a schedule.
* **Nothing is created that the file did not say.** A link to an issue outside
  the export is a dropped dependency with a reason, not an invented task.

Nothing here imports FastAPI, SQLAlchemy or `settings`, so the whole importer
is testable as a function.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date

from backend.app.core.workflow import (
    AssignmentSpec,
    DependencySpec,
    DepType,
    ResourceSpec,
    TaskSpec,
    TaskStatus,
    WorkflowSnapshot,
)
from backend.app.ingest.csvsource import Record, Sheet, normalise_column, read_sheet
from backend.app.ingest.mapping import (
    JIRA_STATUS_CATEGORY,
    JIRA_STATUS_VOCABULARY,
    ColumnMapping,
    Interpretation,
    extract_keys,
    looks_like_duration,
    parse_date,
    parse_duration_days,
)

#: Widths the database actually enforces (`models/version.py`). A key that
#: does not fit is refused up front; a name or description that does not fit
#: is truncated and the truncation is reported. Discovering this as an
#: `sqlalchemy.exc.DataError` on Postgres after a clean preview would be the
#: worst possible place to find out.
MAX_KEY_CHARS = 40
MAX_NAME_CHARS = 255
MAX_DESCRIPTION_CHARS = 2000

_SLUG = re.compile(r"[^a-z0-9]+")


@dataclass(frozen=True, slots=True)
class ImportOptions:
    """Everything the caller may say about how to read the numbers.

    Each of these is echoed into `ImportPlan.assumptions`, so a reader can
    recompute an effort by hand from the raw cell and these settings - the
    same contract `EngineConfig` has with the analysis payload.
    """

    #: Working days per story point. Story points are a relative, team-local
    #: unit with no duration in them at all; 1.0 is a starting point, not a
    #: fact, and the preview says so on every row that uses it.
    story_point_days: float = 1.0
    #: Hours in a working day, for the estimate column and Jira's `2d 4h`.
    hours_per_day: float = 8.0
    #: How to read a bare number in the estimate column. Jira's CSV export
    #: writes `Original Estimate` in **seconds**, which is why that is the
    #: default; a hand-made CSV usually means hours or days, so the caller can
    #: say. There is no sniffing: a heuristic that reads 8 as eight seconds
    #: and 28800 as eight hours is a heuristic that will one day read a real
    #: number wrong and never mention it.
    estimate_unit: str = "seconds"
    #: Used when a row names no effort at all. Reported as assumed, per row.
    default_effort_days: float = 1.0
    delimiter: str = ","
    start_date: date | None = None
    deadline: date | None = None

    def __post_init__(self) -> None:
        if self.estimate_unit not in ("seconds", "hours", "days"):
            raise ValueError(
                f"estimate_unit must be seconds, hours or days; got "
                f"{self.estimate_unit!r}"
            )
        if self.story_point_days <= 0:
            raise ValueError("story_point_days must be greater than zero")
        if self.hours_per_day <= 0:
            raise ValueError("hours_per_day must be greater than zero")
        if self.default_effort_days < 0:
            raise ValueError("default_effort_days must be zero or more")

    def as_dict(self) -> dict:
        return {
            "story_point_days": self.story_point_days,
            "hours_per_day": self.hours_per_day,
            "estimate_unit": self.estimate_unit,
            "default_effort_days": self.default_effort_days,
            "delimiter": self.delimiter,
            "start_date": self.start_date.isoformat() if self.start_date else None,
            "deadline": self.deadline.isoformat() if self.deadline else None,
        }


@dataclass
class ImportPlan:
    """What would be created, and everything that was decided on the way."""

    source: str
    options: ImportOptions
    tasks: list[TaskSpec] = field(default_factory=list)
    dependencies: list[DependencySpec] = field(default_factory=list)
    resources: list[ResourceSpec] = field(default_factory=list)
    assignments: list[AssignmentSpec] = field(default_factory=list)
    statuses: dict[str, TaskStatus] = field(default_factory=dict)
    #: One entry per row that produced a task, in file order.
    rows: list[dict] = field(default_factory=list)
    #: One entry per row that did not, with its raw content and the reason.
    rejected_rows: list[dict] = field(default_factory=list)
    #: Links that named something we cannot draw an edge to.
    dropped_dependencies: list[dict] = field(default_factory=list)
    #: Columns present in the file that this mapping does not read.
    unmapped_columns: list[dict] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    #: (from, to) -> the link cell that produced the edge, so the preview can
    #: show a dependency next to the sentence in the file that justifies it.
    edge_evidence: dict = field(default_factory=dict)
    start_date: date = field(default_factory=date.today)
    deadline: date | None = None
    start_date_derived: bool = True
    deadline_derived: bool = False
    header: tuple[str, ...] = ()

    @property
    def deadline_day(self) -> float | None:
        if self.deadline is None:
            return None
        return float((self.deadline - self.start_date).days)

    def snapshot(self) -> WorkflowSnapshot:
        return WorkflowSnapshot.build(
            tasks=self.tasks,
            dependencies=self.dependencies,
            resources=self.resources,
            assignments=self.assignments,
            deadline_day=self.deadline_day,
        )

    def counts(self) -> dict:
        return {
            "tasks": len(self.tasks),
            "dependencies": len(self.dependencies),
            "resources": len(self.resources),
            "assignments": len(self.assignments),
            "rows_read": len(self.rows) + len(self.rejected_rows),
            "rows_rejected": len(self.rejected_rows),
            "dependencies_dropped": len(self.dropped_dependencies),
        }

    def assumptions(self) -> dict:
        """Every inference the import made, in one block.

        The rule this file follows is the one the analysis payload follows:
        anything a reader would have to take on trust is written down instead.
        """
        return {
            "settings_used": self.options.as_dict(),
            "start_date": {
                "value": self.start_date.isoformat(),
                "assumed": self.start_date_derived,
                "how": (
                    "the earliest date found in the file"
                    if self.start_date_derived
                    else "supplied by the caller"
                ),
            },
            "deadline": {
                "value": self.deadline.isoformat() if self.deadline else None,
                "assumed": self.deadline_derived,
                "how": (
                    "the latest task due date in the file, because no deadline "
                    "was supplied"
                    if self.deadline_derived
                    else (
                        "supplied by the caller" if self.deadline
                        else "none: no deadline was supplied and no due dates "
                             "were found, so nothing is claimed about feasibility"
                    )
                ),
            },
            "stated_plainly": [
                "Effort is in working days. A story point is not a unit of "
                f"time; it is read here as {self.options.story_point_days} "
                "working day(s) because a schedule needs a number, and every "
                "row that used that reading says so.",
                "Every imported dependency is ordering only (consumes=false). "
                "An issue tracker's 'blocks' link says nothing about whether "
                "the successor consumes an artifact the predecessor produces, "
                "and guessing would make requirement-change impact report "
                "must_redo where it has no evidence. Mark the consuming edges "
                "by hand afterwards to get that back.",
                "Per-task due dates are read to derive the project deadline "
                "and are otherwise not represented: this platform schedules "
                "from dependencies and effort, and has no per-task deadline "
                "field to put them in.",
                "A due date becomes a day offset by calendar-day subtraction "
                "from the project start, which is exactly how the rest of the "
                "platform converts between days and dates. It is not a "
                "working-day count, and no holiday calendar is applied.",
                "No status history is created. An import is a plan, not a "
                "record of what happened, so every imported project starts "
                "with an empty event log and the analysis says which checks "
                "it therefore cannot run.",
                "Nothing on this path consults a language model. Every column "
                "was mapped because a human said so.",
            ],
            "notes": list(self.notes),
        }


# ---------------------------------------------------------------------------
# The pipeline
# ---------------------------------------------------------------------------


def build_plan(
    text: str,
    mapping: ColumnMapping,
    options: ImportOptions | None = None,
    source: str = "csv",
) -> ImportPlan:
    """Parse `text` under `mapping` into a plan. Never raises for a bad row."""
    options = options or ImportOptions()
    sheet = read_sheet(text, delimiter=options.delimiter)
    plan = ImportPlan(source=source, options=options, header=sheet.header)

    _report_unmapped_columns(sheet, mapping, plan)

    # Pass one: rows -> tasks. Links are held aside because an edge can only
    # be validated once every key in the file is known.
    pending_edges: list[dict] = []
    seen: dict[str, int] = {}
    resources: dict[str, ResourceSpec] = {}
    created_dates: list[date] = []
    due_dates: list[date] = []

    for record in sheet.records:
        _read_row(
            record, mapping, options, plan, pending_edges, seen, resources,
            created_dates, due_dates,
        )

    plan.resources = sorted(resources.values(), key=lambda r: r.key)

    # Pass two: edges, now that every task key is known.
    _resolve_edges(pending_edges, seen, plan)

    # Pass three: the dates the project itself needs.
    _settle_dates(plan, options, created_dates, due_dates)

    return plan


def _report_unmapped_columns(
    sheet: Sheet, mapping: ColumnMapping, plan: ImportPlan
) -> None:
    """Say which columns were seen and not used.

    A user who exported `Epic Link` and `Sprint` and gets a workflow with
    neither should be told, once, that we saw them. This is also where a Jira
    link type we do not handle - `Outward issue link (Relates)`, or the
    `Depends` type whose inward and outward descriptions run the other way -
    surfaces instead of being read as a blocking edge it is not.
    """
    used = {normalise_column(c) for c in mapping.all_columns()}
    reported: set[str] = set()
    for column in sheet.header:
        key = normalise_column(column)
        if not key or key in used or key in reported:
            continue
        reported.add(key)
        if "issue link" in key:
            reason = (
                "This is a link column of a type this importer does not read. "
                "Only the 'Blocks' link type has an unambiguous scheduling "
                "meaning; other types differ per instance in which direction "
                "the arrow points, so reading them would be a guess."
            )
        else:
            reason = "No field in the mapping names this column, so it was read as nothing."
        plan.unmapped_columns.append({"column": column, "reason": reason})


def _reject(plan: ImportPlan, record: Record, reason: str) -> None:
    plan.rejected_rows.append(
        {
            "row": record.row,
            "line": record.line,
            "raw": record.raw(),
            "reason": reason,
        }
    )


def _read_row(
    record: Record,
    mapping: ColumnMapping,
    options: ImportOptions,
    plan: ImportPlan,
    pending_edges: list[dict],
    seen: dict[str, int],
    resources: dict[str, ResourceSpec],
    created_dates: list[date],
    due_dates: list[date],
) -> None:
    if record.blank:
        _reject(plan, record, "The row is blank: there is nothing in it to map.")
        return

    if record.ragged:
        _reject(
            plan,
            record,
            f"The row has {len(record.values)} fields and the header has "
            f"{len(record.header)}. A short or long row means the export was "
            f"truncated or edited, and padding it would produce a task whose "
            f"values are shifted one column out of place.",
        )
        return

    key = record.first(*mapping.key)
    if not key:
        _reject(
            plan,
            record,
            f"No value in {_or_list(mapping.key)}, so this row has no task key. "
            f"Every task needs one: it is what dependencies point at.",
        )
        return

    if "->" in key:
        _reject(
            plan, record,
            f"The task key '{key}' contains '->', which this platform uses to "
            f"name a dependency in a constraint. Rename it in the source.",
        )
        return

    if len(key) > MAX_KEY_CHARS:
        _reject(
            plan, record,
            f"The task key '{key}' is {len(key)} characters and the limit is "
            f"{MAX_KEY_CHARS}.",
        )
        return

    if key in seen:
        _reject(
            plan, record,
            f"The task key '{key}' already appeared on row {seen[key]}. Task "
            f"keys must be unique, and importing the second one would silently "
            f"overwrite the first.",
        )
        return

    interpretation: dict[str, dict] = {}
    notes: list[str] = []

    # -- effort ------------------------------------------------------------
    try:
        effort = _read_effort(record, mapping, options)
    except ValueError as exc:
        _reject(plan, record, str(exc))
        return
    interpretation["effort"] = effort.as_dict()

    # -- due date ----------------------------------------------------------
    due_raw = record.first(*mapping.due_date) if mapping.due_date else ""
    due: date | None = None
    if due_raw:
        try:
            due = parse_date(due_raw)
        except ValueError as exc:
            _reject(
                plan, record,
                f"The due date could not be read: {exc}.",
            )
            return
        due_dates.append(due)
        interpretation["due_date"] = Interpretation(
            value=due.isoformat(),
            raw=due_raw,
            source=_present(record, mapping.due_date),
            how=(
                "read as a calendar date; it contributes to the project "
                "deadline and is not stored per task"
            ),
        ).as_dict()

    # -- created (only ever a default for the project start) ---------------
    created_raw = record.first(*mapping.created) if mapping.created else ""
    if created_raw:
        try:
            created_dates.append(parse_date(created_raw))
        except ValueError as exc:
            notes.append(
                f"The created date {created_raw!r} could not be read ({exc}). "
                f"The row was imported anyway: this column only nudges the "
                f"default project start date, which the caller can set."
            )

    # -- name / description ------------------------------------------------
    name_raw = record.first(*mapping.name) if mapping.name else ""
    if name_raw:
        name = name_raw
        name_how, name_assumed = "read as the task name", False
        if len(name) > MAX_NAME_CHARS:
            name = name[:MAX_NAME_CHARS]
            notes.append(
                f"The name was {len(name_raw)} characters and was truncated to "
                f"{MAX_NAME_CHARS}."
            )
    else:
        name = key
        name_how = (
            "no summary in this row, so the task key is standing in as the name"
        )
        name_assumed = True
    interpretation["name"] = Interpretation(
        value=name, raw=name_raw, source=_present(record, mapping.name),
        how=name_how, assumed=name_assumed,
    ).as_dict()

    description = record.first(*mapping.description) if mapping.description else ""
    if len(description) > MAX_DESCRIPTION_CHARS:
        notes.append(
            f"The description was {len(description)} characters and was "
            f"truncated to {MAX_DESCRIPTION_CHARS}."
        )
        description = description[:MAX_DESCRIPTION_CHARS]

    # -- status ------------------------------------------------------------
    status_reading = _read_status(record, mapping)
    interpretation["status"] = status_reading.as_dict()
    status = TaskStatus(status_reading.value)

    # -- assignee ----------------------------------------------------------
    assignee_raw = record.first(*mapping.assignee) if mapping.assignee else ""
    resource_key: str | None = None
    if assignee_raw:
        resource_key = _resource_key(assignee_raw, resources)
        if resource_key not in resources:
            resources[resource_key] = ResourceSpec(
                key=resource_key,
                name=assignee_raw[:MAX_NAME_CHARS],
                kind="person",
                capacity=1,
            )
        interpretation["assignee"] = Interpretation(
            value=resource_key,
            raw=assignee_raw,
            source=_present(record, mapping.assignee),
            how=(
                "one resource per distinct assignee, capacity 1. Capacity is "
                "not in the export, so anyone working on two things at once "
                "will show as contention"
            ),
            assumed=True,
        ).as_dict()
    else:
        interpretation["assignee"] = Interpretation(
            value=None, raw="", source=_present(record, mapping.assignee),
            how=(
                "unassigned, so this task has no resource and no contention "
                "can be attributed to it"
            ),
            assumed=False,
        ).as_dict()

    # -- links, held for pass two -----------------------------------------
    for column, raw in record.all(*mapping.blocks):
        pending_edges.append(
            {"record": record, "column": column, "raw": raw,
             "owner": key, "direction": "blocks"}
        )
    for column, raw in record.all(*mapping.blocked_by):
        pending_edges.append(
            {"record": record, "column": column, "raw": raw,
             "owner": key, "direction": "blocked_by"}
        )

    seen[key] = record.row
    plan.tasks.append(
        TaskSpec(
            key=key,
            name=name,
            description=description,
            effort=float(effort.value),
        )
    )
    plan.statuses[key] = status
    if resource_key:
        plan.assignments.append(
            AssignmentSpec(task_key=key, resource_key=resource_key, allocation=1.0)
        )
    plan.rows.append(
        {
            "row": record.row,
            "line": record.line,
            "task_key": key,
            "name": name,
            "interpretation": interpretation,
            "notes": notes,
        }
    )


def _read_effort(
    record: Record, mapping: ColumnMapping, options: ImportOptions
) -> Interpretation:
    """Effort in working days, or `ValueError` explaining the refusal.

    Story points win over an estimate when both are present, because a team
    that maintains both maintains the points; the preview says which was used.
    """
    points_raw = record.first(*mapping.story_points) if mapping.story_points else ""
    if points_raw:
        try:
            points = float(points_raw.replace(",", ""))
        except ValueError:
            raise ValueError(
                f"The story points value {points_raw!r} is not a number, so "
                f"there is no effort to schedule with. An absent estimate gets "
                f"a stated default; a value that is present and unreadable is "
                f"refused, because defaulting it would launder a typo into a "
                f"schedule."
            )
        if points < 0:
            raise ValueError(
                f"The story points value {points_raw!r} is negative, and "
                f"effort cannot be."
            )
        return Interpretation(
            value=points * options.story_point_days,
            raw=points_raw,
            source=_present(record, mapping.story_points),
            how=(
                f"{points:g} story points x {options.story_point_days:g} "
                f"working days per point. Story points are a relative unit "
                f"with no time in them; this conversion is the caller's, not "
                f"the file's"
            ),
            assumed=True,
        )

    estimate_raw = record.first(*mapping.estimate) if mapping.estimate else ""
    if estimate_raw:
        if looks_like_duration(estimate_raw):
            days = parse_duration_days(estimate_raw, options.hours_per_day)
            how = (
                f"Jira duration syntax, at {options.hours_per_day:g} hours per "
                f"working day and 5 days per week"
            )
        else:
            try:
                amount = float(estimate_raw.replace(",", ""))
            except ValueError:
                raise ValueError(
                    f"The estimate {estimate_raw!r} is neither a number nor a "
                    f"duration like '2d 4h', so there is no effort to schedule "
                    f"with."
                )
            if amount < 0:
                raise ValueError(
                    f"The estimate {estimate_raw!r} is negative, and effort "
                    f"cannot be."
                )
            if options.estimate_unit == "seconds":
                days = amount / (options.hours_per_day * 3600.0)
                how = (
                    f"{amount:g} seconds / ({options.hours_per_day:g} hours x "
                    f"3600), because a Jira CSV writes Original Estimate in "
                    f"seconds. Send estimate_unit if yours does not"
                )
            elif options.estimate_unit == "hours":
                days = amount / options.hours_per_day
                how = f"{amount:g} hours / {options.hours_per_day:g} per day"
            else:
                days, how = amount, f"{amount:g}, already in working days"
        return Interpretation(
            value=days, raw=estimate_raw,
            source=_present(record, mapping.estimate), how=how, assumed=True,
        )

    columns = mapping.story_points + mapping.estimate
    present = _present(record, columns) if columns else ""
    return Interpretation(
        value=options.default_effort_days,
        raw="",
        source=(
            present if present and not present.startswith("'")
            else "(no effort column in this file)"
        ),
        how=(
            f"nothing in this row states an effort, so it was defaulted to "
            f"{options.default_effort_days:g} working day(s). Every schedule "
            f"number this task contributes to rests on that default"
        ),
        assumed=True,
    )


def _read_status(record: Record, mapping: ColumnMapping) -> Interpretation:
    raw = record.first(*mapping.status) if mapping.status else ""
    source = _present(record, mapping.status)
    if not raw:
        return Interpretation(
            value=TaskStatus.NOT_STARTED.value, raw="", source=source,
            how=(
                "no status in this row, so the task is treated as not started"
            ),
            assumed=True,
        )

    folded = raw.casefold()
    if folded in mapping.status_values:
        return Interpretation(
            value=mapping.status_values[folded].value, raw=raw, source=source,
            how="mapped by the status_values you supplied", assumed=False,
        )
    if folded in JIRA_STATUS_VOCABULARY:
        return Interpretation(
            value=JIRA_STATUS_VOCABULARY[folded].value, raw=raw, source=source,
            how="exact match in the status vocabulary this importer ships",
            assumed=False,
        )

    category = (
        record.first(*mapping.status_category) if mapping.status_category else ""
    )
    if category and category.casefold() in JIRA_STATUS_CATEGORY:
        return Interpretation(
            value=JIRA_STATUS_CATEGORY[category.casefold()].value,
            raw=raw,
            source=source,
            how=(
                f"'{raw}' is not a status this importer knows, so its status "
                f"category '{category}' was used instead. That is coarser than "
                f"the status itself: a custom review state and a custom "
                f"development state both land on the category's answer"
            ),
            assumed=True,
        )

    return Interpretation(
        value=TaskStatus.NOT_STARTED.value,
        raw=raw,
        source=source,
        how=(
            f"'{raw}' has no clean equivalent among our five statuses and this "
            f"row carries no status category to fall back on, so it was left "
            f"as not started rather than guessed. If it is really in flight, "
            f"set it after the import - or send status_values to map it"
        ),
        assumed=True,
    )


def _resolve_edges(
    pending_edges: list[dict], seen: dict[str, int], plan: ImportPlan
) -> None:
    """Turn held link cells into dependencies, dropping nothing in silence.

    Reciprocal statements collapse: `A blocks B` on A's row and `B is blocked
    by A` on B's row are the same edge, and Jira exports both. The count of
    collapses is reported so the number of edges is explicable from the file.
    """
    edges: dict[tuple[str, str], dict] = {}
    duplicates = 0

    for pending in pending_edges:
        record: Record = pending["record"]
        keys, how = extract_keys(pending["raw"])
        if not keys:
            plan.dropped_dependencies.append(
                {
                    "row": record.row, "line": record.line,
                    "column": pending["column"], "raw": pending["raw"],
                    "task_key": pending["owner"], "reason": how,
                }
            )
            continue

        for other in keys:
            if other not in seen:
                plan.dropped_dependencies.append(
                    {
                        "row": record.row, "line": record.line,
                        "column": pending["column"], "raw": pending["raw"],
                        "task_key": pending["owner"],
                        "reason": (
                            f"'{other}' is not in this file. It may be outside "
                            f"the export's filter, or it may be a row that was "
                            f"rejected above. No task was invented for it, so "
                            f"this dependency was not created."
                        ),
                    }
                )
                continue
            if other == pending["owner"]:
                plan.dropped_dependencies.append(
                    {
                        "row": record.row, "line": record.line,
                        "column": pending["column"], "raw": pending["raw"],
                        "task_key": pending["owner"],
                        "reason": (
                            f"'{other}' links to itself. A task cannot block "
                            f"itself, so the link was dropped rather than "
                            f"turned into a one-node cycle."
                        ),
                    }
                )
                continue

            if pending["direction"] == "blocks":
                edge = (pending["owner"], other)
                because = (
                    f"{pending['column']}: {pending['owner']} blocks {other}, "
                    f"so {pending['owner']} must finish first"
                )
            else:
                edge = (other, pending["owner"])
                because = (
                    f"{pending['column']}: {pending['owner']} is blocked by "
                    f"{other}, so {other} must finish first"
                )

            if edge in edges:
                duplicates += 1
                continue
            edges[edge] = {
                "from_task": edge[0], "to_task": edge[1],
                "row": record.row, "column": pending["column"],
                "raw": pending["raw"], "because": because,
            }

    plan.dependencies = [
        DependencySpec(
            from_task=e["from_task"], to_task=e["to_task"],
            dep_type=DepType.FS, consumes=False,
        )
        for e in sorted(edges.values(), key=lambda e: (e["from_task"], e["to_task"]))
    ]
    plan.edge_evidence = {
        (e["from_task"], e["to_task"]): e for e in edges.values()
    }
    if duplicates:
        plan.notes.append(
            f"{duplicates} link cell(s) restated an edge the file had already "
            f"given from the other side - Jira writes 'A blocks B' on A's row "
            f"and 'B is blocked by A' on B's row - and were collapsed into one "
            f"dependency each."
        )


def _settle_dates(
    plan: ImportPlan,
    options: ImportOptions,
    created_dates: list[date],
    due_dates: list[date],
) -> None:
    if options.start_date is not None:
        plan.start_date, plan.start_date_derived = options.start_date, False
    elif created_dates:
        plan.start_date, plan.start_date_derived = min(created_dates), True
        plan.notes.append(
            f"No start date was supplied, so the earliest created date in the "
            f"file ({plan.start_date.isoformat()}) was used. Every day offset "
            f"in this workflow is measured from it."
        )
    elif due_dates:
        plan.start_date, plan.start_date_derived = min(due_dates), True
        plan.notes.append(
            f"No start date was supplied and the file has no created dates, so "
            f"the earliest due date ({plan.start_date.isoformat()}) was used as "
            f"the project start."
        )
    else:
        plan.start_date, plan.start_date_derived = date.today(), True
        plan.notes.append(
            "No start date was supplied and the file carries no dates at all, "
            "so today was used. Set start_date on the commit to anchor the "
            "schedule somewhere meaningful."
        )

    if options.deadline is not None:
        plan.deadline, plan.deadline_derived = options.deadline, False
    elif due_dates:
        plan.deadline, plan.deadline_derived = max(due_dates), True
        plan.notes.append(
            f"No deadline was supplied, so the latest task due date "
            f"({plan.deadline.isoformat()}) became the project deadline. That "
            f"is an inference from the file, not a commitment anybody made."
        )
    else:
        plan.deadline, plan.deadline_derived = None, False


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _present(record: Record, candidates: tuple[str, ...]) -> str:
    """The first candidate column actually present in the header, spelled as
    the file spells it - so the preview names the user's column, not ours."""
    for candidate in candidates:
        positions = record.index.get(normalise_column(candidate), ())
        if positions:
            return record.header[positions[0]]
    return _or_list(candidates) or "(not in this file)"


def _or_list(candidates: tuple[str, ...]) -> str:
    if not candidates:
        return ""
    if len(candidates) == 1:
        return f"'{candidates[0]}'"
    return ", ".join(f"'{c}'" for c in candidates[:-1]) + f" or '{candidates[-1]}'"


def _resource_key(assignee: str, existing: dict[str, ResourceSpec]) -> str:
    """A stable, short, unique key for a person named only by display name."""
    base = _SLUG.sub("-", assignee.strip().casefold()).strip("-") or "unassigned"
    base = base[:MAX_KEY_CHARS]
    for spec in existing.values():
        if spec.name == assignee:
            return spec.key
    if base not in existing:
        return base
    suffix = 2
    while True:
        candidate = f"{base[:MAX_KEY_CHARS - len(str(suffix)) - 1]}-{suffix}"
        if candidate not in existing:
            return candidate
        suffix += 1


def build_jira_plan(text: str, options: ImportOptions | None = None) -> ImportPlan:
    """The Jira front door. Same pipeline, a preset mapping."""
    from backend.app.ingest.mapping import JIRA_MAPPING

    return build_plan(text, JIRA_MAPPING, options, source="jira")


__all__ = [
    "ImportOptions",
    "ImportPlan",
    "build_plan",
    "build_jira_plan",
    "MAX_KEY_CHARS",
    "MAX_NAME_CHARS",
    "MAX_DESCRIPTION_CHARS",
]
