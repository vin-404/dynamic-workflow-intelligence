"""
The one command that gives you a clean database.

Drops every table, recreates the schema, loads both seed domains, and prints
the project ids the demo uses. Works with the server stopped - it talks to the
database directly - so it is also how you recover a demo that has been clicked
into an odd state.

    .venv/Scripts/python.exe -m backend.scripts.reset_db
    .venv/Scripts/python.exe -m backend.scripts.reset_db --keep-schema

`--keep-schema` clears the seeded projects without dropping tables, which is
what you want against a Postgres instance you did not create.

There are no migrations to run (decision D-03): the schema is `create_all`,
and a reset is a reset.
"""
from __future__ import annotations

import argparse
import asyncio
import sys

from backend.app.db import Base, async_session, engine
from backend.app.models import *  # noqa: F401,F403 - register models with Base
from backend.app.seed import loader
from backend.app.settings import settings


async def reset(drop: bool = True) -> dict[str, str]:
    if drop:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        async with async_session() as db:
            projects = await loader.seed_all(db)
    else:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with async_session() as db:
            projects = await loader.reset_and_seed(db)
    await engine.dispose()
    return projects


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--keep-schema",
        action="store_true",
        help="clear the seeded data without dropping tables",
    )
    args = parser.parse_args(argv)

    # Say which database, because deleting the wrong one is not recoverable
    # from a flag you did not read.
    url = settings.DATABASE_URL
    print(f"database: {url}")
    print("dropping and recreating" if not args.keep_schema else "clearing seed data")

    projects = asyncio.run(reset(drop=not args.keep_schema))

    print("\nseeded:")
    for key, project_id in projects.items():
        print(f"  {key:<20} {project_id}")
    print("\nready. start the API with:")
    print("  .venv/Scripts/python.exe -m uvicorn backend.app.main:app --port 8001")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
