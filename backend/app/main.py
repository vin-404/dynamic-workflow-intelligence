"""
Dynamic Workflow Intelligence Platform - FastAPI application.

A modular monolith: one process, one database, one frontend app. The only
boundaries that earn their complexity are `core/` (purity) and `ai/`
(swappability plus an offline fallback).

This module owns four things a user notices within five minutes:

* **Structured errors.** Every 4xx and 5xx is `{error, detail, hint}`. The
  hint says what to do, because "422 Unprocessable Entity" is not a thing
  anybody can act on. The rich validation reasons the engine produces are
  passed through, never flattened.
* **A request id on everything.** One structured log line per request with
  the id, method, path, status and duration, and the same id on any error
  response - so "it broke at 14:02" becomes a grep.
* **Liveness and readiness are different questions.** `/health` says the
  process is up. `/ready` says the database answers.
* **Bounded work.** Analyze, simulate and optimize run under a timeout and
  return an explained 503 rather than holding a connection open.
"""
import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import HTTPException, RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from starlette.exceptions import HTTPException as StarletteHTTPException

from backend.app.api.routers import (
    admin,
    ai,
    analysis,
    analysis_runs,
    domains,
    forecast,
    ingest,
    optimize,
    projects,
    requirements,
    scenarios,
    seed,
    stream,
    users,
    workflow,
)
from backend.app.db import Base, async_session, engine
from backend.app.models import *  # noqa: F401,F403 - register models with Base
from backend.app.seed import loader
from backend.app.settings import settings

log = logging.getLogger("dwi")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Dev-time schema management: create_all plus a reset-and-seed command,
    # deliberately instead of migrations (decision D-03). `create_all` is a
    # no-op against an existing schema, on SQLite and on Postgres alike.
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    if settings.SEED_ON_STARTUP:
        # Idempotent by project id: a restart against a populated database
        # writes nothing. Failing to seed must not stop the process from
        # serving - an empty database is recoverable, a crash loop is not.
        async with async_session() as db:
            try:
                await loader.seed_all(db)
            except Exception:  # pragma: no cover - depends on the database
                log.exception("seed_failed")
                await db.rollback()

    yield

    await engine.dispose()


app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    # Exact origins only. `settings` refuses a wildcard here, because a
    # wildcard with credentials is rejected by every browser anyway - it looks
    # permissive and behaves like a blocklist.
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID"],
)


# ---------------------------------------------------------------------------
# Request id and one structured log line per request
# ---------------------------------------------------------------------------


@app.middleware("http")
async def request_context(request: Request, call_next):
    """Tag every request, time it, log one line.

    Deliberately **no request bodies** in the log: they carry workflow content
    and, on the AI routes, whatever a user typed.
    """
    request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:12]
    request.state.request_id = request_id
    started = time.perf_counter()

    try:
        response = await call_next(request)
    except Exception:
        duration_ms = (time.perf_counter() - started) * 1000
        log.exception(
            "request_failed",
            extra={
                "request_id": request_id,
                "method": request.method,
                "path": request.url.path,
                "duration_ms": round(duration_ms, 1),
            },
        )
        raise

    duration_ms = (time.perf_counter() - started) * 1000
    response.headers["X-Request-ID"] = request_id
    log.info(
        "%s %s %s %sms id=%s",
        request.method,
        request.url.path,
        response.status_code,
        round(duration_ms, 1),
        request_id,
        extra={
            "request_id": request_id,
            "method": request.method,
            "path": request.url.path,
            "status": response.status_code,
            "duration_ms": round(duration_ms, 1),
        },
    )
    return response


# ---------------------------------------------------------------------------
# Structured errors: {error, detail, hint}
# ---------------------------------------------------------------------------

#: What to do about it, by status. A hint that does not tell the user their
#: next action is decoration.
HINTS = {
    400: "Check the values you sent; the detail says which one is wrong.",
    401: "This endpoint needs an admin token. Set ADMIN_TOKEN and send it as "
         "X-Admin-Token.",
    403: "Either you are not allowed to do this, or the endpoint is "
         "disabled in this deployment. The detail says which one, and "
         "what to do about it.",
    404: "That id does not exist here. It may have been reset - reload the "
         "project list.",
    409: "Something changed underneath this request. Reload and try again.",
    422: "The change was refused for the reason in the detail. Adjust it and "
         "resubmit; nothing was written.",
    500: "This is a bug on our side. The request id in this response is "
         "enough to find it in the logs.",
    503: "The request took longer than its budget and was stopped. Narrow the "
         "request - fewer candidates, or a smaller time budget - and retry.",
}


