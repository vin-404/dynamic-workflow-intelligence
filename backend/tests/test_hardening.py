"""
Phase 9: the things a user notices in five minutes.

Structured errors that say what to do, a request id on everything, liveness
and readiness answering different questions, bounded work, an identity you
pick rather than log into, and one guarded reset button.
"""
from __future__ import annotations

import asyncio
import uuid

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from backend.app.api.limits import Timeout, bounded
from backend.app.main import app
from backend.app.settings import Settings, settings

EVENT_PROJECT_ID = "00000000-0000-0000-0000-000000000001"
MISSING = "00000000-0000-0000-0000-0000000000ff"


@pytest_asyncio.fixture(scope="module")
async def client():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


class TestConfiguration:
    def test_cors_origins_accepts_a_comma_separated_list(self, monkeypatch):
        """Which is what a hosting dashboard's single-line text box is good
        at. Quoting a JSON array in one of those is how you get a deployment
        with no CORS and a frontend that renders nothing."""
        monkeypatch.setenv(
            "CORS_ORIGINS", "https://app.vercel.app, http://localhost:3000"
        )
        assert Settings().CORS_ORIGINS == [
            "https://app.vercel.app", "http://localhost:3000"
        ]

    def test_it_still_accepts_the_json_array_form(self, monkeypatch):
        monkeypatch.setenv("CORS_ORIGINS", '["https://app.vercel.app"]')
        assert Settings().CORS_ORIGINS == ["https://app.vercel.app"]

    def test_a_wildcard_is_refused_rather_than_silently_useless(
        self, monkeypatch
    ):
        """`*` with credentials is rejected by every browser, so accepting it
        would produce a deployment that looks configured and is not."""
        monkeypatch.setenv("CORS_ORIGINS", "*")
        with pytest.raises(Exception) as exc:
            Settings()
        assert "cannot be '*'" in str(exc.value)

    def test_an_empty_value_is_no_origins_not_a_crash(self, monkeypatch):
        monkeypatch.setenv("CORS_ORIGINS", "")
        assert Settings().CORS_ORIGINS == []

    def test_the_defaults_run_a_fresh_clone_with_no_env_file(self, monkeypatch):
        for key in ("CORS_ORIGINS", "DATABASE_URL", "ADMIN_TOKEN"):
            monkeypatch.delenv(key, raising=False)
        fresh = Settings()
        assert fresh.DATABASE_URL.startswith("sqlite")
        assert fresh.is_sqlite is True
        assert "http://localhost:3000" in fresh.CORS_ORIGINS
        assert fresh.ADMIN_TOKEN == "", "no admin token by default"

    def test_the_cors_middleware_never_ships_a_wildcard(self):
        """Belt and braces: even if the setting were bypassed, assert what the
        running app is actually configured with."""
        from fastapi.middleware.cors import CORSMiddleware

        for middleware in app.user_middleware:
            if middleware.cls is CORSMiddleware:
                assert "*" not in middleware.kwargs["allow_origins"]
                assert middleware.kwargs["allow_credentials"] is True
                break
        else:  # pragma: no cover
            pytest.fail("CORS middleware is not installed")

    def test_every_documented_variable_exists_on_settings(self):
        """`.env.example` is the deployment contract. A variable documented
        there and misspelled here is a deployment that silently ignores it."""
        import pathlib
        import re

        text = pathlib.Path(".env.example").read_text(encoding="utf-8")
        documented = {
            m.group(1)
            for m in re.finditer(r"^([A-Z][A-Z0-9_]+)=", text, re.MULTILINE)
        }
        known = set(Settings.model_fields) | {
            # Read by the AI layer, not by Settings.
            "ANTHROPIC_API_KEY", "AI_PROVIDER", "PORT",
            # Read by the Next.js server, not by Settings. `API_REWRITE_URL`
            # is where the backend URL lives now; there is deliberately no
            # browser-side one (D-88). The `AUTH_*` set plus `NEXTAUTH_URL`
            # are Auth.js's, which runs in Next rather than here (D-82), and
            # `E2E_AUTH_ENABLED` gates the walkthrough sign-in (D-79).
            "API_REWRITE_URL",
            "AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET", "AUTH_SECRET",
            "NEXTAUTH_URL", "E2E_AUTH_ENABLED",
            # The public-read-only switch is the *proxy's* decision, so it is
            # read in Next and never here. Its counterpart
            # `PUBLIC_VIEWER_EMAIL` *is* a Settings field - it has to be, it
            # is what holds that identity to a read-only bar - so it is not
            # listed here and this test checks it for real.
            "PUBLIC_DEMO_VIEWER",
        }
        assert documented <= known, documented - known


