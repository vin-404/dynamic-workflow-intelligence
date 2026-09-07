"""
The AI provider boundary.

One interface, two implementations, and a hard rule: **the model adds language
and creative proposals, never capability** (ARCHITECTURE B.3). Venue wifi
fails and API keys rate-limit; if the LLM being down breaks the demo, the
architecture is wrong.

`NullProvider` is the default. It is selected whenever no API key is present,
and every one of the three roles has a deterministic fallback that keeps the
feature working:

* Interpreter -> a labelled pattern matcher over the same shapes the UI form
  offers, which returns *nothing* rather than guessing when it does not match
* Proposer   -> the Phase-5 deterministic heuristics, which were always the
  primary candidate source
* Narrator   -> the engine's own templated explanations

Nothing in this package may write workflow state. That is enforced by
`test_ai_boundary.py`, which parses every module here and fails on an import
of the mutation-applying services.
"""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from typing import Any, Protocol

#: The model this project targets. Opus 5 supports structured outputs and
#: adaptive thinking; there is no assistant prefill on this family, which is
#: why every role uses a JSON schema rather than a primed opening brace.
DEFAULT_MODEL = "claude-opus-5"

#: Roles. Exactly three, each with its own prompt and its own output schema,
#: because they fail differently and need different repair strategies
#: (ARCHITECTURE B.1). One combined prompt makes every failure
#: indistinguishable.
INTERPRETER = "interpreter"
PROPOSER = "proposer"
NARRATOR = "narrator"
ROLES = (INTERPRETER, PROPOSER, NARRATOR)


class ProviderUnavailable(Exception):
    """Raised by `NullProvider`, and by a real provider that cannot reach the
    API. Callers catch it and fall back; they never propagate it to a user as
    a failure, because the capability still works without the model."""


class AIRejected(Exception):
    """The model produced something that did not validate, twice.

    Carries a user-visible reason. One repair attempt, then reject - no
    unbounded retries and no parsing of free text (ARCHITECTURE B.4).
    """

    def __init__(self, reason: str, detail: str = ""):
        self.reason = reason
        self.detail = detail
        super().__init__(reason)


@dataclass(frozen=True, slots=True)
class AIRequest:
    role: str
    system: str
    user: str
    #: JSON schema the response must satisfy. Structured output only.
    schema: dict[str, Any]
    schema_name: str
    max_tokens: int = 8000
    #: Low effort suits extraction and rephrasing; the Proposer gets more.
    effort: str = "low"

    @property
    def prompt_hash(self) -> str:
        """Stable hash over everything that could change the answer.

        Used for the cache and written to every `AIInteraction` row, so a
        response can be traced back to the exact request that produced it.
        """
        blob = json.dumps(
            {
                "role": self.role,
                "system": self.system,
                "user": self.user,
                "schema": self.schema,
                "model": DEFAULT_MODEL,
                "effort": self.effort,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class AIResponse:
    text: str
    provider: str
    cached: bool = False
    usage: dict[str, Any] = field(default_factory=dict)


class AIProvider(Protocol):
    name: str
    available: bool

    def complete(self, request: AIRequest) -> AIResponse: ...


class NullProvider:
    """The default, and the one every test runs against.

    It does not pretend to be a model. It raises, and the roles fall back to
    deterministic behaviour that is labelled as such in the response.
    """

    name = "null"
    available = False

    def complete(self, request: AIRequest) -> AIResponse:
        raise ProviderUnavailable(
            "No language model is configured. This capability still works: "
            "the deterministic path is used instead."
        )


class AnthropicProvider:
    """The real provider.

    Structured output only: the response format is constrained by the request's
    JSON schema, so there is no free text to parse and no assistant prefill to
    coax a JSON opening brace out of the model - prefill is rejected on this
    model family anyway.

    The `anthropic` package is imported lazily so the application runs, and
    the whole test suite passes, without it installed.
    """

    name = "anthropic"

    def __init__(
        self,
        api_key: str | None = None,
        model: str = DEFAULT_MODEL,
        timeout: float = 60.0,
    ):
        self._api_key = api_key or os.environ.get("ANTHROPIC_API_KEY") or ""
        self._model = model
        self._timeout = timeout
        self._client: Any = None

    @property
    def available(self) -> bool:
        if not self._api_key:
            return False
        try:
            import anthropic  # noqa: F401
        except ImportError:
            return False
        return True

    def _get_client(self) -> Any:
        if self._client is None:
            try:
                import anthropic
            except ImportError as exc:  # pragma: no cover - env dependent
                raise ProviderUnavailable(
                    "The anthropic package is not installed."
                ) from exc
            self._client = anthropic.Anthropic(
                api_key=self._api_key, timeout=self._timeout
            )
        return self._client

    def complete(self, request: AIRequest) -> AIResponse:
        if not self.available:
            raise ProviderUnavailable(
                "No ANTHROPIC_API_KEY is set, or the anthropic package is "
                "not installed."
            )
        try:
            import anthropic
        except ImportError as exc:  # pragma: no cover
            raise ProviderUnavailable(str(exc)) from exc

        client = self._get_client()
        try:
            response = client.messages.create(
                model=self._model,
                max_tokens=request.max_tokens,
                system=request.system,
                messages=[{"role": "user", "content": request.user}],
                # Structured output: the response is constrained to the schema
                # rather than parsed out of prose.
                output_config={
                    "effort": request.effort,
                    "format": {
                        "type": "json_schema",
                        "schema": request.schema,
                    },
                },
                thinking={"type": "adaptive"},
            )
        except anthropic.APIConnectionError as exc:
            raise ProviderUnavailable(f"Could not reach the API: {exc}") from exc
        except anthropic.RateLimitError as exc:
            raise ProviderUnavailable(f"Rate limited: {exc}") from exc
        except anthropic.APIStatusError as exc:
            if exc.status_code >= 500:
                raise ProviderUnavailable(f"Upstream error: {exc}") from exc
            raise AIRejected(
                "The model request was rejected.", str(exc)
            ) from exc

        if getattr(response, "stop_reason", None) == "refusal":
            details = getattr(response, "stop_details", None)
            raise AIRejected(
                "The model declined this request.",
                getattr(details, "explanation", "") or "",
            )

        text = "".join(
            block.text for block in response.content if block.type == "text"
        )
        usage = getattr(response, "usage", None)
        return AIResponse(
            text=text,
            provider=self.name,
            usage={
                "input_tokens": getattr(usage, "input_tokens", None),
                "output_tokens": getattr(usage, "output_tokens", None),
            }
            if usage
            else {},
        )


def get_provider(
    kind: str | None = None, api_key: str | None = None
) -> AIProvider:
    """Choose a provider.

    Defaults to `NullProvider` unless a key is actually present. An absent key
    is not an error and never blocks anything - it selects the deterministic
    path.
    """
    requested = (kind or os.environ.get("AI_PROVIDER") or "auto").lower()
    if requested in ("null", "none", "off", "disabled"):
        return NullProvider()
    if requested in ("anthropic", "claude"):
        return AnthropicProvider(api_key=api_key)
    # auto
    candidate = AnthropicProvider(api_key=api_key)
    return candidate if candidate.available else NullProvider()
