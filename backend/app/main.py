"""
Dynamic Workflow Intelligence Platform - FastAPI application.

A modular monolith: one process, one SQLite database, one frontend app. The
only boundaries that earn their complexity are `core/` (purity) and `ai/`
(swappability plus an offline fallback).
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.app.api.routers import (
    ai,
    analysis,
    analysis_runs,
    domains,
    optimize,
    projects,
    scenarios,
    seed,
    workflow,
)
from backend.app.db import Base, async_session, engine
from backend.app.models import *  # noqa: F401,F403 - register models with Base
from backend.app.seed import loader
from backend.app.settings import settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Dev-time schema management: create_all plus a reset-and-seed command,
    # deliberately instead of migrations (decision D-03).
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with async_session() as db:
        await loader.seed_all(db)

    yield

    await engine.dispose()


app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(domains.router)
app.include_router(projects.router)
app.include_router(workflow.router)
app.include_router(analysis.router)
app.include_router(analysis_runs.router)
app.include_router(scenarios.project_router)
app.include_router(scenarios.router)
app.include_router(optimize.router)
app.include_router(ai.router)
app.include_router(ai.status_router)
app.include_router(seed.router)


@app.get("/")
def root():
    return {
        "name": settings.PROJECT_NAME,
        "version": settings.VERSION,
        "status": "running",
    }


@app.get("/health")
def health():
    return {"status": "healthy"}
