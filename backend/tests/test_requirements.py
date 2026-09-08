"""
Requirement change as a first-class capability.

The differentiator, and therefore the suite with the most to prove. Four
properties are load-bearing and each has a test that fails loudly if it stops
holding:

* **`must_redo` is not `must_recheck`.** Work that consumed something now wrong
  is separated from work that merely comes after it, and each task carries the
  path that put it in its list.
* **The arithmetic is exact.** Completed work invalidated is counted once as
  lost and once as the cost of doing it again, and unrelated completed work is
  not counted at all.
* **The report mutates nothing.** Asserted on the base version's content hash
  and on the `WorkflowVersion` row count, not on a docstring.
* **The replan is a real scenario.** The existing `evaluate`, `diff` and
  `apply` endpoints accept it unchanged, because there is no second apply path.

The arithmetic fixture is built here rather than reused from `seed.fixtures`,
because the numbers being asserted have to be chosen to make the wrong answer
visible: two completed tasks in the blast radius so a total cannot pass by
accident, one in flight, one merely downstream, and one completed task outside
the blast radius entirely.
"""
from __future__ import annotations

import uuid
from datetime import date

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from backend.app.core.engine.graph import build_graph_from_snapshot
from backend.app.core.engine.staleness import (
    consuming_reasons,
    downstream_reasons,
    stale_report,
    stale_tasks,
)
from backend.app.core.workflow import (
    AssignmentSpec,
    DependencySpec,
    RequirementSpec,
    ResourceSpec,
    TaskSpec,
    TaskStatus,
    WorkflowSnapshot,
)
from backend.app.main import app
from backend.app.models import RequirementRevision, WorkflowVersion
from backend.app.settings import settings

EVENT_PROJECT_ID = "00000000-0000-0000-0000-000000000001"


# ---------------------------------------------------------------------------
# The arithmetic fixture
# ---------------------------------------------------------------------------


def _arithmetic_snapshot() -> WorkflowSnapshot:
    """A workflow whose blast radius has one of everything.

        REQ ----consumed by---- A1 (2d, done)
                                 |  consumes
                                A2 (5d, done)
                                 |  consumes
                                A3 (3d, in_progress)
                                 |  ordering only
                                A4 (1d, not_started)

        B1 (4d, done)   - completed, and nothing to do with REQ

    So: must_redo = A1, A2, A3.  must_recheck = A4.
    Completed and invalid = A1 + A2 = 7 days. B1 is 4 completed days that must
    *not* appear anywhere in the answer, which is the trap this fixture sets.
    """
    return WorkflowSnapshot.build(
        tasks=[
            TaskSpec(key="A1", name="Write the spec", effort=2.0),
            TaskSpec(key="A2", name="Build to the spec", effort=5.0),
            TaskSpec(key="A3", name="Test the build", effort=3.0),
            TaskSpec(key="A4", name="Ship it", effort=1.0),
            TaskSpec(key="B1", name="Unrelated finished work", effort=4.0),
        ],
        dependencies=[
            DependencySpec("A1", "A2", consumes=True),
            DependencySpec("A2", "A3", consumes=True),
            DependencySpec("A3", "A4", consumes=False),
        ],
        resources=[
            ResourceSpec(key="rita", name="Rita"),
            ResourceSpec(key="sam", name="Sam"),
        ],
        assignments=[
            AssignmentSpec("A1", "rita"),
            AssignmentSpec("A2", "rita"),
            AssignmentSpec("A3", "sam"),
            AssignmentSpec("A4", "sam"),
            AssignmentSpec("B1", "rita"),
        ],
        requirements=[
            RequirementSpec(
                key="REQ",
                text="The report is delivered as a PDF",
                version_no=1,
                consumed_by=("A1",),
            ),
            RequirementSpec(
                key="ORPHAN",
                text="Nothing has been built against this yet",
                version_no=1,
                consumed_by=(),
            ),
        ],
        deadline_day=20.0,
    )


_STATUSES = {
    "A1": TaskStatus.DONE,
    "A2": TaskStatus.DONE,
    "A3": TaskStatus.IN_PROGRESS,
    "A4": TaskStatus.NOT_STARTED,
    "B1": TaskStatus.DONE,
}


@pytest_asyncio.fixture(scope="module")
async def client():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c


@pytest_asyncio.fixture(scope="module")
async def arithmetic(client):
    """A project written straight through `versions.write_version`.

    There is no authoring route for requirements or task statuses, and putting
    the fixture in the seed would change numbers other suites assert on. So it
    is written here, once per module, through the same service every other
    write goes through.
    """
    return await _write_project(
        "Requirement arithmetic", _arithmetic_snapshot(), _STATUSES
    )


