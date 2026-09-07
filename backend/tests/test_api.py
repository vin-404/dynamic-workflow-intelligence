"""
API integration tests — verify the full endpoint contract.

Runs against the real FastAPI app over ASGITransport, on the throwaway
database `conftest.py` configured. The app lifespan is entered once per
session by the `api_client` fixture, so table creation and seeding happen
exactly once and nothing leaks between runs.
"""
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from backend.app.main import app

DEMO_PROJECT_ID = "00000000-0000-0000-0000-000000000001"


@pytest_asyncio.fixture(scope="session")
async def api_client():
    """App with its lifespan actually running (create_all + seed), plus a client."""
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client


class TestAPI:
    """API integration tests."""

    async def test_root(self, api_client):
        r = await api_client.get("/")
        assert r.status_code == 200
        assert r.json()["status"] == "running"

    async def test_health(self, api_client):
        r = await api_client.get("/health")
        assert r.status_code == 200
        assert r.json()["status"] == "healthy"

    async def test_list_projects(self, api_client):
        r = await api_client.get("/api/projects")
        assert r.status_code == 200
        projects = r.json()
        assert len(projects) >= 1
        assert projects[0]["name"] == "Campus Tech Symposium"

    async def test_project_state_regression(self, api_client):
        """Core regression test — the state endpoint must match engine demo output."""
        r = await api_client.get(f"/api/projects/{DEMO_PROJECT_ID}/state")
        assert r.status_code == 200
        state = r.json()

        assert state["planned_end"] == 22.0
        assert state["projected_end"] == 26.0
        assert state["slip_days"] == 4.0
        assert len(state["tasks"]) == 17
        assert len(state["bottlenecks"]) == 4
        assert state["critical_path"] == [
            "T01", "T02", "T03", "T13", "T14", "T15", "T17"
        ]
        assert state["departments"] == {
            "ORG": 2, "FIN": 1, "FAC": 1, "MKT": 1, "SPON": 1
        }

    async def test_simulate_delay(self, api_client):
        r = await api_client.post(
            f"/api/projects/{DEMO_PROJECT_ID}/simulate/delay",
            json={"task_code": "T03", "extra_days": 5},
        )
        assert r.status_code == 200
        d = r.json()
        assert d["project_end_before"] == 26.0
        assert d["project_end_after"] == 31.0
        assert d["project_end_delta"] == 5.0
        assert len(d["moved_detail"]) == 7
        assert d["critical_path_changed"] is False

    async def test_simulate_delay_absorbed_by_slack(self, api_client):
        r = await api_client.post(
            f"/api/projects/{DEMO_PROJECT_ID}/simulate/delay",
            json={"task_code": "T12", "extra_days": 1},
        )
        assert r.status_code == 200
        assert r.json()["project_end_delta"] == 0

    async def test_simulate_requirement(self, api_client):
        r = await api_client.post(
            f"/api/projects/{DEMO_PROJECT_ID}/simulate/requirement",
            json={"req_code": "R2"},
        )
        assert r.status_code == 200
        d = r.json()
        assert len(d["must_redo"]) == 4
        assert len(d["must_recheck"]) == 1
        assert sorted(t["task_code"] for t in d["must_redo"]) == [
            "T10", "T11", "T12", "T16"
        ]
        assert d["departments_hit"] == ["FAC", "MKT"]
        assert d["wasted_days"] == 2.0

    async def test_accuracy(self, api_client):
        r = await api_client.get(f"/api/projects/{DEMO_PROJECT_ID}/accuracy")
        assert r.status_code == 200
        d = r.json()
        assert d["recall"] == 1.0
        assert d["precision_vs_planted"] == 1.0
        assert sorted(d["true_positives"]) == ["MKT", "T03", "T12"]

    async def test_list_tasks(self, api_client):
        r = await api_client.get(f"/api/projects/{DEMO_PROJECT_ID}/tasks")
        assert r.status_code == 200
        assert len(r.json()) == 17

    async def test_get_single_task(self, api_client):
        r = await api_client.get(f"/api/projects/{DEMO_PROJECT_ID}/tasks/T03")
        assert r.status_code == 200
        task = r.json()
        assert task["task_code"] == "T03"
        assert task["name"] == "Budget approval"
        assert task["status"] == "in_review"

    async def test_project_not_found(self, api_client):
        r = await api_client.get(
            "/api/projects/00000000-0000-0000-0000-000000000099/state"
        )
        assert r.status_code == 404

    async def test_seed_idempotent(self, api_client):
        r = await api_client.post("/api/seed")
        assert r.status_code == 200
        assert r.json()["project_id"] == DEMO_PROJECT_ID


class TestHermeticity:
    """The suite must not touch the developer's database (decision D-06)."""

    async def test_database_url_is_temporary(self):
        from backend.app.core.config import settings

        assert "dwi-tests-" in settings.DATABASE_URL, (
            "tests must run against a throwaway database, got "
            f"{settings.DATABASE_URL!r}"
        )
        assert not settings.DATABASE_URL.endswith("dwi.db")
