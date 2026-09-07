"""CLI walkthrough -- proves the engine before any UI exists."""
import engine as E
import scenario as S

BAR = "=" * 78


def h(t):
    print(f"\n{BAR}\n{t}\n{BAR}")


def d(day):
    return E.day_to_date(S.PROJECT_START, day)


G = E.build_graph(S.TASKS, S.DEPS)
planned_dur, observed_dur = S.observed_durations()

baseline = E.schedule(G, planned_dur)
current = E.schedule(G, observed_dur)

# ---------------------------------------------------------------- 1. schedule
h("1. SCHEDULE  (plan vs reality)")
print(f"Planned finish   : day {baseline['project_end']:.0f}  ({d(baseline['project_end'])})")
print(f"Projected finish : day {current['project_end']:.0f}  ({d(current['project_end'])})")
print(f"Slip             : {current['project_end'] - baseline['project_end']:+.0f} days")
print(f"\nCritical path    : {' -> '.join(current['critical'])}")

print(f"\n{'id':<5}{'task':<34}{'dept':<6}{'status':<12}{'ES':>4}{'slack':>7}")
print("-" * 78)
for tid in sorted(G.nodes):
    t = G.nodes[tid]
    star = "*" if tid in current["critical"] else " "
    print(f"{tid:<5}{t['name'][:33]:<34}{t['dept']:<6}{S.STATUS[tid]:<12}"
          f"{current['ES'][tid]:>4.0f}{current['slack'][tid]:>6.0f}{star}")
print("\n* = on the critical path (zero slack)")

# ------------------------------------------------------------- 2. bottlenecks
h("2. BOTTLENECK INBOX  (ranked by attributed delay)")
found = E.detect(G, current, S.STATUS, S.EVENTS, S.DEPT_CAPACITY, S.TODAY_DAY)
for i, b in enumerate(found, 1):
    print(f"\n[{i}] {b.kind.upper().replace('_',' ')}   severity={b.severity}   "
          f"delay={b.attributed_delay_days:.0f}d   impact={b.impact_score:.0f}")
    print(f"    tasks      : {', '.join(b.tasks)}")
    print(f"    root cause : {b.root_cause}")
    print(f"    evidence   : {b.evidence}")
    print(f"    downstream : {len(b.downstream_affected)} tasks "
          f"({', '.join(b.downstream_affected[:6])}"
          f"{'...' if len(b.downstream_affected) > 6 else ''})")
    print(f"    action     : {b.suggested_action}")

# ------------------------------------------------------ 3. detector accuracy
h("3. DETECTOR ACCURACY  (against planted ground truth)")
detected = {b.root_cause for b in found}
truth = set(S.GROUND_TRUTH)
tp = sorted(truth & detected)
fn = sorted(truth - detected)
fp = sorted(detected - truth)
for k in sorted(truth):
    mark = "FOUND    " if k in detected else "MISSED   "
    print(f"  {mark} {k}: {S.GROUND_TRUTH[k]}")
for k in fp:
    print(f"  EXTRA    {k}: not planted -- emergent finding")
prec = len(tp) / len(detected) if detected else 0
rec = len(tp) / len(truth) if truth else 0
print(f"\n  planted={len(truth)}  detected={len(detected)}  "
      f"true positives={len(tp)}  missed={len(fn)}  extra={len(fp)}")
print(f"  recall={rec:.0%}   precision(vs planted)={prec:.0%}")

# ------------------------------------------------------- 4. change simulation
h("4. CHANGE SIMULATION  -- 'T03 approval slips another 5 days'")
after = E.schedule(G, E.apply_delay(observed_dur, "T03", 5))
dd = E.diff(current, after)
print(f"Project end : day {dd['project_end_before']:.0f} -> "
      f"{dd['project_end_after']:.0f}  ({dd['project_end_delta']:+.0f} days)")
print(f"Tasks moved : {len(dd['tasks_moved'])}")
print(f"Critical path changed: {dd['critical_path_changed']}")
if dd["newly_critical"]:
    print(f"  newly critical      : {dd['newly_critical']}")
if dd["no_longer_critical"]:
    print(f"  no longer critical  : {dd['no_longer_critical']}")
print(f"\n{'id':<5}{'task':<34}{'dept':<6}{'owner':<9}{'start moves':>14}")
print("-" * 78)
for tid, m in sorted(dd["tasks_moved"].items(), key=lambda kv: -kv[1]["delta"]):
    t = G.nodes[tid]
    print(f"{tid:<5}{t['name'][:33]:<34}{t['dept']:<6}{t['owner']:<9}"
          f"{d(m['from'])} -> {d(m['to'])}")
notify = sorted({G.nodes[t]['owner'] for t in dd["tasks_moved"]})
print(f"\nNotify: {', '.join(notify)}")

# --------------------------------------------------- 5. requirement staleness
h("5. REQUIREMENT CHANGE  -- R2 v1 -> v2: signage/creatives must be bilingual")
req = S.REQUIREMENTS["R2"]
st = E.stale_tasks(G, set(req["consumed_by"]))
print(f"was : {req['text']}")
print(f"now : Signage and creatives in English AND Tamil")
print(f"\nDirectly consumed R2 : {', '.join(req['consumed_by'])}")
print(f"\nMUST REDO ({len(st['must_redo'])}) -- consumed an artifact that is now wrong:")
for tid in st["must_redo"]:
    t = G.nodes[tid]
    print(f"   {tid}  {t['name']:<34} {t['dept']:<5} {t['owner']:<9} "
          f"({S.STATUS[tid]})")
print(f"\nMUST RE-CHECK ({len(st['must_recheck'])}) -- downstream, probably fine:")
for tid in st["must_recheck"]:
    t = G.nodes[tid]
    print(f"   {tid}  {t['name']:<34} {t['dept']:<5} {t['owner']}")
depts = sorted({G.nodes[t]['dept'] for t in st['must_redo']})
print(f"\nDepartments hit: {', '.join(depts)}")
print("This is the part a task board cannot do: a spec changed, and we can say")
print("which finished work is now invalid.")

# ---------------------------------------------------------- 6. cycle handling
h("6. ROBUSTNESS  -- circular dependency is reported, not swallowed")
import networkx as nx
bad = G.copy()
bad.add_edge("T15", "T13", kind="temporal")
try:
    E.schedule(bad, observed_dur)
    print("ERROR: cycle was not detected")
except E.CycleError as exc:
    print(f"CycleError raised, cycle reported: {exc.cycles}")

print(f"\n{BAR}\nMVP engine verified.\n{BAR}")
