"""Central tool registry with permission-aware lookup and invocation."""

from __future__ import annotations

from pydantic import BaseModel

from logix_agent.modules.auth import Actor
from logix_agent.modules.registry.errors import (
    ApprovalRequiredError,
    DuplicateToolError,
    InvalidToolSpecError,
    ToolPermissionError,
    UnknownToolError,
)
from logix_agent.modules.registry.spec import PreviewResult, ToolContext, ToolSpec

WILDCARD = "*"
# LangChain reserves these argument names for injected values.
RESERVED_ARGUMENT_NAMES = frozenset({"config", "runtime"})


def has_permission(actor: Actor, permission: str | None) -> bool:
    return (
        permission is None
        or actor.role == "OWNER"
        or WILDCARD in actor.permissions
        or permission in actor.permissions
    )


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolSpec] = {}

    def register(self, spec: ToolSpec) -> None:
        reserved = RESERVED_ARGUMENT_NAMES & spec.input_model.model_fields.keys()
        if reserved:
            raise InvalidToolSpecError(
                f"Tool {spec.name} uses reserved argument names: {sorted(reserved)}"
            )
        if spec.name in self._tools:
            raise DuplicateToolError(f"Tool already registered: {spec.name}")
        self._tools[spec.name] = spec

    def get(self, name: str) -> ToolSpec:
        try:
            return self._tools[name]
        except KeyError:
            raise UnknownToolError(f"Unknown tool: {name}") from None

    def list_for(self, actor: Actor) -> list[ToolSpec]:
        return [
            spec for spec in self._tools.values() if has_permission(actor, spec.required_permission)
        ]

    async def invoke(
        self, name: str, context: ToolContext, arguments: dict[str, object]
    ) -> BaseModel:
        """Permission check, input validation, handler call, output validation.

        A sensitive tool additionally needs ``context.approval``; the registry
        refuses to run it without one. Creating and consuming approvals is the
        confirmation flow's job, as is audit.
        """
        spec = self.get(name)
        if not has_permission(context.actor, spec.required_permission):
            raise ToolPermissionError(f"Permission denied for tool: {name}")
        if spec.is_sensitive and context.approval is None:
            raise ApprovalRequiredError(f"Confirmation required for tool: {name}")
        parsed = spec.input_model.model_validate(arguments)
        result = await spec.handler(context, parsed)
        return spec.output_model.model_validate(result.model_dump())

    async def preview(
        self, name: str, context: ToolContext, arguments: dict[str, object]
    ) -> PreviewResult:
        """Authoritative preview of a sensitive tool call; never changes data."""
        spec = self.get(name)
        if not has_permission(context.actor, spec.required_permission):
            raise ToolPermissionError(f"Permission denied for tool: {name}")
        if not spec.is_sensitive or spec.preview is None:
            raise InvalidToolSpecError(f"Tool has no preview: {name}")
        parsed = spec.input_model.model_validate(arguments)
        return await spec.preview(context, parsed)
