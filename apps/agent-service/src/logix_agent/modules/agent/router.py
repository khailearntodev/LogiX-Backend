"""AG-UI endpoint for the create_agent flow (auth and identity are the only custom parts)."""

import logging
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass

from ag_ui.core import RunAgentInput, RunErrorEvent
from ag_ui.encoder import EventEncoder
from ag_ui_langgraph import LangGraphAgent
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from langchain_core.language_models import BaseChatModel
from langgraph.checkpoint.memory import InMemorySaver

from logix_agent.modules.agent.graph import build_agent
from logix_agent.modules.agent.run_logging import RunLogHandler
from logix_agent.modules.agui.thread_registry import (
    InvalidThreadIdError,
    ThreadNotFoundError,
    ThreadRegistry,
)
from logix_agent.modules.auth import Actor, get_current_actor

logger = logging.getLogger(__name__)

AGENT_NAME = "logix-copilot-official"
GENERIC_ERROR = "Đã xảy ra lỗi khi xử lý yêu cầu."

router = APIRouter(prefix="/api/v1/agent/official", tags=["Agent (create_agent)"])


@dataclass
class OfficialRuntime:
    agent: LangGraphAgent
    threads: ThreadRegistry


def build_official_runtime(model: BaseChatModel | None = None) -> OfficialRuntime:
    graph = build_agent(InMemorySaver(), model=model)
    return OfficialRuntime(
        agent=LangGraphAgent(name=AGENT_NAME, graph=graph, emit_raw_events=False),
        threads=ThreadRegistry(),
    )


def get_official_runtime(request: Request) -> OfficialRuntime:
    runtime: OfficialRuntime | None = getattr(request.app.state, "official_runtime", None)
    if runtime is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Agent runtime is not available",
        )
    return runtime


def _sanitize(event: object) -> object:
    """Exception text can carry provider or service internals; never send it to the client."""
    if isinstance(event, RunErrorEvent):
        return event.model_copy(update={"code": "INTERNAL", "message": GENERIC_ERROR})
    return event


@router.post("/runs")
async def run_agent(
    input_data: RunAgentInput,
    request: Request,
    actor: Actor = Depends(get_current_actor),
    runtime: OfficialRuntime = Depends(get_official_runtime),
) -> StreamingResponse:
    try:
        runtime.threads.claim(input_data.thread_id, actor)
    except InvalidThreadIdError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid threadId"
        ) from None
    except ThreadNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Thread not found"
        ) from None

    tag = f"run={input_data.run_id[:8]} tenant={actor.tenant_id}"
    agent = runtime.agent.clone()
    agent.config = {
        "callbacks": [RunLogHandler(tag)],
        "configurable": {
            "tenant_id": actor.tenant_id,
            "user_id": actor.user_id,
            "access_token": actor.access_token,
            "correlation_id": request.headers.get("x-correlation-id")
            or input_data.run_id,
        }
    }
    # Identity comes from the token only; client-supplied tools, state, context and props are dropped.
    safe_input = input_data.model_copy(
        update={"tools": [], "state": {}, "context": [], "forwarded_props": {}}
    )
    encoder = EventEncoder(accept=request.headers.get("accept"))

    async def event_stream() -> AsyncIterator[str]:
        started = time.monotonic()
        events = 0
        logger.info(
            "%s agent run started (thread=%s user=%s messages=%d)",
            tag,
            input_data.thread_id,
            actor.user_id,
            len(input_data.messages),
        )
        try:
            async for event in agent.run(safe_input):
                events += 1
                if isinstance(event, RunErrorEvent):
                    logger.warning("%s agent run error: %s", tag, event.message)
                yield encoder.encode(_sanitize(event))
        finally:
            logger.info(
                "%s agent run ended in %.1fs (%d events)",
                tag,
                time.monotonic() - started,
                events,
            )

    return StreamingResponse(
        event_stream(),
        media_type=encoder.get_content_type(),
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