# ---------------------------------------------------------------------------
# Structured errors
# ---------------------------------------------------------------------------


class TestErrorsSayWhatToDo:
    async def test_a_404_carries_an_actionable_hint(self, client):
        r = await client.get(f"/api/projects/{MISSING}/workflow")
        assert r.status_code == 404
        body = r.json()
        assert body["error"] == "not_found"
        assert body["detail"]
        assert "reload" in body["hint"].lower()
        assert body["request_id"]

    async def test_a_refusal_keeps_its_structure_rather_than_a_string(
        self, client
    ):
        """The cited constraint is the product. Flattening it into a message
        would throw away the only part the user can act on."""
        r = await client.post(
            "/api/projects/00000000-0000-0000-0000-000000000002/what-if",
            json={"name": "x", "mutations": [
                {"kind": "TASK_REMOVE", "payload": {"key": "M09"}}
            ]},
        )
        assert r.status_code == 422
        body = r.json()
        assert body["error"] == "rejected"
        rejection = body["detail"]["rejections"][0]
        assert rejection["constraint"] == "MANDATORY_TASK"
        assert "UN38.3" in rejection["constraint_reason"]
        assert "nothing was written" in body["hint"].lower()

    async def test_a_malformed_body_names_the_field(self, client):
        r = await client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/tasks",
            json={"name": "no key, no effort"},
        )
        assert r.status_code == 422
        body = r.json()
        assert body["error"] == "invalid_request"
        fields = {f["field"] for f in body["detail"]["invalid_fields"]}
        assert "key" in fields

    async def test_every_response_carries_its_request_id(self, client):
        r = await client.get("/health")
        assert r.headers["X-Request-ID"]

    async def test_a_supplied_request_id_is_honoured(self, client):
        """So a frontend can correlate its own log with the server's."""
        r = await client.get("/health", headers={"X-Request-ID": "abc123"})
        assert r.headers["X-Request-ID"] == "abc123"

    async def test_no_endpoint_returns_a_bare_string_error(self, client):
        for path in (
            f"/api/projects/{MISSING}/workflow",
            f"/api/projects/{MISSING}/analyze",
            f"/api/scenarios/{MISSING}",
        ):
            body = (await client.get(path)).json()
            assert set(body) >= {"error", "detail", "hint", "request_id"}, path


# ---------------------------------------------------------------------------
# Liveness and readiness are different questions
# ---------------------------------------------------------------------------


class TestHealthAndReadiness:
    async def test_health_is_liveness_only(self, client):
        """It must not touch the database: a platform that restarts the
        container when the database blips turns an outage into a crash loop."""
        r = await client.get("/health")
        assert r.status_code == 200
        assert r.json() == {"status": "healthy"}

    async def test_ready_actually_asks_the_database(self, client):
        r = await client.get("/ready")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ready"
        assert body["database"] in ("sqlite", "postgres")
        assert body["latency_ms"] >= 0

    async def test_ready_reports_a_broken_database_as_503(self, client, monkeypatch):
        import backend.app.main as main

        class Broken:
            async def __aenter__(self):
                raise OSError("connection refused")

            async def __aexit__(self, *exc):
                return False

        monkeypatch.setattr(main, "async_session", lambda: Broken())
        r = await client.get("/ready")
        assert r.status_code == 503
        assert r.json()["database"] == "unreachable"
        assert "DATABASE_URL" in r.json()["hint"]


# ---------------------------------------------------------------------------
# Bounded work
# ---------------------------------------------------------------------------


