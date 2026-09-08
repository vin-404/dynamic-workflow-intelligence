"""
Reading a CSV whose header repeats a column name.

`csv.DictReader` is the obvious tool and it is the wrong one here. Jira
exports one column per issue link, all named `Outward issue link (Blocks)`,
so an issue that blocks four others contributes four identically-named
columns to the single header row. `DictReader` builds a dict, and a dict
holds one value per key: the last one wins and the rest vanish without a
word. An importer that silently drops three quarters of a workflow's edges is
worse than one that refuses to run, so this module does not use it.

Instead: `csv.reader`, the header kept as an ordered tuple, and an index from
normalised column name to *every* position that name occupies. A record then
offers `first()` for a column expected once and `all()` for one that
legitimately repeats.

Two smaller things this module owns, both of which are only visible when they
go wrong:

* **Row numbering.** `row` is the 1-based record number with the header as
  row 1, which is the number a spreadsheet shows beside the line. `line` is
  the physical line number, which differs the moment a quoted field contains
  a newline. Rejections report both, because the two audiences look in
  different places.
* **Raggedness.** A record whose field count differs from the header's is
  reported rather than padded. Padding turns a truncated export into a
  workflow that looks complete and is not.
"""
from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass
from typing import Iterator, Mapping, Sequence

#: A CSV larger than this is refused with an explanation rather than parsed.
#: Nothing in this problem domain needs a five-megabyte issue export - a
#: workflow that size cannot be reasoned about by a human either - and an
#: unbounded parse of an uploaded file is how a demo becomes an outage.
MAX_CSV_BYTES = 5 * 1024 * 1024

#: Ceiling on records, checked while reading rather than after, so a file that
#: is small on disk but pathological in shape still stops early.
MAX_CSV_ROWS = 5_000

_WHITESPACE = re.compile(r"\s+")


class CsvProblem(Exception):
    """The file could not be read at all, as opposed to a row that could not
    be mapped. Routers turn this into a 422 with the message verbatim."""


def normalise_column(name: str) -> str:
    """Casefolded, whitespace-collapsed, BOM-stripped.

    Jira's own exports differ between instances in capitalisation and in the
    stray space before a bracket, and a UTF-8 BOM on the first header cell is
    what Excel leaves behind when someone opens the export and saves it. None
    of those is a different column.
    """
    return _WHITESPACE.sub(" ", name.replace("﻿", "").strip()).casefold()


@dataclass(frozen=True, slots=True)
class Record:
    """One CSV record, addressable by a repeated column name."""

    row: int
    line: int
    header: tuple[str, ...]
    values: tuple[str, ...]
    #: normalised column name -> the positions it occupies, in column order.
    index: Mapping[str, tuple[int, ...]]

    @property
    def ragged(self) -> bool:
        return len(self.values) != len(self.header)

    @property
    def blank(self) -> bool:
        return not any(v.strip() for v in self.values)

    def has(self, *columns: str) -> bool:
        return any(normalise_column(c) in self.index for c in columns)

    def first(self, *columns: str) -> str:
        """The first non-empty value across the named columns, in the order
        the caller listed them.

        `""` when the column is absent or empty: to a mapper those are the
        same thing, and where the difference matters `has()` answers it.
        """
        for column in columns:
            for pos in self.index.get(normalise_column(column), ()):
                if pos < len(self.values):
                    value = self.values[pos].strip()
                    if value:
                        return value
        return ""

    def all(self, *columns: str) -> tuple[tuple[str, str], ...]:
        """Every non-empty value across the named columns, as
        `(column as it appeared in the header, value)` pairs.

        The header spelling travels with the value so a rejection can name the
        exact column the bad value came from - which a normalised key cannot.
        """
        out: list[tuple[str, str]] = []
        for column in columns:
            for pos in self.index.get(normalise_column(column), ()):
                if pos < len(self.values):
                    value = self.values[pos].strip()
                    if value:
                        out.append((self.header[pos], value))
        return tuple(out)

    def raw(self) -> list[list[str]]:
        """The record exactly as it arrived, as `[column, value]` pairs.

        A list of pairs rather than a dict, for the same reason this module
        exists: a dict would collapse the repeated columns, and the rejection
        report would then be missing the very content that caused it.
        """
        pairs: list[list[str]] = []
        for pos, value in enumerate(self.values):
            column = (
                self.header[pos] if pos < len(self.header)
                else f"(unnamed column {pos + 1})"
            )
            pairs.append([column, value])
        return pairs


