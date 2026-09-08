"""
The GitHub webhook receiver.

This is the one write path in the application with no session behind it, so
everything about it is arranged around that single fact.

**Authentication is the signature, and there is no fallback.** GitHub signs
every delivery with HMAC-SHA256 over the raw request body and sends it as
`X-Hub-Signature-256`. We recompute it and compare with `hmac.compare_digest`,
for the reason D-67 gives: `==` on a secret leaks its length and its prefix to
anyone patient enough to measure. With `GITHUB_WEBHOOK_SECRET` unset the
endpoint is **disabled**, exactly as `ADMIN_TOKEN` disables the reset route.
Accepting unsigned deliveries would put an unauthenticated write into the
event log of any project whose id a stranger can guess, and "it is convenient
for testing" is not worth that.

**Which project?** From `?project_id=` on the webhook URL. There is no
repository-to-project table and this phase may not add one, but more
importantly the webhook URL is configured by a human in the repository's
settings - which is exactly the act of saying "this repo is that project", by
someone who has admin rights on the repo. Inferring it from
`repository.full_name` instead would mean a stranger who can name your repo
could pick your project. A delivery with no `project_id` is refused with a
message that says what to add to the URL, and GitHub shows that message in the
delivery log where the person who configured it will read it.

**Which task?** By looking for one of the project's own task keys, as a whole
token, in the issue or PR title, then the head branch, then the body. Nothing
is invented: if no known key appears, the delivery is *accepted* and nothing
is recorded, with the reason stated. That is not a failure - most commits in a
repository are about work this workflow does not track - and answering 500 or
inventing a task would both be worse.

**What gets written.** One `Event` row: an observed status transition. The
webhook never edits the stored workflow version. Reconciling a task's planned
status is an authored, authenticated act, and an unauthenticated caller does
not get to do it by proxy. The event's `from_status` is the last thing the
event log said about that task, which makes redelivery - GitHub retries, and
operators press "Redeliver" - a no-op: the second time round, from equals to
and nothing is appended.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import uuid
from dataclasses import dataclass
from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.workflow import TaskStatus
from backend.app.models import Event, Project, Task, WorkflowVersion

#: GitHub caps a delivery at 25 MB. An `issues` or `pull_request` payload is
#: measured in kilobytes; this ceiling exists so a malformed or hostile
#: delivery is an explained 413 rather than however much memory it asked for.
MAX_WEBHOOK_BYTES = 2 * 1024 * 1024

SIGNATURE_HEADER = "X-Hub-Signature-256"

#: Events with a status meaning. Everything else is accepted and ignored,
#: because a webhook that 500s on `label.created` gets switched off.
HANDLED_EVENTS = ("issues", "pull_request")


class WebhookRefused(Exception):
    """Rejected before anything was read as data. Carries its HTTP status."""

    def __init__(self, status_code: int, detail):
        self.status_code = status_code
        self.detail = detail
        super().__init__(str(detail))


# ---------------------------------------------------------------------------
# Signature
# ---------------------------------------------------------------------------


def expected_signature(body: bytes, secret: str) -> str:
    return "sha256=" + hmac.new(
        secret.encode("utf-8"), body, hashlib.sha256
    ).hexdigest()


def verify_signature(body: bytes, header: str, secret: str) -> None:
    """Raise `WebhookRefused` unless `header` is the right signature.

    An unset secret is a 403 and not a 401: there is no credential that would
    work, so this is "the endpoint is off", not "try again with a better one".
    """
    if not secret:
        raise WebhookRefused(
            403,
            "The GitHub webhook receiver is disabled: this deployment "
            "configures no GITHUB_WEBHOOK_SECRET. A webhook has no session to "
            "authenticate with, so the signature is the whole of its "
            "authentication - accepting unsigned deliveries would make this an "
            "open write endpoint. Set GITHUB_WEBHOOK_SECRET here and the same "
            "value in the repository's webhook settings.",
        )
    if not header:
        raise WebhookRefused(
            401,
            f"Missing {SIGNATURE_HEADER}. GitHub sends it on every delivery "
            f"once a secret is configured on the webhook; if you are testing "
            f"by hand, sign the raw body with HMAC-SHA256.",
        )
    if not hmac.compare_digest(header.strip(), expected_signature(body, secret)):
        raise WebhookRefused(
            401,
            f"The {SIGNATURE_HEADER} on this delivery does not match a "
            f"signature over its body with the configured secret. Nothing was "
            f"read as data.",
        )


# ---------------------------------------------------------------------------
# What the event means
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Transition:
    to_status: TaskStatus
    #: One sentence naming the GitHub event and the reading taken from it.
    because: str


#: `(event, action)` -> what it says about the work, and why.
#:
#: Only transitions are listed. `edited`, `labeled`, `assigned`,
#: `synchronize` and the rest say nothing about *state*, and recording them
#: would fill the event log with entries the Tier-2 detectors would then
#: reason over as if they were status changes.
_MEANINGS: dict[tuple[str, str], Transition] = {
    ("issues", "opened"): Transition(
        TaskStatus.NOT_STARTED, "the issue was opened, so the work exists and has not begun"
    ),
    ("issues", "reopened"): Transition(
        TaskStatus.NOT_STARTED, "the issue was reopened, so the work is live again"
    ),
    ("issues", "closed"): Transition(
        TaskStatus.DONE, "the issue was closed"
    ),
    ("pull_request", "opened"): Transition(
        TaskStatus.IN_REVIEW, "a pull request was opened, so finished work is waiting on a human"
    ),
    ("pull_request", "reopened"): Transition(
        TaskStatus.IN_REVIEW, "the pull request was reopened and is waiting on a human again"
    ),
    ("pull_request", "ready_for_review"): Transition(
        TaskStatus.IN_REVIEW, "the pull request left draft, so it is waiting on a human"
    ),
    ("pull_request", "converted_to_draft"): Transition(
        TaskStatus.IN_PROGRESS,
        "the pull request went back to draft, so it is being worked on rather than reviewed",
    ),
}


def interpret(event: str, payload: dict) -> Transition | None:
    """The status this delivery reports, or `None` if it reports none."""
    action = str(payload.get("action") or "")
    if event == "pull_request" and action == "closed":
        merged = bool((payload.get("pull_request") or {}).get("merged"))
        if merged:
            return Transition(
                TaskStatus.DONE, "the pull request was merged"
            )
        return Transition(
            TaskStatus.IN_PROGRESS,
            "the pull request was closed without merging, so the review ended "
            "but the work did not land",
        )
    return _MEANINGS.get((event, action))


# ---------------------------------------------------------------------------
# Which task
# ---------------------------------------------------------------------------


def _token_pattern(key: str) -> re.Pattern[str]:
    """`DLV-4` as a whole token.

    The boundary class deliberately excludes letters, digits and underscore
    but **not** the hyphen: a branch called `feature/DLV-4-contract-tests`
    separates with hyphens, and treating one as part of the key would mean the
    convention people actually use never matches. Excluding digits is what
    stops `DLV-1` from matching inside `DLV-11`, which is the collision that
    matters - task keys end in a number.
    """
    escaped = re.escape(key)
    return re.compile(rf"(?<![A-Za-z0-9_]){escaped}(?![A-Za-z0-9_])")


def find_task_key(
    event: str, payload: dict, known_keys: tuple[str, ...]
) -> tuple[str | None, str]:
    """The project task key this delivery is about, and how it was found.

    Searched in title, then head branch (pull requests only), then body: the
    order runs from what a person deliberately typed to what they might have
    pasted. Within one field the earliest match wins, and a longer key beats a
    shorter one starting at the same place, so `DLV-1` never shadows `DLV-11`.
    """
    subject = payload.get("pull_request") or payload.get("issue") or {}
    fields: list[tuple[str, str]] = [("title", str(subject.get("title") or ""))]
    if event == "pull_request":
        head = (subject.get("head") or {}).get("ref")
        fields.append(("head branch", str(head or "")))
    fields.append(("body", str(subject.get("body") or "")))

    for where, text in fields:
        if not text:
            continue
        best: tuple[int, int, str] | None = None
        for key in known_keys:
            found = _token_pattern(key).search(text)
            if found and (
                best is None
                or (found.start(), -len(key)) < (best[0], best[1])
            ):
                best = (found.start(), -len(key), key)
        if best is not None:
            return best[2], f"the task key appears in the {where}"

    return None, (
        f"no task key from this project appears in the {event} title"
        + (", head branch" if event == "pull_request" else "")
        + f" or body. The project has {len(known_keys)} task key(s); nothing "
        f"was recorded, and no task was invented."
    )


def event_day(payload: dict, start: date, fallback: float) -> tuple[float, str]:
    """The delivery's timestamp as a day offset from the project start."""
    subject = payload.get("pull_request") or payload.get("issue") or {}
    for field in ("merged_at", "closed_at", "updated_at", "created_at"):
        raw = subject.get(field)
        if not raw:
            continue
        try:
            when = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        except ValueError:
            continue
        day = float((when.date() - start).days)
        if day < 0:
            return 0.0, (
                f"the event's {field} ({when.date().isoformat()}) is before the "
                f"project start ({start.isoformat()}), so it was clamped to "
                f"day 0"
            )
        return day, f"the event's {field} against the project start date"
    return fallback, (
        "the delivery carried no usable timestamp, so the project's current "
        "day was used"
    )


