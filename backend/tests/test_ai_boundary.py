"""
The two invariants the AI layer exists to make structural.

1. **The LLM has no write path.** Asserted by parsing every module under
   `ai/` and failing on an import of anything that writes workflow state, and
   again end to end: an interpretation produces a *pending* scenario and the
   project's current version is untouched.
2. **The LLM is never the authority for a number.** Asserted directly on
   `verify_numbers`, and end to end: a narration containing a figure the
   engine did not produce is discarded rather than shown.

Everything here runs against `NullProvider` or a recorded fake. **No test in
this suite ever calls a live API** (ARCHITECTURE F).
"""
from __future__ import annotations

import ast
import json
import pathlib

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from backend.app import ai
from backend.app.ai.provider import AIRejected, AIRequest, AIResponse, ProviderUnavailable
from backend.app.core.engine import evaluate
from backend.app.core.workflow import Clock
from backend.app.main import app

AI_DIR = pathlib.Path(__file__).resolve().parents[1] / "app" / "ai"
EVENT_PROJECT_ID = "00000000-0000-0000-0000-000000000001"
MFG_PROJECT_ID = "00000000-0000-0000-0000-000000000002"


def _wide_workflow(size: int):
    """A workflow too big to send whole: one long chain plus a wide fan of
    unblocked tasks, none of them assigned."""
    from backend.app.core.workflow import (
        DependencySpec, TaskSpec, WorkflowSnapshot, WorkflowState,
    )

    tasks = [
        TaskSpec(key=f"N{i:03d}", name=f"Task {i}", effort=2.0)
        for i in range(size)
    ]
    deps = [
        DependencySpec(from_task=f"N{i:03d}", to_task=f"N{i + 1:03d}")
        for i in range(60)
    ]
    snapshot = WorkflowSnapshot.build(tasks=tasks, dependencies=deps)
    return snapshot, WorkflowState.empty(snapshot)

# ---------------------------------------------------------------------------
# Recorded providers - never a live API
# ---------------------------------------------------------------------------


class RecordedProvider:
    """Replays canned JSON. This is how the contract tests work: the shape of
    a real response, without the network, the key, or the nondeterminism."""

    name = "recorded"
    available = True

    def __init__(self, *responses: str):
        self._responses = list(responses)
        self.calls: list[AIRequest] = []

    def complete(self, request: AIRequest) -> AIResponse:
        self.calls.append(request)
        if not self._responses:
            raise ProviderUnavailable("no more recorded responses")
        return AIResponse(text=self._responses.pop(0), provider=self.name)


class ExplodingProvider:
    name = "exploding"
    available = True

    def __init__(self, exc: Exception):
        self._exc = exc

    def complete(self, request: AIRequest) -> AIResponse:
        raise self._exc


# ---------------------------------------------------------------------------
# 1. No write path
# ---------------------------------------------------------------------------


def _ai_modules() -> list[pathlib.Path]:
    return sorted(AI_DIR.rglob("*.py"))


class TestTheModelHasNoWritePath:
    def test_there_are_modules_to_check(self):
        assert len(_ai_modules()) >= 6

    @pytest.mark.parametrize("path", _ai_modules(), ids=lambda p: p.name)
    def test_no_ai_module_imports_a_writer(self, path: pathlib.Path):
        """`ai/` may read `core/` types. It may not reach the database, the
        ORM, or any service that writes workflow state."""
        forbidden_roots = {"sqlalchemy", "aiosqlite", "alembic"}
        forbidden_prefixes = (
            "backend.app.db",
            "backend.app.models",
            "backend.app.services",
            "backend.app.api",
            "backend.app.seed",
            "backend.app.main",
        )
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            names: list[str] = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                names = [node.module]
            for name in names:
                assert name.split(".")[0] not in forbidden_roots, (
                    f"{path.name} imports {name!r}: ai/ cannot reach a database"
                )
                assert not name.startswith(forbidden_prefixes), (
                    f"{path.name} imports {name!r}: ai/ has no write path"
                )

    @pytest.mark.parametrize("path", _ai_modules(), ids=lambda p: p.name)
    def test_no_ai_module_calls_a_commit_or_apply(self, path: pathlib.Path):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        banned = {"commit", "flush", "apply_scenario", "write_version", "execute"}
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                assert node.func.attr not in banned, (
                    f"{path.name} calls .{node.func.attr}(): ai/ writes nothing"
                )

    def test_the_ai_package_exposes_exactly_three_roles(self):
        assert ai.ROLES == ("interpreter", "proposer", "narrator")


# ---------------------------------------------------------------------------
# 2. Never the authority for a number
# ---------------------------------------------------------------------------


