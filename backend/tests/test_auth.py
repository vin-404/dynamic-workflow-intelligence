"""
Authentication happens in front of this API; authorization happens inside it.

The Next.js server verifies a Google session, strips whatever identity headers
the browser sent, and proxies `/api/*` upstream with `X-User-Id` and
`X-Proxy-Secret`. This suite covers the backend half of that handshake and the
role enforcement it unlocks:

* the header is honoured **only** when the secret matches, so calling the
  deployed URL directly and claiming to be someone is not a way in;
* an untrusted header is *ignored*, never an error - not knowing who somebody
  is and refusing them are separate decisions;
* with no `PROXY_SHARED_SECRET` configured nothing above changes anything, and
  that compatibility default is asserted here rather than assumed;
* viewer reads and evaluates, editor changes the workflow, owner also changes
  the member list - and a refusal says which of those you are and which you
  needed.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
import pytest_asyncio
from fastapi.routing import APIRoute
from httpx import ASGITransport, AsyncClient

from backend.app.api.deps import (
    OWNER_ONLY,
    READS_THAT_POST,
    enforce_project_role,
)
from backend.app.main import app
from backend.app.settings import settings

SECRET = "a-shared-secret-only-the-proxy-knows"
NOBODY = "00000000-0000-0000-0000-0000000000fe"


@pytest_asyncio.fixture(scope="module")
async def client():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c


@pytest_asyncio.fixture(scope="module")
async def world(client):
    """One project with an owner, an editor, a viewer and an outsider.

    Built with the instance in its open configuration - this is the setup, not
    the thing under test, and it is exactly how a fresh clone behaves.
    """
    previous = settings.PROXY_SHARED_SECRET
    settings.PROXY_SHARED_SECRET = ""
    try:
        people = {}
        for role in ("owner", "editor", "viewer", "outsider"):
            people[role] = (
                await client.post(
                    "/api/users", json={"name": f"Auth {role.title()}"}
                )
            ).json()

        project = (
            await client.post(
                "/api/projects",
                json={
                    "name": "Role enforcement",
                    "start_date": "2026-02-02",
                    "today_day": 0,
                },
                headers={"X-User-Id": people["owner"]["id"]},
            )
        ).json()
        project_id = project["id"]

        for role in ("editor", "viewer"):
            r = await client.post(
                f"/api/projects/{project_id}/members",
                json={
                    "email": people[role]["email"],
                    "name": people[role]["name"],
                    "role": role,
                },
            )
            assert r.status_code == 201, r.text

        r = await client.post(
            f"/api/projects/{project_id}/tasks",
            json={"key": "A1", "name": "Something to move", "effort": 3.0},
        )
        assert r.status_code == 201, r.text

        async def scenario(name: str) -> str:
            r = await client.post(
                f"/api/projects/{project_id}/scenarios",
                json={
                    "name": name,
                    "mutations": [
                        {
                            "kind": "TASK_DELAY_ADD",
                            "payload": {"key": "A1", "extra_days": 2},
                        }
                    ],
                },
            )
            assert r.status_code == 201, r.text
            return r.json()["id"]

        scenarios = SimpleNamespace(
            viewer_may_evaluate=await scenario("Viewer looks"),
            editor_may_mutate=await scenario("Editor edits"),
            editor_may_apply=await scenario("Editor applies"),
            editor_may_delete=await scenario("Editor deletes"),
            owner_may_apply=await scenario("Owner applies"),
        )
    finally:
        settings.PROXY_SHARED_SECRET = previous

    return SimpleNamespace(
        project_id=project_id,
        owner=people["owner"],
        editor=people["editor"],
        viewer=people["viewer"],
        outsider=people["outsider"],
        scenarios=scenarios,
    )


@pytest.fixture
def authenticating(monkeypatch):
    """An instance that is behind the proxy.

    `settings` is constructed at import time, so the environment is no use
    here - the live object is what every dependency reads.
    """
    monkeypatch.setattr(settings, "PROXY_SHARED_SECRET", SECRET)
    return SECRET


@pytest.fixture
def open_instance(monkeypatch):
    """A fresh clone: no proxy, no secret, nothing enforced."""
    monkeypatch.setattr(settings, "PROXY_SHARED_SECRET", "")


def via_proxy(person, secret: str = SECRET) -> dict[str, str]:
    """Headers as the Next.js proxy sends them."""
    return {
        "X-User-Id": person["id"] if isinstance(person, dict) else str(person),
        "X-Proxy-Secret": secret,
    }


def a_task(key: str) -> dict:
    return {"key": key, "name": f"Written by {key}", "effort": 1.0}


# ---------------------------------------------------------------------------
# The handshake
# ---------------------------------------------------------------------------


class TestTheProxyHandshake:
    async def test_the_header_identifies_the_user_when_the_secret_matches(
        self, client, world, authenticating
    ):
        created = await client.post(
            "/api/projects",
            json={"name": "Vouched for", "start_date": "2026-02-02",
                  "today_day": 0},
            headers=via_proxy(world.owner),
        )
        assert created.status_code == 201
        assert created.json()["created_by"] == world.owner["id"]

    async def test_the_header_alone_identifies_nobody(
        self, client, world, authenticating
    ):
        """The whole point: someone who finds the API's public URL and sends
        `X-User-Id` is not that person. The header is a claim the proxy
        vouches for, and an unvouched claim is worth nothing."""
        r = await client.post(
            "/api/projects",
            json={"name": "Impersonation", "start_date": "2026-02-02",
                  "today_day": 0},
            headers={"X-User-Id": world.owner["id"]},
        )
        assert r.status_code == 403
        assert r.json()["detail"]["your_role"] == "anonymous"

    async def test_an_unvouched_header_is_ignored_not_an_error(
        self, client, world, authenticating
    ):
        """Ignored means *served*. A read still works, and it works as a
        visitor - a 500, or a refusal to answer at all, would be treating "we
        do not know who you are" as a fault."""
        r = await client.get(
            f"/api/projects/{world.project_id}/workflow",
            headers={"X-User-Id": world.owner["id"]},
        )
        assert r.status_code == 200

    async def test_a_wrong_secret_is_ignored_too(
        self, client, world, authenticating
    ):
        r = await client.post(
            "/api/projects",
            json={"name": "Guessed", "start_date": "2026-02-02",
                  "today_day": 0},
            headers=via_proxy(world.owner, secret="not-the-secret"),
        )
        assert r.status_code == 403
        assert r.json()["detail"]["your_role"] == "anonymous"

    async def test_a_secret_that_is_a_prefix_of_the_real_one_is_refused(
        self, client, world, authenticating
    ):
        """`hmac.compare_digest`, for the reason D-67 gives - comparing a
        secret with `==` hands its length and prefix to anyone patient enough
        to measure."""
        r = await client.post(
            "/api/projects",
            json={"name": "Prefix", "start_date": "2026-02-02",
                  "today_day": 0},
            headers=via_proxy(world.owner, secret=SECRET[:-1]),
        )
        assert r.status_code == 403

    async def test_a_stale_or_malformed_id_from_the_proxy_is_still_a_visitor(
        self, client, world, authenticating
    ):
        for claimed in (NOBODY, "not-a-uuid", ""):
            r = await client.get(
                f"/api/projects/{world.project_id}/workflow",
                headers={"X-User-Id": claimed, "X-Proxy-Secret": SECRET},
            )
            assert r.status_code == 200, claimed


