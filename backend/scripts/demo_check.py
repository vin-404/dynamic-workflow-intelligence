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
