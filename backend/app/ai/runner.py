"""
The call-and-validate loop shared by all three roles.

One place implements the discipline from ARCHITECTURE B.4, so no role can
quietly skip it:

* structured output only, validated with Pydantic
* on a validation failure, **exactly one** repair attempt with the error
  appended, then reject with a user-visible reason
* responses cached by prompt hash, so a rehearsed demo path cannot fail live
  and costs nothing to repeat
* every interaction logged - role, prompt hash, schema, validation outcome,
  rejection reason - which is the evidence that the model never had authority
"""
from __future__ import annotations

from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Callable, TypeVar

from pydantic import BaseModel, ValidationError

from backend.app.ai.provider import (
    AIProvider,
    AIRejected,
    AIRequest,
    AIResponse,
    ProviderUnavailable,
)

T = TypeVar("T", bound=BaseModel)


@dataclass
class Interaction:
    """One logged call. Persisted as an `AIInteraction` row by the service
    layer; kept as a plain object here so `ai/` never touches the database."""

    role: str
    provider: str
    prompt_hash: str
    schema_name: str
    valid: bool = False
    repaired: bool = False
    cached: bool = False
    rejection_reason: str = ""
    fell_back: bool = False

    def as_dict(self) -> dict:
        return {
            "role": self.role,
            "provider": self.provider,
            "prompt_hash": self.prompt_hash,
            "schema_name": self.schema_name,
            "valid": self.valid,
            "repaired": self.repaired,
            "cached": self.cached,
            "rejection_reason": self.rejection_reason,
            "fell_back": self.fell_back,
        }


class ResponseCache:
    """Cache by prompt hash.

    Makes the demo fast, reproducible and free, and means a rehearsed path
    cannot fail live (ARCHITECTURE B.4). An explicit object rather than a
    module-level dict so tests get a clean one.
    """

    def __init__(self, seed: dict[str, str] | None = None):
        self._entries: dict[str, str] = dict(seed or {})

    def get(self, key: str) -> str | None:
        return self._entries.get(key)

    def put(self, key: str, value: str) -> None:
        self._entries[key] = value

    def __len__(self) -> int:
        return len(self._entries)

    @property
    def entries(self) -> dict[str, str]:
        return dict(self._entries)


@dataclass
class RoleResult:
    """What a role returns. `value` is None when the model was unavailable or
    rejected - the caller then uses its deterministic fallback."""

    value: Any = None
    interaction: Interaction | None = None
    error: str = ""

    @property
    def ok(self) -> bool:
        return self.value is not None


def run(
    provider: AIProvider,
    request: AIRequest,
    model: type[T],
    cache: ResponseCache | None = None,
) -> tuple[T, Interaction]:
    """Call, validate, repair once, or reject.

    Raises `ProviderUnavailable` (caller falls back) or `AIRejected` (caller
    shows the reason).
    """
    interaction = Interaction(
        role=request.role,
        provider=provider.name,
        prompt_hash=request.prompt_hash,
        schema_name=model.__name__,
    )

    cached_text = cache.get(request.prompt_hash) if cache else None
    if cached_text is not None:
        interaction.cached = True
        try:
            value = model.model_validate_json(cached_text)
        except ValidationError as exc:
            # A poisoned cache entry must not be trusted; drop it and re-ask.
            interaction.cached = False
            del cache._entries[request.prompt_hash]  # type: ignore[union-attr]
        else:
            interaction.valid = True
            return value, interaction

    response: AIResponse = provider.complete(request)

    try:
        value = model.model_validate_json(response.text)
    except ValidationError as first_error:
        interaction.repaired = True
        repair = AIRequest(
            role=request.role,
            system=request.system,
            user=(
                f"{request.user}\n\n"
                f"Your previous response did not validate against the required "
                f"schema. Fix exactly these problems and return the corrected "
                f"object:\n{first_error}"
            ),
            schema=request.schema,
            schema_name=request.schema_name,
            max_tokens=request.max_tokens,
            effort=request.effort,
        )
        repaired = provider.complete(repair)
        try:
            value = model.model_validate_json(repaired.text)
        except ValidationError as second_error:
            interaction.rejection_reason = (
                f"The model's output did not match the required shape, twice. "
                f"{_first_problem(second_error)}"
            )
            raise AIRejected(
                interaction.rejection_reason, str(second_error)
            ) from second_error
        response = repaired

    interaction.valid = True
    if cache is not None:
        cache.put(request.prompt_hash, response.text)
    return value, interaction


def _first_problem(error: ValidationError) -> str:
    problems = error.errors()
    if not problems:
        return ""
    first = problems[0]
    where = ".".join(str(p) for p in first.get("loc", ())) or "the response"
    return f"{where}: {first.get('msg', 'invalid')}"


def attempt(
    provider: AIProvider,
    request: AIRequest,
    model: type[T],
    fallback: Callable[[], Any],
    cache: ResponseCache | None = None,
) -> RoleResult:
    """Run the model, or fall back. Never raises.

    This is what makes "every capability works with the LLM disabled" true
    rather than aspirational: the caller gets a usable result either way, and
    the `Interaction` records which path it came from.
    """
    try:
        value, interaction = run(provider, request, model, cache)
        return RoleResult(value=value, interaction=interaction)
    except ProviderUnavailable as exc:
        return RoleResult(
            value=fallback(),
            interaction=Interaction(
                role=request.role,
                provider=provider.name,
                prompt_hash=request.prompt_hash,
                schema_name=model.__name__,
                valid=False,
                fell_back=True,
                rejection_reason=str(exc),
            ),
            error="",
        )
    except AIRejected as exc:
        return RoleResult(
            value=fallback(),
            interaction=Interaction(
                role=request.role,
                provider=provider.name,
                prompt_hash=request.prompt_hash,
                schema_name=model.__name__,
                valid=False,
                fell_back=True,
                rejection_reason=exc.reason,
            ),
            error=exc.reason,
        )
