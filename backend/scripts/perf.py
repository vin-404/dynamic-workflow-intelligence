"""
Measure the endpoints that have a performance floor, warm, over HTTP.

    .venv/Scripts/python.exe -m backend.scripts.perf

Numbers, not vibes: if something is slow the answer is to profile it, not to
put a cache in front of it. The budget section at the end proves the optimizer
returns *partial ranked results* when it runs out of time rather than failing -
which is the behaviour that matters, and the reason the search takes an
injected `should_stop` instead of reading a clock (D-41).
"""
import asyncio
import statistics
import time

from httpx import ASGITransport, AsyncClient

from backend.app.main import app

CAMPUS = "00000000-0000-0000-0000-000000000001"
BATTERY = "00000000-0000-0000-0000-000000000002"


async def timed(client, label, method, path, body=None, runs=12):
    # One warm-up: the first call pays for connection and import cost, and the
    # floor in the brief is a warm one.
    await client.request(method, path, json=body or {})
    samples = []
    for _ in range(runs):
        started = time.perf_counter()
        response = await client.request(method, path, json=body or {})
        samples.append((time.perf_counter() - started) * 1000)
        assert response.status_code == 200, (path, response.status_code)
    samples.sort()
    print(
        f"{label:<44} median {statistics.median(samples):7.1f}ms   "
        f"p95 {samples[int(len(samples) * 0.95) - 1]:7.1f}ms   "
        f"max {samples[-1]:7.1f}ms"
    )
    return statistics.median(samples)


async def main():
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://perf", timeout=60
        ) as c:
            print("\nwarm, over HTTP, in-process ASGI, SQLite\n" + "-" * 92)
            await timed(c, "analyze  campus (17 tasks, tier 2)", "POST",
                        f"/api/projects/{CAMPUS}/analyze")
            await timed(c, "analyze  battery (12 tasks, tier 0)", "POST",
                        f"/api/projects/{BATTERY}/analyze")

            scenario = (await c.post(
                f"/api/projects/{CAMPUS}/scenarios",
                json={"name": "perf", "mutations": [
                    {"kind": "TASK_DELAY_ADD",
                     "payload": {"key": "T03", "extra_days": 5}}
                ]},
            )).json()
            await timed(c, "simulate campus (1 mutation, full diff)", "POST",
                        f"/api/scenarios/{scenario['id']}/evaluate")

            await timed(
                c, "optimize campus (40 candidates, persisted)", "POST",
                f"/api/projects/{CAMPUS}/optimize",
                {"budget": {"max_candidates": 40, "max_seconds": 20}},
                runs=5,
            )
            await timed(
                c, "optimize campus (40 candidates, no persist)", "POST",
                f"/api/projects/{CAMPUS}/optimize",
                {"budget": {"max_candidates": 40, "max_seconds": 20},
                 "persist_candidates": False},
                runs=5,
            )
            await timed(
                c, "optimize battery, aggressive (60 candidates)", "POST",
                f"/api/projects/{BATTERY}/optimize",
                {"aggressive": True, "persist_candidates": False,
                 "budget": {"max_candidates": 60, "max_seconds": 20}},
                runs=5,
            )
            await timed(c, "ready (one trivial query)", "GET", "/ready")

            # The budget has to actually bound it, not just be echoed back.
            print("\nthe budget, honoured\n" + "-" * 92)
            for seconds in (0.1, 0.3, 1.0):
                started = time.perf_counter()
                body = (await c.post(
                    f"/api/projects/{CAMPUS}/optimize",
                    json={"budget": {"max_candidates": 500,
                                     "max_seconds": seconds},
                          "persist_candidates": False},
                )).json()
                elapsed = (time.perf_counter() - started) * 1000
                print(
                    f"max_seconds={seconds:<5} -> {elapsed:7.1f}ms, "
                    f"{len(body['candidates'])} ranked candidates, "
                    f"stopped_early={body['stopped_early']}, "
                    f"{body['stop_reason']}"
                )


if __name__ == "__main__":
    asyncio.run(main())