def _history_snapshot() -> WorkflowSnapshot:
    """A second, smaller project, so the history tests can apply real changes
    without moving the seeded demo project's version pointer under the rest of
    the suite."""
    return WorkflowSnapshot.build(
        tasks=[
            TaskSpec(key="H1", name="Draft the venue plan", effort=2.0),
            TaskSpec(key="H2", name="Book the rooms", effort=3.0),
        ],
        dependencies=[DependencySpec("H1", "H2", consumes=True)],
        resources=[ResourceSpec(key="nina", name="Nina")],
        assignments=[AssignmentSpec("H1", "nina"), AssignmentSpec("H2", "nina")],
        requirements=[
            RequirementSpec(
                key="SPEC",
                text="On-site only, no streaming",
                version_no=1,
                consumed_by=("H1",),
            ),
            RequirementSpec(
                key="UNUSED", text="Nothing reads this", version_no=1,
                consumed_by=(),
            ),
        ],
        deadline_day=12.0,
    )


async def _write_project(name: str, snapshot, statuses) -> dict:
    from backend.app.db import async_session
    from backend.app.models import Project
    from backend.app.services import versions as V

    async with async_session() as db:
        project = Project(
            name=name,
            start_date=date(2026, 3, 2),
            deadline=date(2026, 3, 22),
            today_day=5.0,
        )
        db.add(project)
        await db.flush()
        version = await V.write_version(
            db, project.id, snapshot, statuses=dict(statuses),
            note=f"{name} fixture", is_draft=False,
        )
        project.current_version_id = version.id
        await db.commit()
        return {"project_id": str(project.id), "version_id": str(version.id)}


@pytest_asyncio.fixture(scope="module")
async def historied(client):
    """A project whose requirement really does get changed, twice."""
    project = await _write_project(
        "Requirement history",
        _history_snapshot(),
        {"H1": TaskStatus.DONE, "H2": TaskStatus.NOT_STARTED},
    )
    person = (
        await client.post("/api/users", json={"name": "Historian"})
    ).json()
    headers = {"X-User-Id": person["id"]}
    for text, note in (
        ("On-site only, one overflow room", "Room added"),
        ("On-site and streamed to two overflow rooms", "Streaming added"),
    ):
        r = await client.post(
            f"/api/projects/{project['project_id']}/requirements/SPEC/apply",
            json={"new_text": text, "note": note},
            headers=headers,
        )
        assert r.status_code == 200, r.text
    return {**project, "person": person}


async def _change(client, project_id, key, text, **body):
    r = await client.post(
        f"/api/projects/{project_id}/requirements/{key}/change",
        json={"new_text": text, **body},
    )
    assert r.status_code == 200, r.text
    return r.json()


# ---------------------------------------------------------------------------
# The engine addition, on its own
# ---------------------------------------------------------------------------


class TestStalenessStaysWhatItWas:
    """`stale_tasks` is used by the mutation applier and by the existing
    `requirement-impact` endpoint. It keeps its signature and its answer; the
    new functions sit beside it."""

    def test_stale_tasks_is_unchanged(self):
        G = build_graph_from_snapshot(_arithmetic_snapshot())
        assert stale_tasks(G, {"A1"}) == {
            "must_redo": ["A1", "A2", "A3"],
            "must_recheck": ["A4"],
        }

    def test_stale_report_agrees_with_stale_tasks(self, snapshot):
        """Computed by calling it, so the two can never drift."""
        G = build_graph_from_snapshot(snapshot)
        for req in snapshot.requirements:
            seeds = set(req.consumed_by)
            base = stale_tasks(G, seeds)
            report = stale_report(G, seeds)
            assert report["must_redo"] == base["must_redo"]
            assert report["must_recheck"] == base["must_recheck"]

    def test_every_affected_task_carries_the_path_that_reached_it(self):
        G = build_graph_from_snapshot(_arithmetic_snapshot())
        report = stale_report(G, {"A1"})
        reasons = report["reasons"]
        assert set(reasons) == {"A1", "A2", "A3", "A4"}
        assert reasons["A1"]["via"] == "seed"
        assert reasons["A2"] == {
            "via": "consuming",
            "path": ("A1", "A2"),
            "hops": 1,
            "consumed_from": "A1",
        }
        assert reasons["A3"]["path"] == ("A1", "A2", "A3")
        assert reasons["A4"]["via"] == "downstream"
        assert reasons["A4"]["follows"] == "A3"
        assert reasons["A4"]["final_edge_consumes"] is False

    def test_the_helpers_are_pure_functions_of_the_graph(self):
        G = build_graph_from_snapshot(_arithmetic_snapshot())
        assert consuming_reasons(G, {"A1"}).keys() == {"A1", "A2", "A3"}
        assert downstream_reasons(G, {"A1", "A2", "A3"}).keys() == {"A4"}
        assert consuming_reasons(G, set()) == {}
        # A seed that is not a task at all is reported, not crashed on.
        assert stale_report(G, {"NOPE"})["seeds_not_in_graph"] == ["NOPE"]


# ---------------------------------------------------------------------------
# 1. Invalidated completed work is counted correctly
# ---------------------------------------------------------------------------


