"""
API integration tests - the full endpoint contract.

Runs against the real FastAPI app over ASGITransport, on the throwaway
database `conftest.py` configured. The lifespan is entered once per session,
so table creation and seeding happen exactly once and nothing leaks between
runs.

Every numeric assertion carried over from the prototype's suite is preserved:
planned end 22, projected 26, slip 4, the seven-task critical path, four
findings. What changed is vocabulary, not arithmetic - `departments` became
`resources`, `task_code` became `key`, and `/state` split into `/workflow`
(what you authored) and `/analyze` (what the engine concluded).
"""
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from backend.app.main import app

EVENT_PROJECT_ID = "00000000-0000-0000-0000-000000000001"
MFG_PROJECT_ID = "00000000-0000-0000-0000-000000000002"


@pytest_asyncio.fixture(scope="session")
async def api_client():
    """App with its lifespan actually running (create_all + seed), plus a client."""
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client


class TestServiceBasics:
    async def test_root(self, api_client):
        r = await api_client.get("/")
        assert r.status_code == 200
        assert r.json()["status"] == "running"

    async def test_health(self, api_client):
        r = await api_client.get("/health")
        assert r.status_code == 200
        assert r.json()["status"] == "healthy"


class TestSeeding:
    async def test_both_domains_are_seeded(self, api_client):
        r = await api_client.get("/api/projects")
        assert r.status_code == 200
        names = {p["name"] for p in r.json()}
        assert "Campus Tech Symposium" in names
        assert "Battery Pack Pilot Line" in names

    async def test_domains_are_rows_not_an_enum(self, api_client):
        r = await api_client.get("/api/domains")
        assert r.status_code == 200
        keys = {d["key"] for d in r.json()}
        assert {"event_operations", "hardware_manufacturing"} <= keys

    async def test_seed_is_idempotent(self, api_client):
        r = await api_client.post("/api/seed")
        assert r.status_code == 200
        assert r.json()["projects"]["campus-symposium"] == EVENT_PROJECT_ID

    async def test_seeded_project_ids_are_deterministic(self, api_client):
        r = await api_client.get("/api/seed/projects")
        assert r.status_code == 200
        assert r.json()["demo_project_id"] == EVENT_PROJECT_ID


