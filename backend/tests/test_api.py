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
        """The prototype reported four findings from four stateful detectors.
        Phase 2 adds the Tier-0 structural ones, so this fixture reports
        eleven - all eleven labelled on the fixture, so none is noise."""
        assert len(analysis["findings"]) == 11
        original = {
            "critical_path_blocker", "resource_contention",
            "stalled_in_review", "ready_but_idle",
        }
        prototype = [f for f in analysis["findings"] if f["kind"] in original]
        assert len(prototype) == 4
        assert {f["root_cause"] for f in prototype} == {"T03", "mkt", "T12"}

    async def test_findings_declare_their_tier(self, analysis):
        by_tier = analysis["finding_counts_by_tier"]
        assert by_tier == {"0": 6, "1": 3, "2": 2}
        for f in analysis["findings"]:
            assert f["tier"] in (0, 1, 2, 3)
            assert f["tier_name"] in (
                "structural", "stateful", "historical", "cross-project"
            )

    async def test_analysis_reports_which_checks_ran(self, analysis):
        """"Checked and clean" must be distinguishable from "never checked"."""
        assert len(analysis["checks_run"]) == 14
        assert "stalled_in_review" in analysis["checks_run"]

    async def test_suppressed_findings_are_returned_with_their_reason(
        self, analysis
    ):
        rolled_up = [
            f for f in analysis["suppressed_findings"]
            if f["root_cause"] == "fac"
        ]
        assert rolled_up, "the roll-up overload should be kept, not dropped"
        assert rolled_up[0]["suppressed"]["by"] == "resource_overallocated"
        assert "Suresh" in rolled_up[0]["suppressed"]["reason"]

    async def test_analysis_run_is_persisted_with_provenance(
        self, api_client, analysis
    ):
        assert analysis["analysis_run_id"]
        r = await api_client.get(
            f"/api/analysis/{analysis['analysis_run_id']}"
        )
        assert r.status_code == 200
        run = r.json()
        assert run["engine_version"] == analysis["engine_version"]
        assert run["input_hash"] == analysis["input_hash"]
        assert run["scores"]["projected_end"] == 26.0
        assert len(run["findings"]) == 12       # 11 active + 1 suppressed

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

    async def test_p0_never_emits_a_probability(self, analysis):
        """ARCHITECTURE D.6: an invented percentage is the fastest way to lose
        a technical judge, so P0 emits none.

        Banning the *word* would be the wrong test - the payload uses it
        repeatedly, always to deny one ("is_probability": false, "what would
        make this a probability"). Those denials are the honest part. What
        must not exist is a *number* presented as a likelihood, so that is
        what this asserts.
        """
        import json

        assert analysis["feasibility"]["is_probability"] is False
        assert analysis["feasibility"]["three_point"]["is_probability"] is False
        assert (
            analysis["feasibility"]["three_point"]["monte_carlo"]["available"]
            is False
        )
        assert analysis["risk"]["assumptions"]["score_kind"] == (
            "structural_estimate"
        )
        assert analysis["risk"]["assumptions"]["monte_carlo_run"] is False
        for task in analysis["risk"]["tasks"]:
            assert task["score_kind"] == "structural_estimate"

        # No numeric field anywhere may be *named* like a likelihood.
        suspicious = ("probability", "likelihood", "confidence", "percent_chance",
                      "p_deadline", "success_rate", "odds")

        def walk(node, path=""):
            if isinstance(node, dict):
                for key, value in node.items():
                    here = f"{path}.{key}"
                    if any(word in key.lower() for word in suspicious):
                        assert not isinstance(value, (int, float)) or isinstance(
                            value, bool
                        ), f"{here} presents a number as a likelihood: {value!r}"
                    walk(value, here)
            elif isinstance(node, list):
                for i, value in enumerate(node):
                    walk(value, f"{path}[{i}]")

        walk(analysis)

    async def test_no_probability_phrasing_in_user_facing_prose(self, analysis):
        """Separately: the sentences a user reads must not *claim* one."""
        prose: list[str] = [analysis["feasibility"]["statement"]]
        for finding in analysis["findings"]:
            prose += [finding["explanation"], finding["suggested_action"]]
        for task in analysis["risk"]["tasks"]:
            prose.append(task["explanation"])
            prose += [f["reason"] for f in task["factors"]]

        for text in prose:
            lowered = text.lower()
            for banned in ("% chance", "% likely", "chance of", "odds of",
                           "confidence level", "probability of",
                           "likelihood of", "success rate"):
                assert banned not in lowered, (
                    f"probability claim in user-facing prose: {text!r}"
                )

    async def test_every_finding_carries_evidence_and_an_action(self, analysis):
        for f in analysis["findings"]:
            assert f["evidence"], f"{f['kind']} emitted a bare score"
            assert f["suggested_action"]
            assert f["explanation"]

    async def test_impact_is_a_visible_formula(self, analysis):
        """Never a bare score: both operands and the worked arithmetic travel
        with every number, so a reader can recompute it by hand."""
        for f in analysis["findings"]:
            impact = f["impact"]
            assert f["impact_score"] == pytest.approx(
                impact["magnitude"] * (1 + impact["downstream_affected"])
            )
            assert impact["formula"]
            assert impact["worked"]
            assert impact["magnitude_kind"] in (
                "observed_delay_days", "exposed_days"
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

    async def test_it_finds_real_structural_problems_with_no_history(
        self, analysis
    ):
        """The cold-start payoff: seven findings on a workflow with no
        statuses, no events and no actuals at all."""
        assert len(analysis["findings"]) == 7
        assert all(f["tier"] == 0 for f in analysis["findings"])
        kinds = {f["kind"] for f in analysis["findings"]}
        assert {
            "deadline_infeasible", "single_point_of_failure",
            "zero_slack_chain", "resource_overallocated",
            "redundant_dependency",
        } <= kinds

    async def test_it_ran_only_the_structural_checks(self, analysis):
        assert len(analysis["checks_run"]) == 9
        for name in ("critical_path_blocker", "resource_contention",
                     "stalled_in_review", "ready_but_idle"):
            assert name not in analysis["checks_run"]

    async def test_unavailable_checks_name_the_detectors_that_did_not_run(
        self, analysis
    ):
        listed = " ".join(
            check
            for gap in analysis["unavailable_checks"]
            for check in gap["checks"]
        )
        assert "critical_path_blocker" in listed
        assert "stalled_in_review" in listed
        assert "calibrated_duration_variance" in listed

    async def test_accuracy_reports_no_planted_faults_but_does_score_labels(
        self, api_client
    ):
        """This fixture plants nothing in the "stalled task" sense, so the
        planted-recall headline is undefined - but every structural problem it
        contains is labelled, so recall and precision are real."""
        r = await api_client.get(f"/api/projects/{MFG_PROJECT_ID}/accuracy")
        assert r.status_code == 200
        d = r.json()
        assert d["has_labels"] is True
        assert d["planted"] == 0
        assert d["planted_recall"] is None
        assert d["recall"] == 1.0
        assert d["precision"] == 1.0
        assert d["missed"] == []
        assert d["unexpected"] == []


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
    """Precision and recall against a *fully* labelled fixture.

    The prototype labelled three planted faults and reported
    `precision_vs_planted`. Once the Tier-0 detectors landed, being right
    about eight more real problems would have "dropped precision" to 33%, so
    the fixtures now label everything they are known to contain and these
    numbers mean what they say.
    """

    @pytest_asyncio.fixture
    async def accuracy(self, api_client):
        r = await api_client.get(f"/api/projects/{EVENT_PROJECT_ID}/accuracy")
        assert r.status_code == 200
        return r.json()

    async def test_all_three_planted_faults_are_still_found(self, accuracy):
        assert accuracy["planted"] == 3
        assert accuracy["planted_recall"] == 1.0
        assert accuracy["planted_found"] == [
            "ready_but_idle@T12",
            "resource_contention@mkt",
            "stalled_in_review@T03",
        ]

    async def test_recall_and_precision_are_both_100_percent(self, accuracy):
        assert accuracy["recall"] == 1.0
        assert accuracy["precision"] == 1.0
        assert accuracy["missed"] == []
        assert accuracy["unexpected"] == []

    async def test_labels_come_from_the_fixture_with_descriptions(self, accuracy):
        assert accuracy["has_labels"] is True
        assert len(accuracy["labels"]) == 11
        for label in accuracy["labels"]:
            assert label["description"]
            assert label["detected"] is True

    async def test_accuracy_reports_the_engine_it_measured(self, accuracy):
        assert accuracy["engine_version"]
        assert accuracy["tier_reached"] == 2
        assert len(accuracy["checks_run"]) == 14


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