class TestWastedEffortArithmetic:
    @pytest_asyncio.fixture
    async def report(self, client, arithmetic):
        return await _change(
            client, arithmetic["project_id"], "REQ",
            "The report is delivered as an interactive dashboard",
        )

    def test_must_redo_and_must_recheck_are_separated(self, report):
        assert [r["key"] for r in report["must_redo"]] == ["A1", "A2", "A3"]
        assert [r["key"] for r in report["must_recheck"]] == ["A4"]

    def test_each_task_says_why_it_is_in_its_list(self, report):
        by_key = {r["key"]: r for r in report["must_redo"]}
        assert by_key["A1"]["reason"]["via"] == "seed"
        assert by_key["A2"]["reason"]["consumed_from"] == "A1"
        assert by_key["A3"]["reason"]["path"] == ["A1", "A2", "A3"]
        assert "consumed output from A2" in by_key["A3"]["reason"]["sentence"]
        recheck = report["must_recheck"][0]
        assert recheck["reason"]["via"] == "downstream"
        assert "nothing it consumed is known to be wrong" in (
            recheck["reason"]["sentence"]
        )

    def test_wasted_days_counts_completed_work_only(self, report):
        w = report["wasted_effort"]
        # A1 (2d done) + A2 (5d done). A3 is in flight and A4 is only
        # downstream, so neither is wasted.
        assert w["wasted_days"] == 7.0
        assert w["completed_task_count"] == 2
        assert w["in_flight_days"] == 3.0
        assert w["not_yet_started_days"] == 0.0

    def test_redoing_costs_the_effort_a_second_time(self, report):
        w = report["wasted_effort"]
        assert w["redo_cost_days"] == 7.0
        assert w["additional_effort_days"] == 7.0
        assert "7d of completed work invalidated + 7d to redo it = 14d" in (
            w["arithmetic"]
        )

    def test_the_arithmetic_is_on_the_row_not_only_in_the_total(self, report):
        rows = {r["key"]: r for r in report["wasted_effort"]["rows"]}
        assert rows["A1"]["wasted_days"] == 2.0
        assert rows["A1"]["redo_days"] == 2.0
        assert "2d already spent is now void" in rows["A1"]["arithmetic"]
        assert rows["A2"]["wasted_days"] == 5.0
        assert rows["A3"]["wasted_days"] == 0.0
        assert rows["A3"]["counts_as_wasted"] is False
        assert "none of it is counted as wasted" in rows["A3"]["arithmetic"]
        assert sum(r["wasted_days"] for r in rows.values()) == 7.0

    def test_completed_work_outside_the_blast_radius_is_not_counted(self, report):
        """B1 is four finished days that have nothing to do with REQ. A total
        that swept up every completed task would read 11 instead of 7."""
        keys = {r["key"] for r in report["must_redo"]}
        assert "B1" not in keys
        assert report["wasted_effort"]["blast_radius_effort_days"] == 10.0

    def test_blast_radius_effort_is_the_three_redo_tasks(self, report):
        assert report["wasted_effort"]["blast_radius_effort_days"] == 2 + 5 + 3
        assert report["blast_radius"]["must_redo_count"] == 3
        assert report["blast_radius"]["must_recheck_count"] == 1

    def test_who_needs_to_know_is_grouped_by_resource(self, report):
        groups = {
            g["resource_key"]: g
            for g in report["who_needs_to_know"]["by_resource"]
        }
        assert set(groups) == {"rita", "sam"}
        assert groups["rita"]["completed_work_lost_days"] == 7.0
        assert groups["rita"]["redo_days"] == 7.0
        assert {r["key"] for r in groups["rita"]["must_redo"]} == {"A1", "A2"}
        assert "loses 7 day(s) of completed work (A1, A2)" in (
            groups["rita"]["what_they_lose"]
        )
        # Sam has work in the blast radius but has finished none of it.
        assert groups["sam"]["completed_work_lost_days"] == 0.0
        assert [r["key"] for r in groups["sam"]["must_recheck"]] == ["A4"]

    def test_the_schedule_impact_is_reported_with_its_caveat(self, report):
        s = report["schedule_impact"]
        assert s["is_probability"] is False
        assert s["deadline_survives"] in (True, False)
        assert s["projected_end_date_before"]
        # This scheduler gives finished work its full duration, so re-opening
        # it need not move a date. A zero here must never read as "free".
        if not s["delta_days"]:
            assert s["rework_shows_as_calendar_slip"] is False
            assert "not the change being free" in s["caveat"]
            assert "7 day(s) of effort have to be spent again" in s["caveat"]

    def test_the_headline_leads_with_the_cost(self, report):
        assert "3 task(s) invalid across 2 owner(s)" in report["statement"]
        assert "7 day(s) of completed work lost" in report["statement"]
        assert report["statement"].startswith("Assuming the new wording")


