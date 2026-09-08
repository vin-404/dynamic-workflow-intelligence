"""
Import, preview, commit, and the webhook.

The riskiest thing in this feature is not the HTTP: it is that a Jira export
repeats a column name, `csv.DictReader` silently keeps one value per key, and
an importer built the obvious way loses most of a workflow's edges without
saying anything. `TestRepeatedLinkColumns` demonstrates that failure directly
against `DictReader` and then asserts our reader does not have it - the point
being that a regression here would look exactly like a smaller workflow, not
like an error.

The second riskiest thing is edge direction. An inward "is blocked by" and an
outward "blocks" point opposite ways, and swapping them inverts the whole
graph while leaving every count identical. So both directions are asserted
explicitly, against a fixture whose intended order is readable from the
summaries.

Everything else follows the suite's existing conventions: the real app over
`ASGITransport` on the throwaway database `conftest.py` configured, and the
open (no `PROXY_SHARED_SECRET`) configuration that every other test runs in.
"""
from __future__ import annotations

import csv
import hashlib
import hmac
import io
import json
import uuid

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from backend.app.api.routers import ingest as ingest_router
from backend.app.core.workflow import TaskStatus
from backend.app.ingest import bundled as S
from backend.app.ingest.csvsource import CsvProblem, check_size, read_sheet
from backend.app.ingest.mapping import MappingProblem, mapping_from_payload, parse_date
from backend.app.ingest.plan import ImportOptions, build_jira_plan, build_plan
from backend.app.ingest.preview import preview_payload
from backend.app.main import app
from backend.app.settings import settings

SAMPLE = "jira-delivery-platform"
WEBHOOK_SECRET = "a-secret-only-github-and-this-process-know"


@pytest_asyncio.fixture(scope="module")
async def client():
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c


def sample_text() -> str:
    return S.read_sample(SAMPLE)


def plan_of(text: str):
    return build_jira_plan(text)


def preview_of(text: str) -> dict:
    plan = build_jira_plan(text)
    return preview_payload(plan, hashlib.sha256(text.encode()).hexdigest())


def signed(body: bytes, secret: str = WEBHOOK_SECRET) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


async def events_of(project_id: str) -> list[tuple]:
    """The project's event log, read straight from the database.

    There is no read endpoint for the event log and adding one is not this
    agent's to add, so the webhook's effect is asserted where it lands.
    """
    from sqlalchemy import select

    from backend.app.db import async_session
    from backend.app.models import Event

    async with async_session() as db:
        rows = (
            await db.execute(
                select(Event)
                .where(Event.project_id == uuid.UUID(project_id))
                .order_by(Event.day, Event.created_at)
            )
        ).scalars().all()
        return [(e.task_key, e.from_status, e.to_status, e.day) for e in rows]


# ---------------------------------------------------------------------------
# 1. A realistic export imports, with its dependencies intact
# ---------------------------------------------------------------------------


class TestRepeatedLinkColumns:
    """The failure mode this whole module exists to avoid."""

    def test_the_sample_really_does_repeat_the_column(self):
        header = next(csv.reader(io.StringIO(sample_text())))
        repeats = sum(1 for h in header if h == "Outward issue link (Blocks)")
        assert repeats >= 3, (
            "the fixture no longer exercises the repeated-column case, so "
            "everything below is testing nothing"
        )

    def test_dictreader_would_lose_them(self):
        """Written as a test so the hazard is documented, not remembered.

        `DictReader` keeps one value per key. DLV-6 blocks four issues; read
        this way, three of those four edges disappear silently.
        """
        rows = list(csv.DictReader(io.StringIO(sample_text())))
        dlv6 = next(r for r in rows if r["Issue key"] == "DLV-6")
        collapsed = dlv6["Outward issue link (Blocks)"]
        assert not isinstance(collapsed, str) or collapsed.count("DLV") <= 1, (
            "DictReader appears to have grown multi-value support; if so this "
            "module's premise needs re-checking"
        )

    def test_our_reader_keeps_every_repeat(self):
        sheet = read_sheet(sample_text())
        dlv6 = next(r for r in sheet.records if r.first("Issue key") == "DLV-6")
        values = [v for _, v in dlv6.all("Outward issue link (Blocks)")]
        assert values == ["DLV-7", "DLV-8", "DLV-9", "DLV-11"]

    def test_all_four_edges_survive_into_the_plan(self):
        plan = plan_of(sample_text())
        out_of_6 = {d.to_task for d in plan.dependencies if d.from_task == "DLV-6"}
        assert out_of_6 == {"DLV-7", "DLV-8", "DLV-9", "DLV-11"}


