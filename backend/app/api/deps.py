"""
Who may do what.

`identity.py` answers "who is asking". This module answers "may they", and the
two are deliberately separate: not knowing who someone is never raises, and
refusing them always does.

**One switch.** Everything here is a no-op unless `PROXY_SHARED_SECRET` is
configured. With no secret there is no trustworthy identity to enforce against
- anyone can send any `X-User-Id` - so enforcing a role would be theatre, and
the open behaviour that the existing suite is written against is preserved
exactly. With a secret, `ProjectMember.role` stops being advisory.

**Three roles, and the line is "does this change the workflow".**

* `viewer` may read, and may ask questions: analyze, risk, optimize, explain,
  interpret, evaluate a scenario, diff it, run a what-if. None of those change
  workflow state; the most any of them writes is an `AnalysisRun` or a
  throwaway `Scenario` row, which is scratch paper, not the plan. A seat that
  cannot ask "what happens if this slips" is not a read-only seat, it is a
  screenshot.
* `editor` may additionally author and apply - every task, dependency,
  resource, assignment and constraint write, sealing a version, creating and
  mutating scenarios, and `apply`, which is the one endpoint that writes a new
  workflow version.
* `owner` may additionally change who is on the project.

**Why one router-level guard rather than a decorator per route.** A
`Depends(require_editor)` on each write route is one `git commit` away from a
new write route that nobody remembered to annotate, and the failure is silent:
the endpoint works, for everybody. So the guard is attached once to each
router, it reads the request's method and route template, and its default is
to *refuse*. Everything that is not a `GET` needs `editor` unless it appears
in `READS_THAT_POST` below - so adding a write route inherits the guard for
free, and adding a read that happens to be a POST is a deliberate, reviewable
line in this file. `test_auth.py` asserts that every non-GET route in the
application is either behind this guard or on a short, explicit exemption
list, so a whole new *router* cannot slip past either.

**A signed-in non-member gets reads, not a 403.** This instance has never been
multi-tenant: `GET /api/projects` lists everything to everybody, and a test
from Phase 9 asserts that two people see the same project. Restricting reads
to members would be a different product, and a much larger change than the one
asked for. So visibility stays open and *authorship* is what is protected: an
anonymous or non-member request may read anything and change nothing. The
rejected alternative - 403 on read for a non-member - would also have made
"share this link with a colleague" stop working, which is the main thing the
sharing story is for.
"""
from __future__ import annotations

import hmac
import uuid

from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.identity import current_user
from backend.app.db import get_db
from backend.app.models import Project, ProjectMember, Scenario, User
from backend.app.settings import settings

#: owner > editor > viewer. Anything unknown ranks below viewer, so a role
#: typo in the database fails closed.
ROLE_RANK: dict[str, int] = {"viewer": 1, "editor": 2, "owner": 3}

#: Not a member, or nobody at all. Reported in the 403 body so the reason is
#: readable without a lookup.
NO_ROLE = "none"
ANONYMOUS = "anonymous"


def is_public_viewer(who: User | None) -> bool:
    """Is this the public read-only guest?

    The guest is a real user row (created through `POST /api/users` like
    anyone else) that `settings.PUBLIC_VIEWER_EMAIL` names. It exists so a
    public demo can be *read* without a Google account, which matters when
    the OAuth app is in Testing mode and an unlisted visitor would otherwise
    see nothing at all.

    Naming it here rather than adding a column keeps it a configuration fact
    rather than a schema one, and emptying the setting disables the concept
    outright - no row is then a guest, and the identity becomes an ordinary
    user like any other.
    """
    configured = (settings.PUBLIC_VIEWER_EMAIL or "").strip().lower()
    if not configured or who is None:
        return False
    return (who.email or "").strip().lower() == configured