def _error_body(status: int, detail, request: Request, error: str) -> dict:
    return {
        "error": error,
        "detail": detail,
        "hint": HINTS.get(status, "Retry, and if it persists report the "
                                  "request id below."),
        "request_id": getattr(request.state, "request_id", None),
    }


@app.exception_handler(StarletteHTTPException)
async def http_error(request: Request, exc: StarletteHTTPException):
    """Pass the detail through untouched.

    The mutation validator produces `{rejections: [{constraint, reason, ...}]}`
    and the graph validator produces `{cycles: [...]}`. Those structures are
    the product - flattening them to a string here would throw away the only
    part the user can act on.
    """
    return JSONResponse(
        status_code=exc.status_code,
        content=_error_body(
            exc.status_code, exc.detail, request,
            error=_ERROR_NAMES.get(exc.status_code, "request_failed"),
        ),
        headers={"X-Request-ID": getattr(request.state, "request_id", "")},
    )


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    """A malformed request body. Reported field by field, in plain terms."""
    problems = [
        {
            "field": ".".join(str(p) for p in err["loc"][1:]) or "body",
            "problem": err["msg"],
        }
        for err in exc.errors()
    ]
    return JSONResponse(
        status_code=422,
        content=_error_body(422, {"invalid_fields": problems}, request,
                            error="invalid_request"),
    )


@app.exception_handler(TimeoutError)
async def timeout_error(request: Request, exc: TimeoutError):
    return JSONResponse(
        status_code=503,
        content=_error_body(503, str(exc) or "The request exceeded its time "
                                             "budget.", request,
                            error="timed_out"),
    )


@app.exception_handler(Exception)
async def unhandled_error(request: Request, exc: Exception):
    """The last line. Never a stack trace to a user in production."""
    request_id = getattr(request.state, "request_id", None)
    log.exception("unhandled_error", extra={"request_id": request_id})
    detail = (
        f"{type(exc).__name__}: {exc}" if not settings.is_production
        else "An unexpected error occurred."
    )
    return JSONResponse(
        status_code=500,
        content=_error_body(500, detail, request, error="internal_error"),
    )


_ERROR_NAMES = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    422: "rejected",
    503: "unavailable",
}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

app.include_router(domains.router)
app.include_router(projects.router)
app.include_router(workflow.router)
app.include_router(analysis.router)
app.include_router(analysis_runs.router)
app.include_router(scenarios.project_router)
app.include_router(scenarios.router)
app.include_router(optimize.router)
# Phase 11. The route templates these declare are the contract `deps.py` and
# the frontend are written against; the bodies land in wave 2.
app.include_router(stream.router)
app.include_router(forecast.router)
app.include_router(requirements.router)
app.include_router(ingest.router)
app.include_router(ingest.webhook_router)
app.include_router(ai.router)
app.include_router(ai.status_router)
app.include_router(seed.router)
app.include_router(users.router)
app.include_router(admin.router)


@app.get("/")
def root():
    return {
        "name": settings.PROJECT_NAME,
        "version": settings.VERSION,
        "status": "running",
    }


@app.get("/health")
def health():
    """Liveness only: is this process running?

    Deliberately does not touch the database. A platform that restarts the
    container when the database blips turns a recoverable outage into a crash
    loop.
    """
    return {"status": "healthy"}


@app.get("/ready")
async def ready():
    """Readiness: can this process actually serve a request?

    One trivial query. If the database does not answer, the container is
    running but useless, and a load balancer should know the difference.
    """
    started = time.perf_counter()
    try:
        async with async_session() as db:
            await db.execute(text("SELECT 1"))
    except Exception as exc:
        log.warning("not_ready: %s", exc)
        return JSONResponse(
            status_code=503,
            content={
                "status": "not_ready",
                "database": "unreachable",
                "detail": f"{type(exc).__name__}: {exc}",
                "hint": "Check DATABASE_URL and that the database accepts "
                        "connections from this host.",
            },
        )
    return {
        "status": "ready",
        "database": "sqlite" if settings.is_sqlite else "postgres",
        "latency_ms": round((time.perf_counter() - started) * 1000, 2),
    }