class TestEdgeDirection:
    """Reversing these leaves every count identical and every answer wrong."""

    def test_outward_blocks_runs_from_this_row_to_the_named_issue(self):
        plan = plan_of(sample_text())
        edges = {(d.from_task, d.to_task) for d in plan.dependencies}
        # DLV-1's row carries `Outward issue link (Blocks) = DLV-2`, meaning
        # "DLV-1 blocks DLV-2", so DLV-1 must finish first.
        assert ("DLV-1", "DLV-2") in edges
        assert ("DLV-2", "DLV-1") not in edges

    def test_inward_blocks_runs_from_the_named_issue_to_this_row(self):
        plan = plan_of(sample_text())
        edges = {(d.from_task, d.to_task) for d in plan.dependencies}
        # DLV-12's row carries `Inward issue link (Blocks) = DLV-11`, meaning
        # "DLV-12 is blocked by DLV-11", so DLV-11 must finish first.
        assert ("DLV-11", "DLV-12") in edges
        assert ("DLV-12", "DLV-11") not in edges

    def test_the_direction_is_explained_on_the_edge(self):
        out = preview_of(sample_text())
        because = {
            (d["from_task"], d["to_task"]): d["because"]
            for d in out["would_create"]["dependencies"]
        }
        assert "blocks DLV-2" in because[("DLV-1", "DLV-2")]
        assert "is blocked by DLV-11" in because[("DLV-11", "DLV-12")]

    def test_the_resulting_order_is_the_one_the_summaries_imply(self):
        """A cheap end-to-end sanity check on direction: the contract is
        agreed before the adapter is built, and verification happens after
        cutover, not before it."""
        from backend.app.core import engine as E
        from backend.app.core.workflow import Clock, EngineConfig, WorkflowState

        plan = plan_of(sample_text())
        snapshot = plan.snapshot()
        result = E.evaluate(
            snapshot,
            WorkflowState(statuses=dict(plan.statuses)),
            Clock(0.0),
            EngineConfig(),
        )
        path = result.as_dict()["critical_path"]
        assert path.index("DLV-1") < path.index("DLV-3")
        assert path.index("DLV-13") < path.index("DLV-14")


class TestJiraInterpretation:
    def test_status_vocabulary_is_mapped_and_labelled(self):
        out = preview_of(sample_text())
        by_key = {r["task_key"]: r for r in out["rows"]}
        assert by_key["DLV-1"]["interpretation"]["status"]["value"] == "done"
        assert by_key["DLV-3"]["interpretation"]["status"]["value"] == "in_review"
        assert by_key["DLV-11"]["interpretation"]["status"]["value"] == "blocked"
        assert by_key["DLV-1"]["interpretation"]["status"]["assumed"] is False

    def test_an_unknown_status_falls_back_to_the_category_and_says_so(self):
        out = preview_of(sample_text())
        reading = next(
            r for r in out["rows"] if r["task_key"] == "DLV-8"
        )["interpretation"]["status"]
        assert reading["raw"] == "Awaiting Copy"
        assert reading["value"] == "in_progress"
        assert reading["assumed"] is True
        assert "status category" in reading["how"]

    def test_an_unknown_status_with_no_category_is_not_guessed(self):
        text = "Issue key,Summary,Status,Story Points\nX-1,A thing,Marinating,2\n"
        out = preview_of(text)
        reading = out["rows"][0]["interpretation"]["status"]
        assert reading["value"] == TaskStatus.NOT_STARTED.value
        assert reading["assumed"] is True
        assert "no clean equivalent" in reading["how"]

    def test_story_points_are_read_as_days_and_the_reading_is_visible(self):
        out = preview_of(sample_text())
        effort = next(
            r for r in out["rows"] if r["task_key"] == "DLV-3"
        )["interpretation"]["effort"]
        assert effort["value"] == 5.0
        assert effort["raw"] == "5"
        assert effort["assumed"] is True
        assert "story points" in effort["how"]

    def test_story_point_conversion_is_the_callers_to_change(self):
        plan = build_jira_plan(
            sample_text(), ImportOptions(story_point_days=0.5)
        )
        by_key = {t.key: t for t in plan.tasks}
        assert by_key["DLV-3"].effort == 2.5

    def test_an_original_estimate_in_seconds_becomes_days(self):
        out = preview_of(sample_text())
        effort = next(
            r for r in out["rows"] if r["task_key"] == "DLV-10"
        )["interpretation"]["effort"]
        assert effort["raw"] == "28800"
        assert effort["value"] == 1.0
        assert "seconds" in effort["how"]

    def test_jira_duration_syntax_is_understood(self):
        text = "Issue key,Summary,Original Estimate\nX-1,A thing,2d 4h\n"
        plan = build_jira_plan(text)
        assert plan.tasks[0].effort == 2.5

    def test_a_missing_effort_is_defaulted_and_the_default_is_stated(self):
        out = preview_of(sample_text())
        effort = next(
            r for r in out["rows"] if r["task_key"] == "DLV-12"
        )["interpretation"]["effort"]
        assert effort["value"] == 1.0
        assert effort["assumed"] is True
        assert "defaulted" in effort["how"]

    def test_assignees_become_resources_one_per_person(self):
        out = preview_of(sample_text())
        resources = {r["key"]: r for r in out["would_create"]["resources"]}
        assert set(resources) == {
            "arun-sethi", "mei-chen", "priya-nandan", "sofia-lindqvist",
            "tomas-nowak",
        }
        assert resources["arun-sethi"]["capacity"] == 1
        assert resources["arun-sethi"]["task_count"] == 6

    def test_columns_we_do_not_read_are_reported_rather_than_ignored(self):
        out = preview_of(sample_text())
        named = {u["column"] for u in out["unmapped_columns"]}
        assert {"Issue Type", "Reporter"} <= named

    def test_the_deadline_is_inferred_from_due_dates_and_labelled(self):
        out = preview_of(sample_text())
        assumed = out["assumptions"]["deadline"]
        assert assumed["value"] == "2026-09-21"
        assert assumed["assumed"] is True

    def test_imported_edges_are_ordering_only_and_that_is_stated(self):
        out = preview_of(sample_text())
        assert all(
            d["consumes"] is False for d in out["would_create"]["dependencies"]
        )
        assert any(
            "consumes=false" in claim
            for claim in out["assumptions"]["stated_plainly"]
        )


