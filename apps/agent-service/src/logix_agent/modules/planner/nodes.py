"""StateGraph nodes and routing logic for the planner agent."""

from __future__ import annotations

import logging
import time
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from langchain_core.messages import AIMessage, SystemMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langgraph.graph import END
from langgraph.types import interrupt

from logix_agent.modules.ai.errors import (
    FallbackExhaustedError,
    ModelGatewayError,
    ModelRateLimitError,
    ModelTimeoutError,
    ModelUnavailableError,
)
from logix_agent.modules.auth import Actor
from logix_agent.modules.confirmations.service import ConfirmationService
from logix_agent.modules.planner.state import PlannerState
from logix_agent.modules.registry.errors import (
    ApprovalRequiredError,
    ToolPermissionError,
    UnknownToolError,
)
from logix_agent.modules.registry.registry import ToolRegistry
from logix_agent.modules.registry.spec import ApprovedAction, ToolContext
from logix_agent.modules.tools.langchain_adapter import tools_for_actor

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You are LogiX Copilot, an intelligent assistant for a B2B logistics platform. "
    "Reply in the language the user writes in and keep answers concise. "
    "Use the available tools to read or update business data; never invent data. "
    "When asked to plan or optimize delivery routes, use propose_trip_route to analyze "
    "the optimal stop sequence on the OSRM road network, summarize the distance savings "
    "compared to baselines, and ask the dispatcher for explicit approval. "
    "For sensitive actions (such as confirming sales orders or approving delivery routes), "
    "a confirmation preview will be requested automatically before any modification is executed."
)

_STATUS_MESSAGES = {
    400: "Yêu cầu không hợp lệ. Vui lòng kiểm tra lại thông tin.",
    401: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn.",
    403: "Bạn không có quyền thực hiện thao tác này.",
    404: "Không tìm thấy dữ liệu được yêu cầu.",
    409: "Xung đột dữ liệu hoặc trạng thái không hợp lệ.",
}


def _get_actor_from_config(config: RunnableConfig) -> Actor:
    configurable = config.get("configurable", {})
    actor = configurable.get("actor")
    if isinstance(actor, Actor):
        return actor
    return Actor(
        user_id=str(configurable.get("user_id", "")),
        tenant_id=str(configurable.get("tenant_id", "")),
        role=str(configurable.get("role", "MEMBER")),
        permissions=frozenset(configurable.get("permissions", ())),
        access_token=str(configurable.get("access_token", "")),
    )


def _get_tag(config: RunnableConfig, actor: Actor) -> str:
    configurable = config.get("configurable", {})
    run_id = configurable.get("run_id") or configurable.get("execution_id") or "unknown"
    return f"run={str(run_id)[:8]} tenant={actor.tenant_id}"


def _format_tool_error(exc: Exception) -> str:
    """Format exceptions into safe localized messages for the model."""
    if isinstance(exc, ToolPermissionError):
        return "Bạn không có quyền sử dụng công cụ này."
    if isinstance(exc, ApprovalRequiredError):
        return "Thao tác này bắt buộc phải có sự xác nhận của người dùng."
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if status in _STATUS_MESSAGES:
            return _STATUS_MESSAGES[status]
        if status < 500:
            return "Yêu cầu không hợp lệ, hãy kiểm tra lại tham số."
        return "Dịch vụ nghiệp vụ hiện không khả dụng. Vui lòng thử lại sau."
    if isinstance(exc, httpx.TimeoutException):
        return "Dịch vụ nghiệp vụ phản hồi quá lâu. Vui lòng thử lại."
    if isinstance(exc, httpx.TransportError):
        return "Không kết nối được tới dịch vụ nghiệp vụ. Vui lòng thử lại sau."
    logger.error("Tool execution error", exc_info=exc)
    return "Công cụ gặp lỗi không mong muốn. Vui lòng thử lại sau."


