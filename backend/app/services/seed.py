"""
Seed data service — populates the database with the demo scenario.

Converts scenario.py data into proper database records while preserving
exact values needed for engine regression verification.
"""
from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models import (
    Project, Task, Dependency, Event, Requirement, RequirementConsumer,
    DepartmentCapacity,
)

# The canonical demo project ID (deterministic for easy API access)
DEMO_PROJECT_ID = uuid.UUID("00000000-0000-0000-0000-000000000001")

PROJECT_START = date(2026, 9, 1)
TODAY_DAY = 14.0

TASKS = {
    "T01": dict(name="Define event scope & date",      dept="ORG",  owner="Anitha",  duration=2),
    "T02": dict(name="Draft budget",                    dept="FIN",  owner="Ravi",    duration=3),
    "T03": dict(name="Budget approval",                 dept="FIN",  owner="Deepa",   duration=2),
    "T04": dict(name="Book auditorium",                 dept="FAC",  owner="Suresh",  duration=2),
    "T05": dict(name="Shortlist catering & AV vendors", dept="FAC",  owner="Suresh",  duration=3),
    "T06": dict(name="Vendor contracts",                dept="FIN",  owner="Ravi",    duration=4),
    "T07": dict(name="Sponsor deck",                    dept="SPON", owner="Karthik", duration=3),
    "T08": dict(name="Sponsor outreach",                dept="SPON", owner="Karthik", duration=5),
    "T09": dict(name="Sponsor confirmations",           dept="SPON", owner="Nisha",   duration=4),
    "T10": dict(name="Brand guidelines",                dept="MKT",  owner="Priya",   duration=2),
    "T11": dict(name="Posters & social creatives",      dept="MKT",  owner="Priya",   duration=4),
    "T12": dict(name="Registration site",               dept="MKT",  owner="Arjun",   duration=5),
    "T13": dict(name="Speaker invites",                 dept="ORG",  owner="Anitha",  duration=4),
    "T14": dict(name="Speaker confirmations",           dept="ORG",  owner="Anitha",  duration=5),
    "T15": dict(name="Schedule finalisation",           dept="ORG",  owner="Anitha",  duration=2),
    "T16": dict(name="Print & install signage",         dept="FAC",  owner="Suresh",  duration=3),
    "T17": dict(name="Dry run",                         dept="ORG",  owner="Anitha",  duration=1),
}

DEPS = [
    ("T01", "T02", "artifact"),
    ("T02", "T03", "artifact"),
    ("T01", "T04", "temporal"),
    ("T03", "T04", "temporal"),
    ("T03", "T05", "temporal"),
    ("T05", "T06", "artifact"),
    ("T01", "T07", "artifact"),
    ("T07", "T08", "artifact"),
    ("T08", "T09", "artifact"),
    ("T01", "T10", "artifact"),
    ("T10", "T11", "artifact"),
    ("T09", "T11", "artifact"),
    ("T10", "T12", "artifact"),
    ("T01", "T13", "temporal"),
    ("T03", "T13", "temporal"),
    ("T13", "T14", "artifact"),
    ("T14", "T15", "artifact"),
    ("T04", "T15", "temporal"),
    ("T11", "T16", "artifact"),
    ("T15", "T17", "artifact"),
    ("T16", "T17", "temporal"),
    ("T12", "T17", "temporal"),
    ("T06", "T17", "temporal"),
]

DEPT_CAPACITY = {"ORG": 2, "FIN": 1, "FAC": 1, "MKT": 1, "SPON": 1}

STATUS = {
    "T01": "done",        "T02": "done",        "T03": "in_review",
    "T04": "not_started", "T05": "not_started",  "T06": "not_started",
    "T07": "done",        "T08": "done",         "T09": "done",
    "T10": "done",
    "T11": "not_started", "T12": "not_started",
    "T13": "not_started", "T14": "not_started",  "T15": "not_started",
    "T16": "not_started", "T17": "not_started",
}

