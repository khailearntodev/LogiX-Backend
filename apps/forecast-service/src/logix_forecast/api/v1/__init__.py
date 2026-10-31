"""V1 API router for forecast-service."""

from fastapi import APIRouter

from logix_forecast.api.v1.forecasts import router as forecast_router

v1_router = APIRouter(prefix="/api/v1")
v1_router.include_router(forecast_router)

__all__ = ["v1_router"]
