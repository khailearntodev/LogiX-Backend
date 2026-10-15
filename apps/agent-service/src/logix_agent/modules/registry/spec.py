"""Declarative description of an agent tool."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import StrEnum

from pydantic import BaseModel

from logix_agent.modules.auth import Actor


class RiskLevel(StrEnum):
    READ = "read"
    WRITE = "write"
    CRITICAL = "critical"


@dataclass(frozen=True, slots=True)
class ToolContext:
    actor: Actor
    correlation_id: str


ToolHandler = Callable[[ToolContext, BaseModel], Awaitable[BaseModel]]


@dataclass(frozen=True, slots=True)
class ToolSpec:
    name: str
    description: str
    input_model: type[BaseModel]
    output_model: type[BaseModel]
    handler: ToolHandler
    # Format `module:resource:action`, same as @RequirePermissions in the Nest services.
    required_permission: str
    risk_level: RiskLevel = RiskLevel.READ
    target_service: str | None = None
    version: str = "1"

    @property
    def is_sensitive(self) -> bool:
        return self.risk_level is not RiskLevel.READ
