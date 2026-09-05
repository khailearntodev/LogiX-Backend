"""Import every ORM model so Alembic sees the complete service metadata."""

from logix_route_optimizer.modules.messaging.models import OutboxEvent
from logix_route_optimizer.modules.optimization.models import (
    OptimizationMetric,
    OptimizationResult,
    OptimizationRun,
    OptimizationStop,
)

__all__ = [
    "OptimizationMetric",
    "OptimizationResult",
    "OptimizationRun",
    "OptimizationStop",
    "OutboxEvent",
]

