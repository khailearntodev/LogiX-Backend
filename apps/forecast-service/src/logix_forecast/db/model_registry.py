"""Import every ORM model so Alembic sees the complete service metadata."""

from logix_forecast.modules.demand.models import DemandObservation
from logix_forecast.modules.forecasts.models import ForecastMetric, ForecastResult, ForecastRun, ForecastSeries
from logix_forecast.modules.messaging.models import InboxEvent, OutboxEvent

__all__ = [
    "DemandObservation",
    "ForecastMetric",
    "ForecastResult",
    "ForecastRun",
    "ForecastSeries",
    "InboxEvent",
    "OutboxEvent",
]