# ---------------------------------------------------------------------------
# 2. A malformed file reports every bad row, not the first
# ---------------------------------------------------------------------------


MALFORMED = (
    "Issue key,Summary,Status,Story Points,Due date\n"
    "GOOD-1,This one is fine,To Do,2,2026-03-02\n"
    ",No key at all,To Do,1,2026-03-03\n"
    "GOOD-1,A duplicate key,To Do,1,2026-03-04\n"
    "BAD-3,Points that are not a number,To Do,TBD,2026-03-05\n"
    "BAD-4,A short row,To Do\n"
    "BAD-5,An ambiguous date,To Do,1,03/04/2026\n"
    "\n"
    "BAD-7,Negative points,To Do,-3,2026-03-08\n"
    "GOOD-2,Also fine,In Progress,3,2026-03-09\n"
)


class TestEveryBadRowIsReported:
    @pytest.fixture(scope="class")
    @classmethod
    def out(cls):
        return preview_of(MALFORMED)

    def test_the_good_rows_still_import(self, out):
        assert [t["key"] for t in out["would_create"]["tasks"]] == [
            "GOOD-1", "GOOD-2"
        ]

    def test_every_bad_row_is_reported_not_just_the_first(self, out):
        assert len(out["rejected_rows"]) == 7, out["rejected_rows"]

    def test_each_rejection_carries_its_row_number(self, out):
        # Header is row 1, so the seven bad rows are 3 through 9.
        assert [r["row"] for r in out["rejected_rows"]] == [3, 4, 5, 6, 7, 8, 9]

    def test_each_rejection_carries_its_raw_content(self, out):
        by_row = {r["row"]: r for r in out["rejected_rows"]}
        assert ["Summary", "No key at all"] in by_row[3]["raw"]
        assert ["Story Points", "TBD"] in by_row[5]["raw"]

    def test_each_rejection_says_why_in_words(self, out):
        reasons = {r["row"]: r["reason"] for r in out["rejected_rows"]}
        assert "no task key" in reasons[3]
        assert "already appeared on row 2" in reasons[4]
        assert "not a number" in reasons[5]
        assert "3 fields" in reasons[6] and "header has 5" in reasons[6]
        assert "locale" in reasons[7]
        assert "blank" in reasons[8]
        assert "negative" in reasons[9]

    def test_a_negative_estimate_is_refused_rather_than_clamped(self):
        out = preview_of(
            "Issue key,Summary,Story Points\nX-1,Negative,-3\n"
        )
        assert out["rejected_rows"][0]["reason"].endswith("effort cannot be.")

    def test_absent_and_unreadable_are_treated_differently(self):
        """The distinction the whole rejection policy rests on."""
        out = preview_of(
            "Issue key,Summary,Story Points\n"
            "X-1,Nobody sized this,\n"
            "X-2,Somebody typed a word,TBD\n"
        )
        assert [t["key"] for t in out["would_create"]["tasks"]] == ["X-1"]
        assert out["rows"][0]["interpretation"]["effort"]["assumed"] is True
        assert [r["row"] for r in out["rejected_rows"]] == [3]

    def test_a_link_to_an_issue_outside_the_export_is_reported(self):
        out = preview_of(sample_text())
        dropped = out["dropped_dependencies"]
        assert len(dropped) == 1
        assert dropped[0]["raw"] == "DLV-99"
        assert dropped[0]["row"] == 15
        assert "not in this file" in dropped[0]["reason"]
        assert "DLV-99" not in {t["key"] for t in out["would_create"]["tasks"]}

    def test_a_row_number_and_a_line_number_can_differ(self):
        """DLV-11's description contains a newline, so they must."""
        out = preview_of(sample_text())
        divergent = [r for r in out["rejected_rows"] if r["row"] != r["line"]]
        assert divergent, "the fixture no longer has a multi-line field"

    def test_a_file_with_no_header_is_refused_as_a_whole(self):
        with pytest.raises(CsvProblem):
            read_sheet("")

    def test_an_oversized_file_is_refused_with_an_explanation(self):
        with pytest.raises(CsvProblem) as exc:
            check_size("x" * (6 * 1024 * 1024))
        assert "MB" in str(exc.value) and "Nothing was read" in str(exc.value)


# ---------------------------------------------------------------------------
# 3. A cycle is refused at preview, with the cycle named
# ---------------------------------------------------------------------------


CYCLIC = (
    "Issue key,Summary,Story Points,Outward issue link (Blocks)\n"
    "C-1,First,1,C-2\n"
    "C-2,Second,1,C-3\n"
    "C-3,Third,1,C-1\n"
)


