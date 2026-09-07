"""
Pydantic request/response DTOs for the API boundary.

Kept thin on purpose. Analysis responses are engine output plus presentation
fields, and pinning them into rigid response models here would mean editing
two files every time the engine reports something new -- so analysis endpoints
return plain dicts assembled by the service layer, and these schemas cover
the *inputs*, where validation actually matters.
"""
from backend.app.schemas.authoring import (
    AssignmentIn,
    DependencyIn,
    DomainIn,
    DomainOut,
    MemberIn,
    MemberOut,
    ProjectIn,
    ProjectOut,
    ResourceIn,
    TaskIn,
    TaskPatch,
    VersionOut,
)

__all__ = [
    "DomainIn",
    "DomainOut",
    "ProjectIn",
    "ProjectOut",
    "MemberIn",
    "MemberOut",
    "TaskIn",
    "TaskPatch",
    "DependencyIn",
    "ResourceIn",
    "AssignmentIn",
    "VersionOut",
]
