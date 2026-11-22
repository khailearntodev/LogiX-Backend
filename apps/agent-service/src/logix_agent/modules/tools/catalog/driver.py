"""Driver self-service and delivery stop confirmation tools backed by transport-service.

Supports both:
- Assigned Driver self-service confirmation (direct deliver/fail with Confirmation Gate).
- SUPER_ADMIN acting on behalf of a driver (requires acting_reason and backend action-preview previewToken).
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, ValidationError

from logix_agent.modules.registry import (
    PreviewResult,
    RiskLevel,
    ToolContext,
    ToolError,
    ToolRegistry,
    ToolSpec,
)
from logix_agent.modules.tools.catalog._base import Page, PageIn, View, read_tool
from logix_agent.modules.tools.http_client import TOOL_BAD_RESPONSE, ServiceClient

DRIVER_READ = "transport:driver:read"
DRIVER_UPDATE = "transport:driver:update"
BASE = "/api/v1/driver/trips"


class DriverTripSummaryOut(View):
    trip_id: UUID
    trip_number: str
    status: str
    planned_start_at: datetime | None = None
    warehouse_id: UUID
    version: int
    stop_count: int
    completed_stop_count: int
    next_stop_id: UUID | None = None
    next_approved_sequence: int | None = None


class DriverStopContactOut(View):
    recipient_name: str | None = None
    phone: str | None = None
    address_line: str | None = None
    ward: str | None = None
    district: str | None = None
    province: str | None = None
    delivery_note: str | None = None


class DriverTripStopOut(View):
    stop_id: UUID
    shipment_id: UUID
    shipment_number: str | None = None
    approved_sequence: int
    status: str
    version: int
    is_next: bool
    contact: DriverStopContactOut | None = None


class DriverTripDetailOut(View):
    trip_id: UUID
    trip_number: str
    status: str
    planned_start_at: datetime | None = None
    actual_start_at: datetime | None = None
    completed_at: datetime | None = None
    warehouse_id: UUID
    version: int
    next_stop_id: UUID | None = None
    stops: list[DriverTripStopOut] = Field(default_factory=list)


class ListMyTripsIn(PageIn):
    scope: Literal["current", "history"] = Field(
        "current",
        description="Trip scope: 'current' for active trips or 'history' for completed trips",
    )
    driver_id: UUID | None = Field(
        None,
        description="Optional driver profile id filter (supported for SUPER_ADMIN inspection)",
    )


class DriverTripIdIn(BaseModel):
    trip_id: UUID = Field(description="Assigned delivery trip id")


class CompleteMyDeliveryStopIn(BaseModel):
    trip_id: UUID = Field(description="Delivery trip id (must be IN_PROGRESS)")
    stop_id: UUID | None = Field(
        None,
        description="Target stop id; if omitted, automatically selects the next PENDING stop in sequence",
    )
    acting_reason: str | None = Field(
        None,
        min_length=1,
        max_length=500,
        description=(
            "Mandatory ONLY when a SUPER_ADMIN confirms a stop on behalf of the assigned driver; "
            "omit when the assigned driver confirms their own stop."
        ),
    )


class FailMyDeliveryStopIn(BaseModel):
    trip_id: UUID = Field(description="Delivery trip id (must be IN_PROGRESS)")
    reason: str = Field(
        ...,
        min_length=1,
        max_length=500,
        description="Mandatory reason explaining why delivery failed at this stop",
    )
    stop_id: UUID | None = Field(
        None,
        description="Target stop id; if omitted, automatically selects the next PENDING stop in sequence",
    )
    acting_reason: str | None = Field(
        None,
        min_length=1,
        max_length=500,
        description=(
            "Mandatory ONLY when a SUPER_ADMIN records a failure on behalf of the assigned driver; "
            "omit when the assigned driver records their own stop."
        ),
    )


class DriverStopActionReceiptOut(View):
    request_id: UUID
    trip_id: UUID
    trip_stop_id: UUID
    shipment_id: UUID
    status: str
    reason: str | None = None
    acting_reason: str | None = None
    actor_mode: str | None = None
    attempt: int = 1
    occurred_at: datetime
    trip_version: int
    stop_version: int


def _is_super_admin(ctx: ToolContext) -> bool:
    return ctx.actor.is_super_admin or ctx.actor.role == "SUPER_ADMIN"


def _format_address(contact: Mapping[str, Any] | None) -> str:
    if not isinstance(contact, Mapping):
        return "Không có địa chỉ"
    parts = [
        str(contact[k]).strip()
        for k in ("addressLine", "ward", "district", "province")
        if isinstance(contact.get(k), str) and str(contact[k]).strip()
    ]
    return ", ".join(parts) if parts else "Không có địa chỉ"


def _resolve_next_stop(trip_raw: Mapping[str, Any], requested_stop_id: UUID | None) -> Mapping[str, Any]:
    trip_status = str(trip_raw.get("status") or "")
    if trip_status != "IN_PROGRESS":
        raise ToolError(
            "TRIP_NOT_IN_PROGRESS",
            f"Chuyến xe đang ở trạng thái {trip_status}, chỉ có thể xác nhận điểm dừng khi chuyến đang IN_PROGRESS.",
        )

    stops = trip_raw.get("stops")
    if not isinstance(stops, list) or not stops:
        raise ToolError("NO_STOPS_FOUND", "Chuyến xe không có điểm giao hàng nào.")

    next_stop = next(
        (s for s in stops if isinstance(s, Mapping) and s.get("isNext") is True),
        None,
    )
    if next_stop is None:
        raise ToolError("NO_PENDING_STOP", "Tất cả điểm dừng của chuyến xe đã được hoàn tất.")

    if requested_stop_id is not None and str(next_stop.get("stopId")) != str(requested_stop_id):
        raise ToolError(
            "DELIVERY_STOP_NOT_NEXT",
            "Điểm dừng được chọn không phải điểm giao kế tiếp theo thứ tự lộ trình đã duyệt.",
        )

    return next_stop


def _build_request_id(ctx: ToolContext) -> str:
    if ctx.approval is not None:
        try:
            return str(UUID(str(ctx.approval.approval_id)))
        except ValueError:
            pass
    return str(uuid.uuid4())


def register(registry: ToolRegistry, client: ServiceClient) -> None:
    registry.register(
        read_tool(
            client=client,
            name="list_my_assigned_trips",
            description=(
                "List delivery trips assigned to the currently logged-in driver "
                "(supports scope='current' or 'history', and optional driver_id filter for SUPER_ADMIN)."
            ),
            service="transport",
            path=BASE,
            input_model=ListMyTripsIn,
            output_model=Page[DriverTripSummaryOut],
            permission=DRIVER_READ,
        )
    )
    registry.register(
        read_tool(
            client=client,
            name="get_my_assigned_trip",
            description=(
                "Get full details of one delivery trip assigned to the current driver (or inspected by SUPER_ADMIN), "
                "including stops, next stop sequence, and recipient delivery addresses."
            ),
            service="transport",
            path=f"{BASE}/{{trip_id}}",
            input_model=DriverTripIdIn,
            output_model=DriverTripDetailOut,
            permission=DRIVER_READ,
        )
    )

    async def _preview_stop_action(
        ctx: ToolContext,
        *,
        trip_id: UUID,
        stop_id: UUID | None,
        outcome: Literal["DELIVERED", "FAILED"],
        reason: str | None = None,
        acting_reason: str | None = None,
    ) -> PreviewResult:
        super_admin = _is_super_admin(ctx)
        cleaned_acting_reason = acting_reason.strip() if isinstance(acting_reason, str) else ""
        cleaned_reason = reason.strip() if isinstance(reason, str) else ""

        if super_admin and not cleaned_acting_reason:
            raise ToolError(
                "ACTING_REASON_REQUIRED",
                "Tài khoản SUPER_ADMIN bắt buộc phải cung cấp lý do thao tác thay tài xế (acting_reason) "
                "trước khi xác nhận điểm dừng.",
            )
        if not super_admin and cleaned_acting_reason:
            raise ToolError(
                "DRIVER_CANNOT_ACT_AS_ADMIN",
                "Tài xế tự xác nhận điểm dừng không được truyền lý do thao tác thay (acting_reason).",
            )
        if outcome == "FAILED" and not cleaned_reason:
            raise ToolError(
                "FAILURE_REASON_REQUIRED",
                "Bắt buộc phải nhập lý do khi ghi nhận giao hàng thất bại.",
            )

        raw = await client.request("transport", "GET", f"{BASE}/{trip_id}", ctx)
        if not isinstance(raw, Mapping) or "version" not in raw:
            raise ToolError(
                TOOL_BAD_RESPONSE, "Dịch vụ vận tải trả về thông tin chuyến xe không hợp lệ."
            )

        stop = _resolve_next_stop(raw, stop_id)
        resolved_stop_id = str(stop.get("stopId") or "")
        if not resolved_stop_id or "version" not in stop:
            raise ToolError(
                TOOL_BAD_RESPONSE, "Dịch vụ vận tải trả về thông tin điểm dừng không hợp lệ."
            )

        trip_version = int(raw["version"])
        stop_version = int(stop["version"])

        binding: dict[str, Any] = {
            "tripId": str(trip_id),
            "stopId": resolved_stop_id,
            "expectedTripVersion": trip_version,
            "expectedStopVersion": stop_version,
        }

        if super_admin:
            preview_payload: dict[str, Any] = {
                "action": "DELIVER" if outcome == "DELIVERED" else "FAIL",
                "expectedTripVersion": trip_version,
                "expectedStopVersion": stop_version,
                "actingReason": cleaned_acting_reason,
            }
            if outcome == "FAILED":
                preview_payload["reason"] = cleaned_reason
            admin_preview = await client.request(
                "transport",
                "POST",
                f"{BASE}/{trip_id}/stops/{resolved_stop_id}/action-preview",
                ctx,
                json=preview_payload,
            )
            if not isinstance(admin_preview, Mapping) or not isinstance(
                admin_preview.get("previewToken"), str
            ):
                raise ToolError(
                    TOOL_BAD_RESPONSE,
                    "Dịch vụ vận tải không trả về mã xác nhận previewToken hợp lệ cho SUPER_ADMIN.",
                )
            binding["previewToken"] = admin_preview["previewToken"]
            binding["actingReason"] = cleaned_acting_reason

        trip_number = str(raw.get("tripNumber") or str(trip_id)[:12])
        shipment_number = str(stop.get("shipmentNumber") or str(stop.get("shipmentId") or "")[:12])
        sequence = stop.get("approvedSequence")
        contact = stop.get("contact") if isinstance(stop.get("contact"), Mapping) else {}
        recipient_name = str(contact.get("recipientName") or "Không rõ người nhận")
        address_text = _format_address(contact)

        attributes: list[dict[str, str]] = [
            {"label": "Mã chuyến xe", "value": trip_number},
            {"label": "Điểm dừng", "value": f"#{sequence}" if sequence is not None else "Kế tiếp"},
            {"label": "Mã vận đơn", "value": shipment_number},
            {"label": "Người nhận", "value": recipient_name},
            {"label": "Địa chỉ giao", "value": address_text},
        ]
        if super_admin:
            attributes.append({"label": "Chế độ thao tác", "value": "SUPER_ADMIN thay tài xế"})
            attributes.append({"label": "Lý do thao tác thay", "value": cleaned_acting_reason})
        if outcome == "FAILED":
            attributes.append({"label": "Lý do thất bại", "value": cleaned_reason})

        if outcome == "DELIVERED":
            ui: dict[str, Any] = {
                "title": "Xác nhận giao hàng thành công",
                "subtitle": f"Chuyến {trip_number} · Điểm dừng #{sequence}",
                "icon": "check-circle",
                "severity": "info",
                "impact": (
                    "Thao tác này không thể hoàn tác: điểm dừng sẽ chuyển sang DELIVERED "
                    "và đồng bộ trạng thái vận đơn/đơn hàng."
                ),
                "attributes": attributes,
            }
        else:
            ui = {
                "title": "Xác nhận giao hàng thất bại",
                "subtitle": f"Chuyến {trip_number} · Điểm dừng #{sequence}",
                "icon": "alert-triangle",
                "severity": "warning",
                "impact": (
                    "Thao tác này không thể hoàn tác: điểm dừng sẽ chuyển sang FAILED kèm lý do "
                    "và đồng bộ trạng thái vận đơn."
                ),
                "attributes": attributes,
            }

        return PreviewResult(
            target_type="driver_delivery_stop",
            target_id=f"{trip_id}:{resolved_stop_id}",
            target_version=trip_version,
            summary={
                "tripId": str(trip_id),
                "tripNumber": trip_number,
                "stopId": resolved_stop_id,
                "shipmentNumber": shipment_number,
                "approvedSequence": sequence,
                "outcome": outcome,
                "reason": cleaned_reason or None,
                "actingReason": cleaned_acting_reason or None,
                "expectedTripVersion": trip_version,
                "expectedStopVersion": stop_version,
                "ui": ui,
            },
            execution_binding=binding,
        )

    async def _execute_stop_action(
        ctx: ToolContext,
        *,
        trip_id: UUID,
        endpoint_suffix: Literal["deliver", "fail"],
        reason: str | None = None,
    ) -> DriverStopActionReceiptOut:
        binding = (
            ctx.approval.execution_binding
            if ctx.approval is not None and isinstance(ctx.approval.execution_binding, Mapping)
            else None
        )
        if not binding:
            raise ToolError(
                "APPROVAL_BINDING_REQUIRED",
                "Thiếu thông tin phiên bản chuyến xe/điểm dừng từ bước xem trước xác nhận.",
            )

        resolved_stop_id = str(binding.get("stopId") or "")
        expected_trip_version = binding.get("expectedTripVersion")
        expected_stop_version = binding.get("expectedStopVersion")
        if (
            not resolved_stop_id
            or not isinstance(expected_trip_version, int)
            or not isinstance(expected_stop_version, int)
        ):
            raise ToolError(
                "APPROVAL_BINDING_INVALID",
                "Dữ liệu xác nhận điểm dừng không hợp lệ. Vui lòng thử lại.",
            )

        payload: dict[str, Any] = {
            "requestId": _build_request_id(ctx),
            "expectedTripVersion": expected_trip_version,
            "expectedStopVersion": expected_stop_version,
            "confirmed": True,
        }
        if isinstance(binding.get("previewToken"), str) and isinstance(
            binding.get("actingReason"), str
        ):
            payload["previewToken"] = binding["previewToken"]
            payload["actingReason"] = binding["actingReason"]

        if endpoint_suffix == "fail":
            cleaned_reason = (reason or "").strip()
            if not cleaned_reason:
                raise ToolError(
                    "FAILURE_REASON_REQUIRED",
                    "Bắt buộc phải nhập lý do khi ghi nhận giao hàng thất bại.",
                )
            payload["reason"] = cleaned_reason

        raw = await client.request(
            "transport",
            "POST",
            f"{BASE}/{trip_id}/stops/{resolved_stop_id}/{endpoint_suffix}",
            ctx,
            json=payload,
        )
        try:
            return DriverStopActionReceiptOut.model_validate(raw)
        except ValidationError:
            raise ToolError(
                TOOL_BAD_RESPONSE, "Dịch vụ vận tải trả về biên nhận giao hàng không hợp lệ."
            ) from None

    async def preview_complete(ctx: ToolContext, args: BaseModel) -> PreviewResult:
        assert isinstance(args, CompleteMyDeliveryStopIn)
        return await _preview_stop_action(
            ctx,
            trip_id=args.trip_id,
            stop_id=args.stop_id,
            outcome="DELIVERED",
            acting_reason=args.acting_reason,
        )

    async def handle_complete(ctx: ToolContext, args: BaseModel) -> DriverStopActionReceiptOut:
        assert isinstance(args, CompleteMyDeliveryStopIn)
        return await _execute_stop_action(
            ctx,
            trip_id=args.trip_id,
            endpoint_suffix="deliver",
        )

    async def preview_fail(ctx: ToolContext, args: BaseModel) -> PreviewResult:
        assert isinstance(args, FailMyDeliveryStopIn)
        return await _preview_stop_action(
            ctx,
            trip_id=args.trip_id,
            stop_id=args.stop_id,
            outcome="FAILED",
            reason=args.reason,
            acting_reason=args.acting_reason,
        )

    async def handle_fail(ctx: ToolContext, args: BaseModel) -> DriverStopActionReceiptOut:
        assert isinstance(args, FailMyDeliveryStopIn)
        return await _execute_stop_action(
            ctx,
            trip_id=args.trip_id,
            endpoint_suffix="fail",
            reason=args.reason,
        )

    registry.register(
        ToolSpec(
            name="complete_my_delivery_stop",
            description=(
                "Mark the next pending delivery stop on an IN_PROGRESS trip as DELIVERED. "
                "Supports both the assigned driver and SUPER_ADMIN acting on behalf of a driver (with acting_reason). "
                "SENSITIVE: requires preview and explicit confirmation."
            ),
            risk_level=RiskLevel.WRITE,
            target_service="transport",
            required_permission=DRIVER_UPDATE,
            input_model=CompleteMyDeliveryStopIn,
            output_model=DriverStopActionReceiptOut,
            preview=preview_complete,
            handler=handle_complete,
        )
    )
    registry.register(
        ToolSpec(
            name="fail_my_delivery_stop",
            description=(
                "Mark the next pending delivery stop on an IN_PROGRESS trip as FAILED with a mandatory reason. "
                "Supports both the assigned driver and SUPER_ADMIN acting on behalf of a driver (with acting_reason). "
                "SENSITIVE: requires preview and explicit confirmation."
            ),
            risk_level=RiskLevel.WRITE,
            target_service="transport",
            required_permission=DRIVER_UPDATE,
            input_model=FailMyDeliveryStopIn,
            output_model=DriverStopActionReceiptOut,
            preview=preview_fail,
            handler=handle_fail,
        )
    )
