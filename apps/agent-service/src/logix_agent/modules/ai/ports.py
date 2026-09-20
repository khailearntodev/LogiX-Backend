"""Ports (Protocol interfaces) for the AI runtime.

Application / graph / agent code depends **only** on these protocols.
Concrete implementations live in ``adapters/`` and are wired at startup.

"""

from __future__ import annotations

from typing import Protocol, Sequence, runtime_checkable

from logix_agent.modules.ai.contracts import (
    ModelProfile,
    ModelRequest,
    ModelResponse,
    ToolDefinition,
)


@runtime_checkable
class ModelGateway(Protocol):
    """Port for LLM content generation and tool calling.

    Graph nodes call ``generate()`` with a logical *model_profile* name.
    The adapter resolves the profile to a concrete provider/model, invokes
    the provider, and returns a normalised ``ModelResponse``.

    Business tests substitute a ``FakeModelGateway`` that satisfies this
    protocol without network access.
    """

    async def generate(
        self,
        request: ModelRequest,
        *,
        tools: Sequence[ToolDefinition] = (),
    ) -> ModelResponse:
        """Generate a model response, optionally with tool definitions."""
        ...


@runtime_checkable
class ModelProfileRegistry(Protocol):
    """Port for looking up model profiles by name.

    Implementations read profiles from config files, environment variables,
    or a database.  The registry must resolve fallback chains.
    """

    def get(self, profile_name: str) -> ModelProfile | None:
        """Return the profile or ``None`` if it does not exist."""
        ...

    def require(self, profile_name: str) -> ModelProfile:
        """Return the profile or raise ``ProfileNotFoundError``."""
        ...
