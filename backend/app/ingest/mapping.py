"""
Which column means what, and what a foreign vocabulary means in ours.

Everything in this module is a lookup table plus a small amount of parsing.
There is no model call anywhere in the import path (D-51 says the AI layer has
no write path, and an importer that creates a project is a write path): a
column is mapped because a human said so, either by using Jira's own header
names or by sending a mapping payload. The same pipeline serves both, which
is why `ColumnMapping` exists at all - "Jira" is just a preset.

Every inference this module makes is returned alongside its answer rather
than applied quietly. `Interpretation` is that pairing: a value, the raw text
it came from, how it was read, and whether the reading was assumed. The
preview renders one per row, so a story point read as a day is visible to the
person who has to live with it.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Mapping

from backend.app.core.workflow import TaskStatus


class MappingProblem(Exception):
    """The caller's mapping payload cannot be used. A 422, message verbatim."""


# ---------------------------------------------------------------------------
# What an inference looks like when it is stated out loud
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Interpretation:
    """One field read from one row, with its provenance attached.

    `raw` is the caller's own text, unedited. That is deliberate: a preview
    that paraphrases what the file said is a preview the reader has to take on
    trust, and the whole point of showing it is that they should not have to.
    """

    value: object
    raw: str
    #: Which column the value came from, spelled as it appears in the header.
    source: str
    #: One sentence a non-technical reader can check the arithmetic against.
    how: str
    #: True when nothing in the file said this and the importer chose it.
    assumed: bool = False

    def as_dict(self) -> dict:
        return {
            "value": self.value,
            "raw": self.raw,
            "source": self.source,
            "how": self.how,
            "assumed": self.assumed,
        }


# ---------------------------------------------------------------------------
# Status vocabulary
# ---------------------------------------------------------------------------

#: Jira's default workflow vocabulary, plus the variants that appear on almost
#: every instance that has ever been customised, mapped onto our five
#: statuses. Keys are casefolded.
#:
#: The mapping is deliberately conservative at both ends. Anything that means
#: "a human is looking at finished work" lands on `in_review` rather than
#: `in_progress`, because the stalled-in-review detector is one of the four
#: original findings and collapsing review into progress would silence it.
#: Anything that means "waiting on someone else" lands on `blocked` rather
#: than `not_started`, because those are different problems.
JIRA_STATUS_VOCABULARY: Mapping[str, TaskStatus] = {
    # not started
    "to do": TaskStatus.NOT_STARTED,
    "todo": TaskStatus.NOT_STARTED,
    "open": TaskStatus.NOT_STARTED,
    "backlog": TaskStatus.NOT_STARTED,
    "new": TaskStatus.NOT_STARTED,
    "created": TaskStatus.NOT_STARTED,
    "selected for development": TaskStatus.NOT_STARTED,
    "ready": TaskStatus.NOT_STARTED,
    "ready for development": TaskStatus.NOT_STARTED,
    "reopened": TaskStatus.NOT_STARTED,
    "not started": TaskStatus.NOT_STARTED,
    # in progress
    "in progress": TaskStatus.IN_PROGRESS,
    "in development": TaskStatus.IN_PROGRESS,
    "in dev": TaskStatus.IN_PROGRESS,
    "doing": TaskStatus.IN_PROGRESS,
    "started": TaskStatus.IN_PROGRESS,
    "building": TaskStatus.IN_PROGRESS,
    "implementing": TaskStatus.IN_PROGRESS,
    # in review
    "in review": TaskStatus.IN_REVIEW,
    "review": TaskStatus.IN_REVIEW,
    "code review": TaskStatus.IN_REVIEW,
    "peer review": TaskStatus.IN_REVIEW,
    "in testing": TaskStatus.IN_REVIEW,
    "testing": TaskStatus.IN_REVIEW,
    "qa": TaskStatus.IN_REVIEW,
    "in qa": TaskStatus.IN_REVIEW,
    "verifying": TaskStatus.IN_REVIEW,
    "awaiting approval": TaskStatus.IN_REVIEW,
    "ready for review": TaskStatus.IN_REVIEW,
    # blocked
    "blocked": TaskStatus.BLOCKED,
    "impeded": TaskStatus.BLOCKED,
    "on hold": TaskStatus.BLOCKED,
    "waiting": TaskStatus.BLOCKED,
    "waiting for support": TaskStatus.BLOCKED,
    "escalated": TaskStatus.BLOCKED,
    # done
    "done": TaskStatus.DONE,
    "closed": TaskStatus.DONE,
    "resolved": TaskStatus.DONE,
    "complete": TaskStatus.DONE,
    "completed": TaskStatus.DONE,
    "released": TaskStatus.DONE,
    "shipped": TaskStatus.DONE,
    "cancelled": TaskStatus.DONE,
    "canceled": TaskStatus.DONE,
    "won't do": TaskStatus.DONE,
    "wont do": TaskStatus.DONE,
}

