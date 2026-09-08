"""
SQLAlchemy models.

Organised by lifetime, not by entity: `identity` is mutable and long-lived,
`version` is written-once and immutable, `analysis` is derived and disposable.

`Department` is gone. `Resource {kind, name, capacity, skills, parent_key}`
replaced it, which is the domain leak removed from the schema itself rather
than papered over in the service layer.
"""
from backend.app.models.analysis import (
    AIInteraction,
    AnalysisRun,
    Finding,
    Mutation,
    Scenario,
)
from backend.app.models.identity import Domain, Project, ProjectMember, User
from backend.app.models.requirement_history import RequirementRevision
from backend.app.models.version import (
    Assignment,
    Calendar,
    Constraint,
    Dependency,
    Event,
    Requirement,
    Resource,
    Task,
    WorkflowVersion,
)

__all__ = [
    # identity & access
    "User",
    "Domain",
    "Project",
    "ProjectMember",
    # immutable workflow snapshot
    "WorkflowVersion",
    "Task",
    "Dependency",
    "Resource",
    "Assignment",
    "Requirement",
    "Constraint",
    "Calendar",
    "Event",
    "RequirementRevision",
    # change & analysis
    "Scenario",
    "Mutation",
    "AnalysisRun",
    "Finding",
    "AIInteraction",
]
