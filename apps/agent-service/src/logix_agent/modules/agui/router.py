"""AG-UI endpoint serving the unified planner graph, thread management and confirmation decisions."""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Literal

from ag_ui.core import (
    EventType,
    ResumeEntry,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
)
from ag_ui.encoder import EventEncoder
from ag_ui_langgraph import LangGraphAgent
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from langchain_core.language_models import BaseChatModel
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.store.base import BaseStore
from langgraph.store.memory import InMemoryStore
from pydantic import BaseModel, Field

from logix_agent.modules.agui.thread_registry import (
    InMemoryThreadStore,
    InvalidThreadIdError,
    ThreadNotFoundError,
    ThreadStore,
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
from logix_agent.modules.conversations.recorder import ConversationRecorder
from logix_agent.modules.executions.service import (
    EXECUTION_FAILED,
    EXECUTION_RUNNING,
    EXECUTION_SUCCEEDED,
    EXECUTION_WAITING_CONFIRMATION,
    ExecutionRecorder,
    InMemoryExecutionRecorder,
)
from logix_agent.modules.planner.graph import build_planner_graph
from logix_agent.modules.planner.nodes import INTERNAL, PUBLIC_MESSAGES
from logix_agent.modules.registry.registry import ToolRegistry

if TYPE_CHECKING:
    from logix_agent.modules.tools.http_client import ServiceClient
    from logix_agent.modules.provider_configs.tenant_gateway import (
        ResolvedTenantModel,
        TenantModelResolver,
    )

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


class ThreadSummaryResponse(BaseModel):
    threadId: str
    title: str | None = None
    createdAt: datetime
    updatedAt: datetime


class ConversationMessageResponse(BaseModel):
    id: str
    role: str
    content: str
    sequence: int
    modelMessageId: str | None = None
    createdAt: datetime


@dataclass
class AguiRuntime:
    agent: LangGraphAgent
    threads: ThreadStore
    conversation_recorder: ConversationRecorder
    confirmation_service: ConfirmationService
    registry: ToolRegistry
    execution_recorder: ExecutionRecorder
    store: BaseStore | None = None
    prompt_policy_version: str = "v1"
    model_config_resolver: TenantModelResolver | None = None


def build_agui_runtime(
    gateway_or_model: ModelGateway | BaseChatModel | None = None,
    *,
    registry: ToolRegistry | None = None,
    checkpointer: BaseCheckpointSaver | None = None,
    store: BaseStore | None = None,
    confirmation_service: ConfirmationService | None = None,
    execution_recorder: ExecutionRecorder | None = None,
    thread_store: ThreadStore | None = None,
    service_client: ServiceClient | None = None,
    prompt_policy_version: str = "v1",
    model_config_resolver: TenantModelResolver | None = None,
) -> AguiRuntime:
    """Build the unified planner runtime supporting ToolRegistry and Confirmation Gate."""
    if registry is None:
        registry = ToolRegistry()

    if checkpointer is None:
        checkpointer = InMemorySaver()

    if store is None:
        store = InMemoryStore()

    if confirmation_service is None:
        confirmation_service = ConfirmationService(InMemoryConfirmationStore())

    if execution_recorder is None:
        execution_recorder = InMemoryExecutionRecorder()

    if thread_store is None:
        thread_store = InMemoryThreadStore()

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
        execution_recorder=execution_recorder,
        store=store,
        service_client=service_client,
    )

    agent = LangGraphAgent(
        name=AGENT_NAME,
        graph=graph,
        emit_raw_events=False,
        emit_interrupt_outcome=True,
    )
    return AguiRuntime(
        agent=agent,
        threads=thread_store,
        conversation_recorder=ConversationRecorder(thread_store),
        confirmation_service=confirmation_service,
        registry=registry,
        execution_recorder=execution_recorder,
        store=store,
        prompt_policy_version=prompt_policy_version,
        model_config_resolver=model_config_resolver,
    )


async def _begin_model_execution(
    runtime: AguiRuntime, actor: Actor, execution_id: str
) -> ResolvedTenantModel | None:
    resolver = runtime.model_config_resolver
    if resolver is None:
        return None
    try:
        return await resolver.begin_execution(actor.tenant_id, execution_id)
    except Exception as exc:
        from logix_agent.modules.provider_configs.tenant_gateway import (
            TenantModelConfigurationError,
        )

        if isinstance(exc, TenantModelConfigurationError):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=exc.code,
            ) from None
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="MODEL_CONFIG_UNAVAILABLE",
        ) from None


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