#: Jira's *status category* has exactly three values on every instance, and
#: unlike the status itself it cannot be renamed. When a customised status is
#: unrecognised, this is the honest fallback: it is coarser, we say we used
#: it, and it beats guessing from the wording.
JIRA_STATUS_CATEGORY: Mapping[str, TaskStatus] = {
    "to do": TaskStatus.NOT_STARTED,
    "new": TaskStatus.NOT_STARTED,
    "in progress": TaskStatus.IN_PROGRESS,
    "indeterminate": TaskStatus.IN_PROGRESS,
    "done": TaskStatus.DONE,
    "complete": TaskStatus.DONE,
}


# ---------------------------------------------------------------------------
# The column mapping
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ColumnMapping:
    """Which header names carry which field.

    Every field is a *tuple of candidates* rather than one name, and the first
    candidate that is present in the header wins. Jira instances disagree
    about whether story points live in `Story Points`, `Story point estimate`
    or `Custom field (Story Points)`, and asking a user to rename their export
    before it can be read is not an import feature.
    """

    key: tuple[str, ...]
    name: tuple[str, ...] = ()
    description: tuple[str, ...] = ()
    assignee: tuple[str, ...] = ()
    status: tuple[str, ...] = ()
    status_category: tuple[str, ...] = ()
    story_points: tuple[str, ...] = ()
    estimate: tuple[str, ...] = ()
    due_date: tuple[str, ...] = ()
    created: tuple[str, ...] = ()
    #: Columns whose values name tasks that **this row blocks**: an edge runs
    #: from this row's task to each named task.
    blocks: tuple[str, ...] = ()
    #: Columns whose values name tasks **this row is blocked by**: an edge
    #: runs from each named task to this row's task.
    blocked_by: tuple[str, ...] = ()
    #: Extra status words this caller's tool uses, casefolded, on top of the
    #: built-in vocabulary. Only the generic path sets it.
    status_values: Mapping[str, TaskStatus] = field(default_factory=dict)

    def all_columns(self) -> tuple[str, ...]:
        return (
            self.key + self.name + self.description + self.assignee
            + self.status + self.status_category + self.story_points
            + self.estimate + self.due_date + self.created
            + self.blocks + self.blocked_by
        )


#: The Jira preset.
#:
#: **Direction.** Jira's link *type* here is named "Blocks"; its outward
#: description is "blocks" and its inward description is "is blocked by", and
#: the CSV column prefix names the direction as seen from the exported row's
#: own issue. So on issue X's row:
#:
#:   `Outward issue link (Blocks)` = Y  ->  X blocks Y  ->  edge X -> Y
#:   `Inward issue link (Blocks)`  = Y  ->  X is blocked by Y  ->  edge Y -> X
#:
#: Reversing these silently inverts the entire graph - the critical path runs
#: backwards, the bottleneck becomes a leaf, and nothing in the output looks
#: obviously wrong - so `tests/test_ingest.py` asserts both directions
#: explicitly against a fixture whose intended order a human can read off the
#: summaries.
JIRA_MAPPING = ColumnMapping(
    key=("Issue key", "Key", "Issue Key"),
    name=("Summary",),
    description=("Description",),
    assignee=("Assignee", "Assignee Name"),
    status=("Status",),
    status_category=("Status Category", "Status Category Name"),
    story_points=(
        "Story Points",
        "Story point estimate",
        "Custom field (Story Points)",
        "Custom field (Story point estimate)",
    ),
    estimate=("Original Estimate", "Original estimate", "Custom field (Original Estimate)"),
    due_date=("Due date", "Due Date"),
    created=("Created",),
    blocks=("Outward issue link (Blocks)",),
    blocked_by=("Inward issue link (Blocks)",),
)