class TestAnalysisRegression:
    """The numbers that must not move."""

    @pytest_asyncio.fixture
    async def analysis(self, api_client):
        r = await api_client.post(f"/api/projects/{EVENT_PROJECT_ID}/analyze")
        assert r.status_code == 200
        return r.json()

    async def test_schedule_matches_the_prototype(self, analysis):
        assert analysis["planned_end"] == 22.0
        assert analysis["projected_end"] == 26.0
        assert analysis["slip_days"] == 4.0
        assert analysis["critical_path"] == [
            "T01", "T02", "T03", "T13", "T14", "T15", "T17"
        ]

    async def test_task_count(self, analysis):
        assert len(analysis["tasks"]) == 17

    async def test_finding_count_and_root_causes(self, analysis):
        assert len(analysis["findings"]) == 4
        assert {f["root_cause"] for f in analysis["findings"]} == {
            "T03", "mkt", "T12"
        }

    async def test_resources_replaced_departments(self, analysis):
        """The prototype returned `departments: {ORG: 2, FIN: 1, ...}`. It now
        returns resources, where `kind` is data - and the capacities are
        unchanged."""
        assert "departments" not in analysis
        teams = {
            r["key"]: r["capacity"]
            for r in analysis["resources"]
            if r["kind"] == "team"
        }
        assert teams == {"org": 2, "fin": 1, "fac": 1, "mkt": 1, "spon": 1}

    async def test_people_roll_up_to_teams(self, analysis):
        people = {r["key"]: r["parent_key"] for r in analysis["resources"]
                  if r["kind"] == "person"}
        assert people["priya"] == "mkt"
        assert people["arjun"] == "mkt"
        assert len(people) == 8

    async def test_analysis_reports_provenance(self, analysis):
        assert analysis["engine_version"]
        assert len(analysis["input_hash"]) == 64
        assert analysis["tier_reached"] == 2
        assert analysis["config"]["parallel_efficiency"] == 0.6

    async def test_analysis_reports_the_effort_model(self, analysis):
        model = analysis["effort_model"]
        assert "effort / (1 + efficiency" in model["formula"]
        assert model["efficiency"] == 0.6

    async def test_feasibility_is_a_verdict_not_a_probability(self, analysis):
        f = analysis["feasibility"]
        assert f["verdict"] == "infeasible"
        assert f["margin_days"] == -2.0
        assert f["is_probability"] is False

    async def test_no_probability_language_in_p0_output(self, analysis):
        """ARCHITECTURE D.6: an invented percentage is the fastest way to lose
        a technical judge, so P0 emits none.

        The `is_probability: false` flag is the one legitimate use of the word
        - it is the explicit denial - so it is asserted rather than banned.
        """
        import json

        assert analysis["feasibility"]["is_probability"] is False

        stripped = json.loads(json.dumps(analysis))
        stripped["feasibility"].pop("is_probability")
        blob = json.dumps(stripped).lower()
        for banned in ("probability", "p(deadline)", "confidence", "likelihood",
                       "chance of", "% likely", "success rate"):
            assert banned not in blob, f"found probability language: {banned!r}"

    async def test_every_finding_carries_evidence_and_an_action(self, analysis):
        for f in analysis["findings"]:
            assert f["evidence"], f"{f['kind']} emitted a bare score"
            assert f["suggested_action"]
            assert f["impact_score"] == pytest.approx(
                f["attributed_delay_days"] * (1 + len(f["downstream_affected"]))
            )

    async def test_analysis_is_available_as_a_get(self, api_client, analysis):
        r = await api_client.get(f"/api/projects/{EVENT_PROJECT_ID}/analyze")
        assert r.status_code == 200
        assert r.json()["projected_end"] == analysis["projected_end"]


class TestColdStartProject:
    """The second seed domain has no history at all."""

    @pytest_asyncio.fixture
    async def analysis(self, api_client):
        r = await api_client.post(f"/api/projects/{MFG_PROJECT_ID}/analyze")
        assert r.status_code == 200
        return r.json()

    async def test_it_still_schedules(self, analysis):
        assert analysis["projected_end"] == 31.0
        assert analysis["critical_path"]

    async def test_it_reaches_only_tier_zero(self, analysis):
        assert analysis["tier_reached"] == 0

    async def test_it_says_what_it_cannot_assess(self, analysis):
        tiers = {g["tier"] for g in analysis["unavailable_checks"]}
        assert tiers == {1, 2, 3}

    async def test_it_still_reports_infeasibility(self, analysis):
        assert analysis["feasibility"]["verdict"] == "infeasible"
        assert analysis["feasibility"]["margin_days"] == -5.0

    async def test_accuracy_refuses_to_score_without_labelled_faults(
        self, api_client
    ):
        r = await api_client.get(f"/api/projects/{MFG_PROJECT_ID}/accuracy")
        assert r.status_code == 200
        d = r.json()
        assert d["has_ground_truth"] is False
        assert d["recall"] is None
        assert d["precision_vs_planted"] is None


