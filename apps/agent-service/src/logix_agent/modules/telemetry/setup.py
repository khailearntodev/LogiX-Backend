"""OpenTelemetry lifecycle management and Tracer provider initialization."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import Tracer

if TYPE_CHECKING:
    from fastapi import FastAPI

    from logix_agent.config import AgentSettings

logger = logging.getLogger(__name__)

_tracer_provider: TracerProvider | None = None
_fastapi_instrumented: bool = False


def setup_telemetry(settings: AgentSettings, app: FastAPI | None = None) -> None:
    """Initialize OpenTelemetry tracer provider, exporter, and auto-instrumentation."""
    global _tracer_provider, _fastapi_instrumented

    if not settings.otel_enabled:
        logger.info("OpenTelemetry tracing is disabled (OTEL_ENABLED=false).")
        return

    if _tracer_provider is not None:
        logger.debug("OpenTelemetry TracerProvider already initialized.")
        return

    try:
        resource = Resource.create(
            {
                SERVICE_NAME: settings.otel_service_name,
                "deployment.environment": settings.environment,
            }
        )
        provider = TracerProvider(resource=resource)
        exporter = OTLPSpanExporter(endpoint=settings.otel_exporter_otlp_endpoint)
        processor = BatchSpanProcessor(exporter)
        provider.add_span_processor(processor)

        trace.set_tracer_provider(provider)
        _tracer_provider = provider

        if app is not None and not _fastapi_instrumented:
            FastAPIInstrumentor.instrument_app(
                app,
                tracer_provider=provider,
                excluded_urls="health/.*",
            )
            _fastapi_instrumented = True

        logger.info(
            "OpenTelemetry initialized successfully (service=%s, endpoint=%s)",
            settings.otel_service_name,
            settings.otel_exporter_otlp_endpoint,
        )
    except Exception as exc:
        logger.warning("Failed to initialize OpenTelemetry tracing: %s", exc, exc_info=True)


def shutdown_telemetry() -> None:
    """Flush and shut down the OpenTelemetry tracer provider cleanly."""
    global _tracer_provider
    if _tracer_provider is not None:
        try:
            _tracer_provider.shutdown()
            logger.info("OpenTelemetry TracerProvider shut down cleanly.")
        except Exception as exc:
            logger.warning("Error during OpenTelemetry shutdown: %s", exc)
        finally:
            _tracer_provider = None


def get_tracer(instrumenting_module_name: str) -> Tracer:
    """Return an OpenTelemetry Tracer.

    Falls back to a standard No-op tracer automatically if OpenTelemetry
    is disabled or uninitialized, ensuring zero runtime impact.
    """
    return trace.get_tracer(instrumenting_module_name)
