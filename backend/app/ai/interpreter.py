"""
The Interpreter: natural language in, a mutation list out.

It computes nothing. It produces a `MutationList` which is then validated
semantically and turned into a **pending** scenario - never applied. A human
has to press apply, and that call is the only write path to workflow state
(ARCHITECTURE B.2).

Under `NullProvider` the fallback is a small, clearly-labelled pattern matcher
over the same handful of shapes the UI form offers. It is not a model and does
not pretend to be one: when it does not recognise a phrase it says so and
returns nothing, rather than guessing.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from backend.app.ai.projection import project, render
from backend.app.ai.provider import INTERPRETER, AIProvider, AIRequest
from backend.app.ai.runner import Interaction, ResponseCache, attempt
from backend.app.ai.schemas import (
    InterpretationOut,
    MutationOut,
    interpretation_schema,
)
from backend.app.core.engine.evaluate import EvaluationResult
from backend.app.core.workflow import WorkflowSnapshot, WorkflowState

SYSTEM = """\
You translate a person's request about a project workflow into a list of typed
mutations. You do not compute anything: every date, duration, slack figure and
risk score comes from a deterministic engine, not from you.

Rules you must follow:

1. Emit only mutations from the given closed set. If the request cannot be
   expressed with them, set understood=false and list what you could not
   express in `unsupported`. Never approximate.
2. Reference every task and resource by its `key`, never by its name.
3. Do not invent tasks, resources or requirements that are not in the
   workflow given to you.
4. Do not remove a task that carries a MANDATORY_TASK constraint, do not drop
   a dependency that carries IMMUTABLE_DEPENDENCY, and do not split a task
   that carries NON_DIVISIBLE_TASK. If the request asks for one of these, set
   understood=false and say which constraint forbids it.
5. Prefer the smallest set of mutations that expresses the request.
6. `intent` restates the request in one sentence. It is not a summary of what
   will happen - you do not know what will happen until the engine runs.
