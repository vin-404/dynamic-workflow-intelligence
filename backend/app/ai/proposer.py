"""
The Proposer: a **third candidate source** for the Phase-5 search.

It does not score its own proposals, it does not apply them, and it gets no
shortcut. A model proposal becomes a `Candidate` exactly like a heuristic one
and goes through the same semantic validation, the same hard constraint gates
and the same deterministic scoring (ARCHITECTURE B.1, D.5).

Under `NullProvider` this returns nothing at all, and the optimizer runs on
its five deterministic generators - which were always the primary source. The
model adds domain-aware restructurings the heuristics cannot see; it does not
add the capability.
"""
from __future__ import annotations

from dataclasses import dataclass

from backend.app.ai.projection import project, render
from backend.app.ai.provider import PROPOSER, AIProvider, AIRequest
from backend.app.ai.runner import Interaction, ResponseCache, attempt
from backend.app.ai.schemas import ProposalsOut, proposals_schema
from backend.app.core.engine.evaluate import EvaluationResult
from backend.app.core.mutations import Mutation
from backend.app.core.optimization import Candidate
from backend.app.core.workflow import WorkflowSnapshot, WorkflowState

SYSTEM = """\
You propose alternative arrangements of a project workflow. Another system
scores them; you never do.

You are given the workflow, its current findings, and its constraints. Propose
up to four candidates. Each is a list of typed mutations from a closed set,
plus a short rationale explaining the reasoning a scheduler could not reach on
its own - domain knowledge, sequencing insight, what usually goes wrong in
work of this kind.

Rules you must follow:

1. Emit only mutations from the given closed set, referencing tasks and
   resources by `key`.
2. Never remove a task with a MANDATORY_TASK constraint. Never drop a
   dependency with IMMUTABLE_DEPENDENCY. Never split a task with
   NON_DIVISIBLE_TASK. These will be rejected and the proposal wasted.
3. A restructuring changes sequence and allocation, not the amount of work.
   Do not reduce effort or delete tasks to make the number look better.
4. Do not propose the obvious mechanical wins - removing dependencies already
   implied by a longer path, or splitting an unblocked critical task - a
   deterministic pass already finds those. Propose what it cannot see.
5. Do not state any projected date, duration, saving or percentage. You do not
   know them. Say what you are changing and why it might help.
6. If you have nothing worth proposing, return an empty list. That is a valid
   and useful answer.
"""


@dataclass
class ProposalSet:
    candidates: list[Candidate]
    interaction: Interaction | None = None
    available: bool = True
    note: str = ""


def propose(
    snapshot: WorkflowSnapshot,
    state: WorkflowState,
    result: EvaluationResult,
    provider: AIProvider,
    domain_name: str | None = None,
    domain_hints: list[str] | None = None,
    cache: ResponseCache | None = None,
    max_proposals: int = 4,
) -> ProposalSet:
    """Ask for candidates. Returns an empty set when no model is configured."""
    payload = render(
        project(snapshot, state, result, domain_name, domain_hints)
    )
    request = AIRequest(
        role=PROPOSER,
        system=SYSTEM,
        user=(
            f"Workflow and current analysis:\n{payload}\n\n"
            f"Propose up to {max_proposals} alternative arrangements."
        ),
        schema=proposals_schema(),
        schema_name="ProposalsOut",
        # Proposing a restructuring is the one role worth real thinking on.
        effort="high",
        max_tokens=12000,
    )

    outcome = attempt(
        provider,
        request,
        ProposalsOut,
        fallback=lambda: None,
        cache=cache,
    )

    if not isinstance(outcome.value, ProposalsOut):
        return ProposalSet(
            candidates=[],
            interaction=outcome.interaction,
            available=False,
            note=(
                outcome.error
                or "No language model is configured, so the search used its "
                "deterministic generators only."
            ),
        )

    candidates: list[Candidate] = []
    for proposal in outcome.value.proposals[:max_proposals]:
        try:
            mutations = tuple(
                Mutation.from_dict(m.as_dict()) for m in proposal.mutations
            )
        except ValueError:
            # A kind outside the algebra. The schema should have caught it;
            # if it slips through, drop the proposal rather than the run.
            continue
        candidates.append(
            Candidate(
                name=proposal.name.strip() or "Model proposal",
                generator="llm_proposer",
                rationale=proposal.rationale.strip(),
                mutations=mutations,
                origin="llm_proposal",
            )
        )

    return ProposalSet(
        candidates=candidates,
        interaction=outcome.interaction,
        available=True,
        note=(
            f"{len(candidates)} model proposal(s) entered the search. Each is "
            f"validated, gated against your constraints and scored by the same "
            f"engine as every other candidate."
        ),
    )
