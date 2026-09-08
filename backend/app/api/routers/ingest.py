"""
Getting data in without typing it - Jira CSV import, a generic mapped CSV
path, and a GitHub webhook receiver.

Owned by Agent INGEST (Phase 11 wave 2).

Two routers on purpose. `router` carries the project role guard: importing is
authorship, so it needs an identity. `webhook_router` cannot, because a
webhook has no session - it is authenticated by an HMAC signature over the
body instead, and rejects outright when no secret is configured.

**Why the bodies are read by hand instead of being declared as parameters.**
FastAPI reads and parses a request body *before* it solves dependencies, so a
`Depends(...)` cannot get in front of a 500 MB upload - by the time it runs,
the body is already in memory. So these routes take the raw `Request`, read it
in chunks against a ceiling, and validate the parsed object against the same
pydantic models by hand. A body that is too large is an explained 413 instead
of an out-of-memory kill, and `openapi_extra` keeps the documented request
schema. The validation errors are re-raised as `RequestValidationError` so
that `main.py` renders them in exactly the `{invalid_fields: [...]}` shape
every other endpoint produces.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field, ValidationError, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.deps import project_role_guard
from backend.app.api.identity import current_user
from backend.app.db import get_db
from backend.app.ingest import bundled as S
from backend.app.ingest.commit import CommitRefused, commit_plan
from backend.app.ingest.csvsource import CsvProblem
from backend.app.ingest.github import (
    HANDLED_EVENTS,
    MAX_WEBHOOK_BYTES,
    SIGNATURE_HEADER,
    WebhookRefused,
    actor_of,
    current_status,
    event_day,
    find_task_key,
    interpret,
    known_task_keys,
    verify_signature,
)
from backend.app.ingest.mapping import JIRA_MAPPING, MappingProblem, mapping_from_payload
from backend.app.ingest.plan import ImportOptions, build_plan
from backend.app.ingest.preview import preview_payload
from backend.app.models import Event, Project, User
from backend.app.settings import settings

router = APIRouter(
    prefix="/api/import", tags=["import"], dependencies=[project_role_guard]
)
webhook_router = APIRouter(prefix="/api/ingest", tags=["ingest"])

#: A 5 MB CSV JSON-escapes to something under twice its size, and the parser
#: refuses anything larger than that anyway. This is the outer wall: it is
#: what stops a 500 MB POST from being read into memory at all.
MAX_BODY_BYTES = 12 * 1024 * 1024


# ---------------------------------------------------------------------------
# Request bodies
# ---------------------------------------------------------------------------


class ImportRequest(BaseModel):
    """What to parse, and how to read the numbers in it.

    `csv_text` carries the file as text rather than as a multipart upload: the
    browser reads the file, the JSON body carries it, and the same body is
    posted again at commit. That is what makes preview stateless - there is no
    import-batch row on the server holding a half-finished import, and
    therefore nothing to expire, collide or leak.
    """

    source: Literal["jira", "csv"] = "jira"
    #: The file itself. Exactly one of `csv_text` and `sample` is required.
    csv_text: str | None = None
    #: The name of a bundled sample, for the demo path that ships with no file.
    sample: str | None = None
    #: Required when `source` is "csv". Ignored for "jira", which has a preset.
    mapping: dict | None = None

    delimiter: str = Field(default=",", min_length=1, max_length=1)
    story_point_days: float = Field(default=1.0, gt=0)
    hours_per_day: float = Field(default=8.0, gt=0)
    estimate_unit: Literal["seconds", "hours", "days"] = "seconds"
    default_effort_days: float = Field(default=1.0, ge=0)
    start_date: date | None = None
    deadline: date | None = None

    @model_validator(mode="after")
    def _one_source(self):
        if bool(self.csv_text) == bool(self.sample):
            raise ValueError(
                "send exactly one of `csv_text` (the file) or `sample` (the "
                "name of a bundled sample)"
            )
        if self.source == "csv" and not self.mapping:
            raise ValueError(
                "`mapping` is required when source is 'csv': without it there "
                "is nothing to say which of your columns is the key, and no "
                "amount of guessing would be honest about it"
            )
        return self

    def options(self) -> ImportOptions:
        return ImportOptions(
            story_point_days=self.story_point_days,
            hours_per_day=self.hours_per_day,
            estimate_unit=self.estimate_unit,
            default_effort_days=self.default_effort_days,
            delimiter=self.delimiter,
            start_date=self.start_date,
            deadline=self.deadline,
        )


class CommitRequest(ImportRequest):
    """The same body, plus what the new project is called.

    Note what is absent: there is no `project_id`. An import creates a
    project; it never merges into a live one.
    """

    name: str = Field(min_length=1, max_length=255)
    description: str = ""
    goal: str = ""
    domain_id: uuid.UUID | None = None
    today_day: float = 0.0
    owner_email: str | None = None


# ---------------------------------------------------------------------------
# Bounded body reading
# ---------------------------------------------------------------------------


async def read_bounded_body(request: Request, max_bytes: int, what: str) -> bytes:
    """Read the request body in chunks, refusing once it exceeds `max_bytes`.

    The declared `Content-Length` is checked first so an honest client is
    refused before it uploads anything, and the running total is checked as
    well so a chunked or lying client is refused at the ceiling rather than at
    the end.
    """
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > max_bytes:
        raise HTTPException(status_code=413, detail=_too_big(int(declared), max_bytes, what))

    chunks = bytearray()
    async for chunk in request.stream():
        chunks.extend(chunk)
        if len(chunks) > max_bytes:
            raise HTTPException(
                status_code=413, detail=_too_big(None, max_bytes, what)
            )
    return bytes(chunks)


def _too_big(size: int | None, max_bytes: int, what: str) -> str:
    seen = f"{size / 1_048_576:.1f} MB" if size else "more than the ceiling"
    return (
        f"That {what} is {seen} and this endpoint accepts at most "
        f"{max_bytes / 1_048_576:.0f} MB. Nothing was read. Export a filtered "
        f"issue set rather than a whole instance."
    )


def _parse_body(raw: bytes, model: type[BaseModel]) -> BaseModel:
    """JSON-decode and validate, producing this application's usual errors."""
    if not raw.strip():
        raise HTTPException(
            status_code=422,
            detail="The request body is empty; this endpoint needs a JSON object.",
        )
    try:
        decoded = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(
            status_code=422, detail=f"The request body is not valid JSON: {exc}"
        )
    if not isinstance(decoded, dict):
        raise HTTPException(
            status_code=422,
            detail="The request body must be a JSON object, not a "
                   f"{type(decoded).__name__}.",
        )
    try:
        return model.model_validate(decoded)
    except ValidationError as exc:
        # `main.py`'s handler strips the first element of `loc` because
        # FastAPI's own body errors are prefixed with "body". Prefixing here
        # keeps the field names in the rendered response.
        raise RequestValidationError(
            [{**err, "loc": ("body", *err.get("loc", ()))} for err in exc.errors()]
        )