class TestTheModelIsNotTheAuthorityForNumbers:
    PAYLOAD = {
        "projected_end_day": 26.0,
        "slip_days": 4.0,
        "findings": [{"impact_score": 72.0, "root_cause": "T03"}],
    }

    def test_a_number_from_the_payload_passes(self):
        assert ai.verify_numbers("It finishes on day 26.", self.PAYLOAD) == []

    def test_a_rounded_number_passes(self):
        assert ai.verify_numbers("About 4 days late.", self.PAYLOAD) == []

    def test_an_invented_number_is_caught(self):
        invented = ai.verify_numbers(
            "You will finish 31% earlier.", self.PAYLOAD
        )
        assert "31" in invented

    def test_several_invented_numbers_are_all_caught(self):
        invented = ai.verify_numbers(
            "Save 12 days and 9 weeks, cutting 45 hours.", self.PAYLOAD
        )
        assert set(invented) == {"12", "9", "45"}

    def test_a_task_key_does_not_license_its_digits(self):
        """`T03` in the payload is an identifier. A narration claiming "3
        days" is claiming a number the engine never produced, and the key
        must not be what excuses it."""
        assert ai.verify_numbers("Three tasks, 3 days each.", self.PAYLOAD) == ["3"]
        assert ai.verify_numbers("T03 is the bottleneck.", self.PAYLOAD) == []

    def test_a_narration_that_invents_a_number_is_discarded(self):
        """End to end: the model returns a plausible sentence with a made-up
        percentage, and the engine's own wording is shown instead."""
        recorded = json.dumps({
            "headline": "Two days late",
            "explanation": "You are 4 days behind and 87% likely to slip.",
            "numbers_used": ["4", "87"],
        })
        narration = ai.narrate(
            self.PAYLOAD,
            "Engine wording: projected day 26 against a day 24 deadline.",
            RecordedProvider(recorded),
        )
        assert narration.method == "engine_template"
        assert "87" in narration.rejected_reason
        assert "discarded" in narration.rejected_reason
        assert narration.explanation.startswith("Engine wording")

    def test_a_clean_narration_is_kept(self):
        recorded = json.dumps({
            "headline": "Two days late",
            "explanation": "The plan lands on day 26, four days later than planned.",
            "numbers_used": ["26"],
        })
        narration = ai.narrate(
            self.PAYLOAD, "fallback", RecordedProvider(recorded)
        )
        assert narration.method == "model"
        assert narration.rejected_reason == ""

    def test_the_narrator_receives_only_engine_output(self, event_fixture):
        """The prompt contains the engine result and nothing else - no raw
        workflow, no user text to be steered by."""
        recorded = json.dumps({
            "headline": "h", "explanation": "day 26", "numbers_used": ["26"],
        })
        provider = RecordedProvider(recorded)
        ai.narrate(self.PAYLOAD, "fallback", provider)
        sent = provider.calls[0].user
        assert "projected_end_day" in sent
        assert "Engine result" in sent


# ---------------------------------------------------------------------------
# Structured output discipline
# ---------------------------------------------------------------------------


