"""AI error types.

Hierarchy:
    ModelGatewayError (base)
    ├── ModelTimeoutError          — retryable
    ├── ModelRateLimitError        — retryable
    ├── ModelUnavailableError      — retryable
    ├── ModelResponseValidationError — NOT retryable
    ├── ModelCapabilityError       — NOT retryable
    ├── ProfileNotFoundError       — NOT retryable
    └── FallbackExhaustedError     — NOT retryable

Graph/agent code catches *ModelGatewayError* and inspects `retryable` to
decide whether a bounded retry or fallback is appropriate.  Schema-validation,
permission, and business-tool failures are never retried by changing provider.
"""

from __future__ import annotations


class ModelGatewayError(Exception):
    """Base error for all ModelGateway failures."""

    retryable: bool = False

    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


# ── Transient / retryable ────────────────────────────────────────


class ModelTimeoutError(ModelGatewayError):
    """LLM provider did not respond within the configured timeout."""

    def __init__(self, message: str = "Model request timed out") -> None:
        super().__init__(message, retryable=True)


class ModelRateLimitError(ModelGatewayError):
    """LLM provider returned a rate-limit / quota-exceeded response."""

    def __init__(self, message: str = "Model rate limit exceeded") -> None:
        super().__init__(message, retryable=True)


class ModelUnavailableError(ModelGatewayError):
    """LLM provider is temporarily unreachable or returned a 5xx error."""

    def __init__(self, message: str = "Model provider unavailable") -> None:
        super().__init__(message, retryable=True)


# ── Non-retryable ───────────────────────────────────────────────


class ModelResponseValidationError(ModelGatewayError):
    """Provider response does not conform to the expected contract."""

    def __init__(self, message: str = "Model response validation failed") -> None:
        super().__init__(message, retryable=False)


class ModelCapabilityError(ModelGatewayError):
    """Requested capability (e.g. tool_calling) is not available on the model."""

    def __init__(self, message: str = "Model lacks required capability") -> None:
        super().__init__(message, retryable=False)


class ProfileNotFoundError(ModelGatewayError):
    """The requested model profile name does not exist in the registry."""

    def __init__(self, profile_name: str) -> None:
        super().__init__(
            f"Model profile '{profile_name}' not found in registry",
            retryable=False,
        )
        self.profile_name = profile_name


class FallbackExhaustedError(ModelGatewayError):
    """All profiles in the fallback chain have been tried and failed."""

    def __init__(self, chain: list[str], cause: ModelGatewayError | None = None) -> None:
        chain_str = " → ".join(chain)
        super().__init__(
            f"Fallback chain exhausted: {chain_str}",
            retryable=False,
        )
        self.chain = chain
        self.__cause__ = cause