#: Non-GET routes that do not change anything a viewer should be protected
#: from - reads and evaluations that happen to need a request body. Keyed by
#: `(method, route template)`. This is the *only* way to be exempt: a write
#: route that is not listed here is guarded whether or not anyone remembered.
READS_THAT_POST: frozenset[tuple[str, str]] = frozenset(
    {
        # Capability 1: analysis is a pure read over an immutable snapshot.
        ("POST", "/api/projects/{project_id}/analyze"),
        ("POST", "/api/projects/{project_id}/risk"),
        ("POST", "/api/projects/{project_id}/requirement-impact"),
        # Capability 3: asking a hypothetical. `evaluate` writes an
        # AnalysisRun, `what-if` may keep a Scenario; neither touches the
        # project's workflow version, which is the thing a role protects.
        ("POST", "/api/scenarios/{scenario_id}/evaluate"),
        ("POST", "/api/projects/{project_id}/what-if"),
        # Capability 4: the optimizer proposes; applying is a separate,
        # guarded call. Persisted candidates are scenarios, not versions.
        ("POST", "/api/projects/{project_id}/optimize"),
        # The AI layer has no write path at all (D-51 enforces it).
        ("POST", "/api/projects/{project_id}/interpret"),
        ("POST", "/api/projects/{project_id}/explain"),
        # Phase 11. A replay runs over an immutable snapshot exactly like a
        # scenario does - it never writes a workflow version, and the stored
        # base hash is asserted unchanged by `test_stream.py`. Its lifecycle
        # verbs are how you *watch*, so they sit with the reads: a seat that
        # cannot pause the thing it is watching is not a read-only seat.
        ("POST", "/api/projects/{project_id}/replay"),
        ("POST", "/api/projects/{project_id}/replay/control"),
        ("DELETE", "/api/projects/{project_id}/replay"),
        # Capability 2 with a distribution behind it. Same shape as `risk`:
        # sampling reads the snapshot and returns numbers.
        ("POST", "/api/projects/{project_id}/forecast"),
        # Asking what a re-worded requirement would cost. The impact report
        # mutates nothing and the replan comes back unapplied, so this is the
        # `what-if` argument in a different vocabulary. `.../apply` is
        # deliberately absent: that one writes a version and stays guarded.
        ("POST", "/api/projects/{project_id}/requirements/{requirement_key}/change"),
        ("POST", "/api/projects/{project_id}/requirements/{requirement_key}/compare"),
    }
)

#: Changing who is on a project is the one thing an editor may not do. There
#: is no delete-project endpoint in this application; if one is ever added it
#: belongs here rather than in `READS_THAT_POST`.
OWNER_ONLY: frozenset[tuple[str, str]] = frozenset(
    {
        ("POST", "/api/projects/{project_id}/members"),
        ("DELETE", "/api/projects/{project_id}/members/{user_id}"),
    }
)

_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

#: "This route names a project or scenario that does not exist." The guard
#: stands aside so the route itself answers 404 - a 403 for a thing that is
#: not there would send the caller looking for a permission problem.
_UNKNOWN = object()


# ---------------------------------------------------------------------------
# The refusal
# ---------------------------------------------------------------------------


_SIGN_IN = (
    "Sign in and retry. If you are calling this API directly, note that the "
    "identity header is only honoured when it arrives through the "
    "authenticating proxy."
)


def _not_signed_in(attempted: str) -> HTTPException:
    """A 403 for a route that has no project to hold a role on."""
    return HTTPException(
        status_code=403,
        detail={
            "reason": "not_signed_in",
            "attempted": attempted,
            "project_id": None,
            "your_role": ANONYMOUS,
            "required_role": "any signed-in user",
            "message": (
                f"{attempted} needs a signed-in identity, and this request "
                f"has none. {_SIGN_IN}"
            ),
        },
    )