# ---------------------------------------------------------------------------
# The compatibility default
# ---------------------------------------------------------------------------


class TestTheOpenDefault:
    async def test_the_secret_is_unset_out_of_the_box(self):
        """Load-bearing. It is what makes a fresh clone, local development
        and every other test in this suite work with no configuration."""
        from backend.app.settings import Settings

        assert Settings().PROXY_SHARED_SECRET == ""

    async def test_the_identity_header_works_on_its_own_with_no_secret(
        self, client, world, open_instance
    ):
        created = await client.post(
            "/api/projects",
            json={"name": "Open instance", "start_date": "2026-02-02",
                  "today_day": 0},
            headers={"X-User-Id": world.owner["id"]},
        )
        assert created.status_code == 201
        assert created.json()["created_by"] == world.owner["id"]

    async def test_a_viewer_can_still_edit_when_nothing_is_configured(
        self, client, world, open_instance
    ):
        """Roles stay advisory in the open configuration, which is what
        `test_hardening.py::test_no_endpoint_enforces_a_permission` asserts.
        Enforcing a role against an identity anyone can claim would be
        theatre, not security."""
        r = await client.post(
            f"/api/projects/{world.project_id}/tasks",
            json=a_task("OPEN1"),
            headers={"X-User-Id": world.viewer["id"]},
        )
        assert r.status_code == 201

    async def test_the_projects_note_tells_the_truth_in_both_configurations(
        self, client, world, monkeypatch
    ):
        path = f"/api/users/{world.viewer['id']}/projects"

        monkeypatch.setattr(settings, "PROXY_SHARED_SECRET", "")
        body = (await client.get(path)).json()
        assert body["roles_enforced"] is False
        assert "advisory" in body["note"]

        monkeypatch.setattr(settings, "PROXY_SHARED_SECRET", SECRET)
        body = (await client.get(path)).json()
        assert body["roles_enforced"] is True
        assert "enforced" in body["note"]


