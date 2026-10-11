"""AG-UI endpoint serving the chat graph over SSE."""

from __future__ import annotations

import re
from collections.abc import AsyncIterator
from dataclasses import dataclass

from ag_ui.core import RunAgentInput, RunErrorEvent
from ag_ui.encoder import EventEncoder
from ag_ui_langgraph import LangGraphAgent
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from langgraph.checkpoint.memory import InMemorySaver

from logix_agent.modules.agui.thread_registry import (
    InvalidThreadIdError,
    ThreadNotFoundError,
    ThreadRegistry,
)
from logix_agent.modules.ai.ports import ModelGateway
from logix_agent.modules.auth import Actor, get_current_actor
from logix_agent.modules.planner.chat_graph import (
    INTERNAL,
    PUBLIC_MESSAGES,
    build_chat_graph,
)

AGENT_NAME = "logix-copilot"
_CODED_MESSAGE = re.compile(r"^\[([A-Z_]+)\] (.*)$", re.DOTALL)

router = APIRouter(prefix="/api/v1/agent", tags=["Agent"])


@dataclass
class AguiRuntime:
    agent: LangGraphAgent
    threads: ThreadRegistry


def build_agui_runtime(
    gateway: ModelGateway, *, prompt_policy_version: str = "v1"
) -> AguiRuntime:
    graph = build_chat_graph(
        gateway,
        checkpointer=InMemorySaver(),
        prompt_policy_version=prompt_policy_version,
    )
    # RAW events would leak the system prompt and LangChain internals to the browser.
    return AguiRuntime(
        agent=LangGraphAgent(name=AGENT_NAME, graph=graph, emit_raw_events=False),
        threads=ThreadRegistry(),
    )


def get_agui_runtime(request: Request) -> AguiRuntime:
    runtime: AguiRuntime | None = getattr(request.app.state, "agui_runtime", None)
    if runtime is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Agent runtime is not available",
        )
    return runtime


def _sanitize(event: object) -> object:
    """Never forward raw exception text to the client; keep only coded messages."""
    if not isinstance(event, RunErrorEvent):
        return event
    match = _CODED_MESSAGE.match(event.message or "")
    if match and match.group(1) in PUBLIC_MESSAGES:
        return event.model_copy(update={"code": match.group(1), "message": match.group(2)})
    return event.model_copy(
        update={"code": INTERNAL, "message": PUBLIC_MESSAGES[INTERNAL]}
    )


@router.post("/runs")
async def run_agent(
    input_data: RunAgentInput,
    request: Request,
    actor: Actor = Depends(get_current_actor),
    runtime: AguiRuntime = Depends(get_agui_runtime),
) -> StreamingResponse:
    try:
        runtime.threads.claim(input_data.thread_id, actor)
    except InvalidThreadIdError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid threadId",
        ) from None
    except ThreadNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Thread not found"
        ) from None

    # Identity comes from the verified token only; client state/props are ignored.
    agent = runtime.agent.clone()
    agent.config = {
        "configurable": {
            "tenant_id": actor.tenant_id,
            "user_id": actor.user_id,
            "correlation_id": request.headers.get("x-correlation-id")
            or input_data.run_id,
        }
    }
    safe_input = input_data.model_copy(
        update={"tools": [], "state": {}, "context": []}
    )
    encoder = EventEncoder(accept=request.headers.get("accept"))

    async def event_stream() -> AsyncIterator[str]:
        async for event in agent.run(safe_input):
            yield encoder.encode(_sanitize(event))

    return StreamingResponse(
        event_stream(),
        media_type=encoder.get_content_type(),
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
