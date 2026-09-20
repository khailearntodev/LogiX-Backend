"""Model profile registry — reads profiles from application settings.

This is the default ``ModelProfileRegistry`` implementation for MVP.
It builds ``ModelProfile`` instances from ``AgentSettings`` environment
variables (``PLANNER_DEFAULT_MODEL``, ``PLANNER_FALLBACK_MODEL``, etc.)
and supports fallback-chain resolution.

Design reference: ``ai-services-technical-design.md`` §8.5.3, §20.
"""

from __future__ import annotations

from logix_agent.config import AgentSettings
from logix_agent.modules.ai.contracts import (
    ModelCapability,
    ModelProfile,
)
from logix_agent.modules.ai.errors import ProfileNotFoundError


class ConfigModelProfileRegistry:
    """Build model profiles from ``AgentSettings`` (environment/config).

    MVP profiles:

    * ``planner-default`` — primary model for the Planner agent.
    * ``planner-fallback`` — optional fallback for transient failures.

    Additional profiles can be registered programmatically via
    ``register()`` for specialised use-cases or testing.
    """

    def __init__(self, settings: AgentSettings) -> None:
        self._profiles: dict[str, ModelProfile] = {}
        self._build_from_settings(settings)

    # ── Public API (satisfies ModelProfileRegistry protocol) ─────

    def get(self, profile_name: str) -> ModelProfile | None:
        """Return the profile or ``None`` if it does not exist."""
        return self._profiles.get(profile_name)

    def require(self, profile_name: str) -> ModelProfile:
        """Return the profile or raise ``ProfileNotFoundError``."""
        profile = self.get(profile_name)
        if profile is None:
            raise ProfileNotFoundError(profile_name)
        return profile

    def register(self, profile: ModelProfile) -> None:
        """Add or overwrite a profile in the registry."""
        self._profiles[profile.profile_name] = profile

    @property
    def profile_names(self) -> list[str]:
        """Return sorted list of registered profile names."""
        return sorted(self._profiles)

    # ── Private ──────────────────────────────────────────────────

    def _build_from_settings(self, s: AgentSettings) -> None:
        """Construct MVP profiles from flat env-var settings."""

        # Determine fallback wiring
        fallback_ref: str | None = None
        if s.llm_fallback_enabled and s.planner_fallback_model:
            fallback_ref = "planner-fallback"

            self._profiles["planner-fallback"] = ModelProfile(
                profile_name="planner-fallback",
                model=s.planner_fallback_model,
                required_capabilities=[
                    ModelCapability.TOOL_CALLING,
                    ModelCapability.STRUCTURED_OUTPUT,
                ],
                timeout_seconds=s.llm_timeout_seconds,
                max_attempts=1,  # last resort — no further fallback
                fallback_profile=None,
            )

        self._profiles["planner-default"] = ModelProfile(
            profile_name="planner-default",
            model=s.planner_default_model,
            required_capabilities=[
                ModelCapability.TOOL_CALLING,
                ModelCapability.STRUCTURED_OUTPUT,
            ],
            timeout_seconds=s.llm_timeout_seconds,
            max_attempts=s.llm_max_attempts,
            fallback_profile=fallback_ref,
        )
