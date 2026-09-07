"""
Authoring tests - can a user actually build a workflow from nothing?

The prototype could not: every component was a read-only view and there was no
write endpoint for a task or a dependency. This file walks the whole journey
the Phase 6 UI will drive - define a domain, create a project, add resources,
add tasks, draw dependencies, analyze - against an empty database, and checks
that the failure modes report a reason a human can act on.
"""
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from backend.app.main import app


@pytest_asyncio.fixture(scope="module")
async def client():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c


@pytest_asyncio.fixture
async def project(client):
    """A project in a freshly defined custom domain, with an empty version 1."""
    r = await client.post(
        "/api/projects",
        json={
            "name": "Podcast season launch",
            "goal": "Ship eight episodes before the sponsor window closes.",
            "start_date": "2026-11-02",
            "deadline": "2026-11-20",
            "owner_email": "producer@example.com",
            "new_domain": {
                "key": f"custom_media_{id(client) % 100000}",
                "name": "Media Production",
                "description": "Episodic content with a fixed publication date.",
                "vocabulary_hints": ["episode", "edit", "master"],
            },
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


class TestProjectCreation:
    async def test_a_project_starts_with_an_empty_version(self, client, project):
        r = await client.get(f"/api/projects/{project['id']}/workflow")
        assert r.status_code == 200
        wf = r.json()
        assert wf["tasks"] == []
        assert wf["dependencies"] == []
        assert wf["version"]["version_no"] == 1
        assert wf["version"]["is_draft"] is True

    async def test_a_custom_domain_is_just_a_row(self, client, project):
        r = await client.get("/api/domains")
        custom = [d for d in r.json() if d["is_custom"]]
        assert any(d["name"] == "Media Production" for d in custom)

    async def test_the_deadline_becomes_an_integer_day_offset(self, client, project):
        r = await client.get(f"/api/projects/{project['id']}/workflow")
        wf = r.json()
        # 2026-11-02 -> 2026-11-20 is 18 days.
        assert wf["deadline_day"] == 18.0
        assert wf["deadline"] == "2026-11-20"

    async def test_a_deadline_before_the_start_is_rejected(self, client):
        r = await client.post(
            "/api/projects",
            json={
                "name": "Impossible",
                "start_date": "2026-11-02",
                "deadline": "2026-10-02",
            },
        )
        assert r.status_code == 422
        assert "before the start date" in r.text

    async def test_an_empty_workflow_analyzes_without_crashing(self, client, project):
        """A judge who creates a project and clicks Analyze before typing
        anything must not see a stack trace."""
        r = await client.post(f"/api/projects/{project['id']}/analyze")
        assert r.status_code == 200
        d = r.json()
        assert d["tasks"] == []
        assert d["projected_end"] == 0
        assert d["tier_reached"] == 0
        assert d["unavailable_checks"]


class TestBuildingAWorkflow:
    @pytest_asyncio.fixture
    async def built(self, client, project):
        pid = project["id"]
        await client.post(
            f"/api/projects/{pid}/resources",
            json={"key": "studio", "name": "Studio", "kind": "team", "capacity": 1},
        )
        await client.post(
            f"/api/projects/{pid}/resources",
            json={"key": "sam", "name": "Sam", "kind": "person",
                  "parent_key": "studio"},
        )
        for key, name, effort, divisible in [
            ("E1", "Book guests", 3, True),
            ("E2", "Record episodes", 6, True),
            ("E3", "Edit and master", 5, True),
            ("E4", "Sponsor sign-off", 2, False),
            ("E5", "Publish", 1, True),
        ]:
            r = await client.post(
                f"/api/projects/{pid}/tasks",
                json={
                    "key": key, "name": name, "effort": effort,
                    "divisible": divisible, "assignees": ["sam"],
                },
            )
            assert r.status_code == 201, r.text
        for u, v, consumes in [
            ("E1", "E2", True), ("E2", "E3", True),
            ("E3", "E4", True), ("E4", "E5", True),
        ]:
            r = await client.post(
                f"/api/projects/{pid}/dependencies",
                json={"from_task": u, "to_task": v, "consumes": consumes},
            )
            assert r.status_code == 201, r.text
        return pid

    async def test_the_workflow_was_actually_built(self, client, built):
        r = await client.get(f"/api/projects/{built}/workflow")
        wf = r.json()
        assert len(wf["tasks"]) == 5
        assert len(wf["dependencies"]) == 4
        assert len(wf["resources"]) == 2

    async def test_it_analyzes_end_to_end(self, client, built):
        r = await client.post(f"/api/projects/{built}/analyze")
        assert r.status_code == 200
        d = r.json()
        # A pure serial chain: 3 + 6 + 5 + 2 + 1 = 17 days.
        assert d["projected_end"] == 17.0
        assert d["critical_path"] == ["E1", "E2", "E3", "E4", "E5"]
        assert d["feasibility"]["verdict"] == "feasible"
        assert d["feasibility"]["margin_days"] == 1.0

    async def test_editing_a_task_moves_the_schedule(self, client, built):
        r = await client.patch(
            f"/api/projects/{built}/tasks/E2", json={"effort": 9}
        )
        assert r.status_code == 200
        d = (await client.post(f"/api/projects/{built}/analyze")).json()
        assert d["projected_end"] == 20.0
        assert d["feasibility"]["verdict"] == "infeasible"
        assert d["feasibility"]["margin_days"] == -2.0
        # put it back
        await client.patch(f"/api/projects/{built}/tasks/E2", json={"effort": 6})

    async def test_a_status_change_appends_history_and_raises_the_tier(
        self, client, built
    ):
        before = (await client.post(f"/api/projects/{built}/analyze")).json()
        assert before["tier_reached"] == 0

        r = await client.patch(
            f"/api/projects/{built}/tasks/E1", json={"status": "done"}
        )
        assert r.status_code == 200

        after = (await client.post(f"/api/projects/{built}/analyze")).json()
        assert after["tier_reached"] == 2, (
            "recording a status change should unlock the stateful and "
            "historical tiers"
        )

    async def test_assigning_a_second_person_does_not_halve_the_task(
        self, client, built
    ):
        r = await client.post(
            f"/api/projects/{built}/resources",
            json={"key": "rae", "name": "Rae", "kind": "person",
                  "parent_key": "studio"},
        )
        assert r.status_code == 201
        r = await client.post(
            f"/api/projects/{built}/tasks/E3/assignments",
            json={"resource_key": "rae"},
        )
        assert r.status_code == 201
        d = (await client.post(f"/api/projects/{built}/analyze")).json()
        e3 = next(t for t in d["tasks"] if t["key"] == "E3")
        assert e3["effort"] == 5.0
        # 5 / (1 + 0.6) = 3.125, not 2.5.
        assert e3["duration"] == pytest.approx(3.125)
        assert e3["duration"] > 2.5

    async def test_a_non_divisible_task_gains_nothing_from_a_second_person(
        self, client, built
    ):
        r = await client.post(
            f"/api/projects/{built}/resources",
            json={"key": "rae", "name": "Rae", "kind": "person",
                  "parent_key": "studio"},
        )
        assert r.status_code == 201
        r = await client.post(
            f"/api/projects/{built}/tasks/E4/assignments",
            json={"resource_key": "rae"},
        )
        assert r.status_code == 201
        d = (await client.post(f"/api/projects/{built}/analyze")).json()
        e4 = next(t for t in d["tasks"] if t["key"] == "E4")
        assert e4["duration"] == 2.0
        assert "E4" in d["effort_model"]["non_divisible_tasks"]


class TestAuthoringRejectionsExplainThemselves:
    """Validation failures return 422 with a reason. Those reasons are a
    feature (ARCHITECTURE E)."""

    @pytest_asyncio.fixture
    async def pid(self, client, project):
        p = project["id"]
        for key in ("A", "B", "C"):
            await client.post(
                f"/api/projects/{p}/tasks",
                json={"key": key, "name": f"Task {key}", "effort": 2},
            )
        await client.post(
            f"/api/projects/{p}/dependencies",
            json={"from_task": "A", "to_task": "B"},
        )
        await client.post(
            f"/api/projects/{p}/dependencies",
            json={"from_task": "B", "to_task": "C"},
        )
        return p

    async def test_a_cycle_is_rejected_with_the_cycle(self, client, pid):
        r = await client.post(
            f"/api/projects/{pid}/dependencies",
            json={"from_task": "C", "to_task": "A"},
        )
        assert r.status_code == 422
        detail = r.json()["detail"]
        assert "circular dependency" in detail["message"]
        assert detail["cycles"], "the cycle itself must be reported"
        assert set(detail["cycles"][0]) == {"A", "B", "C"}

    async def test_a_self_dependency_is_rejected(self, client, pid):
        r = await client.post(
            f"/api/projects/{pid}/dependencies",
            json={"from_task": "A", "to_task": "A"},
        )
        assert r.status_code == 422
        assert "cannot depend on itself" in r.text

    async def test_an_unknown_task_is_rejected_by_name(self, client, pid):
        r = await client.post(
            f"/api/projects/{pid}/dependencies",
            json={"from_task": "A", "to_task": "ZZ"},
        )
        assert r.status_code == 422
        assert "ZZ" in r.text

    async def test_a_duplicate_task_key_is_rejected(self, client, pid):
        r = await client.post(
            f"/api/projects/{pid}/tasks",
            json={"key": "A", "name": "Clash", "effort": 1},
        )
        assert r.status_code == 422
        assert "already exists" in r.text

    async def test_a_duplicate_dependency_is_rejected(self, client, pid):
        r = await client.post(
            f"/api/projects/{pid}/dependencies",
            json={"from_task": "A", "to_task": "B"},
        )
        assert r.status_code == 422
        assert "already exists" in r.text

    async def test_assigning_an_unknown_resource_is_rejected(self, client, pid):
        r = await client.post(
            f"/api/projects/{pid}/tasks/A/assignments",
            json={"resource_key": "ghost"},
        )
        assert r.status_code == 422
        assert "ghost" in r.text

    async def test_negative_effort_is_rejected(self, client, pid):
        r = await client.post(
            f"/api/projects/{pid}/tasks",
            json={"key": "NEG", "name": "Negative", "effort": -3},
        )
        assert r.status_code == 422


class TestConstraintsProtectTheWorkflow:
    """Constraints are user declarations, and the authoring API honours them
    before the optimizer ever sees them."""

    MFG = "00000000-0000-0000-0000-000000000002"

    async def test_a_mandatory_task_cannot_be_deleted(self, client):
        r = await client.delete(f"/api/projects/{self.MFG}/tasks/M09")
        assert r.status_code == 422
        assert "mandatory task" in r.text
        assert "UN38.3" in r.text, "the reason on record must be quoted"

    async def test_an_immutable_dependency_cannot_be_deleted(self, client):
        r = await client.delete(
            f"/api/projects/{self.MFG}/dependencies/M09/M12"
        )
        assert r.status_code == 422
        assert "immutable dependency" in r.text
        assert "certification" in r.text

    async def test_a_droppable_dependency_can_be_deleted(self, client):
        """The contrast matters: the guardrail is specific, not a blanket
        refusal to change anything."""
        r = await client.delete(
            f"/api/projects/{self.MFG}/dependencies/M11/M12"
        )
        assert r.status_code == 200
        # restore it so the fixture project stays as seeded
        await client.post(
            f"/api/projects/{self.MFG}/dependencies",
            json={"from_task": "M11", "to_task": "M12", "consumes": False},
        )


class TestVersionImmutability:
    """Editing a sealed version clones it; it never edits history in place."""

    async def test_editing_a_sealed_version_creates_a_new_draft(
        self, client, project
    ):
        pid = project["id"]
        await client.post(
            f"/api/projects/{pid}/tasks",
            json={"key": "S1", "name": "Sealed task", "effort": 2},
        )
        sealed = (
            await client.post(f"/api/projects/{pid}/versions/seal", params={"note": "v1 final"})
        ).json()
        assert sealed["version"]["is_draft"] is False
        sealed_id = sealed["version"]["id"]
        sealed_hash = sealed["version"]["content_hash"]

        after = (
            await client.post(
                f"/api/projects/{pid}/tasks",
                json={"key": "S2", "name": "Added later", "effort": 1},
            )
        ).json()
        assert after["version"]["id"] != sealed_id
        assert after["version"]["parent_version_id"] == sealed_id
        assert after["version"]["is_draft"] is True

        # The sealed version is untouched, hash included.
        old = (
            await client.get(
                f"/api/projects/{pid}/workflow", params={"version_id": sealed_id}
            )
        ).json()
        assert old["version"]["content_hash"] == sealed_hash
        assert [t["key"] for t in old["tasks"]] == ["S1"]

    async def test_history_is_listed_and_ordered(self, client, project):
        r = await client.get(f"/api/projects/{project['id']}/versions")
        versions = r.json()
        assert [v["version_no"] for v in versions] == sorted(
            v["version_no"] for v in versions
        )


class TestMembers:
    async def test_a_member_can_be_added_and_removed(self, client, project):
        pid = project["id"]
        r = await client.post(
            f"/api/projects/{pid}/members",
            json={"email": "editor@example.com", "name": "Ed", "role": "editor"},
        )
        assert r.status_code == 201
        user_id = r.json()["user_id"]

        listed = (await client.get(f"/api/projects/{pid}/members")).json()
        assert any(m["email"] == "editor@example.com" for m in listed)

        r = await client.delete(f"/api/projects/{pid}/members/{user_id}")
        assert r.status_code == 204

    async def test_an_unknown_role_is_rejected(self, client, project):
        r = await client.post(
            f"/api/projects/{project['id']}/members",
            json={"email": "x@example.com", "role": "admin"},
        )
        assert r.status_code == 422
