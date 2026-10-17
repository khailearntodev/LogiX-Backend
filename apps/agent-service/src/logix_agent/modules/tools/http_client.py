"""Shared HTTP client for tool calls to business services.

Forwards the caller's access token so each downstream service enforces its own
tenant isolation and permissions.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping

import httpx

from logix_agent.config import AgentSettings
from logix_agent.modules.registry import ToolContext, ToolError

TOOL_TIMEOUT = "TOOL_TIMEOUT"
TOOL_UNAVAILABLE = "TOOL_UNAVAILABLE"
TOOL_UNAUTHORIZED = "TOOL_UNAUTHORIZED"
TOOL_FORBIDDEN = "TOOL_FORBIDDEN"
TOOL_NOT_FOUND = "TOOL_NOT_FOUND"
TOOL_CONFLICT = "TOOL_CONFLICT"
TOOL_INVALID_REQUEST = "TOOL_INVALID_REQUEST"
TOOL_BAD_RESPONSE = "TOOL_BAD_RESPONSE"
TOOL_NOT_CONFIGURED = "TOOL_NOT_CONFIGURED"

_STATUS_ERRORS: dict[int, tuple[str, str]] = {
    401: (TOOL_UNAUTHORIZED, "Phiên đăng nhập không hợp lệ hoặc đã hết hạn."),
    403: (TOOL_FORBIDDEN, "Bạn không có quyền thực hiện thao tác này."),
    404: (TOOL_NOT_FOUND, "Không tìm thấy dữ liệu được yêu cầu."),
    409: (TOOL_CONFLICT, "Yêu cầu xung đột với trạng thái dữ liệu hiện tại."),
}
_RETRYABLE_STATUS = frozenset({502, 503, 504})
_RETRYABLE_METHODS = frozenset({"GET", "HEAD"})


def _error_for_status(status: int) -> ToolError:
    if status in _STATUS_ERRORS:
        code, message = _STATUS_ERRORS[status]
        return ToolError(code, message)
    if 400 <= status < 500:
        return ToolError(TOOL_INVALID_REQUEST, "Yêu cầu không hợp lệ, vui lòng kiểm tra lại tham số.")
    return ToolError(TOOL_UNAVAILABLE, "Dịch vụ nghiệp vụ hiện không khả dụng. Vui lòng thử lại sau.")


class ServiceClient:
    def __init__(
        self,
        *,
        base_urls: Mapping[str, str],
        timeout_seconds: float = 10.0,
        max_attempts: int = 2,
        backoff_seconds: float = 0.2,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_urls = {name: url.rstrip("/") for name, url in base_urls.items()}
        self._max_attempts = max(1, max_attempts)
        self._backoff_seconds = backoff_seconds
        self._client = httpx.AsyncClient(timeout=timeout_seconds, transport=transport)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def request(
        self,
        service: str,
        method: str,
        path: str,
        context: ToolContext,
        *,
        params: Mapping[str, str | int | float | bool] | None = None,
        json: object | None = None,
    ) -> object:
        base_url = self._base_urls.get(service)
        if base_url is None:
            raise ToolError(TOOL_NOT_CONFIGURED, "Dịch vụ nghiệp vụ chưa được cấu hình.")
        token = context.actor.access_token
        if not token:
            raise ToolError(TOOL_UNAUTHORIZED, _STATUS_ERRORS[401][1])

        method = method.upper()
        attempts = self._max_attempts if method in _RETRYABLE_METHODS else 1
        headers = {
            "Authorization": f"Bearer {token}",
            "X-Correlation-Id": context.correlation_id,
        }

        for attempt in range(1, attempts + 1):
            try:
                response = await self._client.request(
                    method,
                    f"{base_url}/{path.lstrip('/')}",
                    params=params,
                    json=json,
                    headers=headers,
                )
            except httpx.TimeoutException:
                error = ToolError(TOOL_TIMEOUT, "Dịch vụ nghiệp vụ phản hồi quá lâu. Vui lòng thử lại.")
            except httpx.TransportError:
                error = ToolError(
                    TOOL_UNAVAILABLE, "Không kết nối được tới dịch vụ nghiệp vụ. Vui lòng thử lại sau."
                )
            else:
                if response.is_success:
                    return self._parse(response)
                error = _error_for_status(response.status_code)
                if response.status_code not in _RETRYABLE_STATUS:
                    raise error

            if attempt == attempts:
                raise error
            await asyncio.sleep(self._backoff_seconds * attempt)

        raise AssertionError("unreachable")  # pragma: no cover

    @staticmethod
    def _parse(response: httpx.Response) -> object:
        if response.status_code == 204 or not response.content:
            return None
        try:
            return response.json()
        except ValueError:
            raise ToolError(
                TOOL_BAD_RESPONSE, "Dịch vụ nghiệp vụ trả về dữ liệu không hợp lệ."
            ) from None


def create_service_client(settings: AgentSettings) -> ServiceClient:
    return ServiceClient(
        base_urls={
            "identity": settings.identity_service_url,
            "order": settings.order_service_url,
            "master_data": settings.master_data_service_url,
            "inventory": settings.inventory_service_url,
        },
        timeout_seconds=settings.tool_http_timeout_seconds,
        max_attempts=settings.tool_http_max_attempts,
    )
