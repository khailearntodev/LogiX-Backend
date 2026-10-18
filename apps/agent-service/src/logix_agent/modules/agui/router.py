"""AG-UI endpoint serving the unified planner graph and confirmation decisions over SSE."""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal

from ag_ui.core import ResumeEntry, RunAgentInput, RunErrorEvent
from ag_ui.encoder import EventEncoder
from ag_ui_langgraph import LangGraphAgent
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from langchain_core.language_models import BaseChatModel
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import InMemorySaver
from pydantic import BaseModel, Field

from logix_agent.modules.agui.thread_registry import (
    InvalidThreadIdError,
    ThreadNotFoundError,
    ThreadRegistry,
)
from logix_agent.modules.ai.langchain_adapter import ModelGatewayChatModel
from logix_agent.modules.ai.ports import ModelGateway
from logix_agent.modules.auth import Actor, get_current_actor
from logix_agent.modules.confirmations.errors import (
    ConfirmationAccessDeniedError,
    ConfirmationExpiredError,
    ConfirmationNotFoundError,
    ConfirmationStateError,
)
from logix_agent.modules.confirmations.service import (
    ConfirmationService,
    InMemoryConfirmationStore,
)
from logix_agent.modules.planner.graph import build_planner_graph
from logix_agent.modules.planner.nodes import INTERNAL, PUBLIC_MESSAGES
from logix_agent.modules.registry.registry import ToolRegistry

logger = logging.getLogger(__name__)

AGENT_NAME = "logix-copilot"
_CODED_MESSAGE = re.compile(r"^\[([A-Z_]+)\] (.*)$", re.DOTALL)

router = APIRouter(prefix="/api/v1/agent", tags=["Agent"])


class DecisionPayload(BaseModel):
    decision: Literal["APPROVE", "REJECT", "approve", "reject"] | str = Field(
        description="Decision for the sensitive tool approval"
    )
    approval_id: str | None = Field(default=None, description="Approval ID if known")
    thread_id: str | None = Field(default=None, description="Thread ID to resume")
    reason: str | None = Field(default=None, description="Optional reason for the decision")


@dataclass
class AguiRuntime:
    agent: LangGraphAgent
    threads: ThreadRegistry
    confirmation_service: ConfirmationService
    registry: ToolRegistry


