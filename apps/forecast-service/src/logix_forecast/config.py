from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class ForecastSettings(BaseSettings):
    service_name: str = "forecast-service"
    port: int = 8002
    environment: str = "development"
    database_url: str | None = None
    log_level: str = "INFO"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = ForecastSettings()
