"""V1 API router."""

from fastapi import APIRouter
from logix_route_optimizer.api.v1.routes import router as route_router

v1_router = APIRouter(prefix="/api/v1")
v1_router.include_router(route_router)

__all__ = ["v1_router"]
