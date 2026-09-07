"""
Who is asking, and whether we believe it.

Authentication does not live here. It lives in the Next.js server in front of
this API: a person signs in with Google there, and the server proxies `/api/*`
upstream with two headers attached - `X-User-Id`, the backend `User.id` for
that Google account, and `X-Proxy-Secret`, a shared secret only the proxy
knows. Any such headers the browser sent are stripped before the proxy adds
its own. This module is the other half of that handshake, and nothing more:
there is no login route here, no password, no session and no token issued by
this service.

The behaviour depends on one setting, and only one:

* **`PROXY_SHARED_SECRET` unset** (a fresh clone, local development, the test
  suite): `X-User-Id` is trusted exactly as it arrives, as it always has been.
  It is an identity, not a credential - it drives `created_by` and the member
  list, nothing is protected by it, and `deps.enforce_project_role` enforces
  nothing. This is the open, single-player configuration.
* **`PROXY_SHARED_SECRET` set** (a real deployment): `X-User-Id` is honoured
  **only** when `X-Proxy-Secret` matches, so calling the API's public URL
  directly with a hand-written `X-User-Id` identifies nobody. That is the
  claim the deployment rests on, and `deps.py` turns the resulting identity
  into an enforced `ProjectMember.role`.

The comparison is `hmac.compare_digest` for the reason D-67 gives: comparing
a secret with `==` leaks its length and its prefix to anyone patient enough
to measure.

`current_user` never raises, in either configuration. An untrusted, missing,
malformed or stale id makes the request *anonymous*; it does not make it an
error. Deciding what an anonymous request may do is `deps.py`'s job, and it
is a separate question from working out who is asking.
"""
from __future__ import annotations

import hmac
import uuid

from fastapi import Depends, Header
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db import get_db
from backend.app.models import User
from backend.app.settings import settings


def proxy_is_trusted(x_proxy_secret: str = Header(default="")) -> bool:
    """Did this request come through the authenticating proxy?

    With no `PROXY_SHARED_SECRET` configured every request is "trusted",
    which is the pre-existing open behaviour stated out loud rather than
    implied: there is no proxy, so there is nothing to distinguish.
    """
    expected = settings.PROXY_SHARED_SECRET
    if not expected:
        return True
    return hmac.compare_digest(x_proxy_secret, expected)


async def current_user(
    x_user_id: str = Header(default=""),
    trusted: bool = Depends(proxy_is_trusted),
    db: AsyncSession = Depends(get_db),
) -> User | None:
    """The identified user, or None.

    Never raises. A header we do not trust, or an id that is missing,
    malformed or stale, is a visitor - somebody who has not signed in, or
    whose identity was wiped by an admin reset. Refusing the request *here*
    would conflate "we do not know who you are" with "you may not do this",
    and only the second of those is an authorization decision.
    """
    if not trusted or not x_user_id:
        return None
    try:
        user_id = uuid.UUID(x_user_id)
    except ValueError:
        return None
    return (
        await db.execute(select(User).where(User.id == user_id))
    ).scalar_one_or_none()
