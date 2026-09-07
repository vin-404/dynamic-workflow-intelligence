"""
API integration tests — verify the full endpoint contract.

Uses httpx TestClient against the actual FastAPI app.
"""
import pytest
from httpx import AsyncClient, ASGITransport
import asyncio

from backend.app.main import app

DEMO_PROJECT_ID = "00000000-0000-0000-0000-000000000001"

# We need to trigger the lifespan manually since ASGITransport doesn't do it.
# Instead, run the full app lifecycle once for all tests.
_initialized = False


async def _ensure_init():
    global _initialized
    if not _initialized:
        # Manually run lifespan startup
        async with app.router.lifespan_context(app):
            _initialized = True
            # lifespan will create tables and seed data
            # We keep the context open by yielding... but we can't.
            # Instead, the create_all already ran by now.
        # After lifespan exits, tables are created and data is seeded.
        # The DB file persists since we're using SQLite.


def _run(coro):
    """Helper to run async code in sync tests."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# Initialize once for all tests
_run(_ensure_init())


class TestAPI:
    """API integration tests."""

    def _call(self, method, path, **kwargs):
        async def _do():
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as c:
                return await getattr(c, method)(path, **kwargs)
        return _run(_do())

    def test_root(self):
        r = self._call("get", "/")
        assert r.status_code == 200
        assert r.json()["status"] == "running"

    def test_health(self):
        r = self._call("get", "/health")
        assert r.status_code == 200
        assert r.json()["status"] == "healthy"

    def test_list_projects(self):
        r = self._call("get", "/api/projects")
        assert r.status_code == 200
        projects = r.json()
        assert len(projects) >= 1
        assert projects[0]["name"] == "Campus Tech Symposium"

    def test_project_state_regression(self):
        """Core regression test — the state endpoint must match engine demo output."""
        r = self._call("get", f"/api/projects/{DEMO_PROJECT_ID}/state")
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

    def test_simulate_delay(self):
        r = self._call(
            "post",
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

    def test_simulate_delay_absorbed_by_slack(self):
        r = self._call(
            "post",
            f"/api/projects/{DEMO_PROJECT_ID}/simulate/delay",
            json={"task_code": "T12", "extra_days": 1},
        )
        assert r.status_code == 200
        assert r.json()["project_end_delta"] == 0

    def test_simulate_requirement(self):
        r = self._call(
            "post",
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

    def test_accuracy(self):
        r = self._call("get", f"/api/projects/{DEMO_PROJECT_ID}/accuracy")
        assert r.status_code == 200
        d = r.json()
        assert d["recall"] == 1.0
        assert d["precision_vs_planted"] == 1.0
        assert sorted(d["true_positives"]) == ["MKT", "T03", "T12"]

    def test_list_tasks(self):
        r = self._call("get", f"/api/projects/{DEMO_PROJECT_ID}/tasks")
        assert r.status_code == 200
        assert len(r.json()) == 17

    def test_get_single_task(self):
        r = self._call("get", f"/api/projects/{DEMO_PROJECT_ID}/tasks/T03")
        assert r.status_code == 200
        task = r.json()
        assert task["task_code"] == "T03"
        assert task["name"] == "Budget approval"
        assert task["status"] == "in_review"

    def test_project_not_found(self):
        r = self._call(
            "get",
            "/api/projects/00000000-0000-0000-0000-000000000099/state",
        )
        assert r.status_code == 404

    def test_seed_idempotent(self):
        r = self._call("post", "/api/seed")
        assert r.status_code == 200
        assert r.json()["project_id"] == DEMO_PROJECT_ID