# ---------------------------------------------------------------------------
# viewer
# ---------------------------------------------------------------------------


class TestWhatAViewerMayDo:
    async def test_a_viewer_may_read(self, client, world, authenticating):
        headers = via_proxy(world.viewer)
        for path in (
            f"/api/projects/{world.project_id}",
            f"/api/projects/{world.project_id}/workflow",
            f"/api/projects/{world.project_id}/versions",
            f"/api/projects/{world.project_id}/members",
            f"/api/projects/{world.project_id}/risk",
            f"/api/projects/{world.project_id}/scenarios",
        ):
            assert (await client.get(path, headers=headers)).status_code == 200, path

    async def test_a_viewer_may_ask_questions(
        self, client, world, authenticating
    ):
        """Analyze, risk, optimize, evaluate, diff, what-if. A read-only seat
        that cannot ask "what happens if this slips" is a screenshot."""
        headers = via_proxy(world.viewer)
        pid, sid = world.project_id, world.scenarios.viewer_may_evaluate

        assert (await client.post(
            f"/api/projects/{pid}/analyze", headers=headers
        )).status_code == 200
        assert (await client.post(
            f"/api/projects/{pid}/risk", headers=headers
        )).status_code == 200
        assert (await client.post(
            f"/api/projects/{pid}/optimize",
            json={"budget": {"max_candidates": 3, "max_seconds": 1.0},
                  "persist_candidates": False},
            headers=headers,
        )).status_code == 200
        assert (await client.post(
            f"/api/scenarios/{sid}/evaluate", headers=headers
        )).status_code == 200
        assert (await client.get(
            f"/api/scenarios/{sid}/diff", headers=headers
        )).status_code == 200
        assert (await client.post(
            f"/api/projects/{pid}/what-if",
            json={"mutations": [{"kind": "TASK_DELAY_ADD",
                                 "payload": {"key": "A1", "extra_days": 1}}],
                  "keep": False},
            headers=headers,
        )).status_code == 200

    async def test_a_viewer_may_not_author(self, client, world, authenticating):
        headers = via_proxy(world.viewer)
        pid = world.project_id

        refusals = [
            await client.post(
                f"/api/projects/{pid}/tasks", json=a_task("V1"), headers=headers
            ),
            await client.patch(
                f"/api/projects/{pid}/tasks/A1", json={"name": "Renamed"},
                headers=headers,
            ),
            await client.delete(
                f"/api/projects/{pid}/tasks/A1", headers=headers
            ),
            await client.post(
                f"/api/projects/{pid}/resources",
                json={"key": "vres", "name": "Viewer resource"},
                headers=headers,
            ),
            await client.post(
                f"/api/projects/{pid}/versions/seal", headers=headers
            ),
        ]
        for r in refusals:
            assert r.status_code == 403, r.request.url
            assert r.json()["detail"]["your_role"] == "viewer"
            assert r.json()["detail"]["required_role"] == "editor"

    async def test_a_viewer_may_not_change_or_apply_a_scenario(
        self, client, world, authenticating
    ):
        headers = via_proxy(world.viewer)
        sid = world.scenarios.viewer_may_evaluate

        assert (await client.post(
            f"/api/projects/{world.project_id}/scenarios",
            json={"name": "Viewer's scenario"}, headers=headers,
        )).status_code == 403
        assert (await client.post(
            f"/api/scenarios/{sid}/mutations",
            json={"kind": "TASK_DELAY_ADD",
                  "payload": {"key": "A1", "extra_days": 1}},
            headers=headers,
        )).status_code == 403
        assert (await client.delete(
            f"/api/scenarios/{sid}/mutations/1", headers=headers
        )).status_code == 403

        applied = await client.post(
            f"/api/scenarios/{sid}/apply", headers=headers
        )
        assert applied.status_code == 403, (
            "apply writes a new workflow version - it is squarely a write"
        )
        assert (await client.delete(
            f"/api/scenarios/{sid}", headers=headers
        )).status_code == 403

    async def test_a_viewer_may_not_change_the_member_list(
        self, client, world, authenticating
    ):
        r = await client.post(
            f"/api/projects/{world.project_id}/members",
            json={"email": "someone@example.com", "role": "owner"},
            headers=via_proxy(world.viewer),
        )
        assert r.status_code == 403
        assert r.json()["detail"]["required_role"] == "owner"