class TestOutputDiscipline:
    SCHEMA_REQ = AIRequest(
        role="narrator",
        system="s",
        user="u",
        schema={"type": "object"},
        schema_name="NarrationOut",
    )

    def test_malformed_output_is_repaired_once_then_accepted(self):
        bad = json.dumps({"headline": "h"})            # missing fields
        good = json.dumps({
            "headline": "h", "explanation": "e", "numbers_used": [],
        })
        from backend.app.ai.schemas import NarrationOut

        provider = RecordedProvider(bad, good)
        value, interaction = ai.run(provider, self.SCHEMA_REQ, NarrationOut)
        assert value.explanation == "e"
        assert interaction.repaired is True
        assert interaction.valid is True
        assert len(provider.calls) == 2

    def test_the_repair_prompt_includes_the_validation_error(self):
        from backend.app.ai.schemas import NarrationOut

        bad = json.dumps({"headline": "h"})
        good = json.dumps({
            "headline": "h", "explanation": "e", "numbers_used": [],
        })
        provider = RecordedProvider(bad, good)
        ai.run(provider, self.SCHEMA_REQ, NarrationOut)
        repair = provider.calls[1].user
        assert "did not validate" in repair
        assert "explanation" in repair

    def test_malformed_twice_is_rejected_not_retried_forever(self):
        from backend.app.ai.schemas import NarrationOut

        bad = json.dumps({"headline": "h"})
        provider = RecordedProvider(bad, bad, bad, bad)
        with pytest.raises(AIRejected) as exc:
            ai.run(provider, self.SCHEMA_REQ, NarrationOut)
        assert "twice" in exc.value.reason
        assert len(provider.calls) == 2, "exactly one repair attempt"

    def test_a_kind_outside_the_algebra_is_rejected(self):
        from backend.app.ai.schemas import InterpretationOut

        with pytest.raises(Exception) as exc:
            InterpretationOut.model_validate({
                "understood": True,
                "intent": "x",
                "mutations": [{"kind": "RESTRUCTURE_EVERYTHING", "payload": {}}],
                "unsupported": [],
            })
        assert "not a mutation this system can express" in str(exc.value)

    def test_every_role_declares_a_schema_with_a_closed_kind_enum(self):
        from backend.app.ai import schemas

        for builder in (schemas.interpretation_schema, schemas.proposals_schema):
            rendered = json.dumps(builder())
            assert "TASK_SPLIT" in rendered
            assert "RESTRUCTURE" not in rendered

    def test_responses_are_cached_by_prompt_hash(self):
        from backend.app.ai.schemas import NarrationOut

        good = json.dumps({
            "headline": "h", "explanation": "e", "numbers_used": [],
        })
        cache = ai.ResponseCache()
        provider = RecordedProvider(good)
        ai.run(provider, self.SCHEMA_REQ, NarrationOut, cache)
        assert len(cache) == 1

        # Second call is served from the cache - the provider has no responses
        # left, so a cache miss would raise.
        value, interaction = ai.run(
            provider, self.SCHEMA_REQ, NarrationOut, cache
        )
        assert interaction.cached is True
        assert value.explanation == "e"
        assert len(provider.calls) == 1

    def test_a_poisoned_cache_entry_is_dropped_not_trusted(self):
        from backend.app.ai.schemas import NarrationOut

        good = json.dumps({
            "headline": "h", "explanation": "e", "numbers_used": [],
        })
        cache = ai.ResponseCache({self.SCHEMA_REQ.prompt_hash: "{not json"})
        provider = RecordedProvider(good)
        value, interaction = ai.run(
            provider, self.SCHEMA_REQ, NarrationOut, cache
        )
        assert value.explanation == "e"
        assert interaction.cached is False

    def test_the_prompt_hash_is_stable_and_covers_the_inputs(self):
        other = AIRequest(
            role="narrator", system="s", user="different",
            schema={"type": "object"}, schema_name="NarrationOut",
        )
        assert self.SCHEMA_REQ.prompt_hash == self.SCHEMA_REQ.prompt_hash
        assert self.SCHEMA_REQ.prompt_hash != other.prompt_hash


# ---------------------------------------------------------------------------
# Everything works with the model disabled
# ---------------------------------------------------------------------------