def _read_only_guest(attempted: str) -> HTTPException:
    """A 403 for the public guest on a route with no project to hold a role on.

    Distinct from `_not_signed_in` because that one says "this request has no
    identity", which would be false: the guest has one, it is simply held to
    a read-only bar. Telling a judge "you are not signed in" while the header
    shows them signed in as a guest is the kind of small lie that makes a
    reader stop believing the rest of the screen.
    """
    return HTTPException(
        status_code=403,
        detail={
            "reason": "read_only_guest",
            "attempted": attempted,
            "project_id": None,
            "your_role": "public read-only guest",
            "required_role": "any signed-in user",
            "message": (
                f"{attempted} is not available to the public read-only guest. "
                "Reading, analysing, risk-scoring, optimising and asking a "
                "what-if all work as they do for anyone else; creating and "
                "changing things needs an account. Sign in with Google to do "
                "this."
            ),
        },
    )


def _forbidden(attempted: str, held: str, required: str, project_id) -> HTTPException:
    """A 403 whose `detail` explains itself.

    `main.py` wraps this into `{error, detail, hint, request_id}` and passes
    the detail through untouched (D-63), and its `HINTS[403]` was written for
    the admin route. So the detail carries the whole reason - what was tried,
    what the caller holds, what it needs, and what to do next - rather than
    relying on the hint to complete the sentence.
    """
    if held == ANONYMOUS:
        because, what_to_do = "this request is not signed in", _SIGN_IN
    elif held == NO_ROLE:
        because = "you are not a member of this project"
        what_to_do = f"Ask an owner of this project to add you as an {required}."
    else:
        because = f"your role on this project is {held}"
        what_to_do = (
            f"Ask an owner of this project to change your role to {required}."
        )

    return HTTPException(
        status_code=403,
        detail={
            "reason": "insufficient_role",
            "attempted": attempted,
            "project_id": str(project_id) if project_id else None,
            "your_role": held,
            "required_role": required,
            "message": (
                f"{attempted} requires the {required} role on this project, "
                f"and {because}. {what_to_do}"
            ),
        },
    )


# ---------------------------------------------------------------------------
# Working out what the request is asking for
# ---------------------------------------------------------------------------


def route_template(request: Request) -> str:
    """The route's path template, e.g. `/api/projects/{project_id}/tasks`.

    FastAPI puts the matched route in the ASGI scope; the fallback covers the
    day it stops doing so, because a guard that silently starts classifying
    every route by its concrete URL would stop matching and fail open.
    """
    route = request.scope.get("route")
    path = getattr(route, "path", None)
    if path:
        return path
    endpoint = request.scope.get("endpoint")
    if endpoint is not None:
        for candidate in request.app.routes:
            if getattr(candidate, "endpoint", None) is endpoint:
                return candidate.path
    return request.url.path


async def _project_of(request: Request, db: AsyncSession):
    """The project this request acts on.

    `None` when the route is not project-scoped (creating a project, creating
    a domain, seeding), `_UNKNOWN` when it names one that does not exist.
    """
    params = request.path_params
    raw = params.get("project_id")
    if raw is not None:
        try:
            project_id = uuid.UUID(str(raw))
        except ValueError:
            return _UNKNOWN
        found = (
            await db.execute(select(Project.id).where(Project.id == project_id))
        ).scalar_one_or_none()
        return found if found is not None else _UNKNOWN

    raw = params.get("scenario_id")
    if raw is not None:
        try:
            scenario_id = uuid.UUID(str(raw))
        except ValueError:
            return _UNKNOWN
        found = (
            await db.execute(
                select(Scenario.project_id).where(Scenario.id == scenario_id)
            )
        ).scalar_one_or_none()
        return found if found is not None else _UNKNOWN

    return None


async def role_on_project(
    db: AsyncSession, project_id: uuid.UUID, who: User | None
) -> str:
    """`owner` / `editor` / `viewer`, or `none`, or `anonymous`."""
    if who is None:
        return ANONYMOUS
    # The public guest holds `viewer` on every project. This grants nothing:
    # under the rules below, `viewer`, `none` and `anonymous` are already
    # identical for every route - reads and evaluations are open to all three
    # and every write needs `editor`. What it changes is that a refusal names
    # a real role the reader can act on ("your role on this project is
    # viewer") instead of "you are not a member of this project", which would
    # send a judge looking for an invitation that is not the problem.
    if is_public_viewer(who):
        return "viewer"
    role = (
        await db.execute(
            select(ProjectMember.role).where(
                ProjectMember.project_id == project_id,
                ProjectMember.user_id == who.id,
            )
        )
    ).scalar_one_or_none()
    return role or NO_ROLE