# ---------------------------------------------------------------------------
# editor
# ---------------------------------------------------------------------------


class TestWhatAnEditorMayDo:
    async def test_an_editor_may_author(self, client, world, authenticating):
        headers = via_proxy(world.editor)
        pid = world.project_id

        assert (await client.post(
            f"/api/projects/{pid}/tasks", json=a_task("E1"), headers=headers
        )).status_code == 201
        assert (await client.patch(
            f"/api/projects/{pid}/tasks/E1", json={"name": "Renamed by editor"},
            headers=headers,
        )).status_code == 200
        assert (await client.post(
            f"/api/projects/{pid}/resources",
            json={"key": "eres", "name": "Editor resource"}, headers=headers,
        )).status_code == 201
        assert (await client.delete(
            f"/api/projects/{pid}/tasks/E1", headers=headers
        )).status_code == 200

    async def test_an_editor_may_change_and_apply_a_scenario(
        self, client, world, authenticating
    ):
        headers = via_proxy(world.editor)

        assert (await client.post(
            f"/api/scenarios/{world.scenarios.editor_may_mutate}/mutations",
            json={"kind": "TASK_DELAY_ADD",
                  "payload": {"key": "A1", "extra_days": 1}},
            headers=headers,
        )).status_code == 201
        assert (await client.post(
            f"/api/scenarios/{world.scenarios.editor_may_apply}/apply",
            headers=headers,
        )).status_code == 200
        assert (await client.delete(
            f"/api/scenarios/{world.scenarios.editor_may_delete}",
            headers=headers,
        )).status_code == 204

    async def test_an_editor_may_not_change_the_member_list(
        self, client, world, authenticating
    ):
        headers = via_proxy(world.editor)

        added = await client.post(
            f"/api/projects/{world.project_id}/members",
            json={"email": "recruit@example.com", "role": "editor"},
            headers=headers,
        )
        assert added.status_code == 403
        assert added.json()["detail"]["your_role"] == "editor"
        assert added.json()["detail"]["required_role"] == "owner"

        removed = await client.delete(
            f"/api/projects/{world.project_id}/members/"
            f"{world.viewer['id']}",
            headers=headers,
        )
        assert removed.status_code == 403


