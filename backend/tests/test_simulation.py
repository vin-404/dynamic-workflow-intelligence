"""
Capability 3 tests - simulation, diff, and apply.

The invariant this file exists to prove: **evaluating a scenario leaves the
base version's hash unchanged**. It is asserted at three levels - on the pure
snapshot, through the service, and through the HTTP API - because "the
original workflow must remain unchanged" is a product promise and one
assertion in one layer is not enough for it.
"""
from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from backend.app.core.mutations import Mutation, MutationKind as K
from backend.app.core.simulation import Scenario, simulate, summarise
from backend.app.core.workflow import Clock
from backend.app.main import app

EVENT_PROJECT_ID = "00000000-0000-0000-0000-000000000001"
MFG_PROJECT_ID = "00000000-0000-0000-0000-000000000002"


# ---------------------------------------------------------------------------
# Pure core
# ---------------------------------------------------------------------------


def scenario(fx, *mutations, name="test"):
    return Scenario(
        base=fx.snapshot,
        base_state=fx.state,
        mutations=tuple(mutations),
        name=name,
    )


class TestBaseImmutability:
    """The assertion the brief calls for by name."""

    def test_the_base_hash_is_unchanged_after_evaluation(self, event_fixture):
        before = event_fixture.snapshot.content_hash()
        result = simulate(
            scenario(
                event_fixture,
                Mutation(K.TASK_DELAY_ADD, {"key": "T03", "extra_days": 5}),
            ),
            Clock(event_fixture.today_day),
        )
        assert result.base_hash_before == before
        assert result.base_hash_after == before
        assert result.base_unchanged is True
        assert event_fixture.snapshot.content_hash() == before

    def test_a_scenario_that_changes_a_lot_still_leaves_the_base_alone(
        self, event_fixture
    ):
        before = event_fixture.snapshot.content_hash()
        result = simulate(
            scenario(
                event_fixture,
                Mutation(K.TASK_REMOVE, {"key": "T12"}),
                Mutation(K.TASK_SPLIT, {"key": "T14", "parts": 3}),
                Mutation(K.DEPENDENCY_REMOVE, {
                    "from_task": "T01", "to_task": "T04",
                }),
                Mutation(K.RESOURCE_CAPACITY_SET, {
                    "resource_key": "mkt", "capacity": 4,
                }),
                Mutation(K.DEADLINE_SET, {"deadline_day": 40}),
            ),
            Clock(event_fixture.today_day),
        )
        assert result.base_unchanged
        assert result.after_hash != before
        assert event_fixture.snapshot.content_hash() == before

    def test_the_base_state_is_unchanged_too(self, event_fixture):
        statuses_before = dict(event_fixture.state.statuses)
        simulate(
            scenario(
                event_fixture,
                Mutation(K.TASK_STATUS_SET, {"key": "T04", "status": "done"}),
                Mutation(K.REQUIREMENT_VERSION_BUMP, {"requirement_key": "R2"}),
            ),
            Clock(event_fixture.today_day),
        )
        assert dict(event_fixture.state.statuses) == statuses_before

    def test_evaluating_twice_gives_the_same_answer(self, event_fixture):
        sc = scenario(
            event_fixture,
            Mutation(K.TASK_DELAY_ADD, {"key": "T03", "extra_days": 5}),
        )
        a = simulate(sc, Clock(14.0)).as_dict()
        b = simulate(sc, Clock(14.0)).as_dict()
        assert a == b


class TestThereIsOnlyOneScheduler:
    """If simulation had its own scheduling code the two would drift and only
    one would be right. So the numbers a simulation reports for its base must
    be exactly what `evaluate()` reports on its own."""

    def test_the_simulations_base_matches_a_plain_evaluation(self, event_fixture):
        from backend.app.core.engine import evaluate

        direct = evaluate(
            event_fixture.snapshot, event_fixture.state, Clock(14.0)
        ).as_dict()
        via_sim = simulate(scenario(event_fixture), Clock(14.0)).base.as_dict()
        assert direct == via_sim

    def test_an_empty_scenario_changes_nothing(self, event_fixture):
        result = simulate(scenario(event_fixture), Clock(14.0))
        assert result.comparison["projected_completion"]["delta_days"] == 0
        assert result.comparison["tasks_moved"] == []
        assert result.comparison["findings"]["created"] == []
        assert result.comparison["findings"]["removed"] == []