class TestNullProvider:
    def test_it_is_the_default_with_no_key(self, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("AI_PROVIDER", raising=False)
        assert ai.get_provider().name == "null"

    def test_it_can_be_forced_even_with_a_key(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-not-real")
        assert ai.get_provider("null").name == "null"

    def test_it_raises_rather_than_pretending(self):
        with pytest.raises(ProviderUnavailable):
            ai.NullProvider().complete(TestOutputDiscipline.SCHEMA_REQ)

    def test_the_interpreter_falls_back_to_a_labelled_matcher(self, event_fixture):
        result = ai.interpret(
            "T03 slips 5 days",
            event_fixture.snapshot,
            event_fixture.state,
            ai.NullProvider(),
        )
        assert result.understood is True
        assert result.method == "deterministic_patterns"
        assert result.mutations[0]["kind"] == "TASK_DELAY_ADD"
        assert result.mutations[0]["payload"]["extra_days"] == 5.0

    def test_the_fallback_refuses_rather_than_guesses(self, event_fixture):
        result = ai.interpret(
            "reorganise everything so it goes faster",
            event_fixture.snapshot,
            event_fixture.state,
            ai.NullProvider(),
        )
        assert result.understood is False
        assert result.mutations == []
        assert "pattern matcher rather than an interpreter" in (
            result.clarification_needed
        )

    def test_the_intent_reads_back_names_not_lowercased_keys(
        self, event_fixture
    ):
        """The intent is the sentence a person reads back before deciding.
        A key is lowercase, so "anitha is unavailable" reads like a bug even
        when the mutation underneath is right."""
        result = ai.interpret(
            "Anitha is unavailable from day 14 to day 21",
            event_fixture.snapshot,
            event_fixture.state,
            ai.NullProvider(),
        )
        assert result.understood is True
        assert "anitha is unavailable" not in result.intent
        assert result.mutations[0]["payload"]["resource_key"] == "anitha"

    def test_a_task_intent_names_the_task_as_well_as_its_key(
        self, event_fixture
    ):
        result = ai.interpret(
            "T03 slips 5 days",
            event_fixture.snapshot,
            event_fixture.state,
            ai.NullProvider(),
        )
        assert result.intent.startswith("T03 (")
        assert "5 more day(s)" in result.intent

    def test_the_proposer_returns_nothing_and_says_why(self, event_fixture):
        result = evaluate(
            event_fixture.snapshot, event_fixture.state, Clock(14.0)
        )
        proposals = ai.propose(
            event_fixture.snapshot,
            event_fixture.state,
            result,
            ai.NullProvider(),
        )
        assert proposals.candidates == []
        assert proposals.available is False
        assert "deterministic" in proposals.note

    def test_the_narrator_falls_back_to_the_engines_own_words(self):
        narration = ai.narrate(
            {"projected_end_day": 26}, "The engine said this.", ai.NullProvider()
        )
        assert narration.method == "engine_template"
        assert narration.explanation == "The engine said this."

    def test_a_provider_outage_mid_flight_also_falls_back(self, event_fixture):
        result = ai.interpret(
            "T03 slips 5 days",
            event_fixture.snapshot,
            event_fixture.state,
            ExplodingProvider(ProviderUnavailable("wifi died")),
        )
        assert result.method == "deterministic_patterns"
        assert result.understood is True

    def test_a_model_rejection_also_falls_back(self):
        narration = ai.narrate(
            {"projected_end_day": 26},
            "engine words",
            ExplodingProvider(AIRejected("the model declined")),
        )
        assert narration.method == "engine_template"
        assert narration.rejected_reason == "the model declined"


# ---------------------------------------------------------------------------
# The projection is compact and domain-quarantined
# ---------------------------------------------------------------------------


class TestProjection:
    def test_it_references_tasks_by_key(self, event_fixture):
        payload = ai.project(event_fixture.snapshot, event_fixture.state)
        for task in payload["tasks"]:
            assert task["key"]
        for dep in payload["dependencies"]:
            assert dep["from"] in {t["key"] for t in payload["tasks"]}

    def test_it_carries_the_constraints_so_the_model_can_respect_them(
        self, mfg_fixture
    ):
        payload = ai.project(mfg_fixture.snapshot, mfg_fixture.state)
        kinds = {c["kind"] for c in payload["constraints"]}
        assert "MANDATORY_TASK" in kinds
        assert all(c["reason"] for c in payload["constraints"])

    def test_domain_context_reaches_the_prompt_and_nothing_else(
        self, event_fixture
    ):
        payload = ai.project(
            event_fixture.snapshot,
            event_fixture.state,
            domain_name="Event Operations",
            domain_hints=["venue", "sponsor"],
        )
        assert payload["domain_context"]["name"] == "Event Operations"
        assert "never sees this" in payload["domain_context"]["note"]

    def test_a_large_workflow_is_trimmed_rather_than_sent_whole(self):
        snapshot, state = _wide_workflow(120)
        result = evaluate(snapshot, state, Clock(0.0))
        payload = ai.project(snapshot, state, result)
        assert payload["total_tasks"] == 120
        assert payload["tasks_shown"] < 120
        assert "omitted to keep this compact" in payload["note"]

    def test_findings_cannot_pull_the_whole_graph_back_in(self):
        """Compaction is per-task, but findings name tasks. 300 isolated
        tasks produce 300 findings that between them name every one of them,
        which put the entire graph back in the prompt one `task_ids` at a
        time until the finding cap went in."""
        from backend.app.ai.projection import MAX_TASKS_SENT

        snapshot, state = _wide_workflow(300)
        result = evaluate(snapshot, state, Clock(0.0))
        named = {k for f in result.findings for k in f.task_ids}
        assert len(named) > MAX_TASKS_SENT, (
            "fixture no longer produces findings covering the whole graph"
        )
        payload = ai.project(snapshot, state, result)
        assert payload["tasks_shown"] <= MAX_TASKS_SENT
        assert len(payload["analysis"]["findings"]) < len(result.findings)

    def test_compaction_keeps_the_whole_critical_path(self):
        snapshot, state = _wide_workflow(300)
        result = evaluate(snapshot, state, Clock(0.0))
        payload = ai.project(snapshot, state, result)
        shown = {t["key"] for t in payload["tasks"]}
        assert set(result.schedule["critical"]) <= shown

    def test_compaction_is_deterministic_at_the_ceiling(self):
        snapshot, state = _wide_workflow(300)
        result = evaluate(snapshot, state, Clock(0.0))
        a = ai.render(ai.project(snapshot, state, result))
        b = ai.render(ai.project(snapshot, state, result))
        assert a == b

    def test_the_projection_is_deterministic(self, event_fixture):
        a = ai.render(ai.project(event_fixture.snapshot, event_fixture.state))
        b = ai.render(ai.project(event_fixture.snapshot, event_fixture.state))
        assert a == b


# ---------------------------------------------------------------------------
# The Proposer is gated exactly like every other candidate
# ---------------------------------------------------------------------------


class TestProposalsGetNoShortcut:
    def _result(self, fixture):
        return evaluate(fixture.snapshot, fixture.state, Clock(fixture.today_day))

    def test_a_proposal_violating_a_constraint_is_rejected_with_it_cited(
        self, mfg_fixture
    ):
        """The brief's named assertion: an LLM proposal that breaks a
        constraint is refused, with the constraint quoted."""
        from backend.app.core.optimization import optimize

        recorded = json.dumps({
            "proposals": [{
                "name": "Skip certification to hit the date",
                "rationale": "It is the longest thing on the path.",
                "mutations": [{"kind": "TASK_REMOVE", "payload": {"key": "M09"}}],
            }]
        })
        proposals = ai.propose(
            mfg_fixture.snapshot,
            mfg_fixture.state,
            self._result(mfg_fixture),
            RecordedProvider(recorded),
        )
        assert len(proposals.candidates) == 1
        assert proposals.candidates[0].origin == "llm_proposal"

        result = optimize(
            mfg_fixture.snapshot,
            mfg_fixture.state,
            Clock(0.0),
            extra_candidates=proposals.candidates,
        )
        refused = next(
            c for c in result.rejected
            if c.name == "Skip certification to hit the date"
        )
        assert refused.rejections[0].constraint == "MANDATORY_TASK"
        assert "UN38.3" in refused.rejections[0].constraint_reason
        assert refused.score is None, "a refused proposal is never scored"

    def test_a_valid_proposal_is_scored_by_the_same_engine(self, event_fixture):
        from backend.app.core.optimization import optimize

        recorded = json.dumps({
            "proposals": [{
                "name": "Run the speaker track in parallel",
                "rationale": "Invitations do not need the budget signed off.",
                "mutations": [
                    {"kind": "DEPENDENCY_REMOVE",
                     "payload": {"from_task": "T03", "to_task": "T13"}}
                ],
            }]
        })
        proposals = ai.propose(
            event_fixture.snapshot,
            event_fixture.state,
            self._result(event_fixture),
            RecordedProvider(recorded),
        )
        result = optimize(
            event_fixture.snapshot,
            event_fixture.state,
            Clock(14.0),
            extra_candidates=proposals.candidates,
        )
        scored = next(
            c for c in result.candidates
            if c.name == "Run the speaker track in parallel"
        )
        assert scored.score is not None
        assert len(scored.score.criteria) == 6
        assert scored.origin == "llm_proposal"

    def test_a_proposal_is_ranked_against_heuristics_on_merit(
        self, event_fixture
    ):
        from backend.app.core.optimization import optimize

        recorded = json.dumps({
            "proposals": [{
                "name": "A pointless change",
                "rationale": "None really.",
                "mutations": [
                    {"kind": "TASK_PRIORITY_SET",
                     "payload": {"key": "T05", "priority": 3}}
                ],
            }]
        })
        proposals = ai.propose(
            event_fixture.snapshot,
            event_fixture.state,
            self._result(event_fixture),
            RecordedProvider(recorded),
        )
        result = optimize(
            event_fixture.snapshot,
            event_fixture.state,
            Clock(14.0),
            extra_candidates=proposals.candidates,
        )
        assert result.recommended is not None
        assert result.recommended.name != "A pointless change"

    def test_the_proposer_prompt_forbids_stating_numbers(self):
        from backend.app.ai.proposer import SYSTEM

        assert "Do not state any projected date" in SYSTEM
        assert "know them" in SYSTEM


# ---------------------------------------------------------------------------
# Through the API
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture(scope="module")
async def client():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c


class TestAiApi:
    async def test_status_reports_the_degraded_behaviour(self, client):
        r = await client.get("/api/ai/status")
        assert r.status_code == 200
        body = r.json()
        assert body["provider"] == "null"
        assert body["available"] is False
        assert set(body["degraded_behaviour"]) == {
            "interpreter", "proposer", "narrator"
        }
        assert any("no write path" in g for g in body["guarantees"])

    async def test_interpret_creates_a_pending_scenario_not_a_version(
        self, client
    ):
        before = await client.get(f"/api/projects/{EVENT_PROJECT_ID}/workflow")
        version_before = before.json()["version"]

        r = await client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/interpret",
            json={"utterance": "T03 slips 5 days"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["understood"] is True
        assert body["applied"] is False
        assert body["scenario_id"]
        assert body["validation"]["valid"] is True

        after = await client.get(f"/api/projects/{EVENT_PROJECT_ID}/workflow")
        assert after.json()["version"]["id"] == version_before["id"]
        assert (
            after.json()["version"]["content_hash"]
            == version_before["content_hash"]
        )

    async def test_the_pending_scenario_is_a_normal_scenario(self, client):
        r = await client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/interpret",
            json={"utterance": "split T14 across 2 people"},
        )
        scenario_id = r.json()["scenario_id"]

        detail = await client.get(f"/api/scenarios/{scenario_id}")
        assert detail.status_code == 200
        assert detail.json()["mutations"][0]["kind"] == "TASK_SPLIT"

        evaluated = await client.post(f"/api/scenarios/{scenario_id}/evaluate")
        assert evaluated.status_code == 200
        assert evaluated.json()["base_unchanged"] is True

    async def test_an_unrecognised_request_returns_the_gap(self, client):
        r = await client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/interpret",
            json={"utterance": "make everything better somehow"},
        )
        body = r.json()
        assert body["understood"] is False
        assert body["scenario_id"] is None
        assert body["unsupported"]

    async def test_a_request_that_breaks_a_constraint_is_not_stored(
        self, client
    ):
        """Even when the shape is understood, semantic validation runs before
        anything is written."""
        r = await client.post(
            f"/api/projects/{MFG_PROJECT_ID}/interpret",
            json={"utterance": "split M09 across 3 people"},
        )
        body = r.json()
        assert body["understood"] is True
        assert body["validation"]["valid"] is False
        assert body["scenario_id"] is None
        rejection = body["validation"]["rejections"][0]
        assert "non-divisible" in rejection["reason"]

    async def test_explain_uses_the_engines_words_with_no_model(self, client):
        r = await client.post(f"/api/projects/{EVENT_PROJECT_ID}/explain")
        assert r.status_code == 200
        body = r.json()
        assert body["method"] == "engine_template"
        assert "infeasible" in body["explanation"]
        assert "cannot introduce" in body["note"]

    async def test_every_interaction_is_logged(self, client):
        """The audit trail is the evidence that the model never had
        authority."""
        from sqlalchemy import func, select

        from backend.app.db import async_session
        from backend.app.models import AIInteraction

        await client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/interpret",
            json={"utterance": "T05 slips 2 days", "keep": False},
        )
        async with async_session() as db:
            total = (
                await db.execute(select(func.count()).select_from(AIInteraction))
            ).scalar_one()
            rows = (
                await db.execute(
                    select(AIInteraction).order_by(
                        AIInteraction.created_at.desc()
                    ).limit(5)
                )
            ).scalars().all()
        assert total > 0
        for row in rows:
            assert row.role in ai.ROLES
            assert len(row.prompt_hash) == 64
            assert row.schema_name

    async def test_optimize_reports_what_the_proposer_contributed(self, client):
        r = await client.post(
            f"/api/projects/{MFG_PROJECT_ID}/optimize",
            json={"budget": {"max_candidates": 3, "max_seconds": 10},
                  "persist_candidates": False},
        )
        assert r.status_code == 200
        note = r.json()["llm_proposals"]
        assert note["count"] == 0
        assert "deterministic" in note["note"]

    async def test_optimize_still_works_with_the_llm_turned_off(self, client):
        r = await client.post(
            f"/api/projects/{MFG_PROJECT_ID}/optimize",
            json={"use_llm": False, "persist_candidates": False,
                  "budget": {"max_candidates": 5, "max_seconds": 10}},
        )
        assert r.status_code == 200
        assert r.json()["candidates"]
        assert r.json()["llm_proposals"]["note"] == "not requested"