# ---------------------------------------------------------------------------
# owner
# ---------------------------------------------------------------------------


class TestWhatAnOwnerMayDo:
    async def test_an_owner_may_author_and_apply(
        self, client, world, authenticating
    ):
        headers = via_proxy(world.owner)
        assert (await client.post(
            f"/api/projects/{world.project_id}/tasks", json=a_task("O1"),
            headers=headers,
        )).status_code == 201
        assert (await client.post(
            f"/api/scenarios/{world.scenarios.owner_may_apply}/apply",
            headers=headers,
        )).status_code == 200

    async def test_an_owner_may_change_the_member_list(
        self, client, world, authenticating
    ):
        headers = via_proxy(world.owner)
        added = await client.post(
            f"/api/projects/{world.project_id}/members",
            json={"email": "recruit@example.com", "name": "Recruit",
                  "role": "editor"},
            headers=headers,
        )
        assert added.status_code == 201
        removed = await client.delete(
            f"/api/projects/{world.project_id}/members/"
            f"{added.json()['user_id']}",
            headers=headers,
        )
        assert removed.status_code == 204


# ---------------------------------------------------------------------------
# Everybody else
# ---------------------------------------------------------------------------


class TestStrangersAndVisitors:
    async def test_a_signed_in_non_member_may_read(
        self, client, world, authenticating
    ):
        """Decided deliberately: this instance has never been multi-tenant -
        `GET /api/projects` lists everything to everybody, and Phase 9 asserts
        two people see the same project. Visibility stays open; authorship is
        what a role protects."""
        r = await client.get(
            f"/api/projects/{world.project_id}/workflow",
            headers=via_proxy(world.outsider),
        )
        assert r.status_code == 200

    async def test_a_signed_in_non_member_may_not_write(
        self, client, world, authenticating
    ):
        r = await client.post(
            f"/api/projects/{world.project_id}/tasks",
            json=a_task("X1"),
            headers=via_proxy(world.outsider),
        )
        assert r.status_code == 403
        assert r.json()["detail"]["your_role"] == "none"
        assert "not a member" in r.json()["detail"]["message"]

    async def test_an_anonymous_request_may_read(
        self, client, world, authenticating
    ):
        assert (await client.get(
            f"/api/projects/{world.project_id}/analyze"
        )).status_code == 200
        assert (await client.get("/api/projects")).status_code == 200

    async def test_an_anonymous_request_may_not_write(
        self, client, world, authenticating
    ):
        r = await client.post(
            f"/api/projects/{world.project_id}/tasks", json=a_task("N1")
        )
        assert r.status_code == 403
        assert r.json()["detail"]["your_role"] == "anonymous"

    async def test_creating_a_project_needs_an_identity(
        self, client, authenticating
    ):
        r = await client.post(
            "/api/projects",
            json={"name": "Ownerless", "start_date": "2026-02-02",
                  "today_day": 0},
        )
        assert r.status_code == 403
        assert r.json()["detail"]["reason"] == "not_signed_in"

    async def test_a_write_to_a_project_that_does_not_exist_is_still_a_404(
        self, client, world, authenticating
    ):
        """A 403 for something that is not there would send the caller
        hunting for a permission problem they do not have."""
        r = await client.post(
            f"/api/projects/{NOBODY}/tasks", json=a_task("M1"),
            headers=via_proxy(world.owner),
        )
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# Signing in has to keep working
# ---------------------------------------------------------------------------


