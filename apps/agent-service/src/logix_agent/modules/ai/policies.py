"""Provider-agnostic ModelGateway decorators.

Capability validation, bounded retry and fallback-profile chaining are policy,
not provider detail.  Keeping them here means every adapter — Gemini, a future
LiteLLM adapter, or ``FakeModelGateway`` in CI — is governed by the same rules
instead of reimplementing them.

Design reference: ``ai-services-technical-design.md`` §8.5.3.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence

from logix_agent.modules.ai.contracts import (
    ModelCapability,
    ModelProfile,
    ModelRequest,
    ModelResponse,
    ModelStreamChunk,
    ToolDefinition,
)
from logix_agent.modules.ai.errors import (
    FallbackExhaustedError,
    ModelCapabilityError,
    ModelGatewayError,
)
from logix_agent.modules.ai.ports import ModelGateway, ModelProfileRegistry

logger = logging.getLogger(__name__)

DEFAULT_BACKOFF_BASE_SECONDS = 0.5


class CapabilityCheckingModelGateway:
    """Reject a request whose profile does not declare the capabilities it needs.

    Runs before any provider call so an under-specified profile fails fast and
    deterministically rather than producing a silently degraded response.
    """

    def __init__(
        self,
        inner: ModelGateway,
        *,
        profile_registry: ModelProfileRegistry,
    ) -> None:
        self.inner = inner
        self._profiles = profile_registry

    async def generate(
        self,
        request: ModelRequest,
        *,
        tools: Sequence[ToolDefinition] = (),
    ) -> ModelResponse:
        profile = self._profiles.require(request.model_profile)
        self._validate(profile, request, tools)
        return await self.inner.generate(request, tools=tools)

    async def stream(
        self,
        request: ModelRequest,
        *,
        tools: Sequence[ToolDefinition] = (),
    ) -> AsyncIterator[ModelStreamChunk]:
        profile = self._profiles.require(request.model_profile)
        self._validate(profile, request, tools)
        async for chunk in self.inner.stream(request, tools=tools):
            yield chunk

    @staticmethod
    def _validate(
        profile: ModelProfile,
        request: ModelRequest,
        tools: Sequence[ToolDefinition],
    ) -> None:
        capabilities = set(profile.required_capabilities)

        if tools and ModelCapability.TOOL_CALLING not in capabilities:
            raise ModelCapabilityError(
                f"Profile '{profile.profile_name}' lacks TOOL_CALLING capability "
                f"but {len(tools)} tools were supplied"
            )

        if (
            request.structured_response_schema
            and ModelCapability.STRUCTURED_OUTPUT not in capabilities
        ):
            raise ModelCapabilityError(
                f"Profile '{profile.profile_name}' lacks STRUCTURED_OUTPUT capability "
                f"but structured_response_schema was supplied"
            )


class RetryingModelGateway:
    """Bounded retry on transient failures, then one hop to the fallback profile.

    Only errors flagged ``retryable`` are retried; capability, schema, policy and
    business rejections surface unchanged so a different model cannot mask them.
    """

    def __init__(
        self,
        inner: ModelGateway,
        *,
        profile_registry: ModelProfileRegistry,
        backoff_base_seconds: float = DEFAULT_BACKOFF_BASE_SECONDS,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self.inner = inner
        self._profiles = profile_registry
        self._backoff_base_seconds = backoff_base_seconds
        self._sleep = sleep

    async def generate(
        self,
        request: ModelRequest,
        *,
        tools: Sequence[ToolDefinition] = (),
    ) -> ModelResponse:
        primary = self._profiles.require(request.model_profile)

        try:
            return await self._attempt_profile(primary, request, tools)
        except ModelGatewayError as primary_error:
            if not primary_error.retryable or not primary.fallback_profile:
                raise
            fallback, fallback_request, chain = self._prepare_fallback(
                primary, request, primary_error
            )

        try:
            return await self._attempt_profile(fallback, fallback_request, tools)
        except ModelGatewayError as fallback_error:
            logger.error(
                "Fallback profile '%s' also failed: %s", fallback.profile_name, fallback_error
            )
            raise FallbackExhaustedError(chain, cause=fallback_error) from fallback_error

    async def stream(
        self,
        request: ModelRequest,
        *,
        tools: Sequence[ToolDefinition] = (),
    ) -> AsyncIterator[ModelStreamChunk]:
        """Stream chunks with bounded pre-first-chunk retry and fallback.

        Once a chunk has been yielded downstream, errors surface directly so a
        mid-stream failure cannot splice two partial responses together.
        """
        primary = self._profiles.require(request.model_profile)
        emitted_any = False

        try:
            async for chunk in self._stream_with_retry_before_first_chunk(
                primary, request, tools
            ):
                emitted_any = True
                yield chunk
            return
        except ModelGatewayError as primary_error:
            if emitted_any or not primary_error.retryable or not primary.fallback_profile:
                raise
            fallback, fallback_request, chain = self._prepare_fallback(
                primary, request, primary_error
            )

        fallback_emitted = False
        try:
            async for chunk in self._stream_with_retry_before_first_chunk(
                fallback, fallback_request, tools
            ):
                fallback_emitted = True
                yield chunk
        except ModelGatewayError as fallback_error:
            if fallback_emitted:
                raise
            logger.error(
                "Fallback profile '%s' also failed: %s", fallback.profile_name, fallback_error
            )
            raise FallbackExhaustedError(chain, cause=fallback_error) from fallback_error

    def _prepare_fallback(
        self,
        primary: ModelProfile,
        request: ModelRequest,
        error: ModelGatewayError,
    ) -> tuple[ModelProfile, ModelRequest, list[str]]:
        fallback_name = primary.fallback_profile
        assert fallback_name is not None
        logger.warning(
            "Model profile '%s' failed transiently (%s); falling back to '%s'",
            primary.profile_name,
            error,
            fallback_name,
        )
        fallback = self._profiles.require(fallback_name)
        fallback_request = request.model_copy(update={"model_profile": fallback_name})
        return fallback, fallback_request, [primary.profile_name, fallback_name]

    async def _wait_and_advance_attempt(
        self,
        attempt: int,
        profile: ModelProfile,
        error: ModelGatewayError,
    ) -> int:
        backoff = self._backoff_base_seconds * (2 ** (attempt - 1))
        logger.info(
            "Attempt %d/%d for profile '%s' failed (%s); retrying in %.1fs",
            attempt,
            profile.max_attempts,
            profile.profile_name,
            error,
            backoff,
        )
        await self._sleep(backoff)
        return attempt + 1

    async def _attempt_profile(
        self,
        profile: ModelProfile,
        request: ModelRequest,
        tools: Sequence[ToolDefinition],
    ) -> ModelResponse:
        attempt = 1
        while True:
            try:
                response = await self.inner.generate(request, tools=tools)
            except ModelGatewayError as error:
                if not error.retryable or attempt >= profile.max_attempts:
                    raise
                attempt = await self._wait_and_advance_attempt(attempt, profile, error)
                continue

            return response.model_copy(update={"attempt": attempt})

    async def _stream_with_retry_before_first_chunk(
        self,
        profile: ModelProfile,
        request: ModelRequest,
        tools: Sequence[ToolDefinition],
    ) -> AsyncIterator[ModelStreamChunk]:
        attempt = 1
        while True:
            emitted_any = False
            try:
                async for chunk in self.inner.stream(request, tools=tools):
                    emitted_any = True
                    yield chunk.model_copy(update={"attempt": attempt})
                return
            except ModelGatewayError as error:
                if emitted_any or not error.retryable or attempt >= profile.max_attempts:
                    raise
                attempt = await self._wait_and_advance_attempt(attempt, profile, error)