def build_agui_runtime(
    gateway_or_model: ModelGateway | BaseChatModel | None = None,
    *,
    registry: ToolRegistry | None = None,
    checkpointer: BaseCheckpointSaver | None = None,
    confirmation_service: ConfirmationService | None = None,
    prompt_policy_version: str = "v1",
) -> AguiRuntime:
    """Build the unified planner runtime supporting ToolRegistry and Confirmation Gate."""
    if registry is None:
        registry = ToolRegistry()

    if checkpointer is None:
        checkpointer = InMemorySaver()

    if confirmation_service is None:
        confirmation_service = ConfirmationService(InMemoryConfirmationStore())

    model: BaseChatModel | None = None
    if isinstance(gateway_or_model, BaseChatModel):
        model = gateway_or_model
    elif isinstance(gateway_or_model, ModelGateway):
        model = ModelGatewayChatModel(
            gateway=gateway_or_model, system_policy_version=prompt_policy_version
        )

    graph = build_planner_graph(
        registry=registry,
        checkpointer=checkpointer,
        model=model,
        confirmation_service=confirmation_service,
    )

    agent = LangGraphAgent(
        name=AGENT_NAME,
        graph=graph,
        emit_raw_events=False,
        emit_interrupt_outcome=True,
    )
    return AguiRuntime(
        agent=agent,
        threads=ThreadRegistry(),
        confirmation_service=confirmation_service,
        registry=registry,
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
    return event.model_copy(update={"code": INTERNAL, "message": PUBLIC_MESSAGES[INTERNAL]})


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

    tag = f"run={input_data.run_id[:8]} tenant={actor.tenant_id}"
    agent = runtime.agent.clone()
    agent.config = {
        "configurable": {
            "tenant_id": actor.tenant_id,
            "user_id": actor.user_id,
            "role": actor.role,
            "permissions": list(actor.permissions),
            "access_token": actor.access_token,
            "actor": actor,
            "correlation_id": request.headers.get("x-correlation-id") or input_data.run_id,
            "execution_id": input_data.run_id,
            "run_id": input_data.run_id,
        }
    }
    # Identity comes from the verified token only; client-supplied tools, state and forwarded props are dropped.
    safe_input = input_data.model_copy(
        update={"tools": [], "state": {}, "context": [], "forwarded_props": {}}
    )
    encoder = EventEncoder(accept=request.headers.get("accept"))

    async def event_stream() -> AsyncIterator[str]:
        logger.info(
            "%s agent run started (thread=%s user=%s messages=%d)",
            tag,
            input_data.thread_id,
            actor.user_id,
            len(input_data.messages),
        )
        try:
            async for event in agent.run(safe_input):
                if isinstance(event, RunErrorEvent):
                    logger.warning("%s agent run error: %s", tag, event.message)
                yield encoder.encode(_sanitize(event))
        finally:
            logger.info("%s agent run ended", tag)

    return StreamingResponse(
        event_stream(),
        media_type=encoder.get_content_type(),
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/executions/{execution_id}/decisions")
async def submit_decision(
    execution_id: str,
    body: DecisionPayload,
    request: Request,
    actor: Actor = Depends(get_current_actor),
    runtime: AguiRuntime = Depends(get_agui_runtime),
) -> StreamingResponse:
    """Submit a confirmation decision (APPROVE or REJECT) and resume graph execution."""
    approval_id = body.approval_id
    if not approval_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="approval_id is required in decision payload",
        )

    try:
        await runtime.confirmation_service.record_decision(
            tenant_id=actor.tenant_id,
            approval_id=approval_id,
            actor=actor,
            decision=body.decision,
            reason=body.reason,
        )
    except ConfirmationNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Confirmation request not found",
        ) from None
    except ConfirmationAccessDeniedError:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: actor not authorized for this confirmation",
        ) from None
    except ConfirmationExpiredError:
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="Confirmation request has expired",
        ) from None
    except ConfirmationStateError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from None

    thread_id = body.thread_id
    if not thread_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="thread_id is required to resume execution",
        )

    try:
        runtime.threads.claim(thread_id, actor)
    except InvalidThreadIdError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid threadId",
        ) from None
    except ThreadNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Thread not found"
        ) from None

    tag = f"resume={execution_id[:8]} tenant={actor.tenant_id}"
    agent = runtime.agent.clone()
    agent.config = {
        "configurable": {
            "thread_id": thread_id,
            "tenant_id": actor.tenant_id,
            "user_id": actor.user_id,
            "role": actor.role,
            "permissions": list(actor.permissions),
            "access_token": actor.access_token,
            "actor": actor,
            "correlation_id": request.headers.get("x-correlation-id") or execution_id,
            "execution_id": execution_id,
            "run_id": execution_id,
        }
    }

    # Retrieve active interrupt id from state if available
    graph_state = await agent.graph.aget_state({"configurable": {"thread_id": thread_id}})
    interrupt_id = "default"
    if graph_state and graph_state.tasks:
        for t in graph_state.tasks:
            if t.interrupts:
                interrupt_id = getattr(t.interrupts[0], "id", "default")
                break

    is_approved = body.decision.strip().upper() == "APPROVE"
    resume_entry = ResumeEntry(
        interrupt_id=interrupt_id,
        status="resolved",
        payload={
            "decision": body.decision.strip().upper(),
            "approved": is_approved,
            "approval_id": approval_id,
            "reason": body.reason,
        },
    )

    resume_input = RunAgentInput(
        thread_id=thread_id,
        run_id=str(uuid.uuid4()),
        messages=[],
        tools=[],
        context=[],
        state={},
        forwarded_props={},
        resume=[resume_entry],
    )
    encoder = EventEncoder(accept=request.headers.get("accept"))

    async def event_stream() -> AsyncIterator[str]:
        logger.info("%s resuming graph execution on thread %s", tag, thread_id)
        try:
            async for event in agent.run(resume_input):
                if isinstance(event, RunErrorEvent):
                    logger.warning("%s resume run error: %s", tag, event.message)
                yield encoder.encode(_sanitize(event))
        finally:
            logger.info("%s resume execution ended", tag)

    return StreamingResponse(
        event_stream(),
        media_type=encoder.get_content_type(),
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
