"""
Scenario: annual campus tech symposium, 17 tasks across 5 departments.

Small enough to reason about by hand, big enough to have a real critical
path and cross-department handoffs.  Three bottlenecks are planted
deliberately so detector accuracy is measurable -- GROUND_TRUTH below.
"""
from datetime import date

PROJECT_START = date(2026, 9, 1)
TODAY_DAY = 14.0          # we are 14 days into the project

# tid: name, dept, owner, planned duration (days)
TASKS = {
    "T01": dict(name="Define event scope & date",     dept="ORG",  owner="Anitha",  duration=2),
    "T02": dict(name="Draft budget",                  dept="FIN",  owner="Ravi",    duration=3),
    "T03": dict(name="Budget approval",               dept="FIN",  owner="Deepa",   duration=2),
    "T04": dict(name="Book auditorium",               dept="FAC",  owner="Suresh",  duration=2),
    "T05": dict(name="Shortlist catering & AV vendors",dept="FAC", owner="Suresh",  duration=3),
    "T06": dict(name="Vendor contracts",              dept="FIN",  owner="Ravi",    duration=4),
    "T07": dict(name="Sponsor deck",                  dept="SPON", owner="Karthik", duration=3),
    "T08": dict(name="Sponsor outreach",              dept="SPON", owner="Karthik", duration=5),
    "T09": dict(name="Sponsor confirmations",         dept="SPON", owner="Nisha",   duration=4),
    "T10": dict(name="Brand guidelines",              dept="MKT",  owner="Priya",   duration=2),
    "T11": dict(name="Posters & social creatives",    dept="MKT",  owner="Priya",   duration=4),
    "T12": dict(name="Registration site",             dept="MKT",  owner="Arjun",   duration=5),
    "T13": dict(name="Speaker invites",               dept="ORG",  owner="Anitha",  duration=4),
    "T14": dict(name="Speaker confirmations",         dept="ORG",  owner="Anitha",  duration=5),
    "T15": dict(name="Schedule finalisation",         dept="ORG",  owner="Anitha",  duration=2),
    "T16": dict(name="Print & install signage",       dept="FAC",  owner="Suresh",  duration=3),
    "T17": dict(name="Dry run",                       dept="ORG",  owner="Anitha",  duration=1),
}

# (predecessor, successor, kind)
#   artifact = successor consumes something predecessor produces (hard)
#   temporal = ordering only (soft)
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
    "T01": "done",  "T02": "done",  "T03": "in_review",
    "T04": "not_started", "T05": "not_started", "T06": "not_started",
    "T07": "done",  "T08": "done",  "T09": "done",
    "T10": "done",
    "T11": "not_started", "T12": "not_started",
    "T13": "not_started", "T14": "not_started", "T15": "not_started",
    "T16": "not_started", "T17": "not_started",
}

# append-only event log -- detectors read THIS, not current state
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

# Requirements, versioned.  `consumed_by` is what makes staleness computable.
REQUIREMENTS = {
    "R1": dict(version=1, text="Single-day event, 400 attendees",
               consumed_by=["T02", "T04", "T05", "T12"]),
    "R2": dict(version=1, text="Signage and creatives in English only",
               consumed_by=["T10", "T11", "T16"]),
    "R3": dict(version=1, text="On-site only, no streaming",
               consumed_by=["T05", "T12", "T17"]),
}

# What we planted, for measuring the detectors.
GROUND_TRUTH = {
    "T03": "budget approval stalled in review for 9 days (critical path)",
    "MKT": "marketing has 2 ready tasks (T11, T12) against capacity 1",
    "T12": "registration site unblocked for 10 days, never started",
}


def observed_durations():
    """Planned durations, plus time already burned by stalled work.

    T03 was planned at 2 days and has been sitting in review since day 5.
    Pretending it still takes 2 days is how schedules lie.
    """
    d = {tid: float(t["duration"]) for tid, t in TASKS.items()}
    planned = dict(d)
    stalled_extra = TODAY_DAY - 5.0 - d["T03"]        # 14 - 5 - 2 = 7 days lost
    d["T03"] = d["T03"] + stalled_extra
    return planned, d
