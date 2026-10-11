from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from starlette.exceptions import HTTPException as StarletteHTTPException

from logix_agent.config import settings
from logix_agent.db.session import create_engine, create_session_factory
from logix_agent.modules.agui.router import build_agui_runtime
from logix_agent.modules.agui.router import router as agui_router
from logix_agent.modules.ai.factory import create_model_gateway
from logix_agent.modules.ai.ports import ModelGateway

app_engine: AsyncEngine | None = None
app_session_factory: async_sessionmaker[AsyncSession] | None = None
app_model_gateway: ModelGateway | None = None


def get_engine() -> AsyncEngine:
    global app_engine
    if app_engine is None:
        app_engine = create_engine(settings.database_url)
    return app_engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    global app_session_factory
    if app_session_factory is None:
        app_session_factory = create_session_factory(get_engine())
    return app_session_factory


def get_model_gateway() -> ModelGateway:
    global app_model_gateway
    if app_model_gateway is None:
        app_model_gateway = create_model_gateway(settings)
    return app_model_gateway


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    global app_engine, app_session_factory, app_model_gateway
    try:
        session_factory = get_session_factory()
        async with session_factory() as session:
            await session.execute(text("SELECT 1"))
    except Exception as exc:
        print(f"[{settings.service_name}] Database connection warning on startup: {exc}")

    try:
        app_model_gateway = create_model_gateway(settings)
        app.state.agui_runtime = build_agui_runtime(
            app_model_gateway,
            prompt_policy_version=settings.prompt_policy_version,
        )
    except Exception as exc:
        print(f"[{settings.service_name}] Model gateway initialization warning: {exc}")

    yield

    app.state.agui_runtime = None

    if app_engine is not None:
        await app_engine.dispose()
        app_engine = None
        app_session_factory = None
    app_model_gateway = None


app = FastAPI(
    title="LogiX Agent Service",
    description="Agentic AI Service for LogiX B2B Logistics Platform",
    version="0.1.0",
    lifespan=lifespan,
)
app.include_router(agui_router)


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(
    _: Request, exc: StarletteHTTPException
) -> JSONResponse:
    """Same error body shape as the NestJS services."""
    status_phrase = {
        400: "Bad Request",
        401: "Unauthorized",
        403: "Forbidden",
        404: "Not Found",
        422: "Unprocessable Entity",
        503: "Service Unavailable",
    }.get(exc.status_code, "Error")
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "statusCode": exc.status_code,
            "message": exc.detail,
            "error": status_phrase,
        },
        headers=getattr(exc, "headers", None),
    )


@app.get("/", tags=["Info"])
async def root() -> dict[str, str]:
    return {
        "service": settings.service_name,
        "version": "0.1.0",
        "status": "running",
    }


@app.get("/health/live", tags=["Health"])
async def liveness() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/ready", tags=["Health"])
async def readiness() -> dict[str, str]:
    try:
        session_factory = get_session_factory()
        async with session_factory() as session:
            await session.execute(text("SELECT 1"))
        return {"status": "ready"}
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Database is not ready: {exc}",
        )


@app.get("/health/ai", tags=["Health"])
async def ai_health() -> dict[str, str | bool | None]:
    return {
        "status": "configured" if app_model_gateway is not None else "uninitialized",
        "backend": settings.llm_gateway_backend,
        "default_model": settings.planner_default_model,
        "fallback_enabled": settings.llm_fallback_enabled,
    }
