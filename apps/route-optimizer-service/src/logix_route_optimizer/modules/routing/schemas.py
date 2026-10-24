from __future__ import annotations

import uuid
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field


class LocationIn(BaseModel):
    name: str = "Kho Tổng Miền Nam (Tân Bình)"
    address: str = "32 Phan Thúc Duyện, Phường 4, Quận Tân Bình, TP.HCM"
    lat: float = 10.8015
    lng: float = 106.6542


class StopIn(BaseModel):
    trip_stop_id: UUID = Field(default_factory=uuid.uuid4)
    stop_name: str
    address: str = ""
    lat: float
    lng: float
    demand_weight_kg: float = 0.0
    demand_volume_m3: float = 0.0
    sequence: int | None = None


class VehicleIn(BaseModel):
    vehicle_id: UUID | None = None
    plate_number: str | None = "59C-123.45"
    capacity_weight_kg: float = 1000.0
    capacity_volume_m3: float = 8.0


class RouteOptimizationRequest(BaseModel):
    trip_id: UUID | None = None
    warehouse_id: UUID | None = None
    vehicle_id: UUID | None = None
    notes: str | None = None
    route_request_id: UUID | None = None
    tenant_id: UUID | None = None
    idempotency_key: str | None = None
    depot: LocationIn | None = None
    vehicle: VehicleIn | None = None
    stops: list[StopIn] | None = None


class StopDetailOut(BaseModel):
    trip_stop_id: UUID
    sequence: int
    stop_name: str
    address: str
    lat: float
    lng: float
    demand_weight_kg: float
    demand_volume_m3: float
    distance_from_prev_km: float
    estimated_duration_minutes: int


class ProposedRouteOut(BaseModel):
    trip_id: UUID
    route_plan_id: UUID
    depot_name: str
    depot_address: str
    depot_lat: float
    depot_lng: float
    total_distance_km: float
    total_duration_minutes: int
    baseline_input_order_km: float
    baseline_nearest_neighbor_km: float
    distance_saved_km: float
    improvement_ratio_percent: float
    vehicle_capacity_weight_kg: float
    total_demand_weight_kg: float
    vehicle_capacity_volume_m3: float
    total_demand_volume_m3: float
    feasibility_status: str
    solver_method: str
    distance_provider: str
    stops: list[StopDetailOut]
    recommended_action: str
    polyline: list[list[float]] = Field(default_factory=list)
    legs: list[dict[str, Any]] = Field(default_factory=list)
