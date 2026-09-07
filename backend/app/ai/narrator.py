"""
The Narrator: engine result in, prose out.

It receives **only** engine output and may only rephrase it. Every number in
the narration must already exist in the payload it was given; a number that
does not is a fabrication, and the narration is rejected rather than shown
(ARCHITECTURE B.2, rule 2).

That check is enforced here, not just tested: `verify_numbers` runs on every
model narration before it is returned, and a failure falls back to the
engine's own templated explanation - which was always the primary source of
the words.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from backend.app.ai.provider import NARRATOR, AIProvider, AIRequest
from backend.app.ai.runner import Interaction, ResponseCache, attempt
from backend.app.ai.schemas import NarrationOut, narration_schema

SYSTEM = """\
You explain the result of a deterministic scheduling analysis to the person
who owns the work.

The single rule: every number you write must appear in the payload you were
given. You may round a number that is already there, and you may restate it in
words. You may not compute a new one, infer one, or estimate one. No
percentages that are not in the payload. No probabilities of any kind - this
system deliberately does not produce them.

Write plainly, in the second person, in at most four sentences. Lead with what
matters to a decision. Name the cause rather than the symptom. Do not hedge and
do not add encouragement.

List every numeric value you used in `numbers_used`, written exactly as it
appears in your prose.
"""

#: Matches numbers as a reader would see them, including decimals and
#: negatives. Ordinals and years get filtered separately.
#: A standalone numeric token. The lookaround matters: `T03` and `M09` are
#: task keys, not quantities, so neither a payload containing `T03` nor a
#: narration mentioning it counts as the number 3. Without this, every key
#: in the workflow silently licenses a digit.
_NUMBER = re.compile(r"(?<![A-Za-z0-9_.])-?\d+(?:\.\d+)?(?![A-Za-z0-9_])")


@dataclass
class Narration:
    headline: str
    explanation: str
    method: str = "model"
    interaction: Interaction | None = None
    rejected_reason: str = ""
    numbers_checked: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "headline": self.headline,
            "explanation": self.explanation,
            "method": self.method,
            "rejected_reason": self.rejected_reason,
            "numbers_checked": self.numbers_checked,
            "note": (
                "Presentation only. Every number here comes from the "
                "deterministic engine; this text cannot introduce one."
            ),
        }


def _numbers_in(text: str) -> set[str]:
    """Normalised numeric tokens, so 26, 26.0 and 26.00 compare equal."""
    out: set[str] = set()
    for raw in _NUMBER.findall(text):
        try:
            value = float(raw)
        except ValueError:  # pragma: no cover - regex guarantees parseable
            continue
        out.add(_norm(value))
    return out


def _norm(value: float) -> str:
    if value == int(value):
        return str(int(value))
    return f"{value:.4f}".rstrip("0").rstrip(".")


def _numbers_available(payload: Any) -> set[str]:
    """Every number anywhere in the engine payload, plus the roundings a
    writer may legitimately use."""
    out: set[str] = set()

    def walk(node: Any) -> None:
        if isinstance(node, bool):
            return
        if isinstance(node, (int, float)):
            out.add(_norm(float(node)))
            out.add(_norm(float(round(node))))
            out.add(_norm(abs(float(node))))
            out.add(_norm(abs(float(round(node)))))
        elif isinstance(node, str):
            out.update(_numbers_in(node))
        elif isinstance(node, dict):
            for key, value in node.items():
                # Keys carry numbers too ("day_14_load"), and a writer citing
                # one is citing the engine.
                out.update(_numbers_in(str(key)))
                walk(value)
        elif isinstance(node, (list, tuple)):
            for item in node:
                walk(item)

    walk(payload)
    return out


def verify_numbers(text: str, payload: Any) -> list[str]:
    """Numbers in `text` that are not in `payload`. Empty means clean."""
    available = _numbers_available(payload)
    return sorted(
        n for n in _numbers_in(text) if n not in available
    )


def narrate(
    payload: dict[str, Any],
    fallback_text: str,
    provider: AIProvider,
    headline: str = "",
    cache: ResponseCache | None = None,
) -> Narration:
    """Rephrase an engine result.

    `fallback_text` is the engine's own templated explanation. It is used
    whenever no model is configured, the model is rejected, **or the model
    writes a number that is not in the payload**.
    """
    import json

    rendered = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    request = AIRequest(
        role=NARRATOR,
        system=SYSTEM,
        user=(
            f"Engine result:\n{rendered}\n\n"
            f"The engine's own summary, which you are rephrasing:\n"
            f"{fallback_text}\n\n"
            f"Explain this to the person who owns the work."
        ),
        schema=narration_schema(),
        schema_name="NarrationOut",
        effort="low",
        max_tokens=2000,
    )

    def engine_words() -> Narration:
        return Narration(
            headline=headline or "Analysis",
            explanation=fallback_text,
            method="engine_template",
        )

    outcome = attempt(
        provider, request, NarrationOut, fallback=engine_words, cache=cache
    )
    if not isinstance(outcome.value, NarrationOut):
        result = outcome.value
        result.interaction = outcome.interaction
        result.rejected_reason = outcome.error
        return result

    value = outcome.value
    invented = verify_numbers(
        f"{value.headline} {value.explanation}", payload
    )
    if invented:
        # The model wrote a number the engine never produced. The narration is
        # discarded - not corrected, not shown with a caveat.
        result = engine_words()
        result.interaction = outcome.interaction
        result.rejected_reason = (
            f"The narration was discarded because it contained "
            f"{len(invented)} number(s) that the engine did not produce: "
            f"{', '.join(invented)}. The engine's own wording is shown instead."
        )
        result.numbers_checked = invented
        if result.interaction is not None:
            result.interaction.valid = False
            result.interaction.rejection_reason = result.rejected_reason
        return result

    return Narration(
        headline=value.headline,
        explanation=value.explanation,
        method="model",
        interaction=outcome.interaction,
        numbers_checked=sorted(_numbers_in(value.explanation)),
    )