# ---------------------------------------------------------------------------
# The whole product, with the model switched off
# ---------------------------------------------------------------------------


class TestEveryCapabilityWorksWithNoModel:
    """The brief's standing rule: "every capability must work with the LLM
    disabled". This walks all four end to end against `NullProvider`, which
    is what the whole suite runs under - so if any capability had quietly
    grown a dependency on a model, it would fail here."""

    async def test_capability_1_detect_current_bottlenecks(self, client):
        r = await client.post(f"/api/projects/{EVENT_PROJECT_ID}/analyze")
        assert r.status_code == 200
        body = r.json()
        assert body["findings"], "detection produced nothing"
        top = body["findings"][0]
        assert top["evidence"], "a finding with no evidence is not explainable"
        assert top["explanation"]
        assert top["suggested_action"]
        assert top["root_cause"]
        assert body["critical_path"], "no critical path"
        assert body["checks_run"], "the checks that ran must be enumerable"
        assert body["tier_reached"] >= 0

    async def test_capability_2_predict_future_bottlenecks(self, client):
        r = await client.post(f"/api/projects/{EVENT_PROJECT_ID}/analyze")
        body = r.json()
        risk = body["risk"]
        assert risk["tasks"], "no forward-looking risk"
        assert risk["assumptions"]["score_kind"] == "structural_estimate"
        assert "not a probability" in risk["assumptions"]["disclaimer"]
        top = risk["tasks"][0]
        assert top["factors"], "risk with no factor breakdown is not explainable"
        assert top["formula"]
        assert abs(
            sum(f["contribution"] for f in top["factors"]) - top["score"]
        ) < 1e-6, "the score must be exactly the sum of its factors"
        assert body["feasibility"]["is_probability"] is False
        assert body["feasibility"]["three_point"]

    async def test_capability_3_simulate_without_touching_the_workflow(
        self, client
    ):
        before = await client.get(f"/api/projects/{EVENT_PROJECT_ID}/workflow")
        base_hash = before.json()["version"]["content_hash"]

        r = await client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/what-if",
            json={
                "name": "No model needed",
                "mutations": [
                    {"kind": "TASK_DELAY_ADD",
                     "payload": {"key": "T03", "extra_days": 5}}
                ],
            },
        )
        assert r.status_code == 200
        body = r.json()
        assert body["base_unchanged"] is True
        assert body["comparison"]["projected_completion"]["delta_days"] == 5.0
        assert body["comparison"]["tasks_moved"]
        assert body["inverse_mutations"], "a simulation must be reversible"

        after = await client.get(f"/api/projects/{EVENT_PROJECT_ID}/workflow")
        assert after.json()["version"]["content_hash"] == base_hash

    async def test_capability_4_propose_and_evaluate_better_workflows(
        self, client
    ):
        r = await client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/optimize",
            json={"persist_candidates": False,
                  "budget": {"max_candidates": 20, "max_seconds": 20}},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["llm_proposals"]["count"] == 0, "no model is configured"
        assert body["candidates"], "the search found nothing without a model"
        assert body["recommended"]
        assert len(body["recommended"]["scores"]["criteria"]) == 6
        assert body["weights"], "the ranking must publish its weights"
        assert body["recommendation_reason"]

    async def test_the_refusal_still_cites_its_constraint(self, client):
        """The demo's sharpest moment does not depend on a model either."""
        r = await client.post(
            f"/api/projects/{MFG_PROJECT_ID}/what-if",
            json={
                "name": "Skip certification",
                "mutations": [
                    {"kind": "TASK_REMOVE", "payload": {"key": "M09"}}
                ],
            },
        )
        assert r.status_code == 422
        rejection = r.json()["detail"]["rejections"][0]
        assert rejection["constraint"] == "MANDATORY_TASK"
        assert "UN38.3" in rejection["constraint_reason"]

    async def test_the_status_endpoint_names_what_carries_each_capability(
        self, client
    ):
        """`available: false` alongside four working capabilities is only
        coherent because each names a deterministic mechanism."""
        status = (await client.get("/api/ai/status")).json()
        assert status["available"] is False
        mechanisms = status["capabilities_without_model"]
        assert set(mechanisms) == {"detect", "predict", "simulate", "optimize"}
        for capability, mechanism in mechanisms.items():
            assert "LLM" not in mechanism, capability
            assert mechanism