# ---------------------------------------------------------------------------
# Recording
# ---------------------------------------------------------------------------


async def known_task_keys(
    db: AsyncSession, project: Project
) -> tuple[tuple[str, ...], uuid.UUID | None]:
    """Task keys of the project's current version, longest first.

    Longest first only matters for the tie-break in `find_task_key`; the DB
    order is not relied on anywhere.
    """
    version_id = project.current_version_id
    if version_id is None:
        latest = (
            await db.execute(
                select(WorkflowVersion.id)
                .where(WorkflowVersion.project_id == project.id)
                .order_by(WorkflowVersion.version_no.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        version_id = latest
    if version_id is None:
        return (), None
    keys = (
        await db.execute(select(Task.key).where(Task.version_id == version_id))
    ).scalars().all()
    return tuple(sorted(keys, key=lambda k: (-len(k), k))), version_id


async def current_status(
    db: AsyncSession, project_id: uuid.UUID, version_id: uuid.UUID | None, key: str
) -> TaskStatus:
    """What the event log last said about this task, else its planned status.

    Reading the log first is what makes a redelivery a no-op: the second
    delivery of the same event finds its own `to_status` already there, so
    `from` equals `to` and nothing is appended.
    """
    last = (
        await db.execute(
            select(Event.to_status)
            .where(Event.project_id == project_id, Event.task_key == key)
            .order_by(Event.day.desc(), Event.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if last is not None:
        try:
            return TaskStatus(last)
        except ValueError:  # pragma: no cover - a status we no longer have
            return TaskStatus.NOT_STARTED
    if version_id is not None:
        planned = (
            await db.execute(
                select(Task.status).where(
                    Task.version_id == version_id, Task.key == key
                )
            )
        ).scalar_one_or_none()
        if planned is not None:
            try:
                return TaskStatus(planned)
            except ValueError:  # pragma: no cover
                return TaskStatus.NOT_STARTED
    return TaskStatus.NOT_STARTED


def actor_of(payload: dict) -> str:
    sender = payload.get("sender") or {}
    return str(sender.get("login") or "github")[:255]
