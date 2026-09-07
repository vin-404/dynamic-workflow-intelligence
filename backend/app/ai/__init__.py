"""
The AI service boundary.

Three roles, three prompts, three schemas - never one mega-prompt
(ARCHITECTURE B.1), because they fail differently and need different repair
strategies.

Two invariants hold across everything in this package, and both are tested
rather than asserted:

1. **No write path.** Nothing here imports the services that write workflow
   state. A model proposal becomes a pending `Scenario`; only an explicit,
   human-triggered apply turns one into a `WorkflowVersion`.
2. **No authority over numbers.** Schedules, dates, slack, impact,
   feasibility and rankings come from `core/`. The Narrator may rephrase them
   and is rejected if it writes a number the engine did not produce.
"""
from backend.app.ai.interpreter import Interpretation, interpret
from backend.app.ai.narrator import Narration, narrate, verify_numbers
from backend.app.ai.projection import project, render
from backend.app.ai.proposer import ProposalSet, propose
from backend.app.ai.provider import (
    DEFAULT_MODEL,
    INTERPRETER,
    NARRATOR,
    PROPOSER,
    ROLES,
    AIProvider,
    AIRejected,
    AIRequest,
    AIResponse,
    AnthropicProvider,
    NullProvider,
    ProviderUnavailable,
    get_provider,
)
from backend.app.ai.runner import Interaction, ResponseCache, RoleResult, attempt, run

__all__ = [
    "AIProvider",
    "AIRequest",
    "AIResponse",
    "AIRejected",
    "ProviderUnavailable",
    "NullProvider",
    "AnthropicProvider",
    "get_provider",
    "DEFAULT_MODEL",
    "ROLES",
    "INTERPRETER",
    "PROPOSER",
    "NARRATOR",
    "Interaction",
    "ResponseCache",
    "RoleResult",
    "run",
    "attempt",
    "project",
    "render",
    "interpret",
    "Interpretation",
    "propose",
    "ProposalSet",
    "narrate",
    "Narration",
    "verify_numbers",
]