EVENTS = [
    dict(day=0.0,  task="T01", actor="Anitha",  frm="not_started", to="in_progress"),
    dict(day=2.0,  task="T01", actor="Anitha",  frm="in_progress", to="done"),
    dict(day=2.0,  task="T02", actor="Ravi",    frm="not_started", to="in_progress"),
    dict(day=5.0,  task="T02", actor="Ravi",    frm="in_progress", to="done"),
    dict(day=5.0,  task="T03", actor="Deepa",   frm="not_started", to="in_review"),
    dict(day=2.0,  task="T07", actor="Karthik", frm="not_started", to="in_progress"),
    dict(day=5.0,  task="T07", actor="Karthik", frm="in_progress", to="done"),
    dict(day=5.0,  task="T08", actor="Karthik", frm="not_started", to="in_progress"),
    dict(day=9.0,  task="T08", actor="Karthik", frm="in_progress", to="done"),
    dict(day=9.0,  task="T09", actor="Nisha",   frm="not_started", to="in_progress"),
    dict(day=13.0, task="T09", actor="Nisha",   frm="in_progress", to="done"),
    dict(day=2.0,  task="T10", actor="Priya",   frm="not_started", to="in_progress"),
    dict(day=4.0,  task="T10", actor="Priya",   frm="in_progress", to="done"),
]

REQUIREMENTS = {
    "R1": dict(
        version=1,
        text="Single-day event, 400 attendees",
        consumed_by=["T02", "T04", "T05", "T12"],
    ),
    "R2": dict(
        version=1,
        text="Signage and creatives in English only",
        consumed_by=["T10", "T11", "T16"],
    ),
    "R3": dict(
        version=1,
        text="On-site only, no streaming",
        consumed_by=["T05", "T12", "T17"],
    ),
}


async def seed_demo_project(db: AsyncSession) -> uuid.UUID:
    """Create the demo project with all data. Returns the project ID.

    Idempotent: if the demo project already exists, it is skipped.
    """
    existing = await db.execute(
        select(Project).where(Project.id == DEMO_PROJECT_ID)
    )
    if existing.scalar_one_or_none() is not None:
        return DEMO_PROJECT_ID

    # Create project
    project = Project(
        id=DEMO_PROJECT_ID,
        name="Campus Tech Symposium",
        description="Annual campus tech symposium — 17 tasks across 5 departments",
        start_date=PROJECT_START,
        today_day=TODAY_DAY,
    )
    db.add(project)

    # Create tasks
    for code, data in TASKS.items():
        task = Task(
            project_id=DEMO_PROJECT_ID,
            task_code=code,
            name=data["name"],
            department=data["dept"],
            owner=data["owner"],
            planned_duration=float(data["duration"]),
            status=STATUS[code],
        )
        db.add(task)

    # Create dependencies
    for pred, succ, kind in DEPS:
        dep = Dependency(
            project_id=DEMO_PROJECT_ID,
            predecessor_code=pred,
            successor_code=succ,
            kind=kind,
        )
        db.add(dep)

    # Create events
    for evt in EVENTS:
        event = Event(
            project_id=DEMO_PROJECT_ID,
            day=evt["day"],
            task_code=evt["task"],
            actor=evt["actor"],
            from_status=evt["frm"],
            to_status=evt["to"],
        )
        db.add(event)

    # Create requirements with consumers
    for code, data in REQUIREMENTS.items():
        req = Requirement(
            project_id=DEMO_PROJECT_ID,
            req_code=code,
            version=data["version"],
            text=data["text"],
        )
        db.add(req)
        await db.flush()  # Get the requirement ID

        for task_code in data["consumed_by"]:
            consumer = RequirementConsumer(
                requirement_id=req.id,
                task_code=task_code,
            )
            db.add(consumer)

    # Create department capacities
    for dept, cap in DEPT_CAPACITY.items():
        dc = DepartmentCapacity(
            project_id=DEMO_PROJECT_ID,
            department=dept,
            capacity=cap,
        )
        db.add(dc)

    await db.commit()
    return DEMO_PROJECT_ID