def _schema(model: type[BaseModel]) -> dict:
    return {
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": model.model_json_schema()}},
        }
    }


# ---------------------------------------------------------------------------
# The pipeline, shared by preview and commit
# ---------------------------------------------------------------------------


def _plan_and_preview(payload: ImportRequest) -> tuple:
    """Parse, and return `(plan, preview payload)`.

    Commit calls this too, rather than trusting anything the preview call left
    behind. Re-parsing is cheap, and it is the only way to be sure that what is
    written is what the same bytes produce.
    """
    text = payload.csv_text
    if payload.sample is not None:
        try:
            text = S.read_sample(payload.sample)
        except S.UnknownSample as exc:
            raise HTTPException(status_code=404, detail=str(exc))
    assert text is not None  # the model validator guarantees one of the two

    try:
        mapping = (
            JIRA_MAPPING if payload.source == "jira"
            else mapping_from_payload(payload.mapping or {})
        )
    except MappingProblem as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    try:
        options = payload.options()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    try:
        plan = build_plan(text, mapping, options, source=payload.source)
    except CsvProblem as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return plan, preview_payload(plan, digest)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("/preview", openapi_extra=_schema(ImportRequest))
async def preview(request: Request):
    """What this file would create, what it would not, and why.

    Returns the tasks, dependencies, resources and assignments that would be
    written; a per-row account of every value that was interpreted, with the
    caller's own raw text beside it; every row that could not be mapped, with
    its number and its raw content; every dependency that named something the
    file does not contain; and any cycle the import would introduce, named as
    a task-key path.

    Writes nothing, and holds nothing: commit re-parses from the same body.
    """
    body = await read_bounded_body(request, MAX_BODY_BYTES, "import")
    payload = _parse_body(body, ImportRequest)
    _, out = _plan_and_preview(payload)
    return out