class TestSigningInStillWorks:
    async def test_creating_a_user_needs_no_identity_and_no_secret(
        self, client, authenticating
    ):
        """The Next.js sign-in callback calls this to mint the very identity
        every other route needs. Gating it would be a deadlock nobody could
        get out of."""
        r = await client.post("/api/users", json={"name": "Brand New Person"})
        assert r.status_code == 201
        assert r.json()["id"]

    async def test_the_name_picker_and_lookup_stay_open(
        self, client, authenticating
    ):
        person = (
            await client.post("/api/users", json={"name": "Looked Up"})
        ).json()
        assert (await client.get("/api/users")).status_code == 200
        assert (
            await client.get(f"/api/users/{person['id']}")
        ).status_code == 200

    async def test_there_is_still_no_login_endpoint(self):
        """Authentication belongs to the Next.js server. This phase moved the
        trust boundary; it did not move the login form."""
        paths = {r.path for r in app.routes if hasattr(r, "path")}
        for forbidden in ("/api/login", "/api/auth", "/api/token",
                          "/api/logout", "/api/register"):
            assert forbidden not in paths


# ---------------------------------------------------------------------------
# The refusal has to be readable
# ---------------------------------------------------------------------------


class TestTheRefusalIsReadable:
    async def test_a_403_carries_the_standard_envelope(
        self, client, world, authenticating
    ):
        r = await client.post(
            f"/api/projects/{world.project_id}/tasks", json=a_task("R1"),
            headers=via_proxy(world.viewer),
        )
        body = r.json()
        assert set(body) >= {"error", "detail", "hint", "request_id"}
        assert body["error"] == "forbidden"
        assert body["request_id"]

    async def test_the_detail_says_what_was_tried_and_by_whom(
        self, client, world, authenticating
    ):
        r = await client.post(
            f"/api/projects/{world.project_id}/tasks", json=a_task("R2"),
            headers=via_proxy(world.viewer),
        )
        detail = r.json()["detail"]
        assert detail["reason"] == "insufficient_role"
        assert detail["attempted"] == "POST /api/projects/{project_id}/tasks"
        assert detail["project_id"] == world.project_id
        assert detail["your_role"] == "viewer"
        assert detail["required_role"] == "editor"

    async def test_the_message_stands_on_its_own(
        self, client, world, authenticating
    ):
        """`main.py` owns `HINTS[403]`, and it was written for the admin
        route. The detail must not need it to make sense."""
        r = await client.post(
            f"/api/projects/{world.project_id}/tasks", json=a_task("R3"),
            headers=via_proxy(world.viewer),
        )
        message = r.json()["detail"]["message"]
        assert "viewer" in message
        assert "editor" in message
        assert "Ask an owner" in message


# ---------------------------------------------------------------------------
# The guard cannot be forgotten
# ---------------------------------------------------------------------------


def _api_routes(router, prefix: str = ""):
    """Every real route, walked through FastAPI's lazy router inclusion.

    `app.routes` no longer holds a flat list - an included router appears as
    one opaque entry - so a test that iterated it would quietly assert nothing
    at all.
    """
    for route in router.routes:
        if isinstance(route, APIRoute):
            yield prefix + route.path, route
            continue
        inner = getattr(route, "original_router", None)
        if inner is not None:
            context = getattr(route, "include_context", None)
            yield from _api_routes(
                inner, prefix + getattr(context, "prefix", "")
            )


def _is_guarded(route: APIRoute) -> bool:
    return any(
        getattr(dep, "dependency", None) is enforce_project_role
        for dep in route.dependencies
    )


#: The only routes allowed to change something without the role guard, each
#: for a reason that is written down. Anything else added here should be
#: harder than adding a route.
UNGUARDED_BY_DESIGN = {
    # The sign-in callback's bootstrap: it mints the identity everything else
    # needs, so it cannot require one.
    ("POST", "/api/users"),
    # Its own operator token, disabled by default (D-67).
    ("POST", "/admin/reset-seed"),
    # A webhook has no session to hold a role on. It is authenticated by an
    # HMAC signature over the raw body instead, and refuses outright when no
    # secret is configured - so the bar is higher here, not lower.
    ("POST", "/api/ingest/github"),
}