class TestCycles:
    def test_the_cycle_is_named_as_a_task_key_path(self):
        out = preview_of(CYCLIC)
        assert len(out["cycles"]) == 1
        path = out["cycles"][0]["path"]
        assert path[0] == path[-1]
        assert set(path) == {"C-1", "C-2", "C-3"}
        assert "->" in out["cycles"][0]["message"]

    def test_the_cycle_names_the_rows_that_caused_it(self):
        out = preview_of(CYCLIC)
        assert out["cycles"][0]["from_rows"] == [2, 3, 4]
        assert all(e["raw"] for e in out["cycles"][0]["evidence"])

    def test_preview_refuses_to_commit_it(self):
        out = preview_of(CYCLIC)
        assert out["can_commit"] is False
        assert any("C-1" in b for b in out["blocking"])

    async def test_commit_refuses_a_cyclic_import(self, client):
        r = await client.post(
            "/api/import/commit",
            json={"source": "jira", "csv_text": CYCLIC, "name": "Should not exist"},
        )
        assert r.status_code == 422, r.text
        detail = r.json()["detail"]
        assert detail["reason"] == "import_would_not_schedule"
        assert any("C-1" in b for b in detail["blocking"])

    async def test_nothing_was_created_by_the_refusal(self, client):
        names = {
            p["name"] for p in (await client.get("/api/projects")).json()
        }
        assert "Should not exist" not in names

    def test_an_acyclic_import_reports_no_cycles(self):
        assert preview_of(sample_text())["cycles"] == []


# ---------------------------------------------------------------------------
# 4. The bundled sample, end to end
# ---------------------------------------------------------------------------


class TestBundledSample:
    async def test_the_sample_is_listed(self, client):
        r = await client.get("/api/import/samples")
        assert r.status_code == 200
        listed = r.json()["samples"]
        assert [s["name"] for s in listed] == [SAMPLE]
        assert listed[0]["demonstrates"]

    async def test_the_sample_can_be_fetched_as_a_ready_made_body(self, client):
        r = await client.get(f"/api/import/samples/{SAMPLE}")
        assert r.status_code == 200
        body = r.json()["suggested"]
        assert body["source"] == "jira"
        assert "Issue key" in body["csv_text"]

    async def test_the_sample_can_be_fetched_as_csv(self, client):
        r = await client.get(f"/api/import/samples/{SAMPLE}/raw")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/csv")
        assert r.text.startswith("Issue key,")

    async def test_an_unknown_sample_is_a_404_not_a_file_read(self, client):
        for name in ("nope", "..", "....//....//.env"):
            r = await client.get(f"/api/import/samples/{name}")
            assert r.status_code in (404, 405), name

    async def test_preview_by_sample_name_needs_no_file(self, client):
        r = await client.post(
            "/api/import/preview", json={"source": "jira", "sample": SAMPLE}
        )
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["counts"] == {
            "tasks": 14,
            "dependencies": 22,
            "resources": 5,
            "assignments": 14,
            "rows_read": 17,
            "rows_rejected": 3,
            "dependencies_dropped": 1,
        }
        assert out["can_commit"] is True

    @pytest_asyncio.fixture(scope="class")
    @classmethod
    async def imported(cls, client):
        r = await client.post(
            "/api/import/commit",
            json={
                "source": "jira",
                "sample": SAMPLE,
                "name": "Imported delivery platform",
                "today_day": 0.0,
            },
        )
        assert r.status_code == 201, r.text
        return r.json()

    async def test_commit_creates_a_project(self, imported):
        assert imported["project"]["project_id"]
        assert imported["project"]["start_date"] == "2026-09-01"
        assert imported["project"]["deadline"] == "2026-09-21"
        assert imported["counts"]["tasks"] == 14

    async def test_commit_carries_the_rejections_forward(self, imported):
        """Committing must not be a way to stop seeing what preview showed."""
        assert len(imported["rejected_rows"]) == 3
        assert len(imported["dropped_dependencies"]) == 1
        assert imported["assumptions"]["stated_plainly"]

    async def test_the_committed_workflow_has_the_edges(self, client, imported):
        pid = imported["project"]["project_id"]
        r = await client.get(f"/api/projects/{pid}/workflow")
        assert r.status_code == 200, r.text
        body = r.json()
        edges = {(d["from_task"], d["to_task"]) for d in body["dependencies"]}
        assert ("DLV-6", "DLV-11") in edges
        assert ("DLV-11", "DLV-12") in edges
        assert len(body["tasks"]) == 14

    async def test_the_committed_statuses_survive(self, client, imported):
        pid = imported["project"]["project_id"]
        body = (await client.get(f"/api/projects/{pid}/workflow")).json()
        by_key = {t["key"]: t for t in body["tasks"]}
        assert by_key["DLV-1"]["status"] == "done"
        assert by_key["DLV-3"]["status"] == "in_review"
        assert by_key["DLV-11"]["status"] == "blocked"

    async def test_it_evaluates_to_a_workflow_with_findings(self, client, imported):
        pid = imported["project"]["project_id"]
        r = await client.post(f"/api/projects/{pid}/analyze")
        assert r.status_code == 200, r.text
        analysis = r.json()
        assert analysis["critical_path"] == [
            "DLV-1", "DLV-2", "DLV-3", "DLV-5", "DLV-11", "DLV-12", "DLV-13",
            "DLV-14",
        ]
        kinds = {f["kind"] for f in analysis["findings"]}
        assert "resource_overallocated" in kinds
        assert "single_point_of_failure" in kinds
        assert "deadline_infeasible" in kinds
        assert analysis["feasibility"]["verdict"] == "infeasible"

    async def test_the_import_invents_no_history(self, client, imported):
        """An import is a plan, not a record of what happened."""
        pid = imported["project"]["project_id"]
        analysis = (
            await client.post(f"/api/projects/{pid}/analyze")
        ).json()
        assert analysis["tier_reached"] < 2
        assert analysis["unavailable_checks"]

    async def test_every_claim_the_sample_makes_about_itself_is_true(self):
        """`demonstrates` is asserted, not asserted-to-be-asserted."""
        sample = S.get_sample(SAMPLE)
        out = preview_of(sample_text())
        claims = " ".join(sample.demonstrates)
        assert "DLV-99" in claims and out["dropped_dependencies"]
        assert "Awaiting Copy" in claims
        assert "TBD" in claims
        assert len(out["rejected_rows"]) == 3
        header = next(csv.reader(io.StringIO(sample_text())))
        assert header.count("Outward issue link (Blocks)") == 4