class TestTheDiffPayload:
    """ARCHITECTURE D.3 lists what a simulation must report. All of it."""

    @pytest.fixture
    def result(self, event_fixture):
        return simulate(
            scenario(
                event_fixture,
                Mutation(K.TASK_DELAY_ADD, {"key": "T03", "extra_days": 5}),
                name="T03 slips 5 more days",
            ),
            Clock(event_fixture.today_day),
        )

    def test_projected_completion_and_delta(self, result):
        c = result.comparison["projected_completion"]
        assert c["before_day"] == 26.0
        assert c["after_day"] == 31.0
        assert c["delta_days"] == 5.0
        assert c["direction"] == "later"

    def test_tasks_moved_with_per_task_deltas(self, result):
        moved = result.comparison["tasks_moved"]
        assert len(moved) == 7
        for entry in moved:
            assert entry["task"]
            assert entry["name"]
            assert entry["delta_days"] == 5.0
            assert entry["to_day"] - entry["from_day"] == entry["delta_days"]

    def test_slack_consumed_is_empty_for_a_uniform_push(self, result):
        """Delaying a zero-slack task moves the whole tail *and* the project
        end, so every other task's late dates move with it and nobody's slack
        shrinks. Reporting slack consumed here would be wrong."""
        assert result.comparison["slack_consumed"] == {}
        assert result.comparison["slack_consumed_total_days"] == 0

    def test_slack_is_consumed_when_a_slack_task_slips(self, event_fixture):
        result = simulate(
            scenario(event_fixture, Mutation(K.TASK_DELAY_ADD, {
                "key": "T12", "extra_days": 3,
            })),
            Clock(14.0),
        )
        assert result.comparison["projected_completion"]["delta_days"] == 0
        assert result.comparison["slack_consumed"]["T12"] == 3.0

    def test_critical_path_before_and_after(self, result):
        cp = result.comparison["critical_path"]
        assert cp["before"] == ["T01", "T02", "T03", "T13", "T14", "T15", "T17"]
        assert cp["after"] == cp["before"]
        assert cp["changed"] is False

    def test_findings_created_and_removed(self, result):
        findings = result.comparison["findings"]
        assert "created" in findings and "removed" in findings
        assert findings["before_count"] == 11
        assert isinstance(findings["unchanged"], list)

    def test_resource_overload_before_and_after(self, result):
        overload = result.comparison["resource_overload"]
        assert "before" in overload and "after" in overload
        assert "resolved" in overload and "introduced" in overload

    def test_feasibility_before_and_after(self, result):
        feas = result.comparison["feasibility"]
        assert feas["before"]["verdict"] == "infeasible"
        assert feas["after"]["verdict"] == "infeasible"
        assert feas["margin_delta_days"] == -5.0
        assert feas["before"]["is_probability"] is False

    def test_structure_reports_no_change_to_the_work_itself(self, result):
        """A delay is not effort. Folding it into effort would let an
        already-overrunning task swallow it silently - T03 is nine elapsed
        days against a two-day estimate - and would also make a slip look
        like a re-baselined plan."""
        structure = result.comparison["structure"]
        assert structure["tasks_added"] == []
        assert structure["tasks_removed"] == []
        assert structure["total_effort_delta"] == 0.0

    def test_an_effort_change_does_show_in_total_effort(self, event_fixture):
        result = simulate(
            scenario(event_fixture, Mutation(K.TASK_EFFORT_SET, {
                "key": "T05", "effort": 8,
            })),
            Clock(14.0),
        )
        assert result.comparison["structure"]["total_effort_delta"] == 5.0

    def test_the_effort_model_travels_with_the_result(self, result):
        model = result.comparison["effort_model"]
        assert "effort / (1 + efficiency" in model["formula"]
        assert model["efficiency"] == 0.6

    def test_the_inverse_list_is_returned_so_the_change_is_undoable(self, result):
        assert result.inverse_mutations
        assert result.inverse_mutations[0]["kind"] == "TASK_DELAY_ADD"
        assert result.inverse_mutations[0]["payload"]["total_delay_days"] == 0.0

    def test_it_summarises_itself_without_an_llm(self, result):
        """The Narrator's fallback: the engine can always describe its own
        result, so language is never a capability the model adds."""
        text = summarise(result)
        assert "day 26" in text and "day 31" in text
        assert "+5 days" in text
        assert "base workflow is unchanged" in text


