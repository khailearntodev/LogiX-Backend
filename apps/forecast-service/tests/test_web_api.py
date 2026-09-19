import pytest
from httpx import ASGITransport, AsyncClient

from logix_forecast.main import app


@pytest.mark.asyncio
async def test_root_endpoint_returns_service_info() -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/")
    assert response.status_code == 200
    data = response.json()
    assert data["service"] == "forecast-service"
    assert data["status"] == "running"


@pytest.mark.asyncio
async def test_liveness_probe_returns_ok() -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/health/live")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