class TestWorkflowView:
    async def test_workflow_is_the_authored_graph(self, api_client):
        r = await api_client.get(f"/api/projects/{EVENT_PROJECT_ID}/workflow")
        assert r.status_code == 200
        wf = r.json()
        assert len(wf["tasks"]) == 17
        assert len(wf["dependencies"]) == 23
        assert wf["version"]["version_no"] == 1
        assert len(wf["version"]["content_hash"]) == 64

    async def test_workflow_carries_constraints(self, api_client):
        r = await api_client.get(f"/api/projects/{MFG_PROJECT_ID}/workflow")
        kinds = {c["kind"] for c in r.json()["constraints"]}
        assert "MANDATORY_TASK" in kinds
        assert "IMMUTABLE_DEPENDENCY" in kinds
        assert "NON_DIVISIBLE_TASK" in kinds

    async def test_every_constraint_states_a_reason(self, api_client):
        r = await api_client.get(f"/api/projects/{MFG_PROJECT_ID}/workflow")
        for c in r.json()["constraints"]:
            assert c["reason"], f"{c['kind']} on {c['target']} has no reason"

    async def test_dependency_consumes_flag_survives(self, api_client):
        r = await api_client.get(f"/api/projects/{EVENT_PROJECT_ID}/workflow")
        edges = {(d["from_task"], d["to_task"]): d["consumes"]
                 for d in r.json()["dependencies"]}
        assert edges[("T02", "T03")] is True     # artifact
        assert edges[("T03", "T04")] is False    # ordering only

    async def test_versions_are_listed(self, api_client):
        r = await api_client.get(f"/api/projects/{EVENT_PROJECT_ID}/versions")
        assert r.status_code == 200
        assert len(r.json()) >= 1

    async def test_members_are_listed(self, api_client):
        r = await api_client.get(f"/api/projects/{EVENT_PROJECT_ID}/members")
        assert r.status_code == 200
        roles = {m["role"] for m in r.json()}
        assert "owner" in roles


class TestRequirementImpact:
    async def test_r2_invalidates_four_tasks(self, api_client):
        r = await api_client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/requirement-impact",
            json={"requirement_key": "R2"},
        )
        assert r.status_code == 200
        d = r.json()
        assert sorted(t["key"] for t in d["must_redo"]) == [
            "T10", "T11", "T12", "T16"
        ]
        assert [t["key"] for t in d["must_recheck"]] == ["T17"]
        assert d["wasted_days"] == 2.0

    async def test_resources_hit_replaces_departments_hit(self, api_client):
        r = await api_client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/requirement-impact",
            json={"requirement_key": "R2"},
        )
        hit = r.json()["resources_hit"]
        assert "Priya (Marketing)" in hit
        assert "Suresh (Facilities)" in hit

    async def test_unknown_requirement_is_404(self, api_client):
        r = await api_client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/requirement-impact",
            json={"requirement_key": "NOPE"},
        )
        assert r.status_code == 404


class TestAccuracyHarness:
    async def test_recall_and_precision_still_100_percent(self, api_client):
        r = await api_client.get(f"/api/projects/{EVENT_PROJECT_ID}/accuracy")
        assert r.status_code == 200
        d = r.json()
        assert d["recall"] == 1.0
        assert d["precision_vs_planted"] == 1.0
        assert sorted(d["true_positives"]) == ["T03", "T12", "mkt"]

    async def test_ground_truth_comes_from_the_fixture(self, api_client):
        r = await api_client.get(f"/api/projects/{EVENT_PROJECT_ID}/accuracy")
        assert r.json()["has_ground_truth"] is True


class TestNotFound:
    async def test_unknown_project_analyze_is_404(self, api_client):
        r = await api_client.post(
            "/api/projects/00000000-0000-0000-0000-000000000099/analyze"
        )
        assert r.status_code == 404

    async def test_unknown_project_workflow_is_404(self, api_client):
        r = await api_client.get(
            "/api/projects/00000000-0000-0000-0000-000000000099/workflow"
        )
        assert r.status_code == 404


class TestHermeticity:
    """The suite must not touch the developer's database (decision D-06)."""

    async def test_database_url_is_temporary(self):
        from backend.app.settings import settings

        assert "dwi-tests-" in settings.DATABASE_URL, (
            "tests must run against a throwaway database, got "
            f"{settings.DATABASE_URL!r}"
        )
        assert not settings.DATABASE_URL.endswith("dwi.db")