# ---------------------------------------------------------------------------
# 2. A change that touches nothing
# ---------------------------------------------------------------------------


class TestAChangeThatTouchesNothing:
    @pytest_asyncio.fixture
    async def report(self, client, arithmetic):
        return await _change(
            client, arithmetic["project_id"], "ORPHAN",
            "Still nothing has been built against this",
        )

    def test_it_is_a_well_formed_report_not_an_error(self, report):
        assert report["no_impact"] is True
        assert report["must_redo"] == []
        assert report["must_recheck"] == []
        assert report["blast_radius"]["must_redo_count"] == 0
        assert report["who_needs_to_know"]["by_resource"] == []
        assert report["findings"]["created"] == []

    def test_every_number_is_zero_rather_than_absent(self, report):
        w = report["wasted_effort"]
        assert w["wasted_days"] == 0.0
        assert w["redo_cost_days"] == 0.0
        assert w["additional_effort_days"] == 0.0
        assert w["blast_radius_effort_days"] == 0.0
        assert w["rows"] == []
        assert report["schedule_impact"]["delta_days"] == 0.0

    def test_it_says_so_in_a_sentence(self, report):
        assert "Nothing consumes ORPHAN" in report["statement"]
        assert "That is a real answer, not an empty one" in report["statement"]

    def test_it_still_carries_the_assumptions_and_the_replan(self, report):
        assert report["assumptions"]["material_change_is_a_human_judgement"]
        assert report["replan"]["scenario_id"]


# ---------------------------------------------------------------------------
# 3. The report mutates nothing
# ---------------------------------------------------------------------------


class TestTheReportMutatesNothing:
    async def _hash_and_versions(self, project_id):
        from backend.app.db import async_session

        async with async_session() as db:
            rows = (
                await db.execute(
                    select(WorkflowVersion.id, WorkflowVersion.content_hash)
                    .where(WorkflowVersion.project_id == uuid.UUID(project_id))
                    .order_by(WorkflowVersion.version_no)
                )
            ).all()
        return {str(i): h for i, h in rows}

    async def test_the_base_hash_is_identical_before_and_after(
        self, client, arithmetic
    ):
        project_id = arithmetic["project_id"]
        before = await self._hash_and_versions(project_id)
        report = await _change(
            client, project_id, "REQ", "Delivered as a printed booklet"
        )
        after = await self._hash_and_versions(project_id)

        assert before == after, "a read wrote to a workflow version"
        assert len(after) == len(before), "a read created a WorkflowVersion"
        # And the endpoint says so itself, so a caller can check rather than
        # take our word for it.
        assert report["base_unchanged"] is True
        assert (
            report["base_version_hash_before"]
            == report["base_version_hash_after"]
            == before[arithmetic["version_id"]]
        )
        assert report["applied"] is False
        assert report["replan"]["applied"] is False

    async def test_comparing_wordings_writes_no_version_either(
        self, client, arithmetic
    ):
        project_id = arithmetic["project_id"]
        before = await self._hash_and_versions(project_id)
        r = await client.post(
            f"/api/projects/{project_id}/requirements/REQ/compare",
            json={"options": ["One wording", "Another wording"]},
        )
        assert r.status_code == 200, r.text
        assert await self._hash_and_versions(project_id) == before
        assert r.json()["applied"] is False

    async def test_the_requirement_itself_is_untouched(self, client, arithmetic):
        r = await client.get(
            f"/api/projects/{arithmetic['project_id']}/requirements/REQ"
        )
        assert r.status_code == 200
        assert r.json()["requirement"]["version_no"] == 1
        assert r.json()["requirement"]["text"] == (
            "The report is delivered as a PDF"
        )


# ---------------------------------------------------------------------------
# 4. Requirement versions are first class
# ---------------------------------------------------------------------------


