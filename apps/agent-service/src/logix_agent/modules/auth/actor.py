"""Authenticated actor resolved from the identity-service access token.

The agent-service never reads the identity database: tenant and user come only
from the verified JWT (payload: ``sub``, ``tenantId``).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from logix_agent.config import settings

_bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True, slots=True)
class Actor:
    user_id: str
    tenant_id: str
    role: str | None = None
    permissions: frozenset[str] = frozenset()
    # Forwarded to downstream services; kept out of repr so it never reaches logs.
    access_token: str | None = field(default=None, repr=False)


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or missing access token",
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_current_actor(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> Actor:
    if not settings.jwt_secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication is not configured",
        )
    if credentials is None:
        raise _unauthorized()

    try:
        payload = jwt.decode(
            credentials.credentials,
            settings.jwt_secret,
            algorithms=["HS256"],
            options={"require": ["exp", "sub"]},
        )
    except jwt.PyJWTError:
        raise _unauthorized() from None

    user_id = payload.get("sub")
    tenant_id = payload.get("tenantId")
    if not isinstance(user_id, str) or not user_id:
        raise _unauthorized()
    if not isinstance(tenant_id, str) or not tenant_id:
        raise _unauthorized()

    # Optional claims: identity-service does not issue them yet; downstream services stay authoritative.
    role = payload.get("role")
    raw_permissions = payload.get("permissions")
    permissions = (
        frozenset(p for p in raw_permissions if isinstance(p, str))
        if isinstance(raw_permissions, list)
        else frozenset()
    )
    return Actor(
        user_id=user_id,
        tenant_id=tenant_id,
        role=role if isinstance(role, str) else None,
        permissions=permissions,
        access_token=credentials.credentials,
    )
