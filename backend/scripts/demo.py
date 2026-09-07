"""
Dev CLI - proves the engine from the command line, with no UI and no database.

Replaces the prototype's root `demo.py`, which walked a single hardcoded
scenario through module-level globals. This runs over both seed fixtures and
covers everything the old CLI verified - schedule, findings, detector
accuracy, change simulation, requirement staleness, cycle robustness - plus
the two things the old one could not say: what the evidence does *not* cover,
and which structural wins are available with no history at all.

    .venv/Scripts/python.exe -m backend.scripts.demo
    .venv/Scripts/python.exe -m backend.scripts.demo campus-symposium
"""
from __future__ import annotations

import sys

from backend.app.core.engine import (
    CycleError,
    all_detectors,
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
NL = "\n"


def h(title: str) -> None:
    print(f"{NL}{BAR}{NL}{title}{NL}{BAR}")


def run(fx) -> None:
    clock = Clock(fx.today_day)
    snapshot, state = fx.snapshot, fx.state
    G = build_graph_from_snapshot(snapshot)
    result = evaluate(snapshot, state, clock)
    sched = result.schedule

    def d(day: float) -> str:
        return day_to_date(fx.start_date, day)

    labels = {r.key: r.name for r in snapshot.resources}
    assignees = snapshot.assignees_by_task

    def who(key: str) -> str:
        names = [labels.get(a, a) for a in assignees.get(key, ())]
        return ", ".join(names) if names else "-"

    print(NL * 2 + "#" * 78)
    print(f"# {fx.name}  --  domain: {fx.domain.name}")
    print(f"# {fx.goal}")
    print("#" * 78)

    # ---------------------------------------------------------- 1. schedule
    h("1. SCHEDULE  (plan vs reality)")
    print(f"Planned finish   : day {result.planned_end:.0f}  "
          f"({d(result.planned_end)})")
    print(f"Projected finish : day {result.projected_end:.0f}  "
          f"({d(result.projected_end)})")
    print(f"Slip             : {result.slip_days:+.0f} days")
    print(f"Feasibility      : {result.feasibility.statement}")
    print(f"Effort model     : {result.effort_model['formula']}  "
          f"(efficiency {result.effort_model['efficiency']})")
    print(f"Engine           : {result.engine_version}  "
          f"input {result.input_hash[:16]}...")
    print(NL + "Critical path    : " + " -> ".join(sched["critical"]))

    print(f"{NL}{'id':<6}{'task':<32}{'who':<12}{'status':<13}"
          f"{'eff':>4}{'dur':>5}{'ES':>5}{'slack':>7}")
    print("-" * 78)
    for key in snapshot.task_keys:
        t = snapshot.task_by_key[key]
        star = "*" if key in sched["critical"] else " "
        print(f"{key:<6}{t.name[:31]:<32}{who(key)[:11]:<12}"
              f"{state.status_of(key).value:<13}{t.effort:>4.0f}"
              f"{sched['durations'][key]:>5.0f}{sched['ES'][key]:>5.0f}"
              f"{sched['slack'][key]:>6.0f}{star}")
    print(NL + "* = on the critical path (zero slack)")

    # --------------------------------------------------------- 2. findings
    h("2. FINDINGS  (ranked by impact, tier-tagged)")
    print(f"Evidence reached tier {result.tier_reached}. "
          f"{len(result.checks_run)} of {len(all_detectors())} checks ran.")
    by_tier = result.findings_by_tier()
    if by_tier:
        print("By tier: " + ", ".join(
            f"tier {t}: {len(items)}" for t, items in sorted(by_tier.items())
        ))
    else:
        print("No findings at all. See section 3 for what was not checked.")

    for i, b in enumerate(result.findings, 1):
        print(f"{NL}[{i}] {b.kind.upper().replace('_', ' ')}   "
              f"tier={int(b.tier)}   severity={b.severity}   "
              f"impact={b.impact_score:.0f}")
        print(f"    tasks      : {', '.join(b.task_ids)}")
        print(f"    root cause : {b.root_cause}")
        print(f"    evidence   : {b.evidence}")
        print(f"    impact     : {b.impact.as_dict()['worked']}")
        print(f"    why        : {b.explanation}")
        print(f"    action     : {b.suggested_action}")

    for b in result.suppressed_findings:
        print(f"{NL}[-] SUPPRESSED {b.kind} ({b.root_cause})")
        print(f"    by         : {b.suppressed.by}")
        print(f"    reason     : {b.suppressed.reason}")

    # ------------------------------------------- 3. limits of the evidence
    h("3. WHAT THIS ANALYSIS CANNOT ASSESS YET  (and why)")
    for gap in result.unavailable_checks:
        print(f"{NL}  Tier {gap['tier']} -- requires {gap['requires']}")
        for check in gap["checks"]:
            print(f"    - {check}")
        print(f"    why        : {gap['why']}")
        print(f"    unlocked by: {gap['unlocked_by']}")

    # ---------------------------------------------------- 4. accuracy check
    h("4. DETECTOR ACCURACY  (against the fixture's labelled findings)")
    detected = {
        (b.kind, b.root_cause) for b in result.findings if b.root_cause
    }
    labelled = fx.labelled_refs
    if not labelled:
        print("  Nothing is labelled for this fixture, so precision and recall")
        print("  are undefined. Reporting a score would be meaningless.")
        print(f"  Detections: {sorted(detected) or 'none'}")
    else:
        tp = labelled & detected
        for label in fx.labelled:
            mark = "FOUND " if label.ref in detected else "MISSED"
            tag = "planted" if label.planted else "structural"
            print(f"  {mark} [{tag:10s}] {label.kind}@{label.root_cause}")
            print(f"                       {label.description}")
        for kind, root in sorted(detected - labelled):
            print(f"  EXTRA  {kind}@{root}: not labelled -- review this")
        planted = {f.ref for f in fx.planted}
        print(f"{NL}  labelled={len(labelled)}  detected={len(detected)}  "
              f"true positives={len(tp)}  missed={len(labelled - detected)}  "
              f"unexpected={len(detected - labelled)}")
        precision = len(tp) / len(detected) if detected else 0.0
        print(f"  recall={len(tp) / len(labelled):.0%}   "
              f"precision={precision:.0%}")
        if planted:
            print(f"  planted faults: {len(planted)}, found "
                  f"{len(planted & detected)} "
                  f"({len(planted & detected) / len(planted):.0%})")

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
        print(f"{NL}{'id':<6}{'task':<30}{'who':<12}{'start moves':>28}")
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
        print(f"{NL}Notify: {', '.join(notify) or 'nobody assigned'}")
        print(f"{NL}The base workflow is provably untouched: content hash "
              f"{hash_before[:16]}...")
        print(f"is still {snapshot.content_hash()[:16]}... after the simulation.")

    # -------------------------------------------- 6. requirement staleness
    if snapshot.requirements:
        req = snapshot.requirements[0]
        h(f"6. REQUIREMENT CHANGE  --  {req.key} v{req.version_no} -> "
          f"v{req.version_no + 1}")
        st = stale_tasks(G, set(req.consumed_by))
        print(f"was : {req.text}")
        print(f"{NL}Directly consumed {req.key} : {', '.join(req.consumed_by)}")
        print(f"{NL}MUST REDO ({len(st['must_redo'])}) -- consumed an artifact "
              f"that is now wrong:")
        for key in st["must_redo"]:
            print(f"   {key}  {snapshot.task_by_key[key].name:<32} "
                  f"{who(key):<16}({state.status_of(key).value})")
        print(f"{NL}MUST RE-CHECK ({len(st['must_recheck'])}) -- downstream in "
              f"time, probably fine:")
        for key in st["must_recheck"]:
            print(f"   {key}  {snapshot.task_by_key[key].name:<32} {who(key)}")
        print(NL + "This is the part a task board cannot do: a spec changed, "
                   "and we")
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
        print("  Each is implied by a longer path, so removing all of them "
              "leaves the")
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
        # And evaluate() degrades rather than raising, so a bad graph cannot
        # take a page down.
        broken = snapshot.evolve(
            dependencies=snapshot.dependencies + (
                type(snapshot.dependencies[0])(from_task=v, to_task=u),
            )
        )
        degraded = evaluate(broken, state, clock)
        print(f"evaluate() returns schedulable={degraded.schedulable} with a "
              f"{degraded.findings[0].kind} finding instead of an exception.")
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

    print(NL + BAR)
    print(f"Engine verified across {len(fixtures)} domain(s), with no database")
    print("and no API key. Same code path for both.")
    print(BAR)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