class TestCommitLooksLikeAHandMadeProject:
    """`POST /api/import/commit` must produce nothing another endpoint has to
    special-case. The owner membership is the part most easily forgotten."""

    @pytest_asyncio.fixture(scope="class")
    @classmethod
    async def person(cls, client):
        return (
            await client.post("/api/users", json={"name": "Import Owner"})
        ).json()

    @pytest_asyncio.fixture(scope="class")
    @classmethod
    async def by_hand(cls, client, person):
        r = await client.post(
            "/api/projects",
            json={"name": "By hand", "start_date": "2026-09-01"},
            headers={"X-User-Id": person["id"]},
        )
        assert r.status_code == 201, r.text
        return r.json()

    @pytest_asyncio.fixture(scope="class")
    @classmethod
    async def by_import(cls, client, person):
        r = await client.post(
            "/api/import/commit",
            json={"source": "jira", "sample": SAMPLE, "name": "By import"},
            headers={"X-User-Id": person["id"]},
        )
        assert r.status_code == 201, r.text
        return r.json()["project"]

    async def test_the_owner_membership_matches(self, client, by_hand, by_import, person):
        hand = (
            await client.get(f"/api/projects/{by_hand['id']}/members")
        ).json()
        imported = (
            await client.get(f"/api/projects/{by_import['project_id']}/members")
        ).json()
        assert [(m["user_id"], m["role"]) for m in hand] == [
            (person["id"], "owner")
        ]
        assert [(m["user_id"], m["role"]) for m in imported] == [
            (person["id"], "owner")
        ]

    async def test_created_by_matches(self, by_hand, by_import, person):
        assert by_hand["created_by"] == person["id"]
        assert by_import["created_by"] == person["id"]

    async def test_an_explicit_owner_email_wins_the_same_way(self, client):
        r = await client.post(
            "/api/import/commit",
            json={
                "source": "jira",
                "sample": SAMPLE,
                "name": "Owned by email",
                "owner_email": "import-owner@example.com",
            },
        )
        assert r.status_code == 201, r.text
        pid = r.json()["project"]["project_id"]
        members = (await client.get(f"/api/projects/{pid}/members")).json()
        assert [(m["email"], m["role"]) for m in members] == [
            ("import-owner@example.com", "owner")
        ]

    async def test_the_version_is_a_draft_with_provenance(self, client, by_import):
        pid = by_import["project_id"]
        versions = (await client.get(f"/api/projects/{pid}/versions")).json()
        assert len(versions) == 1
        assert versions[0]["version_no"] == 1
        assert versions[0]["is_draft"] is True
        assert "Imported from a jira CSV" in versions[0]["note"]

    async def test_an_import_never_names_an_existing_project(self):
        """There is no `project_id` on the commit body, on purpose."""
        assert "project_id" not in ingest_router.CommitRequest.model_fields


# ---------------------------------------------------------------------------
# 5. The generic CSV path
# ---------------------------------------------------------------------------


GENERIC = (
    "id,title,owner,days,state,due,depends on\n"
    "P1,Draft the brief,Ana,2,wip,2026-05-04,\n"
    "P2,Cost the options,Ben,3,queued,2026-05-08,P1\n"
    "P3,Pick one,Ana,1,queued,2026-05-11,P2\n"
)

GENERIC_MAPPING = {
    "key": "id",
    "name": "title",
    "assignee": "owner",
    "effort": "days",
    "status": "state",
    "due_date": "due",
    "blocked_by": ["depends on"],
    "status_values": {"wip": "in_progress", "queued": "not_started"},
}


