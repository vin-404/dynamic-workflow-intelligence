"""
Getting data in without typing it.

One parser, two front doors and a webhook:

* `csvsource` reads a CSV whose header repeats a column name, which is the
  one thing `csv.DictReader` cannot do and the one thing a Jira export
  requires.
* `mapping` says which column means what, and what a foreign status word
  means in our vocabulary. "Jira" is a preset here, not a code path.
* `plan` turns rows into `core.workflow` specs, and turns everything it had
  to infer or refuse into a report.
* `preview` renders that report and asks `core.engine.graph` whether the
  result would even schedule.
* `commit` writes a new project, never into an existing one.
* `github` is the signature-authenticated event receiver.

Nothing in this package consults a language model. Every mapping decision is
a lookup table or something the caller said, which is what lets the preview
promise that its arithmetic can be checked by hand.
"""
from backend.app.ingest.commit import CommitRefused, commit_plan
from backend.app.ingest.csvsource import CsvProblem, MAX_CSV_BYTES, read_sheet
from backend.app.ingest.mapping import (
    JIRA_MAPPING,
    ColumnMapping,
    MappingProblem,
    mapping_from_payload,
)
from backend.app.ingest.plan import ImportOptions, ImportPlan, build_jira_plan, build_plan
from backend.app.ingest.preview import find_import_cycles, preview_payload

__all__ = [
    "ColumnMapping",
    "CommitRefused",
    "CsvProblem",
    "ImportOptions",
    "ImportPlan",
    "JIRA_MAPPING",
    "MAX_CSV_BYTES",
    "MappingProblem",
    "build_jira_plan",
    "build_plan",
    "commit_plan",
    "find_import_cycles",
    "mapping_from_payload",
    "preview_payload",
    "read_sheet",
]