MODEL_TIMEOUT = "MODEL_TIMEOUT"
MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE"
INTERNAL = "INTERNAL"

PUBLIC_MESSAGES = {
    MODEL_TIMEOUT: "Mô hình AI phản hồi quá lâu. Vui lòng thử lại.",
    MODEL_UNAVAILABLE: "Mô hình AI hiện không khả dụng. Vui lòng thử lại sau.",
    INTERNAL: "Đã xảy ra lỗi khi xử lý yêu cầu.",
}


class ChatRunError(Exception):
    """Run failure carrying a stable code; ``str()`` is parsed by the AG-UI router."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(f"[{code}] {PUBLIC_MESSAGES[code]}")


def _classify(exc: ModelGatewayError) -> str:
    if isinstance(exc, ModelTimeoutError):
        return MODEL_TIMEOUT
    if isinstance(exc, (ModelRateLimitError, ModelUnavailableError, FallbackExhaustedError)):
        return MODEL_UNAVAILABLE
    return INTERNAL


def create_agent_node(model: Any, registry: ToolRegistry):
    async def agent_node(state: PlannerState, config: RunnableConfig) -> dict[str, Any]:
        actor = _get_actor_from_config(config)
        tag = _get_tag(config, actor)
        tools = tools_for_actor(registry, actor)
        bound_model = model
        if tools and hasattr(model, "bind_tools"):
            try:
                bound_model = model.bind_tools(tools)
            except NotImplementedError:
                bound_model = model

        history = list(state.get("messages", []))
        # Ensure system prompt is present at the front of conversation
        if not history or not isinstance(history[0], SystemMessage):
            history = [SystemMessage(content=SYSTEM_PROMPT), *history]

        tool_names = [t.name for t in tools] if tools else []
        logger.info(
            "%s [AGENT_NODE:START] user=%s role=%s history=%d tools_available=%d (%s)",
            tag,
            actor.user_id,
            actor.role,
            len(history),
            len(tool_names),
            ", ".join(tool_names),
        )

        correlation_id = str(config.get("configurable", {}).get("correlation_id", ""))
        try:
            response = await bound_model.ainvoke(
                history,
                config,
                tenant_id=actor.tenant_id,
                correlation_id=correlation_id,
            )
        except ModelGatewayError as exc:
            logger.warning("%s [AGENT_NODE:ERROR] Model call gateway error: %s", tag, exc)
            raise ChatRunError(_classify(exc)) from exc

        tool_calls = getattr(response, "tool_calls", []) or []
        if tool_calls:
            tc_summary = [f"{tc['name']}({tc.get('args', {})})" for tc in tool_calls]
            logger.info(
                "%s [AGENT_NODE:RESPONSE] LLM returned %d tool call(s): %s",
                tag,
                len(tool_calls),
                "; ".join(tc_summary),
            )
        else:
            snippet = (response.content or "")[:120].replace("\n", " ")
            logger.info(
                "%s [AGENT_NODE:RESPONSE] LLM returned text (no tool calls): %s%s",
                tag,
                snippet,
                "..." if len(response.content or "") > 120 else "",
            )

        return {"messages": [response]}

    return agent_node


def create_preview_node(
    registry: ToolRegistry,
    confirmation_service: ConfirmationService,
    confirmation_ttl_seconds: int = 900,
):
    async def preview_node(state: PlannerState, config: RunnableConfig) -> dict[str, Any]:
        actor = _get_actor_from_config(config)
        tag = _get_tag(config, actor)
        configurable = config.get("configurable", {})
        correlation_id = str(configurable.get("correlation_id", ""))
        execution_id = (
            configurable.get("execution_id")
            or configurable.get("run_id")
            or "00000000-0000-0000-0000-000000000000"
        )

        last_message = state["messages"][-1]
        if not isinstance(last_message, AIMessage) or not last_message.tool_calls:
            logger.warning("%s [PREVIEW_NODE] No tool call found in last message", tag)
            return {}

        tool_call = last_message.tool_calls[0]
        tool_name = tool_call["name"]
        tool_args = tool_call.get("args", {})
        call_id = tool_call.get("id") or "call_1"

        logger.info(
            "%s [PREVIEW_NODE:START] generating preview for sensitive tool '%s' args=%s",
            tag,
            tool_name,
            str(tool_args)[:200],
        )

        context = ToolContext(actor=actor, correlation_id=correlation_id)

        try:
            preview = await registry.preview(tool_name, context, tool_args)
        except Exception as exc:
            logger.warning(
                "%s [PREVIEW_NODE:ERROR] preview failed for tool '%s': %s", tag, tool_name, exc
            )
            err_msg = _format_tool_error(exc)
            return {
                "messages": [
                    ToolMessage(
                        content=err_msg, name=tool_name, status="error", tool_call_id=call_id
                    )
                ],
                "step_count": state.get("step_count", 0) + 1,
            }

        expires_at = datetime.now(UTC) + timedelta(seconds=confirmation_ttl_seconds)

        record = await confirmation_service.create_request(
            tenant_id=actor.tenant_id,
            user_id=actor.user_id,
            agent_execution_id=execution_id,
            tool_call_id="00000000-0000-0000-0000-000000000000",
            action_type=tool_name,
            target_type=preview.target_type,
            target_id=preview.target_id,
            expected_target_version=preview.target_version,
            preview_summary=dict(preview.summary),
            arguments=tool_args,
            expires_at=expires_at,
        )

        logger.info(
            "%s [PREVIEW_NODE:SUCCESS] created confirmation request approval_id=%s action='%s' target=%s:%s (version=%s)",
            tag,
            record.id,
            tool_name,
            preview.target_type,
            preview.target_id,
            preview.target_version,
        )

        return {
            "pending_approval": {
                "approval_id": str(record.id),
                "action": tool_name,
                "target_type": preview.target_type,
                "target_id": str(preview.target_id),
                "target_version": preview.target_version,
                "preview": preview.summary,
                "expires_at": expires_at.isoformat(),
                "tool_call": tool_call,
            }
        }

    return preview_node


def create_confirm_node():
    def confirm_node(state: PlannerState) -> dict[str, Any]:
        pending = state.get("pending_approval")
        if not pending:
            return {}
        logger.info(
            "[CONFIRM_NODE:INTERRUPT] pausing execution for user confirmation: approval_id=%s action='%s'",
            pending.get("approval_id"),
            pending.get("action"),
        )
        resume_val = interrupt(pending)
        logger.info(
            "[CONFIRM_NODE:RESUMED] received user decision: %s for approval_id=%s",
            resume_val,
            pending.get("approval_id"),
        )
        return {"pending_decision": resume_val}

    return confirm_node


def create_revalidate_and_execute_node(
    registry: ToolRegistry,
    confirmation_service: ConfirmationService,
):
    async def revalidate_and_execute_node(
        state: PlannerState, config: RunnableConfig
    ) -> dict[str, Any]:
        pending = state.get("pending_approval")
        if not pending:
            return {"step_count": state.get("step_count", 0) + 1}

        actor = _get_actor_from_config(config)
        tag = _get_tag(config, actor)
        configurable = config.get("configurable", {})
        correlation_id = str(configurable.get("correlation_id", ""))
        context = ToolContext(actor=actor, correlation_id=correlation_id)

        tool_call = pending["tool_call"]
        tool_name = tool_call["name"]
        tool_args = tool_call.get("args", {})
        call_id = tool_call.get("id") or "call_1"
        approval_id = pending["approval_id"]
        expected_version = pending["target_version"]

        decision_data = state.get("pending_decision")
        logger.info(
            "%s [REVALIDATE_AND_EXECUTE:START] checking decision for approval_id=%s action='%s': raw_decision=%s",
            tag,
            approval_id,
            tool_name,
            decision_data,
        )

        is_approved = False
        if isinstance(decision_data, str):
            is_approved = decision_data.strip().upper() == "APPROVE"
        elif isinstance(decision_data, dict):
            is_approved = (
                decision_data.get("approved") is True
                or str(decision_data.get("decision", "")).strip().upper() == "APPROVE"
            )

        if not is_approved:
            logger.warning(
                "%s [REVALIDATE_AND_EXECUTE:REJECTED] approval_id=%s action='%s' was rejected or cancelled",
                tag,
                approval_id,
                tool_name,
            )
            return {
                "messages": [
                    ToolMessage(
                        content="Thao tác xác nhận đã bị người dùng từ chối hoặc hủy bỏ.",
                        name=tool_name,
                        status="error",
                        tool_call_id=call_id,
                    )
                ],
                "pending_approval": None,
                "pending_decision": None,
                "step_count": state.get("step_count", 0) + 1,
            }

        # Revalidate target version
        try:
            logger.info(
                "%s [REVALIDATE_AND_EXECUTE:REVALIDATE] fetching fresh version for %s:%s (expected=%s)",
                tag,
                pending["target_type"],
                pending["target_id"],
                expected_version,
            )
            fresh_preview = await registry.preview(tool_name, context, tool_args)
            if fresh_preview.target_version != expected_version:
                logger.warning(
                    "%s [REVALIDATE_AND_EXECUTE:VERSION_CONFLICT] version mismatch for approval_id=%s (expected=%s, fresh=%s)",
                    tag,
                    approval_id,
                    expected_version,
                    fresh_preview.target_version,
                )
                await confirmation_service.mark_stale(actor.tenant_id, approval_id)
                return {
                    "messages": [
                        ToolMessage(
                            content="Dữ liệu đối tượng đã bị thay đổi (phiên bản không khớp). Thao tác đã bị hủy để đảm bảo an toàn.",
                            name=tool_name,
                            status="error",
                            tool_call_id=call_id,
                        )
                    ],
                    "pending_approval": None,
                    "pending_decision": None,
                    "step_count": state.get("step_count", 0) + 1,
                }

            approved_action = ApprovedAction(
                approval_id=approval_id,
                target_type=pending["target_type"],
                target_id=pending["target_id"],
                target_version=expected_version,
            )
            exec_context = ToolContext(
                actor=actor, correlation_id=correlation_id, approval=approved_action
            )
            t0 = time.monotonic()
            result = await registry.invoke(tool_name, exec_context, tool_args)
            elapsed = time.monotonic() - t0
            await confirmation_service.mark_consumed(actor.tenant_id, approval_id)
            logger.info(
                "%s [REVALIDATE_AND_EXECUTE:SUCCESS] tool '%s' finished in %.2fs (approval_id=%s consumed)",
                tag,
                tool_name,
                elapsed,
                approval_id,
            )

            return {
                "messages": [
                    ToolMessage(
                        content=result.model_dump_json(), name=tool_name, tool_call_id=call_id
                    )
                ],
                "pending_approval": None,
                "pending_decision": None,
                "step_count": state.get("step_count", 0) + 1,
            }
        except Exception as exc:
            logger.warning(
                "%s [REVALIDATE_AND_EXECUTE:ERROR] tool '%s' failed: %s",
                tag,
                tool_name,
                exc,
            )
            err_msg = _format_tool_error(exc)
            return {
                "messages": [
                    ToolMessage(
                        content=err_msg, name=tool_name, status="error", tool_call_id=call_id
                    )
                ],
                "pending_approval": None,
                "pending_decision": None,
                "step_count": state.get("step_count", 0) + 1,
            }

    return revalidate_and_execute_node


def create_execute_tool_node(registry: ToolRegistry):
    async def execute_tool_node(state: PlannerState, config: RunnableConfig) -> dict[str, Any]:
        actor = _get_actor_from_config(config)
        tag = _get_tag(config, actor)
        configurable = config.get("configurable", {})
        correlation_id = str(configurable.get("correlation_id", ""))
        context = ToolContext(actor=actor, correlation_id=correlation_id)

        last_message = state["messages"][-1]
        if not isinstance(last_message, AIMessage) or not last_message.tool_calls:
            logger.warning("%s [EXECUTE_TOOL] No tool calls in last message to execute", tag)
            return {"step_count": state.get("step_count", 0) + 1}

        logger.info(
            "%s [EXECUTE_TOOL:START] executing %d tool(s): %s",
            tag,
            len(last_message.tool_calls),
            ", ".join(tc["name"] for tc in last_message.tool_calls),
        )

        tool_messages: list[ToolMessage] = []
        for tc in last_message.tool_calls:
            name = tc["name"]
            args = tc.get("args", {})
            call_id = tc.get("id") or "call_1"
            t0 = time.monotonic()
            logger.info("%s [EXECUTE_TOOL] invoking '%s' args=%s", tag, name, str(args)[:200])
            try:
                result = await registry.invoke(name, context, args)
                elapsed = time.monotonic() - t0
                logger.info(
                    "%s [EXECUTE_TOOL:SUCCESS] tool '%s' finished in %.2fs", tag, name, elapsed
                )
                tool_messages.append(
                    ToolMessage(content=result.model_dump_json(), name=name, tool_call_id=call_id)
                )
            except Exception as exc:
                elapsed = time.monotonic() - t0
                logger.warning(
                    "%s [EXECUTE_TOOL:ERROR] tool '%s' failed after %.2fs: %s",
                    tag,
                    name,
                    elapsed,
                    exc,
                )
                err_msg = _format_tool_error(exc)
                tool_messages.append(
                    ToolMessage(content=err_msg, name=name, status="error", tool_call_id=call_id)
                )

        return {
            "messages": tool_messages,
            "step_count": state.get("step_count", 0) + 1,
        }

    return execute_tool_node


def create_route_after_agent(registry: ToolRegistry):
    def route_after_agent(state: PlannerState) -> str:
        messages = state.get("messages", [])
        if not messages:
            logger.info("[ROUTING:AFTER_AGENT] messages empty -> END")
            return END
        last_message = messages[-1]
        if not isinstance(last_message, AIMessage) or not last_message.tool_calls:
            logger.info("[ROUTING:AFTER_AGENT] no tool calls -> END")
            return END

        first_call = last_message.tool_calls[0]
        tool_name = first_call["name"]
        try:
            spec = registry.get(tool_name)
            if spec.is_sensitive:
                logger.info("[ROUTING:AFTER_AGENT] tool '%s' is sensitive -> preview", tool_name)
                return "preview"
        except UnknownToolError:
            pass
        logger.info("[ROUTING:AFTER_AGENT] tool '%s' -> execute_tool", tool_name)
        return "execute_tool"

    return route_after_agent


def create_route_after_preview():
    def route_after_preview(state: PlannerState) -> str:
        if state.get("pending_approval"):
            logger.info("[ROUTING:AFTER_PREVIEW] pending_approval present -> confirm")
            return "confirm"
        logger.info("[ROUTING:AFTER_PREVIEW] no pending_approval -> agent")
        return "agent"

    return route_after_preview


def create_route_after_tool(max_steps: int = 10):
    def route_after_tool(state: PlannerState) -> str:
        step_count = state.get("step_count", 0)
        if step_count >= max_steps:
            logger.warning(
                "[ROUTING:AFTER_TOOL] step_count=%d reached max_steps=%d -> END",
                step_count,
                max_steps,
            )
            return END
        logger.info(
            "[ROUTING:AFTER_TOOL] step_count=%d < max_steps=%d -> loop back to agent",
            step_count,
            max_steps,
        )
        return "agent"

    return route_after_tool