class TestGenericCsvPath:
    async def test_a_mapped_csv_imports(self, client):
        r = await client.post(
            "/api/import/preview",
            json={
                "source": "csv",
                "csv_text": GENERIC,
                "mapping": GENERIC_MAPPING,
                "story_point_days": 1.0,
            },
        )
        assert r.status_code == 200, r.text
        out = r.json()
        assert [t["key"] for t in out["would_create"]["tasks"]] == ["P1", "P2", "P3"]
        assert {
            (d["from_task"], d["to_task"])
            for d in out["would_create"]["dependencies"]
        } == {("P1", "P2"), ("P2", "P3")}
        assert out["would_create"]["tasks"][0]["status"] == "in_progress"

    async def test_the_caller_supplied_vocabulary_is_not_marked_assumed(self, client):
        out = (
            await client.post(
                "/api/import/preview",
                json={
                    "source": "csv", "csv_text": GENERIC,
                    "mapping": GENERIC_MAPPING,
                },
            )
        ).json()
        reading = out["rows"][0]["interpretation"]["status"]
        assert reading["assumed"] is False
        assert "status_values you supplied" in reading["how"]

    async def test_the_generic_path_commits(self, client):
        r = await client.post(
            "/api/import/commit",
            json={
                "source": "csv",
                "csv_text": GENERIC,
                "mapping": GENERIC_MAPPING,
                "name": "Procurement decision",
            },
        )
        assert r.status_code == 201, r.text
        assert r.json()["counts"]["tasks"] == 3

    async def test_a_generic_import_without_a_mapping_is_refused(self, client):
        r = await client.post(
            "/api/import/preview", json={"source": "csv", "csv_text": GENERIC}
        )
        assert r.status_code == 422
        assert "mapping" in json.dumps(r.json()["detail"])

    def test_a_mapping_without_a_key_column_is_refused(self):
        with pytest.raises(MappingProblem) as exc:
            mapping_from_payload({"name": "title"})
        assert "mapping.key" in str(exc.value)

    def test_a_typo_in_a_mapping_field_is_refused_rather_than_ignored(self):
        with pytest.raises(MappingProblem) as exc:
            mapping_from_payload({"key": "id", "blockedby": "deps"})
        assert "blockedby" in str(exc.value)

    def test_an_unknown_status_target_is_refused(self):
        with pytest.raises(MappingProblem) as exc:
            mapping_from_payload(
                {"key": "id", "status_values": {"wip": "half_done"}}
            )
        assert "half_done" in str(exc.value)

    def test_one_parser_serves_both_doors(self):
        """The generic path with Jira's own column names must produce exactly
        what the Jira preset produces - otherwise there are two importers."""
        from backend.app.ingest.mapping import JIRA_MAPPING

        text = sample_text()
        preset = build_jira_plan(text)
        by_hand = build_plan(
            text,
            mapping_from_payload(
                {
                    "key": "Issue key",
                    "name": "Summary",
                    "description": "Description",
                    "assignee": "Assignee",
                    "status": "Status",
                    "status_category": "Status Category",
                    "story_points": "Story Points",
                    "estimate": "Original Estimate",
                    "due_date": "Due date",
                    "created": "Created",
                    "blocks": "Outward issue link (Blocks)",
                    "blocked_by": "Inward issue link (Blocks)",
                }
            ),
            source="csv",
        )
        assert by_hand.snapshot().content_hash() == preset.snapshot().content_hash()
        assert len(by_hand.rejected_rows) == len(preset.rejected_rows)
        assert JIRA_MAPPING.key[0] == "Issue key"


# ---------------------------------------------------------------------------
# 6. The webhook
# ---------------------------------------------------------------------------


def issue_event(key: str, action: str = "closed", **extra) -> dict:
    return {
        "action": action,
        "issue": {
            "number": 4,
            "title": f"{key} Tidy the runbook",
            "body": "",
            "updated_at": "2026-09-08T09:00:00Z",
            **extra,
        },
        "repository": {"full_name": "acme/delivery"},
        "sender": {"login": "octocat"},
    }


def pr_event(action: str, branch: str, merged: bool = False) -> dict:
    return {
        "action": action,
        "pull_request": {
            "number": 12,
            "title": "Adapter work",
            "body": "",
            "merged": merged,
            "head": {"ref": branch},
            "updated_at": "2026-09-09T12:00:00Z",
        },
        "repository": {"full_name": "acme/delivery"},
        "sender": {"login": "octocat"},
    }


@pytest.fixture
def webhook_enabled(monkeypatch):
    monkeypatch.setattr(settings, "GITHUB_WEBHOOK_SECRET", WEBHOOK_SECRET)