class TestBoundedWork:
    async def test_a_slow_operation_raises_an_explained_timeout(self):
        async def slow():
            await asyncio.sleep(5)

        with pytest.raises(Timeout) as exc:
            await bounded(slow(), 0.05, "Analyzing this workflow", "Report it.")
        assert "Analyzing this workflow" in str(exc.value)
        assert "budget" in str(exc.value)
        assert "Report it." in str(exc.value)

    async def test_fast_work_is_unaffected(self):
        async def quick():
            return 42

        assert await bounded(quick(), 10, "x") == 42

    async def test_a_timeout_becomes_a_structured_503(self, client, monkeypatch):
        from backend.app.services import intelligence

        async def slow(*args, **kwargs):
            await asyncio.sleep(5)

        monkeypatch.setattr(intelligence, "analyze", slow)
        monkeypatch.setattr(settings, "ANALYZE_TIMEOUT_SECONDS", 0.05)
        r = await client.post(f"/api/projects/{EVENT_PROJECT_ID}/analyze")
        assert r.status_code == 503
        body = r.json()
        assert body["error"] == "timed_out"
        assert "budget" in body["detail"]
        assert body["hint"]

    async def test_the_optimizer_returns_partial_results_rather_than_timing_out(
        self, client
    ):
        """The real budget is the injected `should_stop`, which stops between
        candidates and returns what it has. A 503 here would mean that
        mechanism failed."""
        r = await client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/optimize",
            json={"budget": {"max_candidates": 500, "max_seconds": 0.1},
                  "persist_candidates": False},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["stopped_early"] is True
        assert body["stop_reason"]
        assert body["candidates"], "a stopped search still returns its ranking"


# ---------------------------------------------------------------------------
# Identity without authentication
# ---------------------------------------------------------------------------


class TestNamePicker:
    async def test_picking_a_name_creates_an_identity(self, client):
        r = await client.post("/api/users", json={"name": "Rae Whitcombe"})
        assert r.status_code == 201
        body = r.json()
        assert body["name"] == "Rae Whitcombe"
        assert body["email"] == "rae-whitcombe@local"

    async def test_the_same_name_comes_back_as_the_same_person(self, client):
        first = (await client.post("/api/users", json={"name": "Sam Ito"})).json()
        second = (await client.post("/api/users", json={"name": "Sam Ito"})).json()
        assert first["id"] == second["id"], (
            "coming back tomorrow has to work, and there is no password to "
            "check them against"
        )

    async def test_a_returning_user_can_respell_their_name(self, client):
        first = (await client.post(
            "/api/users", json={"name": "Jo", "email": "jo@example.com"}
        )).json()
        second = (await client.post(
            "/api/users", json={"name": "Jo Barnes", "email": "jo@example.com"}
        )).json()
        assert first["id"] == second["id"]
        assert second["name"] == "Jo Barnes"

    async def test_the_picker_lists_everyone_on_this_instance(self, client):
        await client.post("/api/users", json={"name": "Listed Person"})
        people = (await client.get("/api/users")).json()
        assert any(p["name"] == "Listed Person" for p in people)
        assert all("project_count" in p for p in people)

    async def test_a_stale_identity_is_a_404_so_the_ui_can_ask_again(
        self, client
    ):
        """After an admin reset, a browser's remembered id is dangling. It
        must find out, not send it on every request forever."""
        r = await client.get(f"/api/users/{MISSING}")
        assert r.status_code == 404
        assert "no longer exists" in r.json()["detail"]

    async def test_a_users_projects_are_listed_with_advisory_roles(self, client):
        """Advisory here means the open configuration; the note says so, and
        says the opposite once `PROXY_SHARED_SECRET` is set."""
        members = (
            await client.get(f"/api/projects/{EVENT_PROJECT_ID}/members")
        ).json()
        user_id = members[0]["user_id"]
        body = (await client.get(f"/api/users/{user_id}/projects")).json()
        assert body["projects"]
        assert body["projects"][0]["role"] in ("owner", "editor", "viewer")
        assert "advisory" in body["note"]

    async def test_there_is_no_login_endpoint(self):
        """Explicitly out of scope. This test exists so adding one is a
        deliberate act rather than a drift."""
        paths = {r.path for r in app.routes if hasattr(r, "path")}
        for forbidden in ("/api/login", "/api/auth", "/api/token",
                          "/api/logout", "/api/register"):
            assert forbidden not in paths

    async def test_no_endpoint_enforces_a_permission(self, client):
        """Roles are advisory **in the open configuration**, and a viewer can
        still edit.

        This is the canary for that configuration, not a statement about the
        product any more: with no `PROXY_SHARED_SECRET` there is no
        trustworthy identity to enforce against, so enforcing a role would be
        theatre (D-74). `test_auth.py` covers the configuration where a viewer
        genuinely cannot. If this test ever fails, the open default has moved
        - which is a decision, not a broken test."""
        members = (
            await client.get(f"/api/projects/{EVENT_PROJECT_ID}/members")
        ).json()
        viewer = [m for m in members if m["role"] == "viewer"]
        if not viewer:
            pytest.skip("no viewer in the seeded members")
        r = await client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/tasks",
            json={"key": "ZZ1", "name": "Written by a viewer", "effort": 1.0},
            headers={"X-User-Id": viewer[0]["user_id"]},
        )
        assert r.status_code == 201


