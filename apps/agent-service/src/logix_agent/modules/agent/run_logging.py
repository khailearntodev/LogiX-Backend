"""Logs what one agent run is doing (model calls, tool calls) through LangChain's callbacks API."""

import logging
import time
from typing import Any
from uuid import UUID

from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.outputs import LLMResult

logger = logging.getLogger(__name__)

MAX_ARGS_CHARS = 200


class RunLogHandler(AsyncCallbackHandler):
    """One instance per run; `tag` identifies the run and tenant in every line."""

    def __init__(self, tag: str) -> None:
        self.tag = tag
        self._started: dict[UUID, tuple[float, str]] = {}

    def _finish(self, run_id: UUID) -> tuple[float, str]:
        started, name = self._started.pop(run_id, (time.monotonic(), "?"))
        return time.monotonic() - started, name

    async def on_chat_model_start(
        self, serialized: Any, messages: list[list[Any]], *, run_id: UUID, **kwargs: Any
    ) -> None:
        self._started[run_id] = (time.monotonic(), "model")
        logger.info("%s model call started (%d messages)", self.tag, len(messages[0]))

    async def on_llm_end(self, response: LLMResult, *, run_id: UUID, **kwargs: Any) -> None:
        elapsed, _ = self._finish(run_id)
        message = getattr(response.generations[0][0], "message", None)
        usage = getattr(message, "usage_metadata", None) or {}
        logger.info(
            "%s model call finished in %.1fs (tokens in=%s out=%s)",
            self.tag,
            elapsed,
            usage.get("input_tokens"),
            usage.get("output_tokens"),
        )

    async def on_llm_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        elapsed, _ = self._finish(run_id)
        logger.warning(
            "%s model call failed after %.1fs: %s", self.tag, elapsed, type(error).__name__
        )

    async def on_tool_start(
        self, serialized: Any, input_str: str, *, run_id: UUID, **kwargs: Any
    ) -> None:
        name = kwargs.get("name") or (serialized or {}).get("name") or "?"
        self._started[run_id] = (time.monotonic(), name)
        logger.info("%s tool %s started args=%s", self.tag, name, input_str[:MAX_ARGS_CHARS])

    async def on_tool_end(self, output: Any, *, run_id: UUID, **kwargs: Any) -> None:
        elapsed, name = self._finish(run_id)
        logger.info("%s tool %s finished in %.2fs", self.tag, name, elapsed)

    async def on_tool_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        elapsed, name = self._finish(run_id)
        logger.warning(
            "%s tool %s failed after %.2fs: %s", self.tag, name, elapsed, type(error).__name__
        )
