"""
The public read-only guest.

A Google OAuth app in Testing mode admits only the addresses on its test-user
list, so a hard sign-in wall on a public link shows every other visitor a
Google error page. `PUBLIC_DEMO_VIEWER=1` on the Next.js side makes a visitor
with no session the **public read-only guest** instead of turning them away.

This suite covers the backend half: what that identity may and may not do. The
properties worth asserting are the ones that would be easy to get wrong and
invisible when wrong:

* the guest is a **real user row**, created through the same `POST /api/users`
  upsert a Google user goes through - so it is not a header the API has been
  taught to special-case into existence;
* it can **read and evaluate** everything an ordinary visitor can, because a
  read-only seat that cannot ask a question is a screenshot;
* every project-scoped **mutation** is refused by the same role check that
  refuses a viewer, and the refusal names a real role;
* and the routes a role *cannot* gate - creating a project, a domain, a seed,
  which have no project to hold a role on - are refused too. That is the one
  that would otherwise turn "let strangers read the demo" into "let strangers
  create projects on it", because those routes ask only for *an* identity and
  the guest has one.
* Emptying `PUBLIC_VIEWER_EMAIL` disables the concept: the same row becomes an
  ordinary user again. The guest is configuration, not a schema fact.
"""
from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from backend.app.main import app
from backend.app.settings import settings

SECRET = "a-shared-secret-only-the-proxy-knows"


@pytest_asyncio.fixture(scope="module")
async def client():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c


@pytest_asyncio.fixture(scope="module")
async def world(client):
    """A project owned by somebody, and the guest, both built in the open
    configuration - this is the setup, not the thing under test."""
    previous = settings.PROXY_SHARED_SECRET
    settings.PROXY_SHARED_SECRET = ""
    try:
        owner = (
            await client.post("/api/users", json={"name": "Guest Suite Owner"})
        ).json()

        # The guest goes through the *same* upsert a real person does. This is
        # the whole of how it comes into existence; there is no other path.
        guest = (
            await client.post(
                "/api/users",
                json={
                    "name": "Read-only guest",
                    "email": settings.PUBLIC_VIEWER_EMAIL,
                },
            )
        ).json()

        project = (
            await client.post(
                "/api/projects",
                json={
                    "name": "Public demo project",
                    "start_date": "2026-03-03",
                    "today_day": 0,
                },
                headers={"X-User-Id": owner["id"]},
            )
        ).json()

        r = await client.post(
            f"/api/projects/{project['id']}/tasks",
            json={"key": "G1", "name": "Something a guest must not move",
                  "effort": 3.0},
        )
        assert r.status_code == 201, r.text

        r = await client.post(
            f"/api/projects/{project['id']}/scenarios",
            json={
                "name": "A guest may evaluate this",
                "mutations": [
                    {"kind": "TASK_DELAY_ADD",
                     "payload": {"key": "G1", "extra_days": 2}}
                ],
            },
        )
        assert r.status_code == 201, r.text
        scenario_id = r.json()["id"]
    finally:
        settings.PROXY_SHARED_SECRET = previous

    from types import SimpleNamespace

    return SimpleNamespace(
        owner=owner,
        guest=guest,
        project_id=project["id"],
        scenario_id=scenario_id,
    )


@pytest.fixture
def authenticating(monkeypatch):
    """An instance behind the proxy. `settings` is built at import time, so the
    live object is what every dependency actually reads."""
    monkeypatch.setattr(settings, "PROXY_SHARED_SECRET", SECRET)
    return SECRET


def via_proxy(person) -> dict[str, str]:
    """Headers as the Next.js proxy sends them for the guest."""
    return {
        "X-User-Id": person["id"] if isinstance(person, dict) else str(person),
        "X-Proxy-Secret": SECRET,
    }


# ---------------------------------------------------------------------------
# It is a real identity, not a special case
# ---------------------------------------------------------------------------


class TestTheGuestIsARealUser:
    async def test_it_is_created_by_the_ordinary_upsert(self, client, world):
        """No separate endpoint, no seeded fixture, no header the API invents
        a user from. The row exists because somebody POSTed to /api/users."""
        r = await client.get(f"/api/users/{world.guest['id']}")
        assert r.status_code == 200
        assert r.json()["email"] == settings.PUBLIC_VIEWER_EMAIL

    async def test_the_upsert_is_idempotent(self, client, world):
        """Every Next.js instance calls this on its first guest request, so
        the second call must return the same id rather than a second row."""
        again = (
            await client.post(
                "/api/users",
                json={"name": "Read-only guest",
                      "email": settings.PUBLIC_VIEWER_EMAIL},
            )
        ).json()
        assert again["id"] == world.guest["id"]

    async def test_it_owns_nothing(self, client, world):
        """A guest that had been made a member of something would be able to
        change it. It is a member of nothing, by construction."""
        body = (
            await client.get(f"/api/users/{world.guest['id']}/projects")
        ).json()
        assert body["projects"] == []