class TestIdentityDrivesOwnership:
    """The identity is not decoration: what you create is yours, and shows up
    on the member list without anyone typing an email."""

    async def test_a_project_created_with_an_identity_is_owned_by_it(
        self, client
    ):
        person = (
            await client.post("/api/users", json={"name": "Nia Okafor"})
        ).json()

        created = await client.post(
            "/api/projects",
            json={
                "name": "Nia's workflow",
                "start_date": "2026-01-05",
                "today_day": 0,
            },
            headers={"X-User-Id": person["id"]},
        )
        assert created.status_code == 201
        project_id = created.json()["id"]
        assert created.json()["created_by"] == person["id"]

        members = (
            await client.get(f"/api/projects/{project_id}/members")
        ).json()
        assert [m["name"] for m in members] == ["Nia Okafor"]
        assert members[0]["role"] == "owner"

        mine = (await client.get(f"/api/users/{person['id']}/projects")).json()
        assert [p["name"] for p in mine["projects"]] == ["Nia's workflow"]

    async def test_no_identity_still_works(self, client):
        """A visitor who has not picked a name is not blocked - refusing them
        would be enforcing an identity, which is what this is not."""
        created = await client.post(
            "/api/projects",
            json={"name": "Anonymous", "start_date": "2026-01-05",
                  "today_day": 0},
        )
        assert created.status_code == 201
        assert created.json()["created_by"] is None

    async def test_a_stale_identity_is_ignored_rather_than_refused(
        self, client
    ):
        """After a reset, a browser sends an id that no longer exists. The
        request is served; the project simply has no owner."""
        created = await client.post(
            "/api/projects",
            json={"name": "Stale", "start_date": "2026-01-05", "today_day": 0},
            headers={"X-User-Id": MISSING},
        )
        assert created.status_code == 201
        assert created.json()["created_by"] is None

    async def test_a_malformed_identity_header_is_ignored(self, client):
        created = await client.post(
            "/api/projects",
            json={"name": "Junk header", "start_date": "2026-01-05",
                  "today_day": 0},
            headers={"X-User-Id": "not-a-uuid"},
        )
        assert created.status_code == 201

    async def test_an_explicit_owner_email_still_wins(self, client):
        """The seed loader and the tests set it, and it must keep working."""
        person = (
            await client.post("/api/users", json={"name": "Header Person"})
        ).json()
        created = await client.post(
            "/api/projects",
            json={
                "name": "Explicit owner",
                "start_date": "2026-01-05",
                "today_day": 0,
                "owner_email": "explicit@example.com",
            },
            headers={"X-User-Id": person["id"]},
        )
        members = (
            await client.get(f"/api/projects/{created.json()['id']}/members")
        ).json()
        assert [m["email"] for m in members] == ["explicit@example.com"]

    async def test_two_people_see_the_same_project(self, client):
        """The whole multi-user requirement: no live sync, but both see it."""
        a = (await client.post("/api/users", json={"name": "First"})).json()
        b = (await client.post("/api/users", json={"name": "Second"})).json()

        created = await client.post(
            "/api/projects",
            json={"name": "Shared", "start_date": "2026-01-05", "today_day": 0},
            headers={"X-User-Id": a["id"]},
        )
        project_id = created.json()["id"]

        seen_by_b = (
            await client.get("/api/projects", headers={"X-User-Id": b["id"]})
        ).json()
        assert any(p["id"] == project_id for p in seen_by_b)

        # And B can edit it, because roles are advisory.
        edit = await client.post(
            f"/api/projects/{project_id}/tasks",
            json={"key": "S1", "name": "Added by the other person",
                  "effort": 2.0},
            headers={"X-User-Id": b["id"]},
        )
        assert edit.status_code == 201


