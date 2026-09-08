"""
The files that ship with the importer.

A demo that has to reach the internet is a demo that fails on conference
wifi, so one real, anonymised, Jira-shaped export lives in this package and is
served from `GET /api/import/samples`. It is a fixture in the same sense as
the two seeded projects: something the product ships so that the first thing a
new reader does can be a real thing rather than a form.

What it is *not* is a domain or a seeded project. Nothing here is written to
the database at startup, and `backend/app/seed/fixtures.py` holds only the
inventory entry - the name, the claims, and the file name - so that "what
ships with this product" stays listed in one place.

The module is `bundled` and the directory beside it is `samples/`, rather than
both being called the same thing. A `samples.py` next to a `samples/` resolves
today only because the directory has no `__init__.py`; the day somebody adds
one to ship the CSV as package data, the module would be shadowed and the
import error would point nowhere near the cause.
"""
from __future__ import annotations

import hashlib
import pathlib

from backend.app.ingest.csvsource import check_size
from backend.app.seed.fixtures import IMPORT_SAMPLES, ImportSampleFixture, import_sample

SAMPLE_DIR = pathlib.Path(__file__).resolve().parent / "samples"


class UnknownSample(KeyError):
    """No sample by that name. The router turns it into a 404."""


def sample_names() -> tuple[str, ...]:
    return tuple(s.name for s in IMPORT_SAMPLES)


def get_sample(name: str) -> ImportSampleFixture:
    """Look up by name against the registry, never by path.

    The name arrives from a URL, so it is never joined onto a filesystem path:
    it selects a record whose `filename` this package wrote. `../../.env` is
    then simply a name that is not in the registry.
    """
    try:
        return import_sample(name)
    except KeyError as exc:
        raise UnknownSample(str(exc)) from None


def read_sample(name: str) -> str:
    sample = get_sample(name)
    path = SAMPLE_DIR / sample.filename
    text = path.read_text(encoding="utf-8")
    check_size(text)
    return text


def sample_summary(sample: ImportSampleFixture) -> dict:
    text = (SAMPLE_DIR / sample.filename).read_text(encoding="utf-8")
    records = text.count("\n")
    return {
        "name": sample.name,
        "title": sample.title,
        "description": sample.description,
        "source": sample.source,
        "filename": sample.filename,
        "bytes": len(text.encode("utf-8")),
        "lines": records,
        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "demonstrates": list(sample.demonstrates),
        "href": f"/api/import/samples/{sample.name}",
        "csv_href": f"/api/import/samples/{sample.name}/raw",
    }


def suggested_body(sample: ImportSampleFixture) -> dict:
    """A request body that can be posted to `/api/import/preview` unchanged.

    The demo path is then two calls with no editing: fetch this, post its
    `suggested` at preview, post the same thing plus a name at commit.
    """
    return {
        "source": sample.source,
        "csv_text": read_sample(sample.name),
        "name": sample.title,
        "description": sample.description,
        "today_day": 0.0,
    }