@dataclass(frozen=True, slots=True)
class Sheet:
    header: tuple[str, ...]
    records: tuple[Record, ...]

    def column_positions(self) -> Mapping[str, tuple[int, ...]]:
        return _index(self.header)

    def has(self, *columns: str) -> bool:
        idx = self.column_positions()
        return any(normalise_column(c) in idx for c in columns)


def _index(header: Sequence[str]) -> dict[str, tuple[int, ...]]:
    out: dict[str, list[int]] = {}
    for pos, name in enumerate(header):
        out.setdefault(normalise_column(name), []).append(pos)
    return {k: tuple(v) for k, v in out.items()}


def check_size(text: str) -> None:
    """Refuse an oversized file before anything tries to parse it."""
    size = len(text.encode("utf-8", errors="ignore"))
    if size > MAX_CSV_BYTES:
        raise CsvProblem(
            f"That file is {size / 1_048_576:.1f} MB and this importer accepts "
            f"at most {MAX_CSV_BYTES / 1_048_576:.0f} MB. Export a filtered "
            f"issue set - one board, one epic or one release - rather than the "
            f"whole instance. Nothing was read."
        )


def read_sheet(text: str, delimiter: str = ",") -> Sheet:
    """Parse `text` into a header and records, repeats preserved.

    Raises `CsvProblem` when there is nothing to parse. Everything survivable
    - a ragged row, a blank row, a row with no key - is left for the mapper to
    report row by row, because a whole file refused over one bad line tells
    the user nothing about the other four hundred.
    """
    check_size(text)
    if not text.strip():
        raise CsvProblem("The file is empty: there is no header row to read.")

    if len(delimiter) != 1:
        raise CsvProblem(
            f"The delimiter must be exactly one character; got {delimiter!r}."
        )

    reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter)
    try:
        raw_header = next(reader)
    except StopIteration:  # pragma: no cover - guarded by the strip() above
        raise CsvProblem("The file is empty: there is no header row to read.")
    except csv.Error as exc:
        raise CsvProblem(f"The file is not valid CSV: {exc}")

    header = tuple(h.replace("﻿", "").strip() for h in raw_header)
    if not any(header):
        raise CsvProblem(
            "The first row is blank, so there are no column names to map "
            "against. A CSV import needs a header row."
        )

    index = _index(header)
    records: list[Record] = []
    for number, values in _iter_rows(reader):
        if len(records) >= MAX_CSV_ROWS:
            raise CsvProblem(
                f"That file has more than {MAX_CSV_ROWS} rows and this "
                f"importer stops there. Import one board or one release at a "
                f"time. Nothing was written."
            )
        records.append(
            Record(
                row=number,
                line=reader.line_num,
                header=header,
                values=tuple(v.strip() for v in values),
                index=index,
            )
        )

    return Sheet(header=header, records=tuple(records))


def _iter_rows(reader) -> Iterator[tuple[int, list[str]]]:
    """Yield `(record number, fields)`, header counted as record 1."""
    number = 1
    while True:
        try:
            values = next(reader)
        except StopIteration:
            return
        except csv.Error as exc:
            raise CsvProblem(
                f"The file stopped being valid CSV at line {reader.line_num}: "
                f"{exc}. The usual cause is an unclosed double quote."
            )
        number += 1
        yield number, values