class TestGithubWebhook:
    @pytest_asyncio.fixture(scope="class")
    @classmethod
    async def project_id(cls, client):
        r = await client.post(
            "/api/import/commit",
            json={"source": "jira", "sample": SAMPLE, "name": "Webhook target"},
        )
        assert r.status_code == 201, r.text
        return r.json()["project"]["project_id"]

    async def post(self, client, project_id, payload, event, secret=WEBHOOK_SECRET,
                   signature=None):
        body = json.dumps(payload).encode()
        headers = {
            "X-GitHub-Event": event,
            "X-GitHub-Delivery": "delivery-1",
            "Content-Type": "application/json",
        }
        if signature is not False:
            headers["X-Hub-Signature-256"] = signature or signed(body, secret)
        url = "/api/ingest/github"
        if project_id:
            url += f"?project_id={project_id}"
        return await client.post(url, content=body, headers=headers)

    async def test_an_unset_secret_rejects_rather_than_accepts(
        self, client, project_id, monkeypatch
    ):
        """The default must be closed. An unauthenticated write path on a
        public URL is not a convenience."""
        monkeypatch.setattr(settings, "GITHUB_WEBHOOK_SECRET", "")
        r = await self.post(client, project_id, issue_event("DLV-12"), "issues")
        assert r.status_code == 403
        assert "GITHUB_WEBHOOK_SECRET" in r.json()["detail"]

    async def test_a_wrong_signature_is_rejected(
        self, client, project_id, webhook_enabled
    ):
        r = await self.post(
            client, project_id, issue_event("DLV-12"), "issues",
            secret="not-the-secret",
        )
        assert r.status_code == 401
        assert "does not match" in r.json()["detail"]

    async def test_a_missing_signature_is_rejected(
        self, client, project_id, webhook_enabled
    ):
        r = await self.post(
            client, project_id, issue_event("DLV-12"), "issues", signature=False
        )
        assert r.status_code == 401
        assert "Missing" in r.json()["detail"]

    async def test_a_signature_over_a_different_body_is_rejected(
        self, client, project_id, webhook_enabled
    ):
        r = await self.post(
            client, project_id, issue_event("DLV-12"), "issues",
            signature=signed(b'{"action":"closed"}'),
        )
        assert r.status_code == 401

    async def test_a_correct_signature_is_accepted_and_recorded(
        self, client, project_id, webhook_enabled
    ):
        r = await self.post(client, project_id, issue_event("DLV-12"), "issues")
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["recorded"] is True
        assert out["task_key"] == "DLV-12"
        assert out["appended"]["to_status"] == "done"
        assert out["appended"]["from_status"] == "not_started"
        assert out["appended"]["actor"] == "octocat"
        assert out["appended"]["day"] == 7.0

    async def test_the_event_reaches_the_projects_log(
        self, client, project_id, webhook_enabled
    ):
        log = await events_of(project_id)
        assert ("DLV-12", "not_started", "done", 7.0) in log

    async def test_a_replay_of_the_same_delivery_changes_nothing(
        self, client, project_id, webhook_enabled
    ):
        before = await events_of(project_id)
        r = await self.post(client, project_id, issue_event("DLV-12"), "issues")
        assert r.status_code == 202, r.text
        assert r.json()["recorded"] is False
        assert "already done" in r.json()["reason"]
        assert await events_of(project_id) == before

    async def test_the_webhook_does_not_edit_the_stored_workflow(
        self, client, project_id, webhook_enabled
    ):
        body = (await client.get(f"/api/projects/{project_id}/workflow")).json()
        by_key = {t["key"]: t for t in body["tasks"]}
        assert by_key["DLV-12"]["status"] == "not_started"

    async def test_a_pull_request_resolves_by_branch_name(
        self, client, project_id, webhook_enabled
    ):
        r = await self.post(
            client, project_id, pr_event("opened", "feature/DLV-4-contract-tests"),
            "pull_request",
        )
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["task_key"] == "DLV-4"
        assert out["appended"]["to_status"] == "in_review"
        assert "head branch" in out["how"]["task"]

    async def test_a_merged_pull_request_is_done(
        self, client, project_id, webhook_enabled
    ):
        r = await self.post(
            client, project_id,
            pr_event("closed", "feature/DLV-4-contract-tests", merged=True),
            "pull_request",
        )
        assert r.json()["appended"]["to_status"] == "done"

    async def test_a_key_prefix_does_not_shadow_a_longer_key(
        self, client, project_id, webhook_enabled
    ):
        r = await self.post(
            client, project_id, pr_event("opened", "fix/DLV-14-verification"),
            "pull_request",
        )
        assert r.json()["task_key"] == "DLV-14"

    async def test_an_unhandled_event_is_accepted_and_ignored(
        self, client, project_id, webhook_enabled
    ):
        r = await self.post(
            client, project_id, {"action": "created"}, "issue_comment"
        )
        assert r.status_code == 202
        assert r.json()["recorded"] is False
        assert "not an event this receiver reads" in r.json()["reason"]

    async def test_an_action_with_no_status_meaning_is_ignored(
        self, client, project_id, webhook_enabled
    ):
        r = await self.post(
            client, project_id, issue_event("DLV-9", action="labeled"), "issues"
        )
        assert r.status_code == 202
        assert "says nothing about whether the work moved" in r.json()["reason"]

    async def test_a_ping_is_answered(self, client, project_id, webhook_enabled):
        r = await self.post(client, project_id, {"zen": "Keep it logically awesome."}, "ping")
        assert r.status_code == 200
        assert r.json()["event"] == "ping"

    async def test_an_event_about_untracked_work_records_nothing(
        self, client, project_id, webhook_enabled
    ):
        r = await self.post(
            client, project_id, issue_event("SOMETHING-ELSE-1"), "issues"
        )
        assert r.status_code == 202
        assert r.json()["recorded"] is False
        assert "no task key from this project" in r.json()["reason"]

    async def test_a_delivery_with_no_project_says_what_to_add_to_the_url(
        self, client, webhook_enabled
    ):
        r = await self.post(client, None, issue_event("DLV-9"), "issues")
        assert r.status_code == 422
        assert "project_id" in r.json()["detail"]

    async def test_a_delivery_for_a_missing_project_is_a_404(
        self, client, webhook_enabled
    ):
        r = await self.post(
            client, "00000000-0000-0000-0000-0000000000ff",
            issue_event("DLV-9"), "issues",
        )
        assert r.status_code == 404

    async def test_a_signed_but_unparseable_body_is_not_a_500(
        self, client, project_id, webhook_enabled
    ):
        body = b"not json at all"
        r = await client.post(
            f"/api/ingest/github?project_id={project_id}",
            content=body,
            headers={
                "X-GitHub-Event": "issues",
                "X-Hub-Signature-256": signed(body),
                "Content-Type": "application/json",
            },
        )
        assert r.status_code == 422
        assert "not valid JSON" in r.json()["detail"]

    def test_the_split_between_the_two_routers_is_the_one_deps_expects(self):
        """`test_auth.UNGUARDED_BY_DESIGN` names this exact template, and the
        import router is guarded precisely because importing is authorship.
        A route moved between the two would silently change who may write."""
        assert "/api/ingest/github" in app.openapi()["paths"]
        assert not ingest_router.webhook_router.dependencies
        assert ingest_router.router.dependencies
        assert ingest_router.router.prefix == "/api/import"


