"""
Dynamic Workflow Intelligence Platform — FastAPI application.
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.app.core.config import settings
from backend.app.core.database import engine, async_session
from backend.app.core.database import Base
from backend.app.models import (  # noqa: F401 — register models with Base
    Project, Task, Dependency, Event, Requirement, RequirementConsumer,
    DepartmentCapacity,
)
from backend.app.api.routers import projects, simulate, tasks, seed
from backend.app.services.seed import seed_demo_project


@asynccontextmanager
async def lifespan(app: FastAPI):
    # On startup: create tables (for dev; Alembic handles production)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # Seed demo data
    async with async_session() as db:
        await seed_demo_project(db)

    yield

    # On shutdown
    await engine.dispose()


app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
app.include_router(projects.router)
app.include_router(simulate.router)
app.include_router(tasks.router)
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