def _next_status(current: str, event: object) -> str:
    """Execution status implied by a stream event; errors outrank an interrupt."""
    if current == EXECUTION_FAILED:
        return current
    if isinstance(event, RunErrorEvent):
        return EXECUTION_FAILED
    if getattr(event, "name", None) == "on_interrupt":
        return EXECUTION_WAITING_CONFIRMATION
    return current


async def _record_final_status(
    runtime: AguiRuntime, actor: Actor, execution_id: str, status_now: str, tag: str
) -> None:
    # Bookkeeping must never break a response that has already been streamed.
    try:
        await runtime.execution_recorder.set_execution_status(
            actor.tenant_id,
            execution_id,
            status_now,
            error_code="RUN_ERROR" if status_now == EXECUTION_FAILED else None,
        )
    except Exception:
        logger.exception("%s failed to record execution status %s", tag, status_now)
    if runtime.model_config_resolver is not None:
        runtime.model_config_resolver.release_execution(actor.tenant_id, execution_id)


def _stream_agent_events(
    *,
    agent: LangGraphAgent,
    agent_input: RunAgentInput,
    encoder: EventEncoder,
    runtime: AguiRuntime,
    actor: Actor,
    execution_id: str,
    thread_id: str,
    tag: str,
    start_log: str,
    end_log: str,
) -> StreamingResponse:
    async def event_stream() -> AsyncIterator[str]:
        logger.info(start_log)
        status_now = EXECUTION_SUCCEEDED
        emitted_terminal = False
        assistant_buffer = runtime.conversation_recorder.new_assistant_buffer(
            fallback_message_id=execution_id
        )
        try:
            async for event in agent.run(agent_input):
                event_type = getattr(event, "type", None)
                if isinstance(event, RunErrorEvent) or event_type == EventType.RUN_ERROR:
                    emitted_terminal = True
                    logger.warning("%s agent run error: %s", tag, getattr(event, "message", ""))
                elif event_type == EventType.RUN_FINISHED:
                    emitted_terminal = True
                elif event_type == EventType.TEXT_MESSAGE_CONTENT:
                    assistant_buffer.append_delta(
                        getattr(event, "delta", None),
                        message_id=getattr(event, "message_id", None),
                    )
                status_now = _next_status(status_now, event)
                yield encoder.encode(_sanitize(event))
            if not emitted_terminal:
                emitted_terminal = True
                yield encoder.encode(
                    RunFinishedEvent(
                        type=EventType.RUN_FINISHED,
                        thread_id=thread_id,
                        run_id=execution_id,
                    )
                )
        except Exception as exc:
            status_now = EXECUTION_FAILED
            logger.exception("%s unhandled error during agent stream", tag)
            if not emitted_terminal:
                emitted_terminal = True
                yield encoder.encode(
                    _sanitize(
                        RunErrorEvent(
                            type=EventType.RUN_ERROR,
                            message=str(exc),
                            code=INTERNAL,
                        )
                    )
                )
        except BaseException:
            status_now = EXECUTION_FAILED
            raise
        finally:
            if status_now != EXECUTION_FAILED:
                await runtime.conversation_recorder.record_completed_assistant_message(
                    tenant_id=actor.tenant_id,
                    thread_id=thread_id,
                    buffer=assistant_buffer,
                    tag=tag,
                )
            await _record_final_status(runtime, actor, execution_id, status_now, tag)
            logger.info(end_log)

    return StreamingResponse(
        event_stream(),
        media_type=encoder.get_content_type(),
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _claim_thread_or_404(runtime: AguiRuntime, thread_id: str, actor: Actor) -> uuid.UUID:
    try:
        return await runtime.threads.claim(thread_id, actor)
    except InvalidThreadIdError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid threadId",
        ) from None
    except ThreadNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Thread not found"
        ) from None


@router.get("/threads", response_model=list[ThreadSummaryResponse])
async def list_threads(
    limit: int = Query(default=50, ge=1, le=100),
    actor: Actor = Depends(get_current_actor),
    runtime: AguiRuntime = Depends(get_agui_runtime),
) -> list[ThreadSummaryResponse]:
    threads = await runtime.threads.list_threads(actor, limit=limit)
    return [
        ThreadSummaryResponse(
            threadId=t.thread_id,
            title=t.title,
            createdAt=t.created_at,
            updatedAt=t.updated_at,
        )
        for t in threads
    ]


@router.get("/threads/{thread_id}/messages", response_model=list[ConversationMessageResponse])
async def list_thread_messages(
    thread_id: str,
    actor: Actor = Depends(get_current_actor),
    runtime: AguiRuntime = Depends(get_agui_runtime),
) -> list[ConversationMessageResponse]:
    try:
        messages = await runtime.threads.list_messages(thread_id, actor)
    except InvalidThreadIdError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid threadId",
        ) from None
    except ThreadNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Thread not found"
        ) from None
    return [
        ConversationMessageResponse(
            id=str(m.id),
            role=m.role,
            content=m.content,
            sequence=m.sequence,
            modelMessageId=m.model_message_id,
            createdAt=m.created_at,
        )
        for m in messages
    ]


