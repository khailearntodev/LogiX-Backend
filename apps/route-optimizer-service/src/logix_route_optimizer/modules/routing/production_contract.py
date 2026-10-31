from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

from pydantic import ConfigDict, Field, model_validator

from logix_route_optimizer.modules.routing.schemas import (
    LocationIn,
    ProposedRouteOut,
    RouteOptimizationRequest,
    StopIn,
    VehicleIn,
)


def canonical_input(value: Any) -> str:
    if isinstance(value, float) or (isinstance(value, int) and not isinstance(value, bool)
                                   and abs(value) > 9_007_199_254_740_991):
        raise ValueError("Canonical measures must be decimal strings; integers must be safe")
    if isinstance(value, dict):
        if any(not isinstance(key, str) or not key.isascii() or
               any(ord(char) < 32 or ord(char) > 126 for char in key) for key in value):
            raise ValueError("Canonical keys must be printable ASCII")
        return "{" + ",".join(
            json.dumps(key, ensure_ascii=False) + ":" + canonical_input(value[key])
            for key in sorted(value)
        ) + "}"
    if isinstance(value, list):
        return "[" + ",".join(canonical_input(item) for item in value) + "]"
    if value is None or isinstance(value, (str, int, bool)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    raise ValueError("Canonical input must contain JSON values")


def input_hash(snapshot: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_input(snapshot).encode("utf-8")).hexdigest()


class ProductionRouteRequest(RouteOptimizationRequest):
    model_config = ConfigDict(extra="forbid")
    contract_version: Literal[1]
    tenant_id: UUID
    trip_id: UUID
    warehouse_id: UUID
    vehicle_id: UUID
    route_request_id: UUID
    idempotency_key: UUID
    trip_version: int = Field(gt=0, le=9_007_199_254_740_991)
    input_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    input_snapshot: dict[str, Any]
    depot: LocationIn
    vehicle: VehicleIn
    stops: list[StopIn] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def verify_binding(self) -> ProductionRouteRequest:
        if not {"name", "address", "lat", "lng"} <= self.depot.model_fields_set or not {
            "vehicle_id", "plate_number", "capacity_weight_kg", "capacity_volume_m3"
        } <= self.vehicle.model_fields_set or any(not {
            "trip_stop_id", "stop_name", "address", "lat", "lng", "demand_weight_kg", "demand_volume_m3", "sequence"
        } <= stop.model_fields_set for stop in self.stops):
            raise ValueError("Production input cannot use sample/default fields")
        snapshot = self.input_snapshot
        if set(snapshot) != {
            "contractVersion", "tenantId", "tripId", "tripVersion", "warehouseId", "vehicleId",
            "plannedStartAt", "objective", "solverVersion", "configVersion", "providerVersion",
            "options", "driver", "depot", "vehicle", "stops",
        }:
            raise ValueError("Complete canonical planning input is required; request/result identities are excluded")
        if input_hash(snapshot) != self.input_hash:
            raise ValueError("Input hash does not match canonical snapshot")
        if self.idempotency_key != self.route_request_id:
            raise ValueError("Idempotency key must identify the route request")
        expected = {
            "contractVersion": 1, "tenantId": str(self.tenant_id), "tripId": str(self.trip_id),
            "tripVersion": self.trip_version, "warehouseId": str(self.warehouse_id),
        }
        if any(snapshot.get(key) != value for key, value in expected.items()):
            raise ValueError("Input identity differs from request binding")
        try:
            depot, vehicle, stops = snapshot["depot"], snapshot["vehicle"], snapshot["stops"]
            driver = snapshot["driver"]
            UUID(str(driver["id"]))
            UUID(str(driver["userId"]))
            for current_version in (driver["version"], vehicle["version"]):
                if type(current_version) is not int or not 0 < current_version <= 9_007_199_254_740_991:
                    raise ValueError("Safe current resource versions are required")
            planned_start = snapshot["plannedStartAt"]
            if not isinstance(planned_start, str) or datetime.fromisoformat(planned_start).tzinfo is None:
                raise ValueError("Bound planned start requires an explicit timezone")
            if any(value is not None and not isinstance(value, str) for value in (snapshot["solverVersion"], snapshot["providerVersion"])):
                raise ValueError("Requested runtime versions must be explicit strings or unknown null")
            if snapshot["objective"] != "MINIMIZE_ROAD_DISTANCE" or snapshot["configVersion"] != "route-v1" or snapshot["options"] != {"returnToDepot": True}:
                raise ValueError("Unsupported bound solver configuration")
            if str(self.vehicle.vehicle_id) != str(self.vehicle_id) or vehicle["vehicleId"] != str(self.vehicle_id) or snapshot["vehicleId"] != str(self.vehicle_id):
                raise ValueError("Vehicle identity mismatch")
            if self.vehicle.plate_number != vehicle["plateNumber"]:
                raise ValueError("Vehicle metadata mismatch")
            if self.depot.name != depot["name"] or self.depot.address != depot["address"]:
                raise ValueError("Depot metadata mismatch")
            measures = [
                (self.depot.lat, depot["latitude"], -90, 90),
                (self.depot.lng, depot["longitude"], -180, 180),
                (self.vehicle.capacity_weight_kg, vehicle["capacityWeight"], 0, math.inf),
                (self.vehicle.capacity_volume_m3, vehicle["capacityVolume"], 0, math.inf),
            ]
            if len(stops) != len(self.stops) or len({str(stop.trip_stop_id) for stop in self.stops}) != len(stops):
                raise ValueError("Complete unique stop set required")
            for index, (stop, frozen) in enumerate(zip(self.stops, stops, strict=True), 1):
                if str(stop.trip_stop_id) != frozen["stopId"] or stop.sequence != index or frozen["sequence"] != index:
                    raise ValueError("Stop identity/sequence mismatch")
                if stop.address != frozen["addressSnapshot"]["addressLine"] or stop.stop_name != frozen["shipmentId"]:
                    raise ValueError("Stop metadata mismatch")
                measures += [
                    (stop.lat, frozen["addressSnapshot"]["latitude"], -90, 90),
                    (stop.lng, frozen["addressSnapshot"]["longitude"], -180, 180),
                    (stop.demand_weight_kg, frozen["demandWeight"], 0, math.inf),
                    (stop.demand_volume_m3, frozen["demandVolume"], 0, math.inf),
                ]
            for numeric, frozen, minimum, maximum in measures:
                if not isinstance(frozen, str) or not math.isfinite(numeric) or numeric != float(Decimal(frozen)) or not minimum <= numeric <= maximum:
                    raise ValueError("Numeric input differs from canonical snapshot")
            if Decimal(vehicle["capacityWeight"]) <= 0 or Decimal(vehicle["capacityVolume"]) <= 0:
                raise ValueError("Positive capacities required")
            if sum(Decimal(stop["demandWeight"]) for stop in stops) > Decimal(vehicle["capacityWeight"]) or \
               sum(Decimal(stop["demandVolume"]) for stop in stops) > Decimal(vehicle["capacityVolume"]):
                raise ValueError("Input exceeds vehicle capacity")
        except (KeyError, TypeError, ArithmeticError) as exc:
            raise ValueError("Invalid full canonical input") from exc
        return self


class ProductionRouteOut(ProposedRouteOut):
    contract_version: Literal[1] = 1
    tenant_id: UUID
    route_request_id: UUID
    trip_version: int
    input_hash: str
    persisted: Literal[True]
    completed_at: str
    solver_version: str
    config_version: str
    objective: str
    provider_version: str | None
