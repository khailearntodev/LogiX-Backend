"""Recursive secret/token redactor for Agent audit payloads (NFR-AUD-001)."""

from __future__ import annotations

import re
from typing import Any

REDACTED_PLACEHOLDER = "[REDACTED]"

_SENSITIVE_KEY_TOKENS = (
    "password",
    "passwd",
    "secret",
    "token",
    "apikey",
    "api_key",
    "authorization",
    "cookie",
    "credential",
    "private_key",
    "privatekey",
    "otp",
    "pin",
)

_JWT_PATTERN = re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")
_BEARER_PATTERN = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b", re.IGNORECASE)
_API_KEY_PATTERN = re.compile(r"\b(?:sk|pk|AIza)[A-Za-z0-9_-]{16,}\b")


def _is_sensitive_key(key: str) -> bool:
    lowered = key.lower().replace("-", "_")
    return any(token in lowered for token in _SENSITIVE_KEY_TOKENS)


def _redact_string(value: str) -> str:
    if _JWT_PATTERN.search(value) or _BEARER_PATTERN.search(value) or _API_KEY_PATTERN.search(value):
        return REDACTED_PLACEHOLDER
    return value


def redact_audit_value(value: Any, *, max_depth: int = 6) -> Any:
    """Return a JSON-safe copy of ``value`` with sensitive fields/tokens redacted."""
    if max_depth <= 0:
        return "[TRUNCATED]"
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for k, v in value.items():
            key_str = str(k)
            if _is_sensitive_key(key_str):
                result[key_str] = REDACTED_PLACEHOLDER
            else:
                result[key_str] = redact_audit_value(v, max_depth=max_depth - 1)
        return result
    if isinstance(value, (list, tuple)):
        return [redact_audit_value(item, max_depth=max_depth - 1) for item in value]
    if isinstance(value, str):
        return _redact_string(value)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return _redact_string(str(value))
