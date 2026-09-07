"""Working-day integer <-> calendar date conversion.

The CPM core reasons in integer day offsets only; calendar dates are produced
here and nowhere else, so weekends and holidays stay in one boundary function
(ARCHITECTURE A.4). Named with a trailing underscore to avoid shadowing the
stdlib `calendar` module.
"""
from __future__ import annotations

from datetime import date, timedelta


def day_to_date(start: date, day: float) -> str:
    return (start + timedelta(days=float(day))).isoformat()
