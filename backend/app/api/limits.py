"""
Bounded work.

Three endpoints do real computation - analyze, simulate, optimize - and each
runs under an explicit ceiling. Exceeding it returns a structured, explained
503 rather than holding a connection open until something upstream gives up.

Two honest notes about what this can and cannot do:

* The optimizer's **real** budget is the `should_stop` callable injected into
  the pure search (D-41), which stops it between candidates and returns the
  partial ranked results it already has. That is the mechanism; this is the
  backstop for everything the search cannot see.
* `asyncio.wait_for` cannot interrupt a synchronous CPU-bound call. It frees
  the *request* on time, and the in-flight computation finishes on its own -
  it is pure, finite and holds no locks, so it costs CPU and nothing else.
  A timeout here means "this is pathological", not "this is routine": the
  seeded workflows analyze in about 20ms against a 20s ceiling.
"""
from __future__ import annotations

import asyncio
from typing import Awaitable, TypeVar

T = TypeVar("T")


class Timeout(TimeoutError):
    """Raised when a bounded operation exceeds its budget.

    A `TimeoutError` subclass so the handler in `main.py` catches it and
    renders `{error, detail, hint}` with a 503.
    """


async def bounded(
    work: Awaitable[T], seconds: float, what: str, advice: str = ""
) -> T:
    """Run `work` under a deadline, or raise `Timeout` explaining what gave up.

    The message names the operation and the budget, because "timeout" on its
    own tells the user nothing they can act on.
    """
    try:
        return await asyncio.wait_for(asyncio.shield(_wrap(work)), timeout=seconds)
    except asyncio.TimeoutError:
        raise Timeout(
            f"{what} exceeded its {seconds:.0f}s budget."
            + (f" {advice}" if advice else "")
        ) from None


async def _wrap(work: Awaitable[T]) -> T:
    # `shield` needs a task; wrapping keeps the shielded computation from
    # being cancelled mid-transaction when the deadline fires, which on a
    # write path would leave the session in an undefined state.
    return await work