# ---------------------------------------------------------------------------
# What it may do
# ---------------------------------------------------------------------------


class TestWhatTheGuestMayDo:
    async def test_it_may_read(self, client, world, authenticating):
        headers = via_proxy(world.guest)
        for path in (
            "/api/projects",
            f"/api/projects/{world.project_id}",
            f"/api/projects/{world.project_id}/workflow",
            f"/api/projects/{world.project_id}/versions",
            f"/api/projects/{world.project_id}/members",
            f"/api/projects/{world.project_id}/risk",
            f"/api/projects/{world.project_id}/scenarios",
        ):
            r = await client.get(path, headers=headers)
            assert r.status_code == 200, f"{path} -> {r.status_code}"

    async def test_it_may_ask_questions(self, client, world, authenticating):
        """Analyze, risk, optimize, evaluate, what-if. These are the product;
        a guest who cannot run them is looking at a screenshot."""
        headers = via_proxy(world.guest)
        pid = world.project_id
        assert (
            await client.post(f"/api/projects/{pid}/analyze", headers=headers)
        ).status_code == 200
        assert (
            await client.post(f"/api/projects/{pid}/risk", headers=headers)
        ).status_code == 200
        assert (
            await client.post(
                f"/api/scenarios/{world.scenario_id}/evaluate", headers=headers
            )
        ).status_code == 200
        assert (
            await client.post(
                f"/api/projects/{pid}/what-if",
                json={
                    "mutations": [
                        {"kind": "TASK_DELAY_ADD",
                         "payload": {"key": "G1", "extra_days": 1}}
                    ]
                },
                headers=headers,
            )
        ).status_code == 200

    async def test_the_numbers_and_the_caveats_are_identical(
        self, client, world, authenticating
    ):
        """The honesty layer is not softened for a guest.

        Nothing about being read-only should change what the analysis claims
        or which limits it states - a guest seeing a friendlier, vaguer
        version of the product would be the worst possible outcome of this
        feature.
        """
        pid = world.project_id
        as_guest = (
            await client.post(
                f"/api/projects/{pid}/risk", headers=via_proxy(world.guest)
            )
        ).json()
        as_owner = (
            await client.post(
                f"/api/projects/{pid}/risk", headers=via_proxy(world.owner)
            )
        ).json()
        # The whole assumptions block, byte for byte - that is where every
        # caveat lives (`disclaimer`, `score_kind`, `monte_carlo_run`,
        # `what_would_make_this_a_probability`, the unavailable-factor note).
        assert as_guest["assumptions"] == as_owner["assumptions"]
        assert as_guest["tasks"] == as_owner["tasks"]
        assert as_guest["band_counts"] == as_owner["band_counts"]
        assert as_guest["tier_reached"] == as_owner["tier_reached"]
        assert as_guest["input_hash"] == as_owner["input_hash"]

        # And named individually, so that deleting one from the payload fails
        # here rather than passing because both sides lost it together.
        caveats = as_guest["assumptions"]
        assert caveats["score_kind"] == "structural_estimate"
        assert caveats["monte_carlo_run"] is False
        assert caveats["disclaimer"]
        assert caveats["what_would_make_this_a_probability"]
        assert caveats["factors_unavailable_note"]


# ---------------------------------------------------------------------------
# What it may not do, and who refuses it
# ---------------------------------------------------------------------------


