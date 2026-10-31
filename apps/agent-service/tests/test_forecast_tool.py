"""Unit tests for Demand Forecast tools in the Planner Agent catalog."""

from __future__ import annotations

import uuid

import httpx
import pytest

from logix_agent.modules.auth import Actor
from logix_agent.modules.registry import RiskLevel, ToolContext, ToolRegistry
from logix_agent.modules.tools.catalog import build_tool_registry
from logix_agent.modules.tools.catalog.forecast import (
    READ_FORECAST,
    RUN_FORECAST,
    CheckStockoutRiskIn,
    DemandForecastOut,
    GetSkuDemandForecastIn,
    StockoutRisksOut,
    TriggerDemandForecastIn,
)
from logix_agent.modules.tools.http_client import ServiceClient


def _sample_forecast_payload(warehouse_id: uuid.UUID, product_id: uuid.UUID) -> dict:
    return {
        "forecast_run_id": str(uuid.uuid4()),
        "forecast_series_id": str(uuid.uuid4()),
        "warehouse_id": str(warehouse_id),
        "warehouse_name": "Kho Tổng Miền Nam (Tân Bình)",
        "product_id": str(product_id),
        "sku_code": "SKU-FMCG-001",
        "product_name": "Thùng Nước Giải Khát 24 Lon",
        "status": "COMPLETED",
        "model_name": "Meta Prophet",
        "used_fallback": False,
        "fallback_reason": None,
        "confidence_level": 0.8,
        "observation_count": 56,
        "training_start_date": "2026-08-20",
        "training_end_date": "2026-10-14",
        "horizon_days": 7,
        "dataset_hash": "a1b2c3d4e5f6",
        "total_predicted_7d": 324.5,
        "total_upper_bound_7d": 362.0,
        "available_stock": 280.0,
        "stockout_risk": True,
        "shortfall_quantity": 82.0,
        "recommended_action": "Advisory: Recommend replenishing at least 82 units to cover 7-day upper-bound demand.",
        "forecast_points": [
            {
                "forecast_date": "2026-10-15",
                "predicted_quantity": 45.0,
                "lower_bound": 39.5,
                "upper_bound": 50.5,
                "trend_component": 42.0,
                "weekly_component": 3.0,
            }
        ],
        "metrics": [
            {
                "method_name": "Meta Prophet",
                "rmse": 4.12,
                "mae": 3.45,
                "mape": 7.8,
                "mape_zero_policy": "FILTER_POSITIVE",
                "evaluated_days": 7,
            },
            {
                "method_name": "Moving Average 7",
                "rmse": 9.85,
                "mae": 8.10,
                "mape": 18.2,
                "mape_zero_policy": "FILTER_POSITIVE",
                "evaluated_days": 7,
            },
        ],
    }


def _sample_stockout_payload(warehouse_id: uuid.UUID, product_id: uuid.UUID) -> dict:
    return {
        "warehouse_id": str(warehouse_id),
        "checked_sku_count": 3,
        "at_risk_count": 1,
        "items": [
            {
                "warehouse_id": str(warehouse_id),
                "warehouse_name": "Kho Tổng Miền Nam (Tân Bình)",
                "product_id": str(product_id),
                "sku_code": "SKU-FMCG-001",
                "product_name": "Thùng Nước Giải Khát 24 Lon",
                "horizon_days": 7,
                "total_predicted_demand": 324.5,
                "total_upper_bound_demand": 362.0,
                "available_stock": 280.0,
                "shortfall_quantity": 82.0,
                "risk_level": "CRITICAL",
                "recommended_replenishment": 82.0,
                "recommended_action": "Replenish 82 units.",
            }
        ],
    }


def _ctx(*permissions: str) -> ToolContext:
    actor = Actor(
        user_id="u-planner-1",
        tenant_id="t-logix-1",
        permissions=frozenset(permissions),
        access_token="test-token",
    )
    return ToolContext(actor=actor, correlation_id="c-forecast-1")