#: The generic payload's field names -> the `ColumnMapping` attribute they
#: set. Anything else in the payload is refused by name, because a typo in
#: `blocked_by` that is quietly ignored produces a workflow with half its
#: edges and no complaint.
_GENERIC_FIELDS = {
    "key": "key",
    "name": "name",
    "description": "description",
    "assignee": "assignee",
    "status": "status",
    "status_category": "status_category",
    "story_points": "story_points",
    "effort": "story_points",
    "estimate": "estimate",
    "due_date": "due_date",
    "created": "created",
    "blocks": "blocks",
    "blocked_by": "blocked_by",
}


def mapping_from_payload(payload: Mapping[str, object]) -> ColumnMapping:
    """Build a `ColumnMapping` from the generic path's request body.

    Each field accepts a string or a list of strings. `status_values` accepts
    `{"their word": "our status"}` and is validated against `TaskStatus` here
    rather than at use, so a bad value is a 422 about the mapping and not a
    silent `not_started` three hundred rows later.
    """
    if not isinstance(payload, Mapping):
        raise MappingProblem("`mapping` must be an object of column names.")

    fields: dict[str, tuple[str, ...]] = {}
    for given, value in payload.items():
        if given == "status_values":
            continue
        attribute = _GENERIC_FIELDS.get(given)
        if attribute is None:
            raise MappingProblem(
                f"`mapping.{given}` is not a field this importer knows. "
                f"Known fields: {', '.join(sorted(set(_GENERIC_FIELDS)))}."
            )
        if isinstance(value, str):
            columns = (value,)
        elif isinstance(value, (list, tuple)):
            columns = tuple(str(v) for v in value if str(v).strip())
        elif value is None:
            continue
        else:
            raise MappingProblem(
                f"`mapping.{given}` must be a column name or a list of column "
                f"names; got {type(value).__name__}."
            )
        fields[attribute] = fields.get(attribute, ()) + tuple(
            c.strip() for c in columns if c.strip()
        )

    if not fields.get("key"):
        raise MappingProblem(
            "`mapping.key` is required: without a column that identifies each "
            "row there is no task key to build a workflow from, and nothing "
            "to hang a dependency on."
        )

    raw_values = payload.get("status_values") or {}
    if not isinstance(raw_values, Mapping):
        raise MappingProblem(
            "`mapping.status_values` must be an object mapping your status "
            "words onto ours."
        )
    status_values: dict[str, TaskStatus] = {}
    allowed = ", ".join(s.value for s in TaskStatus)
    for word, ours in raw_values.items():
        try:
            status_values[str(word).strip().casefold()] = TaskStatus(str(ours))
        except ValueError:
            raise MappingProblem(
                f"`mapping.status_values[{word!r}]` is {ours!r}, which is not "
                f"one of our statuses. Use one of: {allowed}."
            )

    return ColumnMapping(status_values=status_values, **fields)


# ---------------------------------------------------------------------------
# Value parsing. Each returns an `Interpretation` or raises `ValueError`.
# ---------------------------------------------------------------------------

#: Jira's own duration syntax, e.g. `2w 3d 4h 30m`.
_DURATION_TOKEN = re.compile(r"(\d+(?:\.\d+)?)\s*([wdhm])", re.IGNORECASE)
_DURATION_ONLY = re.compile(r"^\s*(?:\d+(?:\.\d+)?\s*[wdhm]\s*)+$", re.IGNORECASE)

