from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from logix_forecast.main import app


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
async def test_post_forecast_runs_and_get_results_mvp() -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        run_resp = await client.post(
            "/api/v1/forecast/runs",
            json={"horizon_days": 7, "available_stock": 200.0},
        )
        assert run_resp.status_code == 200
        run_data = run_resp.json()
        assert run_data["status"] == "SUCCEEDED"
        assert run_data["model_name"] == "Meta Prophet"
        assert len(run_data["forecast_points"]) == 7
        assert run_data["stockout_risk"] is True
        assert run_data["shortfall_quantity"] > 0.0

        metrics_resp = await client.get("/api/v1/forecast/metrics")
        assert metrics_resp.status_code == 200
        metrics_data = metrics_resp.json()
        assert metrics_data["selected_model"] == "Meta Prophet"
        assert metrics_data["prophet_rmse"] < metrics_data["baseline_ma7_rmse"]

        risk_resp = await client.get("/api/v1/forecast/stockout-risks")
        assert risk_resp.status_code == 200
        risk_data = risk_resp.json()
        assert risk_data["checked_sku_count"] == 2
        assert risk_data["at_risk_count"] >= 1

        by_id_resp = await client.get(f"/api/v1/forecast/runs/{uuid.uuid4()}")
        assert by_id_resp.status_code == 200