class TestSimulationsThatImprove:
    def test_removing_a_redundant_dependency_does_not_move_the_finish(
        self, event_fixture
    ):
        """T01 -> T04 is implied by T01 -> T02 -> T03 -> T04, so dropping it is
        provably safe. This is the optimizer's first candidate, verified."""
        result = simulate(
            scenario(event_fixture, Mutation(K.DEPENDENCY_REMOVE, {
                "from_task": "T01", "to_task": "T04",
            })),
            Clock(14.0),
        )
        assert result.comparison["projected_completion"]["delta_days"] == 0
        removed = result.comparison["findings"]["removed"]
        assert any(f["kind"] == "redundant_dependency" for f in removed)

    def test_splitting_a_critical_task_pulls_the_finish_in(self, event_fixture):
        result = simulate(
            scenario(event_fixture, Mutation(K.TASK_SPLIT, {
                "key": "T14", "parts": 2,
            })),
            Clock(14.0),
        )
        c = result.comparison["projected_completion"]
        assert c["delta_days"] < 0
        assert c["direction"] == "earlier"
        # And it did not cheat: the work is still there.
        assert result.comparison["structure"]["total_effort_delta"] == pytest.approx(0)

    def test_raising_capacity_resolves_the_contention_finding(self, event_fixture):
        result = simulate(
            scenario(event_fixture, Mutation(K.RESOURCE_CAPACITY_SET, {
                "resource_key": "mkt", "capacity": 3,
            })),
            Clock(14.0),
        )
        removed = {f["kind"] for f in result.comparison["findings"]["removed"]}
        assert "resource_contention" in removed


class TestResourceUnavailability:
    """The demo's "what if Deepa is unavailable next week" beat."""

    def test_a_window_over_critical_work_pushes_the_finish(self, event_fixture):
        result = simulate(
            scenario(event_fixture, Mutation(K.RESOURCE_UNAVAILABLE_WINDOW, {
                "resource_key": "anitha", "from_day": 14, "to_day": 21,
            })),
            Clock(14.0),
        )
        assert result.comparison["projected_completion"]["delta_days"] == 7.0
        block = result.after.resource_unavailability
        assert block["total_days_added"] == 7.0
        assert len(block["adjustments"]) == 2

    def test_a_window_over_slack_work_does_not(self, event_fixture):
        """Suresh has slack, so his absence costs days of work but not days of
        project. Reporting both facts separately is the point."""
        result = simulate(
            scenario(event_fixture, Mutation(K.RESOURCE_UNAVAILABLE_WINDOW, {
                "resource_key": "suresh", "from_day": 14, "to_day": 20,
            })),
            Clock(14.0),
        )
        assert result.comparison["projected_completion"]["delta_days"] == 0.0
        assert result.after.resource_unavailability["total_days_added"] > 0

    def test_a_window_after_the_work_finishes_costs_nothing(self, event_fixture):
        result = simulate(
            scenario(event_fixture, Mutation(K.RESOURCE_UNAVAILABLE_WINDOW, {
                "resource_key": "deepa", "from_day": 14, "to_day": 21,
            })),
            Clock(14.0),
        )
        assert result.after.resource_unavailability == {}

    def test_the_approximation_is_labelled_as_one(self, event_fixture):
        """We do not solve RCPSP and we do not claim to (ARCHITECTURE H #2)."""
        result = simulate(
            scenario(event_fixture, Mutation(K.RESOURCE_UNAVAILABLE_WINDOW, {
                "resource_key": "anitha", "from_day": 14, "to_day": 21,
            })),
            Clock(14.0),
        )
        block = result.after.resource_unavailability
        assert block["is_approximation"] is True
        assert "do not solve RCPSP" in block["method"]
        assert "single-pass" in block["method"].lower()


