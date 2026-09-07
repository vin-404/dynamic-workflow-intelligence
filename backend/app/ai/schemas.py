
"""
Output schemas for the three roles.

Every model response is constrained by one of these and then validated with
Pydantic. On a validation failure there is **exactly one** repair attempt with
the error appended, and then a rejection with a user-visible reason - no
unbounded retries, and no parsing of free text (ARCHITECTURE B.4).

The Interpreter and Proposer schemas both bottom out in `MutationOut`, whose
`kind` is the closed algebra. That is the whole guard rail: the only thing the
model can emit is a member of a set the engine already knows how to validate,
apply and invert.
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator

from backend.app.core.mutations import MutationKind

VALID_KINDS = tuple(k.value for k in MutationKind)


class MutationOut(BaseModel):
    """One mutation. `kind` is closed - the model cannot invent a new one."""

    kind: str
    payload: dict[str, Any] = Field(default_factory=dict)

    @field_validator("kind")
    @classmethod
    def _known_kind(cls, value: str) -> str:
        if value not in VALID_KINDS:
            raise ValueError(
                f"{value!r} is not a mutation this system can express. "
                f"Valid kinds: {', '.join(VALID_KINDS)}."
            )
        return value

    def as_dict(self) -> dict:
        return {"kind": self.kind, "payload": dict(self.payload)}


class InterpretationOut(BaseModel):
    """Natural language in, a mutation list out. It computes nothing."""

    understood: bool = Field(
        description="False when the request cannot be expressed as mutations."
    )
    intent: str = Field(
        default="", description="One sentence restating what was asked."
    )
    mutations: list[MutationOut] = Field(default_factory=list)
    #: What the model could not express, so the user sees the gap rather than
    #: a silently narrowed request.
    unsupported: list[str] = Field(default_factory=list)
    clarification_needed: str = ""


class ProposalOut(BaseModel):
    """One candidate restructuring. It does not score itself."""

    name: str
    rationale: str
    mutations: list[MutationOut] = Field(min_length=1)


class ProposalsOut(BaseModel):
    proposals: list[ProposalOut] = Field(default_factory=list)


class NarrationOut(BaseModel):
    """Prose over an engine result. It introduces no facts."""

    headline: str
    explanation: str
    #: Every number the narration uses, echoed back. The narrator test checks
    #: each one against the input payload - a number here that is not in the
    #: input is a fabrication, and the response is rejected.
    numbers_used: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# JSON schemas sent to the model
# ---------------------------------------------------------------------------


def _mutation_schema() -> dict:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["kind", "payload"],
        "properties": {
            "kind": {
                "type": "string",
                "enum": list(VALID_KINDS),
                "description": "The mutation kind. This set is closed.",
            },
            "payload": {
                "type": "object",
                "description": (
                    "Fields for this mutation kind. Reference tasks and "
                    "resources by their key, never by name."
                ),
            },
        },
    }


def interpretation_schema() -> dict:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["understood", "intent", "mutations", "unsupported"],
        "properties": {
            "understood": {"type": "boolean"},
            "intent": {"type": "string"},
            "mutations": {"type": "array", "items": _mutation_schema()},
            "unsupported": {"type": "array", "items": {"type": "string"}},
            "clarification_needed": {"type": "string"},
        },
    }


def proposals_schema() -> dict:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["proposals"],
        "properties": {
            "proposals": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["name", "rationale", "mutations"],
                    "properties": {
                        "name": {"type": "string"},
                        "rationale": {"type": "string"},
                        "mutations": {
                            "type": "array",
                            "minItems": 1,
                            "items": _mutation_schema(),
                        },
                    },
                },
            }
        },
    }


def narration_schema() -> dict:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["headline", "explanation", "numbers_used"],
        "properties": {
            "headline": {"type": "string"},
            "explanation": {"type": "string"},
            "numbers_used": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Every numeric value used in the prose, exactly as "
                    "written. Each must come from the input payload."
                ),
            },
        },
    }