class TestWhatTheGuestMayNotDo:
    async def test_a_write_is_refused_by_the_role_check(
        self, client, world, authenticating
    ):
        """The refusal comes from `deps.py`, in the standard envelope, and
        names a real role - not a frontend that hid the button."""
        r = await client.post(
            f"/api/projects/{world.project_id}/tasks",
            json={"key": "G9", "name": "Should never exist", "effort": 1.0},
            headers=via_proxy(world.guest),
        )
        assert r.status_code == 403
        body = r.json()
        assert body["error"] == "forbidden"
        detail = body["detail"]
        assert detail["reason"] == "insufficient_role"
        assert detail["your_role"] == "viewer"
        assert detail["required_role"] == "editor"
        assert body["hint"]

    async def test_every_project_scoped_mutation_is_refused(
        self, client, world, authenticating
    ):
        headers = via_proxy(world.guest)
        pid = world.project_id
        attempts = [
            ("POST", f"/api/projects/{pid}/tasks",
             {"key": "G8", "name": "no", "effort": 1.0}),
            ("PATCH", f"/api/projects/{pid}/tasks/G1", {"effort": 99.0}),
            ("DELETE", f"/api/projects/{pid}/tasks/G1", None),
            ("POST", f"/api/projects/{pid}/resources",
             {"key": "r1", "name": "no", "kind": "person", "capacity": 1}),
            ("POST", f"/api/projects/{pid}/versions/seal", None),
            ("POST", f"/api/projects/{pid}/scenarios",
             {"name": "no", "mutations": []}),
            ("POST", f"/api/scenarios/{world.scenario_id}/apply", None),
            ("DELETE", f"/api/scenarios/{world.scenario_id}", None),
            ("POST", f"/api/projects/{pid}/members",
             {"email": "someone@example.com", "name": "no", "role": "editor"}),
        ]
        for method, path, payload in attempts:
            r = await client.request(
                method, path, json=payload, headers=headers
            )
            assert r.status_code == 403, f"{method} {path} -> {r.status_code}"

    async def test_it_may_not_create_a_project(
        self, client, world, authenticating
    ):
        """The hole this feature would otherwise open.

        Creating a project, a domain or a seed has no project to hold a role
        on, so the guard asks only for *an* identity - and the guest has one.
        Without naming the guest, handing it an identity to read with would
        hand every anonymous visitor on a public URL the ability to create
        projects.
        """
        r = await client.post(
            "/api/projects",
            json={"name": "Guest's own", "start_date": "2026-04-04",
                  "today_day": 0},
            headers=via_proxy(world.guest),
        )
        assert r.status_code == 403
        detail = r.json()["detail"]
        assert detail["reason"] == "read_only_guest"
        # Not "you are not signed in": it is, and saying otherwise while the
        # UI shows it signed in as a guest is a small lie in a product whose
        # whole argument is that it does not tell them.
        assert detail["your_role"] == "public read-only guest"
        assert "Sign in" in detail["message"]

    async def test_it_may_not_create_a_domain_or_seed(
        self, client, world, authenticating
    ):
        headers = via_proxy(world.guest)
        r = await client.post(
            "/api/domains",
            json={"key": "guest-domain", "name": "No", "description": "No"},
            headers=headers,
        )
        assert r.status_code == 403, r.text
        assert r.json()["detail"]["reason"] == "read_only_guest"

        r = await client.post("/api/seed", headers=headers)
        assert r.status_code == 403, r.text
        assert r.json()["detail"]["reason"] == "read_only_guest"


# ---------------------------------------------------------------------------
# The switch, and the compatibility default
# ---------------------------------------------------------------------------


class TestTheGuestIsConfiguration:
    async def test_emptying_the_setting_makes_it_an_ordinary_user(
        self, client, world, monkeypatch
    ):
        """The guest is named by configuration, not marked in the schema. With
        no name configured, no row is a guest - so the same identity becomes
        an ordinary user that may create a project."""
        monkeypatch.setattr(settings, "PROXY_SHARED_SECRET", SECRET)
        monkeypatch.setattr(settings, "PUBLIC_VIEWER_EMAIL", "")
        r = await client.post(
            "/api/projects",
            json={"name": "Ordinary again", "start_date": "2026-05-05",
                  "today_day": 0},
            headers=via_proxy(world.guest),
        )
        assert r.status_code == 201, r.text

    async def test_with_no_secret_nothing_is_enforced_for_the_guest_either(
        self, client, world, monkeypatch
    ):
        """The compatibility default (D-83) is not special-cased away. With no
        `PROXY_SHARED_SECRET` the whole authorization layer is a no-op, and
        that has to include this."""
        monkeypatch.setattr(settings, "PROXY_SHARED_SECRET", "")
        r = await client.post(
            f"/api/projects/{world.project_id}/tasks",
            json={"key": "G7", "name": "Open instance", "effort": 1.0},
            headers={"X-User-Id": world.guest["id"]},
        )
        assert r.status_code == 201, r.text

    async def test_the_guest_holds_viewer_and_nothing_more(
        self, client, world, authenticating
    ):
        """`viewer` is what a refusal reports, and it is the ceiling: the
        guest is refused everything an editor may do."""
        r = await client.post(
            f"/api/projects/{world.project_id}/tasks",
            json={"key": "G6", "name": "no", "effort": 1.0},
            headers=via_proxy(world.guest),
        )
        assert r.json()["detail"]["your_role"] == "viewer"