class TestRejectedScenarios:
    def test_an_invalid_scenario_returns_the_reason_not_a_crash(
        self, mfg_fixture
    ):
        result = simulate(
            scenario(mfg_fixture, Mutation(K.TASK_REMOVE, {"key": "M09"})),
            Clock(0.0),
        )
        assert result.validation.valid is False
        reason = result.validation.rejections[0]
        assert reason.constraint == "MANDATORY_TASK"
        assert "UN38.3" in reason.constraint_reason
        assert result.comparison == {}

    def test_a_rejected_scenario_still_reports_where_you_are(self, mfg_fixture):
        result = simulate(
            scenario(mfg_fixture, Mutation(K.TASK_REMOVE, {"key": "M09"})),
            Clock(0.0),
        )
        assert result.base.projected_end == 31.0
        assert "Not simulated" in summarise(result)

    def test_a_rejected_scenario_does_not_touch_the_base(self, mfg_fixture):
        before = mfg_fixture.snapshot.content_hash()
        result = simulate(
            scenario(mfg_fixture, Mutation(K.TASK_REMOVE, {"key": "M09"})),
            Clock(0.0),
        )
        assert result.base_unchanged
        assert mfg_fixture.snapshot.content_hash() == before


# ---------------------------------------------------------------------------
# Through the API
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture(scope="module")
async def client():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c


class TestMutationKindsAreDiscoverable:
    async def test_the_algebra_is_published_with_its_payload_contracts(
        self, client
    ):
        r = await client.get("/api/scenarios/mutation-kinds")
        assert r.status_code == 200
        body = r.json()
        assert body["closed"] is True
        assert len(body["kinds"]) == 17
        for kind in body["kinds"]:
            assert kind["required"]

    async def test_restructure_the_project_is_not_in_the_algebra(self, client):
        r = await client.get("/api/scenarios/mutation-kinds")
        names = {k["kind"] for k in r.json()["kinds"]}
        assert "RESTRUCTURE" not in " ".join(names)


class TestScenarioApi:
    @pytest_asyncio.fixture
    async def scenario_id(self, client):
        r = await client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/scenarios",
            json={
                "name": "Split the speaker confirmations",
                "mutations": [
                    {"kind": "TASK_SPLIT", "payload": {"key": "T14", "parts": 2}}
                ],
            },
        )
        assert r.status_code == 201, r.text
        return r.json()["id"]

    async def test_a_scenario_records_its_mutations_in_order(
        self, client, scenario_id
    ):
        r = await client.get(f"/api/scenarios/{scenario_id}")
        body = r.json()
        assert body["status"] == "validated"
        assert [m["seq"] for m in body["mutations"]] == [1]
        assert body["mutations"][0]["describes"]

    async def test_appending_a_mutation_validates_it(self, client, scenario_id):
        r = await client.post(
            f"/api/scenarios/{scenario_id}/mutations",
            json={
                "kind": "ASSIGNMENT_ADD",
                "payload": {"task_key": "T15", "resource_key": "ravi"},
            },
        )
        assert r.status_code == 201
        assert len(r.json()["mutations"]) == 2

    async def test_an_invalid_mutation_is_422_with_the_reason(
        self, client, scenario_id
    ):
        r = await client.post(
            f"/api/scenarios/{scenario_id}/mutations",
            json={
                "kind": "DEPENDENCY_ADD",
                "payload": {"from_task": "T17", "to_task": "T01"},
            },
        )
        assert r.status_code == 422
        detail = r.json()["detail"]
        assert detail["error"] == "mutation_rejected"
        assert "circular dependency" in detail["rejections"][0]["reason"]

    async def test_evaluating_returns_the_diff_and_proves_the_base_is_intact(
        self, client, scenario_id
    ):
        r = await client.post(f"/api/scenarios/{scenario_id}/evaluate")
        assert r.status_code == 200
        body = r.json()
        assert body["base_unchanged"] is True
        assert body["base_version_hash"] == body["base_version_hash_after_evaluation"]
        assert body["scenario_hash"] != body["base_version_hash"]
        assert body["comparison"]["projected_completion"]["delta_days"] < 0
        assert body["analysis_run_id"]
        assert body["summary"]

    async def test_a_mutation_can_be_removed_and_the_sequence_stays_dense(
        self, client, scenario_id
    ):
        await client.post(
            f"/api/scenarios/{scenario_id}/mutations",
            json={"kind": "DEADLINE_SET", "payload": {"deadline_day": 30}},
        )
        r = await client.delete(f"/api/scenarios/{scenario_id}/mutations/1")
        assert r.status_code == 200
        assert [m["seq"] for m in r.json()["mutations"]] == [1]

    async def test_diff_against_another_version_is_possible(
        self, client, scenario_id
    ):
        r = await client.get(f"/api/scenarios/{scenario_id}/diff")
        assert r.status_code == 200
        assert r.json()["base_unchanged"] is True

    async def test_scenarios_are_listed_for_the_project(self, client, scenario_id):
        r = await client.get(f"/api/projects/{EVENT_PROJECT_ID}/scenarios")
        assert r.status_code == 200
        assert any(s["id"] == scenario_id for s in r.json())

    async def test_a_scenario_can_be_discarded(self, client, scenario_id):
        r = await client.delete(f"/api/scenarios/{scenario_id}")
        assert r.status_code == 204
        assert (await client.get(f"/api/scenarios/{scenario_id}")).status_code == 404