#: `PROJ-123`. Used to pull a key out of a link cell that carries extra text.
_ISSUE_KEY = re.compile(r"\b[A-Za-z][A-Za-z0-9_]*-\d+\b")

#: An all-numeric slash date is genuinely ambiguous and is refused rather than
#: guessed: 03/04/2026 is two different days on two sides of an ocean, and a
#: deadline off by a month is worse than a rejected row.
_AMBIGUOUS_DATE = re.compile(r"^\d{1,2}/\d{1,2}/\d{2,4}")

#: Formats accepted for a date cell, most specific first. `%d/%b/%y %I:%M %p`
#: is Jira's own default export format.
DATE_FORMATS: tuple[str, ...] = (
    "%Y-%m-%d",
    "%Y/%m/%d",
    "%d/%b/%y %I:%M %p",
    "%d/%b/%Y %I:%M %p",
    "%d/%b/%y %H:%M",
    "%d/%b/%Y %H:%M",
    "%d/%b/%y",
    "%d/%b/%Y",
    "%d-%b-%y",
    "%d-%b-%Y",
    "%b %d, %Y",
)


def parse_date(raw: str) -> date:
    """A calendar date, or `ValueError` naming what was rejected and why."""
    text = raw.strip()
    if not text:
        raise ValueError("the cell is empty")
    if _AMBIGUOUS_DATE.match(text):
        raise ValueError(
            f"'{text}' is an all-numeric slash date, which means two "
            f"different days depending on the locale that wrote it. This "
            f"importer refuses to guess. Re-export with an ISO date "
            f"(2026-09-20) or Jira's default (20/Sep/26)"
        )
    head = text.split("T")[0] if "T" in text else text
    for fmt in DATE_FORMATS:
        for candidate in (text, head):
            try:
                return datetime.strptime(candidate, fmt).date()
            except ValueError:
                continue
    raise ValueError(
        f"'{text}' is not a date this importer recognises. Accepted: "
        f"ISO (2026-09-20) and Jira's default (20/Sep/26 5:00 PM)"
    )


def parse_duration_days(raw: str, hours_per_day: float) -> float:
    """Jira duration syntax (`2w 3d 4h`) in working days.

    A week is five days and a day is `hours_per_day` hours, which is Jira's
    own default and is echoed in the preview's assumptions so a shop that
    works a different week can see what was used.
    """
    if not _DURATION_ONLY.match(raw):
        raise ValueError(f"'{raw}' is not a duration like '2w 3d 4h'")
    hours = 0.0
    for amount, unit in _DURATION_TOKEN.findall(raw):
        value = float(amount)
        unit = unit.lower()
        if unit == "w":
            hours += value * 5 * hours_per_day
        elif unit == "d":
            hours += value * hours_per_day
        elif unit == "h":
            hours += value
        else:
            hours += value / 60.0
    return hours / hours_per_day


def looks_like_duration(raw: str) -> bool:
    return bool(_DURATION_ONLY.match(raw))


def extract_keys(raw: str) -> tuple[list[str], str]:
    """Task keys named by a link cell, and a note about how they were read.

    A Jira link cell holds one bare issue key. Everything else in the wild -
    `blocks DLV-3`, `DLV-3, DLV-7`, `DLV-3; DLV-7` - is handled here rather
    than by asking the user to clean the file first. Returns `([], reason)`
    when nothing usable is in the cell, and the caller reports that as a
    dropped dependency rather than dropping it quietly.
    """
    parts = [p.strip() for p in re.split(r"[;,]", raw) if p.strip()]
    keys: list[str] = []
    extracted = False
    for part in parts:
        if " " not in part:
            keys.append(part)
            continue
        found = _ISSUE_KEY.search(part)
        if found:
            keys.append(found.group(0))
            extracted = True
        else:
            return [], (
                f"'{raw}' does not contain anything that looks like a task "
                f"key, so there is no task to draw an edge to"
            )
    if not keys:
        return [], f"'{raw}' is empty once separators are removed"
    how = (
        "the issue key was extracted from surrounding text"
        if extracted else "read as a task key"
    )
    return keys, how
