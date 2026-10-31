from __future__ import annotations

import uuid
from datetime import date, timedelta

import logix_forecast.api.v1.forecasts as forecasts_api
import pytest
from httpx import ASGITransport, AsyncClient
from logix_forecast.engine.schemas import DemandObservationIn
from logix_forecast.main import app


def _build_test_observations(days: int = 56) -> list[dict[str, object]]:
    weekly_factors = [0.80, 0.90, 0.95, 1.05, 1.20, 1.35, 0.75]
    start = date(2026, 9, 5)
    return [
        {
            "demand_date": (start + timedelta(days=i)).isoformat(),
            "fulfilled_quantity": round(
                (42.0 + 0.35 * i)
                * weekly_factors[(start + timedelta(days=i)).weekday()],
                2,
            ),
        }
        for i in range(days)
    ]


@pytest.mark.asyncio
async def test_root_endpoint_returns_service_info() -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/")
    assert response.status_code == 200
    data = response.json()
    assert data["service"] == "forecast-service"
    assert data["status"] == "running"


@pytest.mark.asyncio
async def test_liveness_probe_returns_ok() -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/health/live")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_post_forecast_runs_with_observations_succeeds() -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        run_resp = await client.post(
            "/api/v1/forecast/runs",
            json={
                "horizon_days": 7,
                "available_stock": 200.0,
                "observations": _build_test_observations(56),
            },
        )
        assert run_resp.status_code == 200
        run_data = run_resp.json()
        assert run_data["status"] == "SUCCEEDED"
        assert run_data["model_name"] == "Meta Prophet"
        assert len(run_data["forecast_points"]) == 7
        assert run_data["stockout_risk"] is True
        assert run_data["shortfall_quantity"] > 0.0


@pytest.mark.asyncio
async def test_endpoints_return_404_when_no_observations_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _empty_series(**_: object) -> list[DemandObservationIn]:
        return []

    monkeypatch.setattr(forecasts_api, "_fetch_series_from_db", _empty_series)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        run_resp = await client.post("/api/v1/forecast/runs", json={"horizon_days": 7})
        assert run_resp.status_code == 404
        assert "No demand observations found" in run_resp.json()["detail"]

        results_resp = await client.get("/api/v1/forecast/results")
        assert results_resp.status_code == 404

        metrics_resp = await client.get("/api/v1/forecast/metrics")
        assert metrics_resp.status_code == 404

        by_id_resp = await client.get(f"/api/v1/forecast/runs/{uuid.uuid4()}")
        assert by_id_resp.status_code == 404
