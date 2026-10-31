from __future__ import annotations

import os
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

SERVICE_DIR = Path(__file__).resolve().parents[2]
ENV_PATH = SERVICE_DIR / ".env"


class ForecastSettings(BaseSettings):
    service_name: str = "forecast-service"
    port: int = 8002
    environment: str = "development"
    database_url: str | None = None
    log_level: str = "INFO"

    model_config = SettingsConfigDict(
        env_file=(".env", ENV_PATH),
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = ForecastSettings()

if settings.database_url:
    os.environ.setdefault("DATABASE_URL", settings.database_url)
