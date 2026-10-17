"""Building blocks shared by the read-only tool catalog."""

from __future__ import annotations

import re
from typing import Generic, TypeVar
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from pydantic.alias_generators import to_camel

from logix_agent.modules.registry import RiskLevel, ToolContext, ToolError, ToolSpec
from logix_agent.modules.tools.http_client import TOOL_BAD_RESPONSE, ServiceClient

# Keeps tool results small enough for the model context.
MAX_PAGE_SIZE = 20


class View(BaseModel):
    """Output model: reads the service's camelCase JSON and keeps only declared fields."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class PageIn(BaseModel):
    page: int = Field(1, ge=1, description="Page number, starting at 1")
    page_size: int = Field(10, ge=1, le=MAX_PAGE_SIZE, description="Rows per page")


T = TypeVar("T", bound=View)


class Page(View, Generic[T]):
    items: list[T]
    page: int
    page_size: int
    total: int


def read_tool(
    *,
    client: ServiceClient,
    name: str,
    description: str,
    service: str,
    path: str,
    input_model: type[BaseModel],
    output_model: type[BaseModel],
    permission: str | None,
) -> ToolSpec:
    """GET tool: `{placeholders}` in `path` come from input fields, the rest become query params."""
    path_keys = re.findall(r"{(\w+)}", path)

    async def handler(ctx: ToolContext, args: BaseModel) -> BaseModel:
        data = args.model_dump(mode="json", exclude_none=True)
        url = path.format(**{k: quote(str(data.pop(k)), safe="") for k in path_keys})
        # class-transformer's Boolean() turns the string "false" into true, so omit False.
        params = {to_camel(k): v for k, v in data.items() if v is not False}
        raw = await client.request(service, "GET", url, ctx, params=params or None)
        try:
            return output_model.model_validate(raw)
        except ValidationError:
            raise ToolError(
                TOOL_BAD_RESPONSE, "Dịch vụ nghiệp vụ trả về dữ liệu không hợp lệ."
            ) from None

    return ToolSpec(
        name=name,
        description=description,
        input_model=input_model,
        output_model=output_model,
        handler=handler,
        required_permission=permission,
        risk_level=RiskLevel.READ,
        target_service=service,
    )
