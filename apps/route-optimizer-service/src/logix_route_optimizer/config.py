from __future__ import annotations

import os
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

SERVICE_DIR = Path(__file__).resolve().parents[2]
ENV_PATH = SERVICE_DIR / ".env"


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
        env_file=(".env", ENV_PATH),
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = RouteOptimizerSettings()

if settings.database_url:
    os.environ.setdefault("DATABASE_URL", settings.database_url)