class TestRequirementHistory:
    """Create, change, change again, read it back, diff v1 against v3, and get
    the impact of that exact change."""

    async def test_history_records_every_wording_who_and_when(
        self, client, historied
    ):
        r = await client.get(
            f"/api/projects/{historied['project_id']}"
            f"/requirements/SPEC/history"
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert [x["version_no"] for x in body["revisions"]] == [1, 2, 3]
        assert body["revision_count"] == 3
        assert body["changes_recorded"] == 2
        assert body["current"]["version_no"] == 3
        assert body["current"]["recorded_in_history"] is True

        original, second, third = body["revisions"]
        # v1 predates the history table: reconstructed, and honest about it.
        assert original["backfilled"] is True
        assert original["attributed"] is False
        assert "predates requirement history" in original["provenance_note"]
        assert original["text"] == "On-site only, no streaming"
        assert original["impact_summary"] is None

        assert second["backfilled"] is False
        assert second["changed_by"].startswith("Historian <")
        assert second["attributed"] is True
        assert second["note"] == "Room added"
        assert second["recorded_at"]
        assert second["workflow_version_id"]
        assert second["scenario_id"]
        assert third["version_no"] == 3
        assert third["text"] == "On-site and streamed to two overflow rooms"

    async def test_what_the_change_was_claimed_to_cost_is_recorded(
        self, client, historied
    ):
        r = await client.get(
            f"/api/projects/{historied['project_id']}"
            f"/requirements/SPEC/history"
        )
        claimed = r.json()["revisions"][1]["impact_summary"]
        assert claimed["claimed_at_apply"] is True
        # H1 was done and consumed SPEC; H2 consumes H1's output.
        assert claimed["must_redo_count"] == 2
        assert claimed["wasted_days"] == 2.0
        assert claimed["redo_cost_days"] == 2.0
        assert claimed["engine_version"]

    async def test_applying_moved_the_workflow_and_kept_the_parent(
        self, client, historied
    ):
        r = await client.get(
            f"/api/projects/{historied['project_id']}/requirements/SPEC"
        )
        assert r.json()["requirement"]["version_no"] == 3
        assert r.json()["requirement"]["text"] == (
            "On-site and streamed to two overflow rooms"
        )
        versions = await client.get(
            f"/api/projects/{historied['project_id']}/versions"
        )
        assert len(versions.json()) == 3

    async def test_v1_can_be_diffed_against_v3(self, client, historied):
        r = await client.get(
            f"/api/projects/{historied['project_id']}/requirements/SPEC/diff"
            f"?from_version=1&to_version=3"
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["from"]["text"] == "On-site only, no streaming"
        assert body["to"]["text"] == (
            "On-site and streamed to two overflow rooms"
        )
        assert "streamed" in body["text_diff"]["added_words"]
        assert "no" in body["text_diff"]["removed_words"]
        assert body["text_diff"]["identical"] is False
        assert body["consumed_by_then"] == ["H1"]
        assert body["consumed_by_now"] == ["H1"]
        assert body["consumption_drifted"] is False
        assert "directly comparable" in body["drift_note"]

    async def test_the_diff_carries_the_impact_of_that_exact_change(
        self, client, historied
    ):
        r = await client.get(
            f"/api/projects/{historied['project_id']}/requirements/SPEC/diff"
            f"?from_version=1&to_version=3"
        )
        body = r.json()
        impact = body["impact"]
        assert impact["proposed_text"] == (
            "On-site and streamed to two overflow rooms"
        )
        assert [t["key"] for t in impact["must_redo"]] == ["H1", "H2"]
        assert impact["applied"] is False
        assert impact["assumptions"]["material_change_is_a_human_judgement"]
        assert body["recorded_impact"]["must_redo_count"] == 2
        assert "Recomputed against workflow version" in body["impact_note"]
        # The recosting scenario is a throwaway, and the payload says so.
        assert impact["replan"]["kept"] is False
        assert "discarded" in impact["replan"]["kept_note"]

    async def test_defaulting_the_range_spans_the_whole_history(
        self, client, historied
    ):
        r = await client.get(
            f"/api/projects/{historied['project_id']}/requirements/SPEC/diff"
        )
        assert r.status_code == 200, r.text
        assert (r.json()["from_version"], r.json()["to_version"]) == (1, 3)

    async def test_an_unrecorded_revision_is_a_404_that_names_what_exists(
        self, client, historied
    ):
        r = await client.get(
            f"/api/projects/{historied['project_id']}/requirements/SPEC/diff"
            f"?from_version=1&to_version=9"
        )
        assert r.status_code == 404
        assert "v1, v2, v3" in r.json()["detail"]

    async def test_a_requirement_with_no_history_says_so(
        self, client, historied
    ):
        r = await client.get(
            f"/api/projects/{historied['project_id']}"
            f"/requirements/UNUSED/history"
        )
        assert r.status_code == 200
        body = r.json()
        assert body["revisions"] == []
        assert "not that the requirement never changed" in body["note"]

        d = await client.get(
            f"/api/projects/{historied['project_id']}"
            f"/requirements/UNUSED/diff"
        )
        assert d.status_code == 404
        assert "History begins with the first change" in d.json()["detail"]

    async def test_the_revision_rows_are_scoped_to_the_project(
        self, client, historied
    ):
        """History lives on the project, like `Event` - not on a workflow
        version, which is copied wholesale on every unrelated edit."""
        from backend.app.db import async_session

        async with async_session() as db:
            count = (
                await db.execute(
                    select(func.count())
                    .select_from(RequirementRevision)
                    .where(
                        RequirementRevision.project_id
                        == uuid.UUID(historied["project_id"]),
                        RequirementRevision.requirement_key == "SPEC",
                    )
                )
            ).scalar_one()
        assert count == 3


# ---------------------------------------------------------------------------
# 5. Comparing two proposed wordings
# ---------------------------------------------------------------------------


class TestComparingWordings:
    async def test_two_plain_wordings_tie_and_the_report_says_why(
        self, client, arithmetic
    ):
        """The honest answer, and the one nobody else gives: the blast radius
        comes from the graph, and the graph does not change when the sentence
        does."""
        r = await client.post(
            f"/api/projects/{arithmetic['project_id']}/requirements/REQ/compare",
            json={"options": ["Delivered as a dashboard", "Delivered as a CSV"]},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["identical_cost"] is True
        assert body["tie"] is True
        assert body["cheapest_option_index"] is None
        assert body["tied_option_indexes"] == [0, 1]
        assert "the graph does not change when the sentence does" in (
            body["differences"]["statement"]
        )
        assert "invalidates" in body["differences"]["statement"]

    async def test_both_options_are_costed_against_the_same_base(
        self, client, arithmetic
    ):
        r = await client.post(
            f"/api/projects/{arithmetic['project_id']}/requirements/REQ/compare",
            json={
                "options": [
                    {"text": "Dashboard", "label": "Everything moves"},
                    {
                        "text": "Dashboard, same data model",
                        "label": "Spec only",
                        "invalidates": [],
                    },
                ]
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["base"]["same_base_for_every_option"] is True
        assert body["base"]["version_id"] == arithmetic["version_id"]
        for option in body["options"]:
            assert option["impact"]["version_id"] == arithmetic["version_id"]
            assert (
                option["impact"]["base_version_hash_before"]
                == body["base"]["content_hash"]
            )

    async def test_the_cheaper_option_is_identifiable(self, client, arithmetic):
        r = await client.post(
            f"/api/projects/{arithmetic['project_id']}/requirements/REQ/compare",
            json={
                "options": [
                    {"text": "Dashboard", "label": "Everything moves"},
                    {
                        "text": "Dashboard, same data model",
                        "label": "Spec only",
                        "invalidates": [],
                    },
                ]
            },
        )
        body = r.json()
        assert body["identical_cost"] is False
        assert body["tie"] is False
        assert body["cheapest_option_index"] == 1
        assert body["ranking"][0]["label"] == "Spec only"

        expensive, cheap = body["options"]
        assert expensive["cost"]["additional_effort_days"] == 7.0
        assert cheap["cost"]["additional_effort_days"] == 0.0
        assert expensive["cost"]["must_redo_count"] == 3
        assert cheap["cost"]["must_redo_count"] == 0

    async def test_the_difference_is_stated_in_cost_terms(self, client, arithmetic):
        r = await client.post(
            f"/api/projects/{arithmetic['project_id']}/requirements/REQ/compare",
            json={
                "options": [
                    {"text": "Dashboard", "label": "Everything moves"},
                    {
                        "text": "Dashboard, same data model",
                        "label": "Spec only",
                        "invalidates": [],
                    },
                ]
            },
        )
        body = r.json()
        assert "Spec only is the cheaper option" in (
            body["differences"]["statement"]
        )
        assert "0 day(s) of new effort against 7" in (
            body["differences"]["statement"]
        )
        varies = {v["field"]: v for v in body["differences"]["varies"]}
        assert varies["additional_effort_days"]["differs"] is True
        assert varies["additional_effort_days"]["spread"] == 7.0
        pair = body["differences"]["pairwise"][0]
        assert pair["tasks_only_a_invalidates"] == ["A1", "A2", "A3"]
        assert pair["tasks_only_b_invalidates"] == []

    async def test_scoping_to_work_that_never_consumed_it_is_refused(
        self, client, arithmetic
    ):
        r = await client.post(
            f"/api/projects/{arithmetic['project_id']}/requirements/REQ/compare",
            json={
                "options": [
                    "Fine",
                    {"text": "Nonsense", "invalidates": ["B1"]},
                ]
            },
        )
        assert r.status_code == 422
        assert "B1 never consumed REQ" in r.json()["detail"]

    async def test_one_option_is_refused_with_a_reason(self, client, arithmetic):
        r = await client.post(
            f"/api/projects/{arithmetic['project_id']}/requirements/REQ/compare",
            json={"options": ["Only one"]},
        )
        assert r.status_code == 422


# ---------------------------------------------------------------------------
# 6. The replan is a real scenario
# ---------------------------------------------------------------------------


class TestTheReadyToApplyScenario:
    @pytest_asyncio.fixture
    async def report(self, client, arithmetic):
        return await _change(
            client, arithmetic["project_id"], "REQ",
            "Delivered as a live dashboard",
        )

    def test_it_is_expressed_in_the_closed_algebra(self, report):
        kinds = [m["kind"] for m in report["replan"]["mutations"]]
        assert kinds == ["REQUIREMENT_VERSION_BUMP"]
        payload = report["replan"]["mutations"][0]["payload"]
        assert payload["requirement_key"] == "REQ"
        assert payload["version_no"] == 2
        assert "No eighteenth mutation kind" in report["replan"]["expressed_in"]

    def test_scoping_is_expressed_in_the_algebra_too(self, report):
        """A human sparing work is TASK_STATUS_SET putting the status back,
        not a new mutation kind with a hidden argument."""
        assert report["scoped"] is False
        assert report["statuses_restored_by_scoping"] == []

    async def test_a_scoped_replan_restores_the_spared_statuses(
        self, client, arithmetic
    ):
        report = await _change(
            client, arithmetic["project_id"], "REQ",
            "Delivered as a live dashboard",
            invalidates=[],
        )
        kinds = [m["kind"] for m in report["replan"]["mutations"]]
        assert kinds[0] == "REQUIREMENT_VERSION_BUMP"
        assert set(kinds[1:]) == {"TASK_STATUS_SET"}
        restored = {
            m["payload"]["key"]: m["payload"]["status"]
            for m in report["replan"]["mutations"][1:]
        }
        assert restored == {"A1": "done", "A2": "done"}
        assert report["statuses_restored_by_scoping"] == ["A1", "A2"]
        assert report["assumptions"]["scoping_is_your_judgement_not_ours"]
        assert report["assumptions"]["restored_statuses_do_not_restore_actuals"]

    async def test_the_existing_evaluate_endpoint_accepts_it(self, client, report):
        scenario_id = report["replan"]["scenario_id"]
        r = await client.post(f"/api/scenarios/{scenario_id}/evaluate")
        assert r.status_code == 200, r.text
        assert r.json()["validation"]["valid"] is True
        assert r.json()["base_unchanged"] is True

    async def test_the_existing_diff_endpoint_accepts_it(self, client, report):
        scenario_id = report["replan"]["scenario_id"]
        r = await client.get(f"/api/scenarios/{scenario_id}/diff")
        assert r.status_code == 200, r.text
        assert r.json()["validation"]["valid"] is True
        assert "projected_completion" in r.json()["comparison"]

    async def test_the_existing_apply_endpoint_accepts_it(self, client, report):
        """Applied through `POST /api/scenarios/{id}/apply` - no special path
        for requirements, which is the architectural invariant."""
        scenario_id = report["replan"]["scenario_id"]
        r = await client.post(f"/api/scenarios/{scenario_id}/apply")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["applied"] is True
        assert body["parent_version"]["unchanged"] is True

        # And the workflow really did move.
        follow = await client.get(
            f"/api/projects/{report['project_id']}/requirements/REQ"
        )
        assert follow.json()["requirement"]["version_no"] == 2
        assert follow.json()["requirement"]["text"] == (
            "Delivered as a live dashboard"
        )


# ---------------------------------------------------------------------------
# 7. The role guard
# ---------------------------------------------------------------------------


class TestApplyStaysGuarded:
    """`change` and `compare` are on `READS_THAT_POST` because they write no
    workflow state. `apply` is deliberately not, and this is what holds that
    line. Enforcement is switched on per test exactly as `test_auth.py` does
    it - the live settings object, not the environment."""

    SECRET = "requirement-change-shared-secret"

    @pytest_asyncio.fixture
    async def world(self, client):
        previous = settings.PROXY_SHARED_SECRET
        settings.PROXY_SHARED_SECRET = ""
        try:
            people = {
                role: (
                    await client.post(
                        "/api/users", json={"name": f"Req {role.title()}"}
                    )
                ).json()
                for role in ("owner", "editor", "viewer")
            }
            project = (
                await client.post(
                    "/api/projects",
                    json={
                        "name": "Requirement roles",
                        "start_date": "2026-04-06",
                        "today_day": 0,
                    },
                    headers={"X-User-Id": people["owner"]["id"]},
                )
            ).json()
            for role in ("editor", "viewer"):
                r = await client.post(
                    f"/api/projects/{project['id']}/members",
                    json={
                        "email": people[role]["email"],
                        "name": people[role]["name"],
                        "role": role,
                    },
                )
                assert r.status_code == 201, r.text
        finally:
            settings.PROXY_SHARED_SECRET = previous
        return {"project_id": project["id"], **people}

    @pytest.fixture
    def authenticating(self, monkeypatch):
        monkeypatch.setattr(settings, "PROXY_SHARED_SECRET", self.SECRET)

    def _headers(self, person):
        return {"X-User-Id": person["id"], "X-Proxy-Secret": self.SECRET}

    async def test_a_viewer_may_ask_what_a_change_would_cost(
        self, client, world, authenticating
    ):
        """A seat that cannot ask "what would this cost" is a screenshot."""
        r = await client.post(
            f"/api/projects/{world['project_id']}/requirements/NOPE/change",
            json={"new_text": "anything"},
            headers=self._headers(world["viewer"]),
        )
        # 404 for the missing requirement, not 403: the guard stood aside.
        assert r.status_code == 404, r.text

    async def test_a_viewer_may_compare_wordings(
        self, client, world, authenticating
    ):
        r = await client.post(
            f"/api/projects/{world['project_id']}/requirements/NOPE/compare",
            json={"options": ["one", "two"]},
            headers=self._headers(world["viewer"]),
        )
        assert r.status_code == 404, r.text

    async def test_a_viewer_may_not_apply_one(
        self, client, world, authenticating
    ):
        r = await client.post(
            f"/api/projects/{world['project_id']}/requirements/NOPE/apply",
            json={"new_text": "anything"},
            headers=self._headers(world["viewer"]),
        )
        assert r.status_code == 403, r.text
        detail = r.json()["detail"]
        assert detail["reason"] == "insufficient_role"
        assert detail["your_role"] == "viewer"
        assert detail["required_role"] == "editor"
        assert detail["attempted"].endswith("/requirements/{requirement_key}/apply")

    async def test_an_editor_may_apply_one(self, client, world, authenticating):
        r = await client.post(
            f"/api/projects/{world['project_id']}/requirements/NOPE/apply",
            json={"new_text": "anything"},
            headers=self._headers(world["editor"]),
        )
        # Past the guard; 404 because that project has no such requirement.
        assert r.status_code == 404, r.text

    async def test_an_anonymous_caller_may_not_apply(
        self, client, world, authenticating
    ):
        r = await client.post(
            f"/api/projects/{world['project_id']}/requirements/NOPE/apply",
            json={"new_text": "anything"},
        )
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# The honesty layer
# ---------------------------------------------------------------------------


class TestTheHonestyLayer:
    @pytest_asyncio.fixture
    async def report(self, client, arithmetic):
        return await _change(
            client, arithmetic["project_id"], "REQ", "A different wording"
        )

    def test_it_never_claims_to_have_judged_the_meaning(self, report):
        a = report["assumptions"]
        claim = a["material_change_is_a_human_judgement"]
        assert "assuming" in claim
        assert "does not read" in claim or "not from the two texts" in claim
        assert "your call" in claim

    def test_the_redo_parity_assumption_is_stated(self, report):
        assert "assumes redoing a task costs the same effort" in (
            report["assumptions"]["redo_costs_what_doing_cost"]
        )

    def test_no_language_model_is_claimed_anywhere(self, report):
        assert "no language model" in (
            report["assumptions"]["no_language_model_is_involved"].lower()
            + report["assumptions"][
                "material_change_is_a_human_judgement"
            ].lower()
        ) or "deterministic code" in (
            report["assumptions"]["no_language_model_is_involved"]
        )

    def test_what_could_not_be_assessed_is_listed_with_what_would_unlock_it(
        self, report
    ):
        unavailable = report["assumptions"]["unavailable"]
        assert len(unavailable) >= 4
        checks = {u["check"] for u in unavailable}
        assert "does_the_new_wording_actually_invalidate_this_work" in checks
        assert "how_much_of_an_unfinished_task_survives" in checks
        assert "what_a_recheck_costs" in checks
        assert "when_the_redone_work_gets_re-scheduled" in checks
        for entry in unavailable:
            assert entry["why"]
            assert entry["would_unlock_it"]

    def test_the_text_diff_is_not_evidence_about_meaning(self, report):
        assert "No cost in this report is derived from it" in (
            report["text_diff"]["note"]
        )


class TestUnchangedWording:
    async def test_proposing_the_current_wording_says_so(
        self, client, arithmetic
    ):
        r = await client.get(
            f"/api/projects/{arithmetic['project_id']}/requirements/REQ"
        )
        current = r.json()["requirement"]["text"]
        report = await _change(
            client, arithmetic["project_id"], "REQ", current
        )
        assert report["text_changed"] is False
        assert report["text_diff"]["identical"] is True
        assert "identical to the current one" in (
            report["assumptions"]["wording_is_unchanged"]
        )


# ---------------------------------------------------------------------------
# The existing endpoint keeps working, unchanged
# ---------------------------------------------------------------------------


class TestTheOlderEndpointIsUntouched:
    async def test_requirement_impact_still_answers_exactly_as_before(
        self, client
    ):
        r = await client.post(
            f"/api/projects/{EVENT_PROJECT_ID}/requirement-impact",
            json={"requirement_key": "R1"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert [t["key"] for t in body["must_redo"]] == [
            "T02", "T03", "T04", "T05", "T06", "T12"
        ]
        assert [t["key"] for t in body["must_recheck"]] == [
            "T13", "T14", "T15", "T17"
        ]
        assert body["wasted_days"] == 3.0

    async def test_the_two_agree_on_the_blast_radius(self, client):
        old = (
            await client.post(
                f"/api/projects/{EVENT_PROJECT_ID}/requirement-impact",
                json={"requirement_key": "R1"},
            )
        ).json()
        new = await _change(
            client, EVENT_PROJECT_ID, "R1", "A re-worded R1",
            keep_scenario=False,
        )
        assert [t["key"] for t in old["must_redo"]] == [
            t["key"] for t in new["must_redo"]
        ]
        assert old["wasted_days"] == new["wasted_effort"]["wasted_days"]
