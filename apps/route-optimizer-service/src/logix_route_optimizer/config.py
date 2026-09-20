from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class RouteOptimizerSettings(BaseSettings):
    service_name: str = "route-optimizer-service"
    port: int = 8003
    environment: str = "development"
    database_url: str | None = None
    log_level: str = "INFO"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = RouteOptimizerSettings()