class TestWhatIfShortcut:
    async def test_a_delay_question_returns_the_full_diff(self, client):
        """This is how the prototype's POST /simulate/delay comes back - as a
        TASK_DELAY_ADD against a real scenario, not a second code path."""
        r = await client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/what-if",
            json={
                "name": "T03 slips 5 more days",
                "keep": False,
                "mutations": [
                    {"kind": "TASK_DELAY_ADD",
                     "payload": {"key": "T03", "extra_days": 5}}
                ],
            },
        )
        assert r.status_code == 200
        body = r.json()
        c = body["comparison"]["projected_completion"]
        assert c["before_day"] == 26.0
        assert c["after_day"] == 31.0
        assert c["delta_days"] == 5.0
        assert len(body["comparison"]["tasks_moved"]) == 7
        assert body["comparison"]["critical_path"]["changed"] is False
        assert body["base_unchanged"] is True

    async def test_a_delay_absorbed_by_slack_moves_nothing(self, client):
        r = await client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/what-if",
            json={
                "keep": False,
                "mutations": [
                    {"kind": "TASK_DELAY_ADD",
                     "payload": {"key": "T12", "extra_days": 1}}
                ],
            },
        )
        assert r.json()["comparison"]["projected_completion"]["delta_days"] == 0

    async def test_calendar_dates_are_returned_at_the_boundary(self, client):
        r = await client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/what-if",
            json={
                "keep": False,
                "mutations": [
                    {"kind": "TASK_DELAY_ADD",
                     "payload": {"key": "T03", "extra_days": 5}}
                ],
            },
        )
        body = r.json()
        assert body["projected_end_date_before"] == "2026-09-27"
        assert body["projected_end_date_after"] == "2026-10-02"

    async def test_a_refused_what_if_is_422_citing_the_constraint(self, client):
        r = await client.post(
            f"/api/projects/{MFG_PROJECT_ID}/what-if",
            json={
                "keep": False,
                "mutations": [
                    {"kind": "TASK_REMOVE", "payload": {"key": "M09"}}
                ],
            },
        )
        assert r.status_code == 422
        assert "mandatory task" in r.text


