"""Registry and tool-execution errors; ``str()`` is safe to show to the model."""

from __future__ import annotations


class ToolRegistryError(Exception):
    """Base class for registry failures."""


class DuplicateToolError(ToolRegistryError):
    pass


class InvalidToolSpecError(ToolRegistryError):
    pass


class UnknownToolError(ToolRegistryError):
    pass


class ToolPermissionError(ToolRegistryError):
    pass


class ApprovalRequiredError(ToolRegistryError):
    """A sensitive tool was invoked without a user approval."""


class ToolError(ToolRegistryError):
    """Normalized tool failure (e.g. downstream timeout/4xx/5xx) with a stable code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)