"""


@dataclass
class Interpretation:
    understood: bool
    intent: str
    mutations: list[dict[str, Any]] = field(default_factory=list)
    unsupported: list[str] = field(default_factory=list)
    clarification_needed: str = ""
    method: str = "model"
    interaction: Interaction | None = None

    def as_dict(self) -> dict:
        return {
            "understood": self.understood,
            "intent": self.intent,
            "mutations": self.mutations,
            "unsupported": self.unsupported,
            "clarification_needed": self.clarification_needed,
            "method": self.method,
            "note": (
                "This is a proposal. Nothing has been changed - it becomes a "
                "pending scenario you can evaluate, edit or discard."
            ),
        }


def interpret(
    utterance: str,
    snapshot: WorkflowSnapshot,
    state: WorkflowState,
    provider: AIProvider,
    result: EvaluationResult | None = None,
    domain_name: str | None = None,
    domain_hints: list[str] | None = None,
    cache: ResponseCache | None = None,
) -> Interpretation:
    payload = render(
        project(snapshot, state, result, domain_name, domain_hints)
    )
    request = AIRequest(
        role=INTERPRETER,
        system=SYSTEM,
        user=(
            f"Workflow:\n{payload}\n\n"
            f"Request:\n{utterance.strip()}\n\n"
            f"Return the mutations that express this request."
        ),
        schema=interpretation_schema(),
        schema_name="InterpretationOut",
        effort="low",
    )

    outcome = attempt(
        provider,
        request,
        InterpretationOut,
        fallback=lambda: _deterministic(utterance, snapshot),
        cache=cache,
    )
    value = outcome.value
    if isinstance(value, InterpretationOut):
        return Interpretation(
            understood=value.understood,
            intent=value.intent,
            mutations=[m.as_dict() for m in value.mutations],
            unsupported=list(value.unsupported),
            clarification_needed=value.clarification_needed,
            method="model",
            interaction=outcome.interaction,
        )
    value.interaction = outcome.interaction
    return value


# ---------------------------------------------------------------------------
# The deterministic fallback
# ---------------------------------------------------------------------------

_NUM = r"(\d+(?:\.\d+)?)"


def _deterministic(
    utterance: str, snapshot: WorkflowSnapshot
) -> Interpretation:
    """A labelled pattern matcher, not a model.

    It handles the same shapes the what-if form offers, so the natural-language
    entry point still does something useful with no API key. Anything it does
    not recognise comes back `understood=false` with a pointer at the form -
    which is the honest answer, and the one ARCHITECTURE B.3 asks for.
    """
    text = utterance.lower().strip()
    tasks = {t.key.lower(): t.key for t in snapshot.tasks}
    task_names = {t.name.lower(): t.key for t in snapshot.tasks}
    resources = {r.key.lower(): r.key for r in snapshot.resources}
    resource_names = {r.name.lower(): r.key for r in snapshot.resources}

    # Keys are lowercase, so an intent built from a key reads "anitha is
    # unavailable" - a person's name in lower case, which looks like a bug to
    # the user even though the mutation underneath is right. The intent is the
    # sentence a human reads back; it gets the display name.
    def label(key: str) -> str:
        for task in snapshot.tasks:
            if task.key == key:
                return f"{task.key} ({task.name})" if task.name else task.key
        for resource in snapshot.resources:
            if resource.key == key:
                return resource.name or resource.key
        return key

    def find_task() -> str | None:
        for key_lower, key in tasks.items():
            if re.search(rf"\b{re.escape(key_lower)}\b", text):
                return key
        for name, key in sorted(task_names.items(), key=lambda kv: -len(kv[0])):
            if name and name in text:
                return key
        return None

    def find_resource() -> str | None:
        for key_lower, key in resources.items():
            if re.search(rf"\b{re.escape(key_lower)}\b", text):
                return key
        for name, key in sorted(
            resource_names.items(), key=lambda kv: -len(kv[0])
        ):
            if name and name.lower() in text:
                return key
        return None

    def unmatched(reason: str) -> Interpretation:
        return Interpretation(
            understood=False,
            intent=utterance.strip(),
            unsupported=[reason],
            clarification_needed=(
                "No language model is configured, so this is a pattern "
                "matcher rather than an interpreter. Use the what-if form to "
                "compose the change exactly, or set ANTHROPIC_API_KEY."
            ),
            method="deterministic_patterns",
        )

    # "T03 slips 5 days" / "delay T03 by 5 days" / "T14 is running late"
    # Trailing \w* so "slips", "delayed" and "takes" match too: \bslip\b does
    # not match "slips", which is exactly the sort of thing a pattern matcher
    # gets wrong and a model does not. This fallback is a convenience, not an
    # interpreter, and it says so when it misses.
    if re.search(r"\b(slip|delay|late|overrun|take|longer|slow)\w*", text):
        task = find_task()
        days = re.search(rf"{_NUM}\s*(?:more\s*)?day", text)
        if task and days:
            return Interpretation(
                understood=True,
                intent=(
                    f"{label(task)} takes {days.group(1)} more "
                    f"day(s) than expected"
                ),
                mutations=[
                    MutationOut(
                        kind="TASK_DELAY_ADD",
                        payload={"key": task, "extra_days": float(days.group(1))},
                    ).as_dict()
                ],
                method="deterministic_patterns",
            )

    # "Priya is unavailable from day 14 to day 21"
    if re.search(r"\b(unavailable|away|off|out|leave|holiday|absent|sick)\w*", text):
        resource = find_resource()
        window = re.findall(rf"day\s*{_NUM}", text)
        if resource and len(window) >= 2:
            return Interpretation(
                understood=True,
                intent=(
                    f"{label(resource)} is unavailable from day {window[0]} "
                    f"to day {window[1]}"
                ),
                mutations=[
                    MutationOut(
                        kind="RESOURCE_UNAVAILABLE_WINDOW",
                        payload={
                            "resource_key": resource,
                            "from_day": float(window[0]),
                            "to_day": float(window[1]),
                        },
                    ).as_dict()
                ],
                method="deterministic_patterns",
            )
        if resource:
            return unmatched(
                f"I can see this is about {label(resource)}, but not which "
                f"days. Say "
                f"'from day 14 to day 21'."
            )

    # "split T14 across 2 people"
    if re.search(r"\b(split|divid|parallel|more people|two people)\w*", text):
        task = find_task()
        parts = re.search(rf"{_NUM}\s*(?:people|persons|ways|parts)", text)
        if task:
            return Interpretation(
                understood=True,
                intent=(
                    f"{label(task)} is split across "
                    f"{parts.group(1) if parts else '2'} people"
                ),
                mutations=[
                    MutationOut(
                        kind="TASK_SPLIT",
                        payload={
                            "key": task,
                            "parts": int(float(parts.group(1))) if parts else 2,
                        },
                    ).as_dict()
                ],
                method="deterministic_patterns",
            )

    # "give marketing capacity 3"
    if re.search(r"\bcapacity\b", text):
        resource = find_resource()
        cap = re.search(rf"capacity\s*(?:of|to)?\s*{_NUM}", text)
        if resource and cap:
            return Interpretation(
                understood=True,
                intent=(
                    f"{label(resource)} can run {cap.group(1)} task(s) "
                    f"at once"
                ),
                mutations=[
                    MutationOut(
                        kind="RESOURCE_CAPACITY_SET",
                        payload={
                            "resource_key": resource,
                            "capacity": int(float(cap.group(1))),
                        },
                    ).as_dict()
                ],
                method="deterministic_patterns",
            )

    return unmatched(
        "I could not match this to any change I know how to make."
    )
