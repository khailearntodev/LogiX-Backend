"""Provider model catalogs loaded through server-side provider credentials."""

from __future__ import annotations

import httpx

from logix_agent.config import AgentSettings

GOOGLE_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models"
MODEL_CATALOG_TIMEOUT_SECONDS = 10.0


class ModelCatalogError(RuntimeError):
    """A provider model catalog could not be loaded safely."""

    code = "MODEL_CATALOG_UNAVAILABLE"


class ModelCatalogProviderNotConfiguredError(ModelCatalogError):
    code = "MODEL_CATALOG_PROVIDER_NOT_CONFIGURED"


class ModelCatalogProviderUnsupportedError(ModelCatalogError):
    code = "MODEL_CATALOG_PROVIDER_UNSUPPORTED"


def _parse_google_models(payload: object) -> list[dict[str, str]]:
    if not isinstance(payload, dict) or not isinstance(payload.get("models"), list):
        raise ModelCatalogError

    models: list[dict[str, str]] = []
    for item in payload["models"]:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        methods = item.get("supportedGenerationMethods")
        display_name = item.get("displayName")
        if (
            not isinstance(name, str)
            or not name.startswith("models/")
            or not isinstance(methods, list)
            or "generateContent" not in methods
        ):
            continue
        model_id = name.removeprefix("models/").strip()
        if not model_id.startswith("gemini-"):
            continue
        models.append(
            {
                "id": model_id,
                "display_name": display_name.strip() if isinstance(display_name, str) else model_id,
            }
        )
    return sorted(models, key=lambda item: item["id"])


async def list_provider_models(
    provider: str,
    *,
    settings: AgentSettings,
) -> list[dict[str, str]]:
    normalized = provider.strip().lower()
    if normalized != "gemini":
        raise ModelCatalogProviderUnsupportedError
    if not settings.gemini_api_key:
        raise ModelCatalogProviderNotConfiguredError

    models: list[dict[str, str]] = []
    page_token: str | None = None
    try:
        async with httpx.AsyncClient(timeout=MODEL_CATALOG_TIMEOUT_SECONDS) as client:
            for _ in range(5):
                params = {"key": settings.gemini_api_key}
                if page_token:
                    params["pageToken"] = page_token
                response = await client.get(GOOGLE_MODELS_URL, params=params)
                response.raise_for_status()
                page = response.json()
                models.extend(_parse_google_models(page))
                page_token = page.get("nextPageToken") if isinstance(page, dict) else None
                if not isinstance(page_token, str) or not page_token:
                    break
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        raise ModelCatalogError from exc
    return models


__all__ = [
    "ModelCatalogError",
    "ModelCatalogProviderNotConfiguredError",
    "ModelCatalogProviderUnsupportedError",
    "_parse_google_models",
    "list_provider_models",
]
