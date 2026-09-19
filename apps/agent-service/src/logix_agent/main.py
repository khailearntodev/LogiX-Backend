from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from logix_agent.config import settings
from logix_agent.db.session import create_engine, create_session_factory

app_engine: AsyncEngine | None = None
app_session_factory: async_sessionmaker[AsyncSession] | None = None


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


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    global app_engine, app_session_factory
    try:
        session_factory = get_session_factory()
        async with session_factory() as session:
            await session.execute(text("SELECT 1"))
    except Exception as exc:
        print(f"[{settings.service_name}] Database connection warning on startup: {exc}")

    yield

    if app_engine is not None:
        await app_engine.dispose()
        app_engine = None
        app_session_factory = None


app = FastAPI(
    title="LogiX Agent Service",
    description="Agentic AI Service for LogiX B2B Logistics Platform",
    version="0.1.0",
    lifespan=lifespan,
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