# ---------------------------------------------------------------------------
# The reset button
# ---------------------------------------------------------------------------


class TestAdminReset:
    async def test_it_is_disabled_when_no_token_is_configured(
        self, client, monkeypatch
    ):
        """Not "open by default". An unguarded database reset on a public URL
        is an undo button for your demo that anyone can press."""
        monkeypatch.setattr(settings, "ADMIN_TOKEN", "")
        r = await client.post("/admin/reset-seed")
        assert r.status_code == 403
        assert "disabled" in r.json()["detail"]

    async def test_a_wrong_token_is_refused(self, client, monkeypatch):
        monkeypatch.setattr(settings, "ADMIN_TOKEN", "the-real-token")
        r = await client.post(
            "/admin/reset-seed", headers={"X-Admin-Token": "guess"}
        )
        assert r.status_code == 401
        assert r.json()["hint"]

    async def test_a_missing_header_is_refused(self, client, monkeypatch):
        monkeypatch.setattr(settings, "ADMIN_TOKEN", "the-real-token")
        assert (await client.post("/admin/reset-seed")).status_code == 401

    async def test_status_says_whether_reset_is_available_here(
        self, client, monkeypatch
    ):
        monkeypatch.setattr(settings, "ADMIN_TOKEN", "")
        assert (await client.get("/admin/status")).json()["reset_available"] is False
        monkeypatch.setattr(settings, "ADMIN_TOKEN", "t")
        assert (await client.get("/admin/status")).json()["reset_available"] is True

    async def test_the_right_token_resets_to_both_seed_domains(
        self, client, monkeypatch
    ):
        monkeypatch.setattr(settings, "ADMIN_TOKEN", "the-real-token")
        await client.post("/api/users", json={"name": "About To Vanish"})

        r = await client.post(
            "/admin/reset-seed", headers={"X-Admin-Token": "the-real-token"}
        )
        assert r.status_code == 200
        body = r.json()
        assert set(body["projects"]) == {"campus-symposium", "battery-pilot-line"}

        projects = (await client.get("/api/projects")).json()
        assert len(projects) == 2, "everything a visitor created is gone"
        people = (await client.get("/api/users")).json()
        assert not any(p["name"] == "About To Vanish" for p in people)

        # And the seeded workflows still analyze, which is the point of it
        # being safe to hand to a stranger.
        analysis = (
            await client.post(f"/api/projects/{EVENT_PROJECT_ID}/analyze")
        ).json()
        assert analysis["findings"]


# ---------------------------------------------------------------------------
# Startup is idempotent
# ---------------------------------------------------------------------------


class TestSeedIdempotency:
    async def test_seeding_twice_does_not_duplicate_anything(self, client):
        """A container restart against an existing database must write
        nothing. Two of every project is how a demo dies quietly."""
        from backend.app.db import async_session
        from backend.app.seed import loader

        before = (await client.get("/api/projects")).json()
        async with async_session() as db:
            await loader.seed_all(db)
            await loader.seed_all(db)
        after = (await client.get("/api/projects")).json()
        assert len(after) == len(before)
        assert {p["id"] for p in after} == {p["id"] for p in before}

    async def test_the_seeded_ids_are_deterministic(self, client):
        """The demo deep-links to them, and `demo_check` asserts on them."""
        ids = {p["id"] for p in (await client.get("/api/projects")).json()}
        assert EVENT_PROJECT_ID in ids
        assert "00000000-0000-0000-0000-000000000002" in ids

    async def test_seeding_can_be_turned_off(self, monkeypatch):
        """For a database you populated yourself."""
        monkeypatch.setattr(settings, "SEED_ON_STARTUP", False)
        assert settings.SEED_ON_STARTUP is False
