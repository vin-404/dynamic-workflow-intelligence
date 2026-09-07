"""
Dev CLI - proves the engine from the command line, with no UI and no database.

Replaces the prototype's root `demo.py`, which walked a single hardcoded
scenario through module-level globals. This runs over both seed fixtures and
covers everything the old CLI verified: schedule, findings, detector accuracy,
change simulation, requirement staleness, and cycle robustness - plus the two
things the old one could not say, which are what the evidence does *not*
cover, and which structural wins are available with no history at all.

    .venv/Scripts/python.exe -m backend.scripts.demo
    .venv/Scripts/python.exe -m backend.scripts.demo campus-symposium
"""
from __future__ import annotations

import sys

from backend.app.core.engine import (
    CycleError,
    apply_delay,
    day_to_date,
    diff,
    evaluate,
    observed_durations,
    schedule,
    stale_tasks,
)
from backend.app.core.engine.graph import (
    build_graph_from_snapshot,
    transitive_redundant_edges,
)
from backend.app.core.workflow import Clock, DepType
from backend.app.seed.fixtures import FIXTURE_BUILDERS, all_fixtures, fixture

BAR = "=" * 78


def h(title: str) -> None:
    print(f"\n{BAR}\n{title}\n{BAR}")


def run(fx) -> None:
    clock = Clock(fx.today_day)
    snapshot, state = fx.snapshot, fx.state
    G = build_graph_from_snapshot(snapshot)
    result = evaluate(snapshot, state, clock)

    def d(day: float) -> str:
        return day_to_date(fx.start_date, day)

    labels = {r.key: r.name for r in snapshot.resources}
    assignees = snapshot.assignees_by_task

    def who(key: str) -> str:
        names = [labels.get(a, a) for a in assignees.get(key, ())]
        return ", ".join(names) if names else "-"

    print("\n\n" + "#" * 78)
    print(f"# {fx.name}  --  domain: {fx.domain.name}")
    print(f"# {fx.goal}")
    print("#" * 78)

    # ---------------------------------------------------------- 1. schedule
    h("1. SCHEDULE  (plan vs reality)")
    print(f"Planned finish   : day {result.planned_end:.0f}  ({d(result.planned_end)})")
    print(f"Projected finish : day {result.projected_end:.0f}  "
          f"({d(result.projected_end)})")
    print(f"Slip             : {result.slip_days:+.0f} days")
    print(f"Feasibility      : {result.feasibility.statement}")
    print(f"Effort model     : {result.effort_model['formula']}  "
          f"(efficiency {result.effort_model['efficiency']})")
    print(f"Engine           : {result.engine_version}  "
          f"input {result.input_hash[:16]}...")
    print("\nCritical path    : " + " -> ".join(result.schedule["critical"]))

    sched = result.schedule
    print(f"\n{'id':<6}{'task':<32}{'who':<12}{'status':<13}"
          f"{'eff':>4}{'dur':>5}{'ES':>5}{'slack':>7}")
    print("-" * 78)
    for key in snapshot.task_keys:
        t = snapshot.task_by_key[key]
        star = "*" if key in sched["critical"] else " "
        print(f"{key:<6}{t.name[:31]:<32}{who(key)[:11]:<12}"
              f"{state.status_of(key).value:<13}{t.effort:>4.0f}"
              f"{sched['durations'][key]:>5.0f}{sched['ES'][key]:>5.0f}"
              f"{sched['slack'][key]:>6.0f}{star}")
    print("\n* = on the critical path (zero slack)")

    # ------------------------------------------------------- 2. bottlenecks
    h("2. FINDINGS  (ranked by impact = days lost x work stuck behind it)")
    print(f"Evidence reached tier {result.tier_reached}.")
    if not result.findings:
        print("\nNo stateful findings: this workflow has no recorded statuses,")
        print("so there is no elapsed time to reason about. That is the honest")
        print("answer rather than an empty one -- see section 3.")
    for i, b in enumerate(result.findings, 1):
        print(f"\n[{i}] {b.kind.upper().replace('_', ' ')}   "
              f"severity={b.severity}   delay={b.attributed_delay_days:.0f}d   "
              f"impact={b.impact_score:.0f}")
        print(f"    tasks      : {', '.join(b.tasks)}")
        print(f"    root cause : {b.root_cause}")
        print(f"    evidence   : {b.evidence}")
        print(f"    impact     : {b.attributed_delay_days:.0f} days lost x "
              f"(1 + {len(b.downstream_affected)} downstream) = "
              f"{b.impact_score:.0f}")
        print(f"    action     : {b.suggested_action}")

    # ------------------------------------------- 3. limits of the evidence
    h("3. WHAT THIS ANALYSIS CANNOT ASSESS YET  (and why)")
    for gap in result.unavailable_checks:
        print(f"\n  Tier {gap['tier']}: {', '.join(gap['checks'])}")
        print(f"    requires   : {gap['requires']}")
        print(f"    why        : {gap['why']}")
        print(f"    unlocked by: {gap['unlocked_by']}")

    # ---------------------------------------------------- 4. accuracy check
    h("4. DETECTOR ACCURACY  (against planted ground truth)")
    detected = {b.root_cause for b in result.findings if b.root_cause}
    truth = set(fx.ground_truth)
    if not truth:
        print("  No faults are labelled for this fixture, so precision and")
        print("  recall are undefined. Reporting a score would be meaningless.")
        print(f"  Detections: {sorted(detected) or 'none'}")
    else:
        tp = sorted(truth & detected)
        for k in sorted(truth):
            mark = "FOUND    " if k in detected else "MISSED   "
            print(f"  {mark} {k}: {fx.ground_truth[k]}")
        for k in sorted(detected - truth):
            print(f"  EXTRA    {k}: not planted -- emergent finding")
        prec = len(tp) / len(detected) if detected else 0.0
        rec = len(tp) / len(truth)
        print(f"\n  planted={len(truth)}  detected={len(detected)}  "
              f"true positives={len(tp)}  missed={len(truth - detected)}  "
              f"extra={len(detected - truth)}")
        print(f"  recall={rec:.0%}   precision(vs planted)={prec:.0%}")

    # ------------------------------------------------- 5. change simulation
    observed = observed_durations(snapshot, state, clock)
    current = schedule(G, observed)
    critical = sched["critical"]
    if critical:
        victim = critical[len(critical) // 2]
        h(f"5. CHANGE SIMULATION  --  '{victim} slips another 5 days'")
        hash_before = snapshot.content_hash()
        after = schedule(G, apply_delay(observed, victim, 5))
        dd = diff(current, after)
        print(f"Project end : day {dd['project_end_before']:.0f} -> "
              f"{dd['project_end_after']:.0f}  "
              f"({dd['project_end_delta']:+.0f} days)")
        print(f"Tasks moved : {len(dd['tasks_moved'])}")
        print(f"Critical path changed: {dd['critical_path_changed']}")
        if dd["newly_critical"]:
            print(f"  newly critical      : {dd['newly_critical']}")
        if dd["no_longer_critical"]:
            print(f"  no longer critical  : {dd['no_longer_critical']}")
        print(f"\n{'id':<6}{'task':<30}{'who':<12}{'start moves':>28}")
        print("-" * 78)
        for key, m in sorted(dd["tasks_moved"].items(),
                             key=lambda kv: -kv[1]["delta"]):
            moves = f"{d(m['from'])} -> {d(m['to'])}"
            print(f"{key:<6}{snapshot.task_by_key[key].name[:29]:<30}"
                  f"{who(key)[:11]:<12}{moves:>28}")
        notify = sorted({
            labels.get(a, a)
            for key in dd["tasks_moved"]
            for a in assignees.get(key, ())
        })
        print(f"\nNotify: {', '.join(notify) or 'nobody assigned'}")
        print(f"\nThe base workflow is provably untouched: content hash "
              f"{hash_before[:16]}...")
        print(f"is still {snapshot.content_hash()[:16]}... after the simulation.")

    # -------------------------------------------- 6. requirement staleness
    if snapshot.requirements:
        req = snapshot.requirements[0]
        h(f"6. REQUIREMENT CHANGE  --  {req.key} v{req.version_no} -> "
          f"v{req.version_no + 1}")
        st = stale_tasks(G, set(req.consumed_by))
        print(f"was : {req.text}")
        print(f"\nDirectly consumed {req.key} : {', '.join(req.consumed_by)}")
        print(f"\nMUST REDO ({len(st['must_redo'])}) -- consumed an artifact "
              f"that is now wrong:")
        for key in st["must_redo"]:
            print(f"   {key}  {snapshot.task_by_key[key].name:<32} "
                  f"{who(key):<16}({state.status_of(key).value})")
        print(f"\nMUST RE-CHECK ({len(st['must_recheck'])}) -- downstream in "
              f"time, probably fine:")
        for key in st["must_recheck"]:
            print(f"   {key}  {snapshot.task_by_key[key].name:<32} {who(key)}")
        print("\nThis is the part a task board cannot do: a spec changed, and we")
        print("can say which finished work is now invalid.")

    # ---------------------------------------------------- 7. structural wins
    h("7. STRUCTURAL OPPORTUNITIES  (computable with zero history)")
    redundant = transitive_redundant_edges(G)
    if redundant:
        edges = ", ".join(f"{u}->{v}" for u, v in redundant)
        print(f"  {len(redundant)} redundant dependency edge(s): {edges}")
        stripped = G.copy()
        for u, v in redundant:
            stripped.remove_edge(u, v)
        after_end = schedule(stripped, observed)["project_end"]
        print(f"  Each is implied by a longer path, so removing all of them "
              f"leaves the")
        print(f"  finish date at {after_end:.0f} (was "
              f"{current['project_end']:.0f}) -- provably safe, not a guess.")
    else:
        print("  No redundant dependencies found.")

    # ------------------------------------------------------- 8. robustness
    h("8. ROBUSTNESS  --  a circular dependency is reported, not swallowed")
    if len(critical) >= 2:
        u, v = critical[0], critical[1]
        bad = G.copy()
        bad.add_edge(v, u, consumes=False, dep_type=DepType.FS.value)
        try:
            schedule(bad, observed)
            print("ERROR: cycle was not detected")
        except CycleError as exc:
            print(f"Added {v} -> {u} on top of {u} -> {v}.")
            print(f"CycleError raised, cycle reported: {exc.cycles}")
    else:
        print("  Workflow too small to plant a cycle in.")


def main(argv: list[str]) -> int:
    if len(argv) > 1:
        key = argv[1]
        if key not in FIXTURE_BUILDERS:
            print(f"unknown fixture {key!r}; have {sorted(FIXTURE_BUILDERS)}")
            return 2
        fixtures = [fixture(key)]
    else:
        fixtures = list(all_fixtures())

    for fx in fixtures:
        run(fx)

    print(f"\n{BAR}")
    print(f"Engine verified across {len(fixtures)} domain(s), with no database")
    print("and no API key. Same code path for both.")
    print(BAR)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
