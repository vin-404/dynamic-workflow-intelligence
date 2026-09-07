"""
`core/` is pure, and this is what enforces it.

The invariant (ARCHITECTURE A.1): `core/` imports no web framework, no ORM,
no AI client, no settings module and nothing from `api/`, `services/`, `db/`
or `ai/`, and it performs no I/O. Three things depend on it:

* the optimizer must run thousands of evaluations, so nothing may touch a
  database per evaluation;
* intelligence must be testable without a database or an API key;
* what-if cannot accidentally mutate real state if the evaluator physically
  cannot write.

Enforced by parsing the source (decision D-05) rather than by importing it, so
a violation is caught in a module no other test happens to execute, and a lazy
import inside a function is caught too.
"""
from __future__ import annotations

import ast
import pathlib

import pytest

CORE = pathlib.Path(__file__).resolve().parents[1] / "app" / "core"

#: Top-level modules `core/` may never import.
FORBIDDEN_ROOTS = {
    # web
    "fastapi", "starlette", "uvicorn",
    # persistence
    "sqlalchemy", "aiosqlite", "alembic", "asyncpg", "psycopg2", "sqlite3",
    # settings / config plumbing
    "pydantic", "pydantic_settings", "dotenv",
    # network / AI clients
    "httpx", "requests", "urllib", "socket", "anthropic", "openai",
    # anything that reaches the filesystem or the environment
    "os", "pathlib", "shutil", "tempfile", "subprocess", "io", "open",
    # a clock of its own: the clock is an argument
    "time",
}

#: Internal packages `core/` may never depend on. `core/` depends on nothing
#: internal; every other layer may depend on `core/`.
FORBIDDEN_INTERNAL_PREFIXES = (
    "backend.app.api",
    "backend.app.services",
    "backend.app.models",
    "backend.app.schemas",
    "backend.app.ai",
    "backend.app.db",
    "backend.app.settings",
    "backend.app.seed",
    "backend.app.main",
)

#: The only third-party dependency `core/` is allowed.
ALLOWED_THIRD_PARTY = {"networkx"}


def _core_modules() -> list[pathlib.Path]:
    return sorted(CORE.rglob("*.py"))


def _imported_roots(tree: ast.AST) -> set[str]:
    """Every module name imported anywhere in the file, including inside
    functions and inside `if TYPE_CHECKING` blocks."""
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.level:  # relative import, stays inside core/
                continue
            if node.module:
                names.add(node.module)
    return names


def test_core_has_modules_to_check():
    """Guard against the suite passing because it found nothing."""
    assert len(_core_modules()) >= 5


@pytest.mark.parametrize(
    "path", _core_modules(), ids=lambda p: p.name
)
def test_module_imports_nothing_forbidden(path: pathlib.Path):
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for name in sorted(_imported_roots(tree)):
        root = name.split(".")[0]

        if name.startswith("backend.app.core"):
            continue
        assert not name.startswith(FORBIDDEN_INTERNAL_PREFIXES), (
            f"{path.name} imports {name!r}: core/ depends on nothing internal"
        )
        assert root not in FORBIDDEN_ROOTS, (
            f"{path.name} imports {name!r}, which is forbidden in core/"
        )


@pytest.mark.parametrize("path", _core_modules(), ids=lambda p: p.name)
def test_module_performs_no_io(path: pathlib.Path):
    """No `open()`, no `datetime.now()`, no environment reads.

    `datetime.now()` matters as much as file access: it makes an analysis
    unreproducible, which is why `Clock` is an argument.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    banned_calls = {"open", "input", "print", "eval", "exec"}
    banned_attrs = {"now", "today", "utcnow", "getenv", "system", "urlopen"}

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Name):
            assert func.id not in banned_calls, (
                f"{path.name} calls {func.id}(): core/ performs no I/O"
            )
        elif isinstance(func, ast.Attribute):
            assert func.attr not in banned_attrs, (
                f"{path.name} calls .{func.attr}(): core/ performs no I/O and "
                f"has no clock of its own"
            )


def test_third_party_dependencies_are_only_networkx():
    """If this list grows, it should be a deliberate decision, not a drift."""
    third_party: set[str] = set()
    stdlib_ok = {
        "__future__", "dataclasses", "enum", "typing", "types", "hashlib",
        "json", "math", "itertools", "functools", "collections", "abc",
        "datetime", "random", "operator", "copy", "statistics",
    }
    for path in _core_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for name in _imported_roots(tree):
            root = name.split(".")[0]
            if name.startswith("backend.app.core") or root in stdlib_ok:
                continue
            third_party.add(root)
    assert third_party <= ALLOWED_THIRD_PARTY, (
        f"core/ grew new third-party dependencies: "
        f"{sorted(third_party - ALLOWED_THIRD_PARTY)}"
    )


def test_core_input_types_have_no_domain_field():
    """The engine's input schema has no domain field **at all** - absent, not
    ignored (ARCHITECTURE A.3). This is the structural half of the guarantee;
    `test_domain_leak.py` is the behavioural half."""
    from backend.app.core import workflow as W

    types_to_check = [
        W.WorkflowSnapshot, W.TaskSpec, W.DependencySpec, W.ResourceSpec,
        W.AssignmentSpec, W.RequirementSpec, W.ConstraintSpec, W.CalendarSpec,
        W.WorkflowState, W.Clock, W.EngineConfig,
    ]
    for t in types_to_check:
        fields = set(getattr(t, "__dataclass_fields__", {}))
        leaked = {f for f in fields if "domain" in f.lower()}
        assert not leaked, f"{t.__name__} has domain field(s): {sorted(leaked)}"


def test_no_module_level_workflow_state_in_core():
    """The prototype held `TASKS`/`STATUS`/`EVENTS` as module globals, which
    made concurrent candidate evaluation impossible. Module-level names in
    `core/` must be immutable constants, not mutable containers."""
    for path in _core_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in tree.body:
            if not isinstance(node, (ast.Assign, ast.AnnAssign)):
                continue
            value = node.value
            if isinstance(value, (ast.Dict, ast.List, ast.Set)):
                targets = (
                    node.targets if isinstance(node, ast.Assign) else [node.target]
                )
                names = [t.id for t in targets if isinstance(t, ast.Name)]
                # `__all__` is a module's export list, not workflow state.
                if names == ["__all__"]:
                    continue
                pytest.fail(
                    f"{path.name} defines mutable module-level state "
                    f"{names or '<complex target>'}; pass state in explicitly"
                )