# ---------------------------------------------------------------------------
# 7. Bounds, and the odds and ends
# ---------------------------------------------------------------------------


class TestBounds:
    async def test_an_oversized_body_is_a_413_not_an_out_of_memory(
        self, client, monkeypatch
    ):
        """The ceiling is enforced while reading, so the real 500 MB case
        never reaches memory. Shrinking the ceiling exercises the same code."""
        monkeypatch.setattr(ingest_router, "MAX_BODY_BYTES", 64)
        r = await client.post(
            "/api/import/preview",
            json={"source": "jira", "csv_text": sample_text()},
        )
        assert r.status_code == 413
        assert "Nothing was read" in r.json()["detail"]

    async def test_an_oversized_csv_inside_a_legal_body_is_explained(
        self, client, monkeypatch
    ):
        from backend.app.ingest import csvsource

        text = sample_text()
        monkeypatch.setattr(csvsource, "MAX_CSV_BYTES", 128)
        r = await client.post(
            "/api/import/preview",
            json={"source": "jira", "csv_text": text},
        )
        assert r.status_code == 422
        assert "at most" in r.json()["detail"]

    async def test_an_empty_body_is_explained(self, client):
        r = await client.post(
            "/api/import/preview", content=b"",
            headers={"Content-Type": "application/json"},
        )
        assert r.status_code == 422
        assert "empty" in r.json()["detail"]

    async def test_a_body_that_names_neither_file_nor_sample_is_refused(self, client):
        r = await client.post("/api/import/preview", json={"source": "jira"})
        assert r.status_code == 422
        assert "invalid_fields" in r.json()["detail"]

    async def test_validation_errors_keep_the_usual_shape(self, client):
        r = await client.post(
            "/api/import/preview",
            json={"source": "jira", "csv_text": "a", "story_point_days": -1},
        )
        assert r.status_code == 422
        fields = {f["field"] for f in r.json()["detail"]["invalid_fields"]}
        assert "story_point_days" in fields


class TestDateReading:
    def test_jira_default_format(self):
        assert parse_date("20/Sep/26 5:00 PM").isoformat() == "2026-09-20"

    def test_iso(self):
        assert parse_date("2026-09-20").isoformat() == "2026-09-20"

    def test_an_all_numeric_slash_date_is_refused_as_ambiguous(self):
        with pytest.raises(ValueError) as exc:
            parse_date("03/04/2026")
        assert "locale" in str(exc.value)


class TestPreviewIsStateless:
    async def test_commit_reparses_rather_than_trusting_the_preview(self, client):
        """There is no import-batch table, so a commit whose body differs from
        the previewed one produces the commit's content, not the preview's."""
        previewed = await client.post(
            "/api/import/preview", json={"source": "jira", "sample": SAMPLE}
        )
        assert previewed.json()["counts"]["tasks"] == 14

        committed = await client.post(
            "/api/import/commit",
            json={
                "source": "jira",
                "csv_text": "Issue key,Summary,Story Points\nZ-1,Only this,1\n",
                "name": "Different content",
            },
        )
        assert committed.status_code == 201
        assert committed.json()["counts"]["tasks"] == 1
        assert (
            committed.json()["csv_sha256"] != previewed.json()["csv_sha256"]
        )

    async def test_the_content_hash_is_reported_so_it_can_be_checked(self, client):
        text = "Issue key,Summary,Story Points\nZ-2,A thing,1\n"
        expected = hashlib.sha256(text.encode()).hexdigest()
        r = await client.post(
            "/api/import/preview", json={"source": "jira", "csv_text": text}
        )
        assert r.json()["csv_sha256"] == expected