@router.delete("/threads/{thread_id}")
async def delete_thread(
    thread_id: str,
    actor: Actor = Depends(get_current_actor),
    runtime: AguiRuntime = Depends(get_agui_runtime),
) -> dict[str, object]:
    try:
        await runtime.threads.delete_thread(thread_id, actor)
    except InvalidThreadIdError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid threadId",
        ) from None
    except ThreadNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Thread not found"
        ) from None
    return {"threadId": thread_id, "deleted": True}


@router.post("/runs")
async def run_agent(
    input_data: RunAgentInput,
    request: Request,
    actor: Actor = Depends(get_current_actor),
    runtime: AguiRuntime = Depends(get_agui_runtime),
) -> StreamingResponse:
    conversation_id = await _claim_thread_or_404(runtime, input_data.thread_id, actor)

    resolved_model = await _begin_model_execution(runtime, actor, input_data.run_id)

    tag = f"run={input_data.run_id[:8]} tenant={actor.tenant_id}"
    correlation_id = request.headers.get("x-correlation-id") or input_data.run_id
    # Created before streaming starts so a persistence failure is a clean error response.
    await runtime.execution_recorder.ensure_execution(
        tenant_id=actor.tenant_id,
        user_id=actor.user_id,
        execution_id=input_data.run_id,
        thread_id=input_data.thread_id,
        correlation_id=correlation_id,
        prompt_policy_version=runtime.prompt_policy_version,
        conversation_id=conversation_id,
        provider=resolved_model.provider if resolved_model else None,
        model=resolved_model.model if resolved_model else None,
        model_version=str(resolved_model.version) if resolved_model else None,
    )
    await runtime.conversation_recorder.record_user_message(
        tenant_id=actor.tenant_id,
        thread_id=input_data.thread_id,
        messages=input_data.messages,
    )

    agent = runtime.agent.clone()
    agent.config = {
        "configurable": {
            "tenant_id": actor.tenant_id,
            "user_id": actor.user_id,
            "role": actor.role,
            "permissions": list(actor.permissions),
            "access_token": actor.access_token,
            "actor": actor,
            "correlation_id": correlation_id,
            "execution_id": input_data.run_id,
            "run_id": input_data.run_id,
        }
    }
    # Identity comes from the verified token only; client-supplied tools, state and forwarded props are dropped.
    safe_input = input_data.model_copy(
        update={"tools": [], "state": {}, "context": [], "forwarded_props": {}}
    )
    encoder = EventEncoder(accept=request.headers.get("accept"))

    return _stream_agent_events(
        agent=agent,
        agent_input=safe_input,
        encoder=encoder,
        runtime=runtime,
        actor=actor,
        execution_id=input_data.run_id,
        thread_id=input_data.thread_id,
        tag=tag,
        start_log=(
            f"{tag} agent run started (thread={input_data.thread_id} "
            f"user={actor.user_id} messages={len(input_data.messages)})"
        ),
        end_log=f"{tag} agent run ended",
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

    resolved_model = await _begin_model_execution(runtime, actor, execution_id)

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

    conversation_id = await _claim_thread_or_404(runtime, thread_id, actor)

    tag = f"resume={execution_id[:8]} tenant={actor.tenant_id}"
    correlation_id = request.headers.get("x-correlation-id") or execution_id
    await runtime.execution_recorder.ensure_execution(
        tenant_id=actor.tenant_id,
        user_id=actor.user_id,
        execution_id=execution_id,
        thread_id=thread_id,
        correlation_id=correlation_id,
        prompt_policy_version=runtime.prompt_policy_version,
        conversation_id=conversation_id,
        provider=resolved_model.provider if resolved_model else None,
        model=resolved_model.model if resolved_model else None,
        model_version=str(resolved_model.version) if resolved_model else None,
    )
    await runtime.execution_recorder.set_execution_status(
        actor.tenant_id, execution_id, EXECUTION_RUNNING
    )
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
            "correlation_id": correlation_id,
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

    return _stream_agent_events(
        agent=agent,
        agent_input=resume_input,
        encoder=encoder,
        runtime=runtime,
        actor=actor,
        execution_id=execution_id,
        thread_id=thread_id,
        tag=tag,
        start_log=f"{tag} resuming graph execution on thread {thread_id}",
        end_log=f"{tag} resume execution ended",
    )
