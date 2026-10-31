from __future__ import annotations

import copy
import time
from uuid import uuid4

import jwt
import pytest
from httpx import ASGITransport, AsyncClient
from logix_route_optimizer.api.v1 import routes
from logix_route_optimizer.main import app
from logix_route_optimizer.modules.routing.production_contract import (
    ProductionRouteRequest,
    canonical_input,
    input_hash,
)
from pydantic import ValidationError

SECRET = "owned-route-contract-test-signing-key-32chars"


@pytest.fixture
def full_input() -> dict:
    tenant, trip, warehouse, vehicle, stop, shipment, request = [str(uuid4()) for _ in range(7)]
    snapshot = {
        "contractVersion": 1, "tenantId": tenant, "tripId": trip, "tripVersion": 4,
        "warehouseId": warehouse, "vehicleId": vehicle, "plannedStartAt": "2027-01-01T08:00:00.000Z",
        "depot": {"name": "Kho kiểm thử", "address": "Địa chỉ", "latitude": "10.000000", "longitude": "106.000000"},
        "vehicle": {"vehicleId": vehicle, "plateNumber": "QA-1", "capacityWeight": "1.000", "capacityVolume": "1.000000", "version": 2},
        "driver": {"id": str(uuid4()), "userId": str(uuid4()), "version": 1},
        "stops": [{"stopId": stop, "shipmentId": shipment, "sequence": 1,
                   "addressSnapshot": {"addressLine": "Điểm nhận", "latitude": "10.100000", "longitude": "106.100000"},
                   "demandWeight": "1.000", "demandVolume": "1.000000"}],
        "objective": "MINIMIZE_ROAD_DISTANCE", "solverVersion": None, "providerVersion": None,
        "configVersion": "route-v1", "options": {"returnToDepot": True},
    }
    return {
        "contract_version": 1, "tenant_id": tenant, "trip_id": trip, "warehouse_id": warehouse,
        "vehicle_id": vehicle, "route_request_id": request, "idempotency_key": request,
        "trip_version": 4, "input_snapshot": snapshot, "input_hash": input_hash(snapshot),
        "depot": {"name": "Kho kiểm thử", "address": "Địa chỉ", "lat": 10, "lng": 106},
        "vehicle": {"vehicle_id": vehicle, "plate_number": "QA-1", "capacity_weight_kg": 1, "capacity_volume_m3": 1},
        "stops": [{"trip_stop_id": stop, "stop_name": shipment, "sequence": 1, "address": "Điểm nhận",
                   "lat": 10.1, "lng": 106.1, "demand_weight_kg": 1, "demand_volume_m3": 1}],
    }


def token(tenant: str, **changes: object) -> str:
    now = int(time.time())
    return jwt.encode({"tenantId": tenant, "iss": "transport-service", "aud": "route-optimizer-service",
                       "typ": "internal-service", "iat": now, "exp": now + 60, **changes}, SECRET, algorithm="HS256")


def test_exact_capacity_and_canonical_decimal_representation(full_input: dict) -> None:
    parsed = ProductionRouteRequest.model_validate(full_input)
    assert parsed.input_hash == input_hash(parsed.input_snapshot)
    assert canonical_input({"b": [True, None, 1], "a": "Tiếng Việt"}) == '{"a":"Tiếng Việt","b":[true,null,1]}'
    changed = copy.deepcopy(parsed.input_snapshot)
    changed["vehicle"]["capacityVolume"] = "1.00000"
    assert input_hash(changed) != parsed.input_hash


@pytest.mark.parametrize("field", ["tenant_id", "trip_id", "warehouse_id", "vehicle_id", "route_request_id", "trip_version", "depot", "vehicle", "stops"])
def test_complete_production_input_is_required(full_input: dict, field: str) -> None:
    del full_input[field]
    with pytest.raises(ValidationError):
        ProductionRouteRequest.model_validate(full_input)


@pytest.mark.parametrize("field", ["driver", "plannedStartAt", "solverVersion", "providerVersion", "options"])
def test_complete_canonical_input_is_required_even_with_a_matching_hash(full_input: dict, field: str) -> None:
    del full_input["input_snapshot"][field]
    full_input["input_hash"] = input_hash(full_input["input_snapshot"])
    with pytest.raises(ValidationError):
        ProductionRouteRequest.model_validate(full_input)


@pytest.mark.parametrize("change", ["hash", "tenant", "coordinate", "demand", "duplicate", "plate", "config", "capacity"])
def test_binding_rejects_mutated_or_unbound_input(full_input: dict, change: str) -> None:
    if change == "hash":
        full_input["input_hash"] = "f" * 64
    elif change == "tenant":
        full_input["tenant_id"] = str(uuid4())
    elif change == "coordinate":
        full_input["stops"][0]["lat"] = 10.2
    elif change == "demand":
        full_input["stops"][0]["demand_volume_m3"] = 0
    elif change == "duplicate":
        full_input["stops"].append(copy.deepcopy(full_input["stops"][0]))
    elif change == "plate":
        full_input["vehicle"]["plate_number"] = "not-bound"
    elif change == "config":
        full_input["input_snapshot"]["options"]["returnToDepot"] = False
        full_input["input_hash"] = input_hash(full_input["input_snapshot"])
    else:
        full_input["input_snapshot"]["stops"][0]["demandVolume"] = "1.000001"
        full_input["stops"][0]["demand_volume_m3"] = 1.000001
        full_input["input_hash"] = input_hash(full_input["input_snapshot"])
    with pytest.raises(ValidationError):
        ProductionRouteRequest.model_validate(full_input)


@pytest.mark.parametrize("value", [float("nan"), 1.0, 9007199254740992, {"非ASCII": 1}])
def test_canonical_input_disallows_lossy_or_nonportable_values(value: object) -> None:
    with pytest.raises(ValueError):
        canonical_input(value)


@pytest.mark.asyncio
async def test_internal_authentication_and_unavailable_persistence_never_returns_samples(full_input: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(routes.settings, "internal_service_jwt_secret", SECRET)
    monkeypatch.setattr(routes.settings, "database_url", "postgresql+asyncpg://owned.invalid/contract-only")
    async def unavailable(*args: object, **kwargs: object) -> None:
        raise RuntimeError("owned unavailable database")
    monkeypatch.setattr(routes, "stored", unavailable)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://owned.test") as client:
        assert (await client.post("/api/v1/route-optimizations", json=full_input)).status_code == 401
        headers = {"x-internal-service-token": token(str(uuid4()))}
        assert (await client.post("/api/v1/route-optimizations", json=full_input, headers=headers)).status_code == 403
        headers = {"x-internal-service-token": token(full_input["tenant_id"], exp=int(time.time()) - 60)}
        assert (await client.post("/api/v1/route-optimizations", json=full_input, headers=headers)).status_code == 401
        headers = {"x-internal-service-token": token(full_input["tenant_id"])}
        result = await client.post("/api/v1/route-optimizations", json=full_input, headers=headers)
        assert result.status_code == 503
        assert "stops" not in result.json()
        assert (await client.get(f"/api/v1/route-optimizations/{uuid4()}", headers=headers)).status_code == 503
        async def missing(*args: object, **kwargs: object) -> None:
            return None
        monkeypatch.setattr(routes, "stored", missing)
        assert (await client.get(f"/api/v1/route-optimizations/{uuid4()}", headers=headers)).status_code == 404
