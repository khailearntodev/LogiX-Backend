from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class RouteOptimizerSettings(BaseSettings):
    service_name: str = "route-optimizer-service"
    port: int = 8003
    environment: str = "development"
    database_url: str | None = None
    internal_service_jwt_secret: str | None = None
    log_level: str = "INFO"
    osrm_url: str = "https://router.project-osrm.org"
    osrm_timeout_seconds: float = 4.0
    default_vehicle_capacity_weight_kg: float = 1000.0
    default_vehicle_capacity_volume_m3: float = 8.0

    model_config = SettingsConfigDict(
        env_file=None,
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = RouteOptimizerSettings()