@router.post("/commit", status_code=201, openapi_extra=_schema(CommitRequest))
async def commit(
    request: Request,
    db: AsyncSession = Depends(get_db),
    who: User | None = Depends(current_user),
):
    """Create a new project from the file. Never merges into an existing one.

    Refuses with a 422 when the preview would have said `can_commit: false` -
    a cycle, or nothing to import - and carries the rejected rows and dropped
    dependencies into its own response, so committing cannot be a way to stop
    seeing them.
    """
    body = await read_bounded_body(request, MAX_BODY_BYTES, "import")
    payload = _parse_body(body, CommitRequest)
    plan, out = _plan_and_preview(payload)

    try:
        created = await commit_plan(
            db,
            plan,
            name=payload.name,
            description=payload.description,
            goal=payload.goal,
            domain_id=payload.domain_id,
            today_day=payload.today_day,
            owner_email=payload.owner_email,
            who=who,
            blocking=out["blocking"],
            csv_sha256=out["csv_sha256"],
        )
    except CommitRefused as exc:
        raise HTTPException(status_code=422, detail=exc.detail)

    return {
        "project": created,
        "source": out["source"],
        "csv_sha256": out["csv_sha256"],
        "counts": out["counts"],
        "rejected_rows": out["rejected_rows"],
        "dropped_dependencies": out["dropped_dependencies"],
        "unmapped_columns": out["unmapped_columns"],
        "assumptions": out["assumptions"],
        "next": (
            f"POST /api/projects/{created['project_id']}/analyze to see what "
            f"the imported plan looks like. The event log is empty, so the "
            f"analysis will say which of its checks it could not run."
        ),
    }


@router.get("/samples")
async def samples():
    """The files that ship with this importer, so a demo needs no network."""
    return {
        "samples": [S.sample_summary(s) for s in S.IMPORT_SAMPLES],
        "note": (
            "Every claim in `demonstrates` is asserted by "
            "backend/tests/test_ingest.py against the file itself."
        ),
    }


@router.get("/samples/{name}")
async def sample(name: str):
    """One sample, with a body that can be posted to `/preview` unchanged."""
    try:
        found = S.get_sample(name)
    except S.UnknownSample as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {**S.sample_summary(found), "suggested": S.suggested_body(found)}


@router.get("/samples/{name}/raw", response_class=PlainTextResponse)
async def sample_raw(name: str):
    """The sample as a CSV file, for saving and re-uploading by hand."""
    try:
        text = S.read_sample(name)
    except S.UnknownSample as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return PlainTextResponse(text, media_type="text/csv; charset=utf-8")


# ---------------------------------------------------------------------------
# The webhook
# ---------------------------------------------------------------------------


