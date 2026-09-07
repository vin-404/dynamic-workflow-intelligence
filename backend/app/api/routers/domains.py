"""Domains - a table, not an enum.

The seeded domains are ordinary rows; a user-created one is the same row with
`is_custom=True`. Nothing downstream branches on which is which, and nothing
in `core/` ever sees either.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db import get_db
from backend.app.models import Domain
from backend.app.schemas.authoring import DomainIn, DomainOut

router = APIRouter(prefix="/api/domains", tags=["domains"])


@router.get("", response_model=list[DomainOut])
async def list_domains(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(Domain).order_by(Domain.name))).scalars().all()
    return list(rows)


@router.post("", response_model=DomainOut, status_code=201)
async def create_domain(payload: DomainIn, db: AsyncSession = Depends(get_db)):
    existing = (
        await db.execute(select(Domain).where(Domain.key == payload.key))
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(
            status_code=422,
            detail=f"A domain with key {payload.key!r} already exists.",
        )
    row = Domain(
        key=payload.key,
        name=payload.name,
        description=payload.description,
        vocabulary_hints=list(payload.vocabulary_hints),
        task_templates=[dict(t) for t in payload.task_templates],
        duration_variance_prior=payload.duration_variance_prior,
        is_custom=True,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row