class TestApplyIsTheOnlyWrite:
    """`apply` promotes a scenario to a new immutable version and moves the
    project pointer. The parent survives with its hash intact."""

    @pytest_asyncio.fixture(scope="class")
    @classmethod
    async def applied(cls, client):
        """Class-scoped: applying moves the project pointer, so a per-test
        fixture would try to apply the same change against a version that no
        longer has the edge it removes."""
        before = await client.get(f"/api/projects/{EVENT_PROJECT_ID}/workflow")
        base_version = before.json()["version"]

        created = await client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/scenarios",
            json={
                "name": "Drop the redundant edge",
                "mutations": [
                    {"kind": "DEPENDENCY_REMOVE",
                     "payload": {"from_task": "T01", "to_task": "T13"}}
                ],
            },
        )
        assert created.status_code == 201, created.text
        scenario_id = created.json()["id"]

        r = await client.post(
            f"/api/scenarios/{scenario_id}/apply",
            json={"note": "Removed an edge implied by a longer path"},
        )
        assert r.status_code == 200, r.text
        return base_version, scenario_id, r.json()


    async def test_apply_creates_a_new_version(self, applied):
        base_version, _, result = applied
        assert result["applied"] is True
        assert result["new_version"]["version_no"] == base_version["version_no"] + 1
        assert result["new_version"]["parent_version_id"] == base_version["id"]
        assert result["new_version"]["content_hash"] != base_version["content_hash"]

    async def test_the_parent_version_is_untouched(self, applied):
        base_version, _, result = applied
        assert result["parent_version"]["unchanged"] is True
        assert result["parent_version"]["content_hash"] == base_version["content_hash"]

    async def test_the_project_pointer_moved(self, applied):
        _, _, result = applied
        assert result["project_current_version_id"] == result["new_version"]["id"]

    async def test_the_old_version_is_still_readable_in_full(
        self, client, applied
    ):
        base_version, _, _ = applied
        r = await client.get(
            f"/api/projects/{EVENT_PROJECT_ID}/workflow",
            params={"version_id": base_version["id"]},
        )
        assert r.status_code == 200
        old = r.json()
        assert old["version"]["content_hash"] == base_version["content_hash"]
        edges = {(d["from_task"], d["to_task"]) for d in old["dependencies"]}
        assert ("T01", "T13") in edges, "history must not be rewritten"

    async def test_the_new_version_reflects_the_change(self, client, applied):
        r = await client.get(f"/api/projects/{EVENT_PROJECT_ID}/workflow")
        edges = {(d["from_task"], d["to_task"]) for d in r.json()["dependencies"]}
        assert ("T01", "T13") not in edges

    async def test_history_lists_both_versions_with_provenance(
        self, client, applied
    ):
        _, scenario_id, result = applied
        r = await client.get(f"/api/projects/{EVENT_PROJECT_ID}/versions")
        versions = {v["id"]: v for v in r.json()}
        new = versions[result["new_version"]["id"]]
        assert new["created_from_scenario_id"] == scenario_id
        assert new["is_draft"] is False

    async def test_applying_twice_is_refused(self, client, applied):
        _, scenario_id, _ = applied
        r = await client.post(f"/api/scenarios/{scenario_id}/apply")
        assert r.status_code == 422
        assert "already been applied" in r.text

    async def test_an_applied_scenario_cannot_be_deleted(self, client, applied):
        _, scenario_id, _ = applied
        r = await client.delete(f"/api/scenarios/{scenario_id}")
        assert r.status_code == 422
        assert "provenance" in r.text

    async def test_an_empty_scenario_cannot_be_applied(self, client):
        created = await client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/scenarios",
            json={"name": "Nothing at all"},
        )
        r = await client.post(f"/api/scenarios/{created.json()['id']}/apply")
        assert r.status_code == 422
        assert "nothing to apply" in r.text

    async def test_an_invalid_scenario_cannot_be_applied(self, client):
        """A scenario stored as rejected must not become a version."""
        created = await client.post(
            f"/api/projects/{MFG_PROJECT_ID}/scenarios",
            json={
                "name": "Delete the certification",
                "mutations": [
                    {"kind": "TASK_REMOVE", "payload": {"key": "M09"}}
                ],
            },
        )
        assert created.json()["status"] == "rejected"
        r = await client.post(f"/api/scenarios/{created.json()['id']}/apply")
        assert r.status_code == 422
        assert "mandatory task" in r.text
