"""Declarative description of an agent tool."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import StrEnum

from pydantic import BaseModel

from logix_agent.modules.auth import Actor


class RiskLevel(StrEnum):
    READ = "read"
    WRITE = "write"
    CRITICAL = "critical"


@dataclass(frozen=True, slots=True)
class ApprovedAction:
    """A user decision a sensitive tool needs before it may run.

    Only the confirmation flow creates it, after the user approved a preview of
    exactly this target at exactly this version.
    """

    approval_id: str
    target_type: str
    target_id: str
    target_version: int


@dataclass(frozen=True, slots=True)
class ToolContext:
    actor: Actor
    correlation_id: str
    approval: ApprovedAction | None = field(default=None)


@dataclass(frozen=True, slots=True)
class PreviewResult:
    """Authoritative read of what a sensitive tool is about to change."""

    target_type: str
    target_id: str
    target_version: int
    # Shown to the user and stored with the approval; must already be sanitized.
    summary: dict[str, object]


ToolHandler = Callable[[ToolContext, BaseModel], Awaitable[BaseModel]]
ToolPreview = Callable[[ToolContext, BaseModel], Awaitable[PreviewResult]]


@dataclass(frozen=True, slots=True)
class ToolSpec:
    name: str
    description: str
    input_model: type[BaseModel]
    output_model: type[BaseModel]
    handler: ToolHandler
    # Format `module:resource:action`, same as @RequirePermissions in the Nest services.
    # None means the downstream endpoint only requires an authenticated user.
    required_permission: str | None
    risk_level: RiskLevel = RiskLevel.READ
    target_service: str | None = None
    version: str = "1"
    # Required for (and only allowed on) sensitive tools.
    preview: ToolPreview | None = None

    @property
    def is_sensitive(self) -> bool:
        return self.risk_level is not RiskLevel.READ