class TestTheGuardCannotBeForgotten:
    def test_every_write_route_is_behind_the_guard(self):
        """The structural guarantee, in the spirit of `test_core_purity`. A
        per-route decorator is one commit away from a new write endpoint
        nobody annotated, and that failure is silent - the endpoint works, for
        everybody. This fails loudly instead."""
        unguarded = set()
        for path, route in _api_routes(app.router):
            for method in route.methods:
                if method in ("GET", "HEAD", "OPTIONS"):
                    continue
                if (method, path) in UNGUARDED_BY_DESIGN:
                    continue
                if not _is_guarded(route):
                    unguarded.add(f"{method} {path}")
        assert not unguarded, (
            "these routes can change something and no role guard runs on "
            f"them: {sorted(unguarded)}"
        )

    def test_the_read_exemptions_all_name_real_routes(self):
        """A stale entry in `READS_THAT_POST` is a hole with a comment next to
        it - a route renamed out from under it silently becomes guarded again,
        or worse, a typo leaves a write permanently exempt."""
        real = {
            (method, path)
            for path, route in _api_routes(app.router)
            for method in route.methods
        }
        assert READS_THAT_POST <= real, READS_THAT_POST - real
        assert OWNER_ONLY <= real, OWNER_ONLY - real

    def test_no_exemption_is_a_workflow_write(self):
        """`apply` and the authoring routes must never appear on the read
        list, whatever else does."""
        exempt_paths = {path for _, path in READS_THAT_POST}
        assert "/api/scenarios/{scenario_id}/apply" not in exempt_paths
        assert not any(
            path.endswith(("/tasks", "/dependencies", "/resources",
                           "/constraints", "/versions/seal"))
            for path in exempt_paths
        )


# ---------------------------------------------------------------------------
# The routes that are not project-scoped
# ---------------------------------------------------------------------------


class TestUnscopedWrites:
    async def test_creating_a_domain_needs_an_identity(
        self, client, authenticating
    ):
        body = {"key": f"d-{uuid.uuid4().hex[:8]}", "name": "Anonymous domain"}
        assert (
            await client.post("/api/domains", json=body)
        ).status_code == 403

    async def test_a_signed_in_user_may_create_a_domain(
        self, client, world, authenticating
    ):
        """A domain has no project and therefore no role to hold. The bar is
        being somebody, which is the same bar as creating a project."""
        body = {"key": f"d-{uuid.uuid4().hex[:8]}", "name": "Someone's domain"}
        r = await client.post(
            "/api/domains", json=body, headers=via_proxy(world.owner)
        )
        assert r.status_code == 201

    async def test_resetting_the_seed_needs_the_admin_token_once_authenticated(
        self, client, world, authenticating, monkeypatch
    ):
        """`POST /api/seed/reset` is `/admin/reset-seed` without the token -
        the same destruction through a second door. It stays open for local
        development and follows D-67 the moment a deployment authenticates.

        Being signed in is not enough, which is the point: no ordinary user
        should be able to drop every project on the instance.
        """
        signed_in = via_proxy(world.owner)

        monkeypatch.setattr(settings, "ADMIN_TOKEN", "")
        r = await client.post("/api/seed/reset", headers=signed_in)
        assert r.status_code == 403
        assert "ADMIN_TOKEN" in r.json()["detail"]

        monkeypatch.setattr(settings, "ADMIN_TOKEN", "the-real-token")
        r = await client.post(
            "/api/seed/reset",
            headers={**signed_in, "X-Admin-Token": "guess"},
        )
        assert r.status_code == 401

    async def test_an_anonymous_seed_reset_never_reaches_the_token_check(
        self, client, authenticating
    ):
        r = await client.post("/api/seed/reset")
        assert r.status_code == 403
        assert r.json()["detail"]["reason"] == "not_signed_in"
