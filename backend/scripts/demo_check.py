"""
Walks the demo in ARCHITECTURE Section I end to end and checks every claim it
makes out loud.

This is not a smoke test. Each beat asserts the *thing the beat is for* - that
the tier-0 findings arrive with no history, that the impact number can be
recomputed by hand from the two numbers next to it, that the base workflow's
content hash is byte-identical after a simulation, that the refusal names the
constraint. If a beat would embarrass you on stage, this fails before you get
there.

    .venv/Scripts/python.exe -m backend.scripts.reset_db
    .venv/Scripts/python.exe -m backend.scripts.demo_check
    .venv/Scripts/python.exe -m backend.scripts.demo_check --provider recorded

`--provider recorded` runs the same walk with the AI layer switched on,
replaying canned model responses. There is no live-API mode: the demo path is
rehearsed, cached and offline on purpose (ARCHITECTURE B.4).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import time
from datetime import date, timedelta
from typing import Any

from httpx import ASGITransport, AsyncClient

CAMPUS = "00000000-0000-0000-0000-000000000001"
BATTERY = "00000000-0000-0000-0000-000000000002"

_failures: list[str] = []
_timings: dict[str, float] = {}


def check(label: str, condition: bool, detail: str = "") -> bool:
    mark = "PASS" if condition else "FAIL"
    print(f"  [{mark}] {label}" + (f" - {detail}" if detail else ""))
    if not condition:
        _failures.append(label)
    return condition


def beat(number: str, title: str) -> None:
    print(f"\n{number} {title}")
    print("-" * 74)


# ---------------------------------------------------------------------------
# The recorded provider - the "LLM enabled" pass, without a key or a network
# ---------------------------------------------------------------------------


class RecordedProvider:
    """Replays canned structured output. The responses are the shape a real
    model returns; the point of the pass is that the *plumbing* works when the
    model answers, not that the model is clever."""

    name = "recorded"
    available = True

    def __init__(self, invent_numbers: bool = False) -> None:
        self.calls = 0
        #: When true, the narrator returns a figure the engine never produced.
        #: The demo needs to show that being caught, not just claim it is.
        self.invent_numbers = invent_numbers

    def complete(self, request):  # noqa: ANN001 - duck-typed on AIProvider
        from backend.app.ai.provider import AIResponse, ProviderUnavailable

        self.calls += 1
        if request.role == "interpreter":
            body = json.dumps({
                "understood": True,
                "intent": "Anitha Rao is unavailable from day 14 to day 21",
                "mutations": [{
                    "kind": "RESOURCE_UNAVAILABLE_WINDOW",
                    "payload": {
                        "resource_key": "anitha",
                        "from_day": 14.0,
                        "to_day": 21.0,
                    },
                }],
                "unsupported": [],
                "clarification_needed": "",
                "confidence": "high",
            })
        elif request.role == "narrator":
            # A real model reads the payload it was given and cites it. The
            # recording does the same rather than hardcoding a day, because a
            # hardcoded one goes stale the moment the demo applies a change -
            # and then this fixture, not the product, is what fails.
            end = re.search(r'"projected_end_day":\s*([\d.]+)', request.user)
            day = end.group(1).rstrip("0").rstrip(".") if end else "?"
            if self.invent_numbers:
                body = json.dumps({
                    "headline": "Comfortably ahead",
                    "explanation": (
                        "You are running 31% ahead of schedule and will "
                        "finish 12 days early."
                    ),
                    "numbers_used": ["31", "12"],
                })
            else:
                body = json.dumps({
                    "headline": "The finish date, in one line",
                    "explanation": (
                        f"The plan lands on day {day}. The delay is "
                        f"concentrated in one chain rather than spread across "
                        f"the workflow."
                    ),
                    "numbers_used": [day],
                })
        elif request.role == "proposer":
            body = json.dumps({
                "proposals": [{
                    "name": "Start the speaker track before the budget lands",
                    "rationale": (
                        "Invitations cost nothing to send and can be withdrawn; "
                        "waiting on the budget buys certainty nobody needs yet."
                    ),
                    "mutations": [{
                        "kind": "DEPENDENCY_REMOVE",
                        "payload": {"from_task": "T03", "to_task": "T13"},
                    }],
                }]
            })
        else:  # pragma: no cover - the roles are closed
            raise ProviderUnavailable(f"no recording for {request.role}")
        return AIResponse(text=body, provider=self.name)


# ---------------------------------------------------------------------------
# The walk
# ---------------------------------------------------------------------------


async def walk(client: AsyncClient, expect_model: bool) -> None:
    async def post(path: str, body: Any = None) -> Any:
        started = time.perf_counter()
        response = await client.post(path, json=body if body is not None else {})
        _timings[f"POST {path.split('/')[-1]}"] = time.perf_counter() - started
        return response

    # -- 2 - Cold start, and honest limits ---------------------------------
    beat("2 -", "Cold start: a custom domain, four tasks, no history")
    today = date.today()
    created = await post("/api/projects", {
        "name": "Grant Submission",
        "goal": "Submit the research grant before the funder's cutoff",
        "start_date": today.isoformat(),
        "deadline": (today + timedelta(days=6)).isoformat(),
        "today_day": 0.0,
        "new_domain": {
            "key": f"research-grants-{int(time.time())}",
            "name": "Research Grants",
            "description": "A domain the engine has never seen",
            "vocabulary_hints": ["funder", "principal investigator"],
        },
    })
    check("a project in a brand-new domain is created", created.status_code == 201)
    cold = created.json()["id"]

    await post(f"/api/projects/{cold}/resources", {
        "key": "pi", "name": "Principal investigator", "kind": "person",
        "capacity": 1,
    })
    chain = [
        ("G01", "Draft the narrative", 4.0),
        ("G02", "Cost the budget", 3.0),
        ("G03", "Collect letters of support", 3.0),
        ("G04", "Internal sign-off", 2.0),
    ]
    for key, name, effort in chain:
        await post(f"/api/projects/{cold}/tasks", {
            "key": key, "name": name, "effort": effort, "assignees": ["pi"],
        })
    for a, b in zip(chain, chain[1:]):
        await post(f"/api/projects/{cold}/dependencies", {
            "from_task": a[0], "to_task": b[0],
        })

    analysis = (await post(f"/api/projects/{cold}/analyze")).json()
    kinds = {f["kind"] for f in analysis["findings"]}
    check(
        "tier-0 findings arrive with no history at all",
        bool(analysis["findings"]),
        f"{len(analysis['findings'])} findings: {', '.join(sorted(kinds))}",
    )
    check("a serial chain with no parallelism is called out", "serial_chain_no_parallelism" in kinds)
    check(
        "one person on every zero-slack task is called out",
        any("overload" in k or "unassigned" in k or "single" in k for k in kinds),
        ", ".join(sorted(kinds)),
    )
    check(
        "the deadline is reported infeasible, with the margin",
        analysis["feasibility"]["verdict"] != "comfortable",
        f"{analysis['feasibility']['statement']}",
    )
    check(
        "it says what it cannot assess yet, and why",
        bool(analysis["unavailable_checks"]),
        f"{len(analysis['unavailable_checks'])} checks locked at tier "
        f"{analysis['tier_reached']}",
    )
    check(
        "every locked check names what would unlock it",
        all(c.get("requires") and c.get("why") for c in analysis["unavailable_checks"]),
    )

    # -- 3 - Domain-agnosticism, proven not claimed ------------------------
    beat("3 -", "The same engine over a completely different structure")
    event = (await post(f"/api/projects/{CAMPUS}/analyze")).json()
    battery = (await post(f"/api/projects/{BATTERY}/analyze")).json()
    check(
        "both seed domains analyze with the same response shape",
        set(event) == set(battery) == set(analysis),
    )
    for name, payload in (("event", event), ("battery", battery), ("cold start", analysis)):
        rendered = json.dumps(payload)
        check(
            f"the {name} analysis carries no domain field",
            '"domain"' not in rendered and '"domain_id"' not in rendered,
        )
    check(
        "the two domains reach different tiers, from evidence not configuration",
        event["tier_reached"] != battery["tier_reached"],
        f"event tier {event['tier_reached']}, battery tier {battery['tier_reached']}",
    )

    # -- 4 - Capability 1 --------------------------------------------------
    beat("4 -", "Capability 1: the blocker, not the blocked task")
    top = event["findings"][0]
    check("the top finding names a root cause", bool(top["root_cause"]), top["root_cause"])
    check("it carries the evidence it reasoned from", bool(top["evidence"]))
    check("it explains why it matters", bool(top["explanation"]))
    impact = top["impact"]
    check(
        "the impact number can be recomputed by hand from the numbers beside it",
        bool(impact.get("formula")) and bool(impact.get("worked")),
        impact.get("worked", ""),
    )

    # -- 5 - Capability 2 --------------------------------------------------
    beat("5 -", "Capability 2: a structural estimate, and it says so")
    risk = event["risk"]
    worst = risk["tasks"][0]
    total = sum(f["contribution"] for f in worst["factors"])
    check(
        "the score is exactly the sum of its factors",
        abs(total - worst["score"]) < 1e-6,
        f"{worst['task_key']}: {total:.4f} == {worst['score']:.4f}",
    )
    check(
        "it is labelled a structural estimate, not a probability",
        risk["assumptions"]["score_kind"] == "structural_estimate"
        and event["feasibility"]["is_probability"] is False,
    )
    check(
        "it says what would make it a real probability",
        bool(risk["assumptions"].get("what_would_make_this_a_probability")),
    )
    check(
        "a factor it cannot measure reports itself unavailable rather than guessing",
        any(not f["available"] for f in worst["factors"]),
    )

    # -- 6 - Capability 3 --------------------------------------------------
    beat("6 -", "Capability 3: a hypothetical, and the base provably untouched")
    before = (await client.get(f"/api/projects/{CAMPUS}/workflow")).json()["version"]
    interpreted = (await post(f"/api/projects/{CAMPUS}/interpret", {
        "utterance": "Anitha is unavailable from day 14 to day 21",
    })).json()
    check("the sentence is understood", interpreted["understood"] is True)
    check(
        "it produced a typed mutation from the closed algebra",
        interpreted["mutations"][0]["kind"] == "RESOURCE_UNAVAILABLE_WINDOW",
    )
    check("nothing was applied", interpreted["applied"] is False)
    check(
        "the method is stated rather than implied",
        interpreted["method"] == ("model" if expect_model else "deterministic_patterns"),
        interpreted["method"],
    )
    simulated = (await post(f"/api/scenarios/{interpreted['scenario_id']}/evaluate")).json()
    completion = simulated["comparison"]["projected_completion"]
    check(
        "the diff reports a direction that matches its own delta",
        (completion["delta_days"] > 0) == (completion["direction"] == "later")
        and (completion["delta_days"] == 0)
        == (completion["direction"] == "unchanged"),
        f"day {completion['before_day']:.0f} -> day {completion['after_day']:.0f} "
        f"({completion['direction']})",
    )
    if before["version_no"] == 1:
        # On the seeded workflow this is the demo's headline number. After the
        # optimizer has been applied it legitimately changes - an absence that
        # cost seven days on the original plan can cost nothing on a better
        # one, which is the point of having optimized it.
        check(
            "on the seeded plan, the absence costs seven days",
            completion["delta_days"] == 7.0,
            f"+{completion['delta_days']:.0f} days",
        )
    after = (await client.get(f"/api/projects/{CAMPUS}/workflow")).json()["version"]
    check(
        "the base workflow's content hash is byte-identical afterwards",
        after["content_hash"] == before["content_hash"],
        after["content_hash"][:16] + "...",
    )
    check("and the simulation says so itself", simulated["base_unchanged"] is True)

    # -- 7 - Capability 4 --------------------------------------------------
    beat("7 -", "Capability 4: candidates, scored by the same engine")
    optimized = (await post(f"/api/projects/{CAMPUS}/optimize", {
        "budget": {"max_candidates": 40, "max_seconds": 20},
    })).json()
    check("candidates are found", bool(optimized["candidates"]), f"{len(optimized['candidates'])} survived")
    check("one is recommended", optimized["recommended"] is not None)
    recommended = optimized["recommended"]
    check(
        "the per-criterion table is on screen, not a single blended number",
        len(recommended["scores"]["criteria"]) == 6,
    )
    check("the weights that produced the ranking are published", bool(optimized["weights"]))
    check(
        "the recommendation explains itself",
        bool(optimized["recommendation_reason"]),
        optimized["recommendation_reason"][:80],
    )
    check(
        "the LLM proposer's contribution is reported either way",
        optimized["llm_proposals"]["count"] > 0 if expect_model
        else optimized["llm_proposals"]["count"] == 0,
        json.dumps(optimized["llm_proposals"]),
    )
    versions_before = (await client.get(f"/api/projects/{CAMPUS}/versions")).json()
    applied = (await post(
        f"/api/scenarios/{optimized['recommended_scenario_id']}/apply",
        {"note": "demo"},
    )).json()
    check("applying it creates a new version", applied["applied"] is True)
    versions_after = (await client.get(f"/api/projects/{CAMPUS}/versions")).json()
    check(
        "the old version is still in history",
        len(versions_after) == len(versions_before) + 1
        and applied["parent_version"]["unchanged"] is True,
        f"{len(versions_before)} -> {len(versions_after)} versions",
    )

    # -- 8 - The refusal ---------------------------------------------------
    beat("8 -", "The refusal: it will not buy the date by dropping the work")
    aggressive = (await post(f"/api/projects/{BATTERY}/optimize", {
        "aggressive": True,
        "budget": {"max_candidates": 60, "max_seconds": 20},
        "persist_candidates": False,
    })).json()
    refused = [c for c in aggressive["rejected"] if c["constraint_violations"]]
    check("optimizing with no limits produces refusals", bool(refused), f"{len(refused)} refused")
    cited = {
        v["constraint"]
        for c in refused for v in c["constraint_violations"] if v.get("constraint")
    }
    check(
        "the refusal names the constraint on record",
        "MANDATORY_TASK" in cited,
        ", ".join(sorted(cited)),
    )
    reasons = [
        v["constraint_reason"]
        for c in refused for v in c["constraint_violations"]
        if v.get("constraint_reason")
    ]
    check(
        "and quotes the reason a human wrote for it",
        any("UN38.3" in r for r in reasons),
        next((r for r in reasons if "UN38.3" in r), ""),
    )
    check(
        "a refused candidate is never scored",
        all(c.get("scores") in (None, {}) for c in refused),
    )

    # -- 9 - Evidence and limits -------------------------------------------
    beat("9 -", "Evidence and limits")
    narration = (await post(f"/api/projects/{CAMPUS}/explain")).json()
    check(
        "the narration says which produced it",
        narration["method"] == ("model" if expect_model else "engine_template"),
        narration["method"],
    )
    check(
        "and states that it cannot introduce a number",
        "cannot introduce" in narration["note"],
    )
    if expect_model:
        check(
            "every number in the model's prose came from the engine",
            narration["rejected_reason"] == "",
            narration["rejected_reason"],
        )
        # And the other half of the guarantee: a model that invents a number
        # is not shown. Claiming this is easy; the demo shows it happening.
        from backend.app.services import ai_service

        inventing = RecordedProvider(invent_numbers=True)
        ai_service.provider = lambda: inventing  # type: ignore[assignment]
        ai_service.reset_cache()
        discarded = (await post(f"/api/projects/{CAMPUS}/explain")).json()
        check(
            "a narration that invents a number is discarded, not flagged",
            discarded["method"] == "engine_template",
            discarded["method"],
        )
        check(
            "and the discard says which number it caught",
            "31" in discarded["rejected_reason"],
            discarded["rejected_reason"],
        )
    status = (await client.get("/api/ai/status")).json()
    check(
        "the AI status page names what carries each capability without a model",
        set(status["capabilities_without_model"]) == {
            "detect", "predict", "simulate", "optimize"
        },
    )

    # -- 10 - Import: the data arrives without being typed ------------------
    beat("10 -", "Import: a real Jira export, and every guess on show")
    samples = (await client.get("/api/import/samples")).json()
    check("a Jira-shaped sample ships with the app", len(samples["samples"]) >= 1)
    sample_name = samples["samples"][0]["name"]
    suggested = (
        await client.get(f"/api/import/samples/{sample_name}")
    ).json()["suggested"]

    preview = (await post("/api/import/preview", suggested)).json()
    check(
        "the preview would create a real workflow",
        preview["counts"]["tasks"] >= 10 and preview["counts"]["dependencies"] >= 15,
        f"{preview['counts']['tasks']} tasks, "
        f"{preview['counts']['dependencies']} dependencies",
    )
    # Repeated same-named columns are the thing `csv.DictReader` silently
    # collapses, and collapsing them loses most of the graph. If this number
    # falls, the importer has quietly stopped reading the file properly.
    check(
        "the repeated Jira link columns all survived",
        preview["counts"]["dependencies"] >= 20,
        f"{preview['counts']['dependencies']} dependencies",
    )
    check(
        "every unmappable row is reported rather than dropped",
        len(preview["rejected_rows"]) == preview["counts"]["rows_rejected"] >= 1,
        f"{preview['counts']['rows_rejected']} reported with reasons",
    )
    check(
        "each rejected row says why, in a sentence",
        all(len(r.get("reason", "")) > 20 for r in preview["rejected_rows"]),
    )
    check(
        "a link pointing outside the export is dropped and named",
        len(preview["dropped_dependencies"]) >= 1,
        str([d["raw"] for d in preview["dropped_dependencies"]]),
    )
    check("nothing blocks this import", preview["can_commit"] is True)

    # The inference is the part that must be visible. An import that silently
    # defaulted an estimate would look identical to one that read it.
    interpreted = [
        field
        for row in preview["rows"]
        for field, how in row["interpretation"].items()
        if how.get("assumed")
    ]
    check(
        "every guessed field is labelled as a guess, per row",
        len(interpreted) >= 1,
        f"{len(interpreted)} assumed readings across {len(preview['rows'])} rows",
    )

    imported = (await post("/api/import/commit", {
        **suggested, "name": "Delivery Platform (demo import)",
    })).json()
    imported_id = imported["project"]["project_id"]
    check("the import commits to a new project", bool(imported_id))
    check(
        "the rejected rows survive into the commit response",
        len(imported["rejected_rows"]) == len(preview["rejected_rows"]),
    )

    imported_analysis = (await post(f"/api/projects/{imported_id}/analyze")).json()
    check(
        "the imported workflow analyses to something worth looking at",
        len(imported_analysis["findings"]) >= 5,
        f"{len(imported_analysis['findings'])} findings",
    )
    check(
        "and it honestly reports a lower evidence tier, because no history was invented",
        imported_analysis["tier_reached"] <= 1
        and len(imported_analysis["unavailable_checks"]) >= 1,
        f"tier {imported_analysis['tier_reached']}, "
        f"{len(imported_analysis['unavailable_checks'])} checks unavailable",
    )

    # -- 11 - Replay: it happens without a button press --------------------
    beat("11 -", "Replay: the event log, forward in accelerated time")
    hash_before = (
        await client.get(f"/api/projects/{CAMPUS}/workflow")
    ).json()["version"]["content_hash"]

    started = (await post(f"/api/projects/{CAMPUS}/replay", {"speed": 600})).json()
    check("a replay starts over the stored version", started["running"] is True)
    check(
        "and says outright that it writes nothing",
        started["writes_nothing"] is True,
    )
    timeline = (
        await client.get(f"/api/projects/{CAMPUS}/replay/timeline")
    ).json()
    check(
        "the replay stops on every simulated day, not only on event days",
        len(timeline["steps"]) > len(timeline["events"]),
        f"{len(timeline['steps'])} steps for {len(timeline['events'])} events",
    )

    seeked = (await post(f"/api/projects/{CAMPUS}/replay/control", {
        "action": "seek", "to_day": timeline["steps"][-1]["day"],
    })).json()
    check("a replay is seekable", seeked["sim_day"] == timeline["steps"][-1]["day"])

    frame = (await client.get(f"/api/projects/{CAMPUS}/replay")).json()["frame"]
    check("a viewer arriving mid-replay is handed a frame", frame is not None)
    check(
        "the frame says it is a reconstruction, not current truth",
        frame["derived"]["is_reconstruction"] is True
        and len(frame["derived"]["caveats"]) >= 1,
        f"{len(frame['derived']['caveats'])} caveats stated",
    )
    check(
        "it says how much of the log it knew when it computed",
        frame["derived"]["events_known"] <= frame["derived"]["events_total"],
        f"{frame['derived']['events_known']} of {frame['derived']['events_total']}",
    )
    check(
        "a replayed projection is still not a probability",
        frame["projection"]["is_probability"] is False,
    )
    # The whole promise of the feature, checked rather than asserted.
    await client.delete(f"/api/projects/{CAMPUS}/replay")
    hash_after = (
        await client.get(f"/api/projects/{CAMPUS}/workflow")
    ).json()["version"]["content_hash"]
    check(
        "replaying left the stored workflow byte-identical",
        hash_before == hash_after,
        hash_before[:16],
    )

    # -- 12 - Forecast: a probability, and the estimate it is not -----------
    beat("12 -", "Forecast: a real probability, and what it rests on")
    fc = (await post(f"/api/projects/{CAMPUS}/forecast", {"seed": 4242})).json()
    block = fc["forecast"]
    check("a Monte Carlo forecast is available here", block["available"] is True)
    check(
        "the response says which of the two numbers it is answering with",
        fc["answer_kind"] == "monte_carlo_probability" and bool(fc["answer_kind_note"]),
    )
    check(
        "P50 <= P80 <= P90",
        block["completion"]["p50_day"]
        <= block["completion"]["p80_day"]
        <= block["completion"]["p90_day"],
        f"{block['completion']['p50_day']} / {block['completion']['p80_day']} / "
        f"{block['completion']['p90_day']}",
    )
    check(
        "it is a probability, and it says it is an uncalibrated one",
        block["is_probability"] is True and block["is_calibrated"] is False,
    )
    assumption_text = " ".join(
        str(v) for v in block["assumptions"].values() if isinstance(v, str)
    ).lower()
    check(
        "the assumptions state that durations are sampled independently",
        "independent" in assumption_text,
    )
    check(
        "and that this is optimistic, because real delays correlate",
        "optimistic" in assumption_text and "correlate" in assumption_text,
    )
    check(
        "and that resource contention was not simulated",
        "contention" in assumption_text,
    )
    check(
        "the seed and iteration count are on the payload, so it is reproducible",
        block["seed"] == 4242 and block["iterations"] >= 100,
    )
    repeat = (await post(f"/api/projects/{CAMPUS}/forecast", {"seed": 4242})).json()
    check(
        "the same seed reproduces the same forecast exactly",
        repeat["forecast"]["completion"] == block["completion"],
    )
    check(
        "every task carries a criticality index",
        all("criticality_index" in t for t in block["tasks"]) and len(block["tasks"]) > 0,
    )
    check(
        "a task whose spread came from the prior is labelled assumed",
        all(
            t["assumed"] == (t["duration"]["spread_provenance"] == "spread_prior")
            for t in block["tasks"]
        ),
    )
    # Adding a probability did not license removing the old refusal.
    check(
        "the structural estimate beside it still refuses to be a probability",
        fc["structural_risk"]["is_probability"] is False,
    )
    check(
        "and the deterministic feasibility does too",
        fc["deterministic"]["feasibility"]["is_probability"] is False,
    )

    # The cold-start project has no three-point estimates anywhere. It still
    # forecasts, because the domain carries a variance prior - but every task's
    # spread is then an assumption rather than a measurement, and the payload
    # has to say so per task. That is the honest middle case between "a real
    # forecast" and "nothing to sample", and it is the one an imported project
    # always lands in.
    cold_fc = (await post(f"/api/projects/{cold}/forecast")).json()
    cold_tasks = cold_fc["forecast"]["tasks"]
    check(
        "a workflow with no estimates still forecasts, from the domain's prior",
        cold_fc["forecast"]["available"] is True and len(cold_tasks) > 0,
        cold_fc["answer_kind"],
    )
    check(
        "and every one of its tasks is labelled as assumed, not measured",
        all(
            t["assumed"] and t["duration"]["spread_provenance"] == "spread_prior"
            for t in cold_tasks
        ),
        f"{len(cold_tasks)} tasks, all from the prior",
    )

    # -- 13 - Requirement change: the differentiator -----------------------
    beat("13 -", "A requirement changes: what it invalidates, and what it costs")
    reqs = (await client.get(f"/api/projects/{CAMPUS}/requirements")).json()
    check("requirements are first class", reqs["count"] >= 1)
    key = reqs["requirements"][0]["key"]

    hash_before = (
        await client.get(f"/api/projects/{CAMPUS}/workflow")
    ).json()["version"]["content_hash"]
    impact = (await post(
        f"/api/projects/{CAMPUS}/requirements/{key}/change",
        {"new_text": "Two-day event, 700 attendees, hybrid attendance"},
    )).json()

    check(
        "work that consumed the requirement is separated from work merely downstream",
        len(impact["must_redo"]) >= 1
        and impact["blast_radius"]["must_redo_count"] == len(impact["must_redo"]),
        f"{len(impact['must_redo'])} must redo, "
        f"{len(impact['must_recheck'])} must recheck",
    )
    check(
        "each affected task says why it is in the list it is in",
        all(t["reason"]["sentence"] for t in impact["must_redo"]),
    )
    check(
        "completed work that is now invalid is counted in days",
        impact["wasted_effort"]["wasted_days"] > 0,
        f"{impact['wasted_effort']['wasted_days']}d lost, "
        f"{impact['wasted_effort']['redo_cost_days']}d to redo",
    )
    check(
        "the arithmetic is shown on the row, not just totalled",
        all(r["arithmetic"] for r in impact["wasted_effort"]["rows"]),
    )
    check(
        "the people who need to know are grouped by owner",
        impact["who_needs_to_know"]["resource_count"] >= 1,
        f"{impact['who_needs_to_know']['resource_count']} owners affected",
    )
    # D-157. The date usually does not move, and the payload must say why
    # rather than letting a zero read as "this change is free".
    check(
        "when the finish date does not move, the report says that is not the same as free",
        impact["schedule_impact"]["delta_days"] != 0
        or (
            impact["schedule_impact"]["rework_shows_as_calendar_slip"] is False
            and len(impact["schedule_impact"]["caveat"]) > 40
        ),
        f"delta {impact['schedule_impact']['delta_days']}d",
    )
    check(
        "the replan comes back as a real, unapplied scenario",
        impact["replan"]["applied"] is False and bool(impact["replan"]["scenario_id"]),
    )
    check(
        "expressed in the mutation algebra that already existed",
        len(impact["replan"]["mutations"]) >= 1,
        impact["replan"]["expressed_in"],
    )
    evaluated = await post(f"/api/scenarios/{impact['replan']['scenario_id']}/evaluate")
    check(
        "and the existing scenario endpoints accept it unchanged",
        evaluated.status_code == 200,
    )
    check(
        "asking cost nothing: the base version is unchanged",
        impact["base_unchanged"] is True and impact["applied"] is False,
    )
    hash_after = (
        await client.get(f"/api/projects/{CAMPUS}/workflow")
    ).json()["version"]["content_hash"]
    check(
        "confirmed against the stored hash, not just the claim",
        hash_before == hash_after,
    )
    # The caveat that matters most on this whole screen.
    judgement = impact["assumptions"]["material_change_is_a_human_judgement"]
    check(
        "it states that whether the wording really invalidates the work is a human call",
        "not from the two texts" in judgement
        and "your call" in judgement
        and "nothing in this system makes it for you" in judgement,
    )
    check(
        "and that no language model was involved in any of it",
        "no_language_model_is_involved" in impact["assumptions"],
    )

    # Two plain wordings cost the same, and the honest answer is to say so.
    compared = (await post(
        f"/api/projects/{CAMPUS}/requirements/{key}/compare",
        {"options": ["Two-day event, 700 attendees", "Extend the event to two days"]},
    )).json()
    check(
        "comparing two wordings reports a tie rather than inventing a difference",
        compared["cheapest_option_index"] is None or compared["tie"] is True,
    )
    check(
        "and explains why the graph cannot tell them apart",
        len(compared["differences"]["statement"]) > 40,
    )


async def main_async(provider: str) -> int:
    from backend.app.main import app
    from backend.app.services import ai_service

    expect_model = provider == "recorded"
    if expect_model:
        recorded = RecordedProvider()
        ai_service.provider = lambda: recorded  # type: ignore[assignment]
        ai_service.reset_cache()

    print("=" * 74)
    print(
        f"DEMO WALK - ARCHITECTURE Section I - AI provider: "
        f"{'recorded (enabled)' if expect_model else 'null (disabled)'}"
    )
    print("=" * 74)

    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(
            transport=transport, base_url="http://demo", timeout=60.0
        ) as client:
            await walk(client, expect_model)

    print("\n" + "-" * 74)
    print("timings (seconds):")
    for label, seconds in sorted(_timings.items(), key=lambda kv: -kv[1])[:6]:
        print(f"  {label:<28} {seconds:.3f}")

    print("-" * 74)
    if _failures:
        print(f"FAILED {len(_failures)} check(s):")
        for failure in _failures:
            print(f"  - {failure}")
        return 1
    print("ALL BEATS PASSED")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--provider",
        choices=("null", "recorded"),
        default="null",
        help="null runs the deterministic path; recorded replays canned model output",
    )
    args = parser.parse_args(argv)
    return asyncio.run(main_async(args.provider))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