# ---------------------------------------------------------------------------
# The real provider, against the real SDK, without the network
# ---------------------------------------------------------------------------


def _recorded_message(text: str, **overrides):
    """A recorded API response, validated by the SDK's own `Message` model -
    so if the response shape changes under us, this fails."""
    from anthropic.types import Message

    payload = {
        "id": "msg_recorded",
        "type": "message",
        "role": "assistant",
        "model": "claude-opus-5",
        "content": [{"type": "text", "text": text}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 1200, "output_tokens": 240},
    }
    payload.update(overrides)
    return Message.model_validate(payload)


class _StubMessages:
    def __init__(self, outcome):
        self._outcome = outcome
        self.kwargs: dict = {}

    def create(self, **kwargs):
        self.kwargs = kwargs
        if isinstance(self._outcome, Exception):
            raise self._outcome
        return self._outcome


class _StubClient:
    def __init__(self, outcome):
        self.messages = _StubMessages(outcome)


class TestAnthropicProviderContract:
    """Contract tests against **recorded responses**, never a live API.

    The stub sits where the SDK client sits, so the request this provider
    builds is checked against the installed SDK's own parameter types, and the
    response it reads is a real `anthropic.types.Message`. If the SDK surface
    this code targets changes, these fail rather than the demo.
    """

    REQUEST = AIRequest(
        role="narrator",
        system="You rephrase engine output.",
        user="Engine result: {}",
        schema={"type": "object", "properties": {"headline": {"type": "string"}}},
        schema_name="NarrationOut",
        effort="low",
        max_tokens=1024,
    )

    def _provider(self, outcome):
        pytest.importorskip("anthropic")
        from backend.app.ai.provider import AnthropicProvider

        provider = AnthropicProvider(api_key="sk-ant-not-a-real-key")
        stub = _StubClient(outcome)
        provider._client = stub
        return provider, stub

    def test_no_key_means_unavailable_rather_than_an_error(self, monkeypatch):
        from backend.app.ai.provider import AnthropicProvider

        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        assert AnthropicProvider().available is False

    def test_every_parameter_it_sends_exists_in_the_sdk(self):
        pytest.importorskip("anthropic")
        from anthropic.types import message_create_params

        provider, stub = self._provider(_recorded_message('{"headline":"h"}'))
        provider.complete(self.REQUEST)
        allowed = set(
            message_create_params.MessageCreateParamsBase.__annotations__
        )
        assert set(stub.messages.kwargs) <= allowed, (
            set(stub.messages.kwargs) - allowed
        )

    def test_it_asks_for_structured_output_not_prose(self):
        pytest.importorskip("anthropic")
        from anthropic.types.output_config_param import OutputConfigParam

        provider, stub = self._provider(_recorded_message('{"headline":"h"}'))
        provider.complete(self.REQUEST)
        config = stub.messages.kwargs["output_config"]
        assert set(config) <= set(OutputConfigParam.__annotations__)
        assert config["format"]["type"] == "json_schema"
        assert config["format"]["schema"] == self.REQUEST.schema
        assert config["effort"] in ("low", "medium", "high", "xhigh", "max")

    def test_it_uses_adaptive_thinking_not_a_token_budget(self):
        """`budget_tokens` is rejected outright on this model family."""
        provider, stub = self._provider(_recorded_message('{"headline":"h"}'))
        provider.complete(self.REQUEST)
        assert stub.messages.kwargs["thinking"] == {"type": "adaptive"}

    def test_it_sends_no_assistant_prefill(self):
        """Prefill is how you coax JSON out of a model without structured
        output. It is rejected on this family, and unnecessary here."""
        provider, stub = self._provider(_recorded_message('{"headline":"h"}'))
        provider.complete(self.REQUEST)
        roles = [m["role"] for m in stub.messages.kwargs["messages"]]
        assert roles == ["user"]

    def test_it_reads_the_text_out_of_a_recorded_response(self):
        provider, _ = self._provider(_recorded_message('{"headline":"done"}'))
        response = provider.complete(self.REQUEST)
        assert response.text == '{"headline":"done"}'
        assert response.provider == "anthropic"
        assert response.usage["input_tokens"] == 1200

    def test_thinking_blocks_are_not_mistaken_for_the_answer(self):
        """With adaptive thinking on, the response carries thinking blocks
        alongside the text. Only the text is the answer."""
        message = _recorded_message(
            '{"headline":"h"}',
            content=[
                {"type": "thinking", "thinking": "The number is 26.",
                 "signature": "sig"},
                {"type": "text", "text": '{"headline":"h"}'},
            ],
        )
        provider, _ = self._provider(message)
        assert provider.complete(self.REQUEST).text == '{"headline":"h"}'

    def test_a_refusal_is_surfaced_with_its_explanation(self):
        message = _recorded_message(
            "",
            content=[],
            stop_reason="refusal",
            stop_details={
                "type": "refusal",
                "category": "general_harms",
                "explanation": "The model declined to answer.",
            },
        )
        provider, _ = self._provider(message)
        with pytest.raises(AIRejected) as exc:
            provider.complete(self.REQUEST)
        assert "declined" in exc.value.detail

    def test_a_connection_failure_is_unavailable_not_rejected(self):
        pytest.importorskip("anthropic")
        import anthropic
        import httpx

        outage = anthropic.APIConnectionError(
            request=httpx.Request("POST", "https://api.anthropic.com")
        )
        provider, _ = self._provider(outage)
        with pytest.raises(ProviderUnavailable):
            provider.complete(self.REQUEST)

    def test_being_rate_limited_is_unavailable_so_the_fallback_runs(self):
        pytest.importorskip("anthropic")
        import anthropic
        import httpx

        request = httpx.Request("POST", "https://api.anthropic.com")
        limited = anthropic.RateLimitError(
            "slow down",
            response=httpx.Response(429, request=request),
            body=None,
        )
        provider, _ = self._provider(limited)
        with pytest.raises(ProviderUnavailable):
            provider.complete(self.REQUEST)

    def test_a_bad_request_is_a_rejection_not_an_outage(self):
        """A 400 is our bug and retrying will not fix it; a 5xx is theirs and
        the deterministic path should take over."""
        pytest.importorskip("anthropic")
        import anthropic
        import httpx

        request = httpx.Request("POST", "https://api.anthropic.com")
        bad = anthropic.BadRequestError(
            "schema too deep",
            response=httpx.Response(400, request=request),
            body=None,
        )
        provider, _ = self._provider(bad)
        with pytest.raises(AIRejected):
            provider.complete(self.REQUEST)

    def test_an_upstream_error_falls_back(self):
        pytest.importorskip("anthropic")
        import anthropic
        import httpx

        request = httpx.Request("POST", "https://api.anthropic.com")
        boom = anthropic.InternalServerError(
            "upstream",
            response=httpx.Response(503, request=request),
            body=None,
        )
        provider, _ = self._provider(boom)
        with pytest.raises(ProviderUnavailable):
            provider.complete(self.REQUEST)

    def test_the_model_is_the_current_one(self):
        from backend.app.ai.provider import DEFAULT_MODEL

        assert DEFAULT_MODEL == "claude-opus-5"
