"""Minimal FastAPI wrapper. Four endpoints, no database, no auth."""
from fastapi import FastAPI
from fastapi.responses import FileResponse
from pydantic import BaseModel
import networkx as nx

import engine as E
import scenario as S

app = FastAPI(title="Workflow Intelligence MVP")

G = E.build_graph(S.TASKS, S.DEPS)
PLANNED, OBSERVED = S.observed_durations()


def _state(durations):
    sched = E.schedule(G, durations)
    return sched


def _task_rows(sched):
    return [
        {
            "id": tid,
            **{k: v for k, v in G.nodes[tid].items()},
            "status": S.STATUS[tid],
            "es": sched["ES"][tid],
            "ef": sched["EF"][tid],
            "slack": sched["slack"][tid],
            "critical": tid in sched["critical"],
            "start_date": E.day_to_date(S.PROJECT_START, sched["ES"][tid]),
            "end_date": E.day_to_date(S.PROJECT_START, sched["EF"][tid]),
            "depends_on": sorted(G.predecessors(tid)),
        }
        for tid in sorted(G.nodes)
    ]


@app.get("/api/state")
def state():
    base, cur = _state(PLANNED), _state(OBSERVED)
    bl = E.detect(G, cur, S.STATUS, S.EVENTS, S.DEPT_CAPACITY, S.TODAY_DAY)
    return {
        "project_start": S.PROJECT_START.isoformat(),
        "today_day": S.TODAY_DAY,
        "planned_end": base["project_end"],
        "projected_end": cur["project_end"],
        "planned_end_date": E.day_to_date(S.PROJECT_START, base["project_end"]),
        "projected_end_date": E.day_to_date(S.PROJECT_START, cur["project_end"]),
        "slip_days": cur["project_end"] - base["project_end"],
        "critical_path": cur["critical"],
        "tasks": _task_rows(cur),
        "edges": [{"from": u, "to": v, "kind": G.edges[u, v]["kind"]}
                  for u, v in G.edges],
        "departments": S.DEPT_CAPACITY,
        "bottlenecks": [b.to_dict() for b in bl],
        "requirements": {k: dict(v) for k, v in S.REQUIREMENTS.items()},
        "ground_truth": S.GROUND_TRUTH,
    }


class DelayReq(BaseModel):
    task_id: str
    extra_days: float


@app.post("/api/simulate/delay")
def simulate_delay(req: DelayReq):
    cur = _state(OBSERVED)
    after = E.schedule(G, E.apply_delay(OBSERVED, req.task_id, req.extra_days))
    d = E.diff(cur, after)
    d["notify"] = sorted({G.nodes[t]["owner"] for t in d["tasks_moved"]})
    d["moved_detail"] = [
        {"id": t, "name": G.nodes[t]["name"], "dept": G.nodes[t]["dept"],
         "owner": G.nodes[t]["owner"], "delta": m["delta"],
         "from_date": E.day_to_date(S.PROJECT_START, m["from"]),
         "to_date": E.day_to_date(S.PROJECT_START, m["to"])}
        for t, m in sorted(d["tasks_moved"].items(), key=lambda kv: -kv[1]["delta"])
    ]
    d["end_date_before"] = E.day_to_date(S.PROJECT_START, d["project_end_before"])
    d["end_date_after"] = E.day_to_date(S.PROJECT_START, d["project_end_after"])
    return d


class ReqChange(BaseModel):
    req_id: str


@app.post("/api/simulate/requirement")
def simulate_requirement(rc: ReqChange):
    req = S.REQUIREMENTS[rc.req_id]
    st = E.stale_tasks(G, set(req["consumed_by"]))

    def rows(ids):
        return [{"id": t, "name": G.nodes[t]["name"], "dept": G.nodes[t]["dept"],
                 "owner": G.nodes[t]["owner"], "status": S.STATUS[t]} for t in ids]

    return {
        "req_id": rc.req_id,
        "text": req["text"],
        "from_version": req["version"],
        "to_version": req["version"] + 1,
        "directly_consumed_by": req["consumed_by"],
        "must_redo": rows(st["must_redo"]),
        "must_recheck": rows(st["must_recheck"]),
        "departments_hit": sorted({G.nodes[t]["dept"] for t in st["must_redo"]}),
        "wasted_days": sum(G.nodes[t]["duration"] for t in st["must_redo"]
                           if S.STATUS[t] == "done"),
    }


@app.get("/api/accuracy")
def accuracy():
    cur = _state(OBSERVED)
    bl = E.detect(G, cur, S.STATUS, S.EVENTS, S.DEPT_CAPACITY, S.TODAY_DAY)
    detected = {b.root_cause for b in bl}
    truth = set(S.GROUND_TRUTH)
    return {
        "planted": len(truth),
        "detected": len(detected),
        "true_positives": sorted(truth & detected),
        "missed": sorted(truth - detected),
        "extra": sorted(detected - truth),
        "recall": len(truth & detected) / len(truth),
        "precision_vs_planted": len(truth & detected) / len(detected) if detected else 0,
    }


@app.get("/")
def index():
    return FileResponse("index.html")