def _registry(
    warehouse_id: uuid.UUID | None = None,
    product_id: uuid.UUID | None = None,
) -> ToolRegistry:
    target_wh = warehouse_id or uuid.uuid4()
    target_prod = product_id or uuid.uuid4()

    def _handler(req: httpx.Request) -> httpx.Response:
        url_str = str(req.url)
        if "/api/v1/forecast/stockout-risks" in url_str:
            return httpx.Response(200, json=_sample_stockout_payload(target_wh, target_prod))
        if "/api/v1/forecast/results" in url_str or "/api/v1/forecast/runs" in url_str:
            return httpx.Response(200, json=_sample_forecast_payload(target_wh, target_prod))
        return httpx.Response(200, json={})

    client = ServiceClient(
        base_urls={
            "inventory": "http://inventory.test",
            "master_data": "http://master.test",
            "order": "http://order.test",
            "fulfillment": "http://fulfillment.test",
            "route_optimizer": "http://route-optimizer.test",
            "transport": "http://transport.test",
            "forecast": "http://forecast.test",
        },
        backoff_seconds=0,
        transport=httpx.MockTransport(_handler),
    )
    return build_tool_registry(client)


def test_forecast_tools_are_registered_as_advisory_read_only() -> None:
    registry = _registry()
    ctx = _ctx(READ_FORECAST, RUN_FORECAST)
    specs = {s.name: s for s in registry.list_for(ctx.actor)}

    assert "get_sku_demand_forecast" in specs
    assert "trigger_demand_forecast" in specs
    assert "check_stockout_risk" in specs

    for tool_name in ("get_sku_demand_forecast", "trigger_demand_forecast", "check_stockout_risk"):
        spec = specs[tool_name]
        assert spec.risk_level is RiskLevel.READ
        assert spec.is_sensitive is False
        assert spec.preview is None
        assert spec.target_service == "forecast"

    assert specs["get_sku_demand_forecast"].required_permission == READ_FORECAST
    assert specs["check_stockout_risk"].required_permission == READ_FORECAST
    assert specs["trigger_demand_forecast"].required_permission == RUN_FORECAST


@pytest.mark.asyncio
async def test_get_sku_demand_forecast_handler() -> None:
    wh_id = uuid.uuid4()
    prod_id = uuid.uuid4()
    registry = _registry(wh_id, prod_id)
    ctx = _ctx(READ_FORECAST)
    spec = registry.get("get_sku_demand_forecast")

    args = GetSkuDemandForecastIn(warehouse_id=wh_id, product_id=prod_id, horizon_days=7)
    result = await spec.handler(ctx, args)

    assert isinstance(result, DemandForecastOut)
    assert result.warehouse_id == wh_id
    assert result.product_id == prod_id
    assert result.model_name == "Meta Prophet"
    assert result.used_fallback is False
    assert result.total_predicted_7d == 324.5
    assert result.stockout_risk is True
    assert len(result.forecast_points) == 1
    assert len(result.metrics) == 2


@pytest.mark.asyncio
async def test_trigger_demand_forecast_handler() -> None:
    wh_id = uuid.uuid4()
    prod_id = uuid.uuid4()
    registry = _registry(wh_id, prod_id)
    ctx = _ctx(RUN_FORECAST)
    spec = registry.get("trigger_demand_forecast")

    args = TriggerDemandForecastIn(
        warehouse_id=wh_id,
        product_id=prod_id,
        sku_code="SKU-FMCG-001",
        horizon_days=7,
    )
    result = await spec.handler(ctx, args)

    assert isinstance(result, DemandForecastOut)
    assert result.sku_code == "SKU-FMCG-001"
    assert result.shortfall_quantity == 82.0


@pytest.mark.asyncio
async def test_check_stockout_risk_handler() -> None:
    wh_id = uuid.uuid4()
    prod_id = uuid.uuid4()
    registry = _registry(wh_id, prod_id)
    ctx = _ctx(READ_FORECAST)
    spec = registry.get("check_stockout_risk")

    args = CheckStockoutRiskIn(warehouse_id=wh_id, horizon_days=7)
    result = await spec.handler(ctx, args)

    assert isinstance(result, StockoutRisksOut)
    assert result.warehouse_id == wh_id
    assert result.checked_sku_count == 3
    assert result.at_risk_count == 1
    assert result.items[0].risk_level == "CRITICAL"