@webhook_router.post("/github")
async def github(
    request: Request,
    project_id: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Receive a signed GitHub `issues` or `pull_request` delivery.

    Authenticated by `X-Hub-Signature-256` over the raw body, and **disabled**
    when `GITHUB_WEBHOOK_SECRET` is unset - there is no unsigned path in.

    The project comes from `?project_id=` on the webhook URL, which is the act
    of a repository admin saying "this repo is that project"; the task comes
    from a task key appearing in the title, head branch or body. A delivery
    that resolves to neither is accepted and recorded as nothing, with the
    reason stated: most activity in a repository is about work this workflow
    does not track, and inventing a task for it would be worse than saying so.

    A verified, resolvable delivery appends exactly one `Event`. It never
    edits the stored workflow version.
    """
    body = await read_bounded_body(request, MAX_WEBHOOK_BYTES, "webhook delivery")
    try:
        verify_signature(
            body,
            request.headers.get(SIGNATURE_HEADER, ""),
            settings.GITHUB_WEBHOOK_SECRET,
        )
    except WebhookRefused as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)

    event = request.headers.get("X-GitHub-Event", "").strip()
    delivery = request.headers.get("X-GitHub-Delivery", "")

    try:
        payload = json.loads(body) if body.strip() else {}
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(
            status_code=422,
            detail=f"The delivery body is signed but is not valid JSON: {exc}",
        )
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=422,
            detail="The delivery body is signed but is not a JSON object.",
        )

    def accepted(reason: str, **extra) -> JSONResponse:
        return JSONResponse(
            status_code=202,
            content={
                "recorded": False,
                "event": event,
                "action": payload.get("action"),
                "delivery_id": delivery,
                "reason": reason,
                **extra,
            },
        )

    if event == "ping":
        return JSONResponse(
            status_code=200,
            content={
                "recorded": False,
                "event": "ping",
                "delivery_id": delivery,
                "reason": (
                    "Signature verified. This receiver handles "
                    f"{' and '.join(HANDLED_EVENTS)} events."
                ),
            },
        )

    if event not in HANDLED_EVENTS:
        return accepted(
            f"'{event or 'an unnamed event'}' is not an event this receiver "
            f"reads. It handles {' and '.join(HANDLED_EVENTS)}; everything "
            f"else is accepted and ignored, because a webhook that errors on "
            f"an event it does not want gets switched off."
        )

    if project_id is None:
        raise HTTPException(
            status_code=422,
            detail=(
                "This delivery names no project. Add `?project_id=<the project "
                "id>` to the webhook URL in the repository's settings - that "
                "is how a repository admin says which workflow this repository "
                "reports to. There is no repository-to-project mapping stored "
                "here, deliberately: inferring it from the repository name "
                "would let anyone who can guess a repository name pick your "
                "project."
            ),
        )

    project = (
        await db.execute(select(Project).where(Project.id == project_id))
    ).scalar_one_or_none()
    if project is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"No project {project_id}. The webhook URL points at a project "
                f"that does not exist here - it may have been reset."
            ),
        )

    transition = interpret(event, payload)
    if transition is None:
        return accepted(
            f"'{event}.{payload.get('action')}' says nothing about whether the "
            f"work moved. Only transitions are recorded; recording an edit or "
            f"a label would put entries in the event log that the historical "
            f"detectors would then read as status changes.",
            project_id=str(project.id),
        )

    keys, version_id = await known_task_keys(db, project)
    task_key, how = find_task_key(event, payload, keys)
    if task_key is None:
        return accepted(how, project_id=str(project.id))

    was = await current_status(db, project.id, version_id, task_key)
    if was == transition.to_status:
        return accepted(
            f"{task_key} is already {was.value} in this project's event log, so "
            f"this delivery adds nothing. A redelivery of an event that was "
            f"already recorded lands here.",
            project_id=str(project.id),
            task_key=task_key,
        )

    day, day_how = event_day(payload, project.start_date, project.today_day)
    row = Event(
        project_id=project.id,
        day=day,
        task_key=task_key,
        actor=actor_of(payload),
        from_status=was.value,
        to_status=transition.to_status.value,
    )
    db.add(row)
    await db.commit()

    return {
        "recorded": True,
        "event": event,
        "action": payload.get("action"),
        "delivery_id": delivery,
        "project_id": str(project.id),
        "task_key": task_key,
        "appended": {
            "day": day,
            "task_key": task_key,
            "actor": row.actor,
            "from_status": row.from_status,
            "to_status": row.to_status,
        },
        "because": transition.because,
        "how": {
            "task": how,
            "day": day_how,
            "workflow": (
                "the event log was appended to. The stored workflow version "
                "was not edited: changing the plan is an authored, "
                "authenticated act, and this request has no identity."
            ),
        },
    }