# ---------------------------------------------------------------------------
# The guard
# ---------------------------------------------------------------------------


async def enforce_project_role(
    request: Request,
    db: AsyncSession = Depends(get_db),
    who: User | None = Depends(current_user),
) -> None:
    """Attached once per router; refuses by default on anything but a read.

    Silent when `PROXY_SHARED_SECRET` is unset, which is the whole
    compatibility story in one line.
    """
    if not settings.PROXY_SHARED_SECRET:
        return

    method = request.method.upper()
    if method in _SAFE_METHODS:
        return

    template = route_template(request)
    signature = (method, template)
    if signature in READS_THAT_POST:
        return

    attempted = f"{method} {template}"
    required = "owner" if signature in OWNER_ONLY else "editor"

    project_id = await _project_of(request, db)
    if project_id is _UNKNOWN:
        # The route will answer 404. Refusing here would report a permission
        # problem for something that does not exist.
        return

    if project_id is None:
        # Not project-scoped: creating a project, creating a domain, seeding.
        # There is no role to hold, so the bar is simply being somebody -
        # otherwise a project is created that nobody owns and nobody can
        # subsequently manage the members of.
        if who is None:
            raise _not_signed_in(attempted)
        # ...but "somebody" cannot include the public read-only guest. These
        # are the only writes a role cannot gate, because there is no project
        # to hold a role on - so without this line, handing a guest an
        # identity to *read* with would also hand every anonymous visitor on
        # a public URL the ability to create projects and domains. This is
        # the one place the guest needs naming; the role ranking below is
        # untouched.
        if is_public_viewer(who):
            raise _read_only_guest(attempted)
        return

    held = await role_on_project(db, project_id, who)
    if ROLE_RANK.get(held, 0) < ROLE_RANK[required]:
        raise _forbidden(attempted, held, required, project_id)


async def require_signed_in(
    who: User | None = Depends(current_user),
) -> User | None:
    """An identity, with no project in sight.

    Only for routes that have no project to hold a role on. Like everything
    else here, it is a no-op with no `PROXY_SHARED_SECRET` configured.
    """
    if settings.PROXY_SHARED_SECRET:
        if who is None:
            raise _not_signed_in("This request")
        if is_public_viewer(who):
            raise _read_only_guest("This request")
    return who


def destructive_operator_only(x_admin_token: str = Header(default="")) -> None:
    """`POST /api/seed/reset` drops every project and reloads the seed.

    It is `POST /admin/reset-seed` without the token - a second, unguarded
    door to the same destruction, and it predates the admin route. Closing it
    outright would break the local reset that `docs/PROGRESS.md` points
    developers at, so it follows the same rule as everything else in this
    module: unchanged when no `PROXY_SHARED_SECRET` is configured, and behind
    `ADMIN_TOKEN` on the same terms as `/admin/reset-seed` (D-67) the moment a
    deployment configures one.
    """
    if not settings.PROXY_SHARED_SECRET:
        return
    if not settings.ADMIN_TOKEN:
        raise HTTPException(
            status_code=403,
            detail=(
                "Resetting the seed is disabled: this deployment authenticates "
                "requests but configures no ADMIN_TOKEN. Set one to enable it."
            ),
        )
    if not hmac.compare_digest(x_admin_token, settings.ADMIN_TOKEN):
        raise HTTPException(
            status_code=401, detail="Wrong or missing X-Admin-Token."
        )


#: The convenience the routers actually import.
project_role_guard = Depends(enforce_project_role)
