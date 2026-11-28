"""Read-only tools backed by identity-service (workspace context, organization, members, roles)."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field

from logix_agent.modules.registry import (
    RiskLevel,
    ToolContext,
    ToolError,
    ToolRegistry,
    ToolSpec,
)
from logix_agent.modules.tools.catalog._base import View
from logix_agent.modules.tools.http_client import TOOL_BAD_RESPONSE, ServiceClient

READ_MEMBERS = "iam:member:read"
READ_ROLES = "iam:role:read"


class EmptyIn(BaseModel):
    pass


class WorkspaceContextOut(View):
    user_id: str
    display_name: str | None = None
    tenant_id: str
    tenant_code: str | None = None
    tenant_name: str | None = None
    role: str | None = None
    is_super_admin: bool = False
    is_owner: bool = False
    is_admin: bool = False
    roles: list[str] = Field(default_factory=list)
    permissions: list[str] = Field(default_factory=list)


class OrganizationLegalSummaryOut(View):
    legal_name: str | None = None
    address_line: str | None = None
    district: str | None = None
    province: str | None = None


class OrganizationContextOut(View):
    id: str
    code: str
    name: str
    status: str
    role: str | None = None
    legal_profile: OrganizationLegalSummaryOut | None = None
    ai_instructions_enabled: bool = True
    ai_instructions_is_default: bool = True


class MemberRoleTagOut(View):
    id: UUID
    code: str
    name: str
    is_system: bool = False


# Personal contact details (email, phoneNumber) are deliberately excluded from LLM payloads.
class OrganizationMemberOut(View):
    id: UUID
    user_id: UUID
    display_name: str
    status: str
    primary_role: str
    roles: list[MemberRoleTagOut] = Field(default_factory=list)


class MemberListOut(View):
    items: list[OrganizationMemberOut]
    total: int


class OrganizationRoleOut(View):
    id: UUID
    code: str
    name: str
    description: str | None = None
    is_system: bool = False
    member_count: int = 0
    permission_count: int = 0


class RoleListOut(View):
    items: list[OrganizationRoleOut]
    total: int


def _extract_legal_summary(raw: Any) -> OrganizationLegalSummaryOut | None:
    if not isinstance(raw, Mapping):
        return None
    summary = OrganizationLegalSummaryOut(
        legal_name=raw.get("legalName") if isinstance(raw.get("legalName"), str) else None,
        address_line=raw.get("addressLine") if isinstance(raw.get("addressLine"), str) else None,
        district=raw.get("district") if isinstance(raw.get("district"), str) else None,
        province=raw.get("province") if isinstance(raw.get("province"), str) else None,
    )
    if not any([summary.legal_name, summary.address_line, summary.district, summary.province]):
        return None
    return summary


def register(registry: ToolRegistry, client: ServiceClient) -> None:
    async def handle_workspace_context(ctx: ToolContext, _args: BaseModel) -> WorkspaceContextOut:
        me_raw, perms_raw = await asyncio.gather(
            client.request("identity", "GET", "/api/v1/auth/me", ctx),
            client.request("identity", "GET", "/api/v1/auth/me/permissions", ctx),
        )
        if not isinstance(me_raw, Mapping) or not isinstance(perms_raw, Mapping):
            raise ToolError(
                TOOL_BAD_RESPONSE, "Dịch vụ định danh trả về ngữ cảnh người dùng không hợp lệ."
            )

        active_tenant = me_raw.get("activeTenant")
        tenant_map = active_tenant if isinstance(active_tenant, Mapping) else {}
        roles_raw = perms_raw.get("roles")
        permissions_raw = perms_raw.get("permissions")

        return WorkspaceContextOut(
            user_id=str(me_raw.get("id") or ctx.actor.user_id),
            display_name=me_raw.get("displayName") if isinstance(me_raw.get("displayName"), str) else None,
            tenant_id=str(tenant_map.get("id") or ctx.actor.tenant_id),
            tenant_code=tenant_map.get("code") if isinstance(tenant_map.get("code"), str) else None,
            tenant_name=tenant_map.get("name") if isinstance(tenant_map.get("name"), str) else None,
            role=str(tenant_map.get("role") or ctx.actor.role or ""),
            is_super_admin=bool(perms_raw.get("isSuperAdmin", False)),
            is_owner=bool(perms_raw.get("isOwner", False)),
            is_admin=bool(perms_raw.get("isAdmin", False)),
            roles=[str(r) for r in roles_raw if isinstance(r, str)] if isinstance(roles_raw, list) else [],
            permissions=[str(p) for p in permissions_raw if isinstance(p, str)]
            if isinstance(permissions_raw, list)
            else [],
        )

    async def handle_current_organization(
        ctx: ToolContext, _args: BaseModel
    ) -> OrganizationContextOut:
        if not ctx.actor.tenant_id:
            raise ToolError("TENANT_REQUIRED", "Không xác định được tổ chức hiện tại.")
        raw = await client.request(
            "identity",
            "GET",
            f"/api/v1/auth/organizations/{ctx.actor.tenant_id}",
            ctx,
        )
        if not isinstance(raw, Mapping):
            raise ToolError(
                TOOL_BAD_RESPONSE, "Dịch vụ định danh trả về thông tin tổ chức không hợp lệ."
            )

        ai_raw = raw.get("aiInstructions")
        ai_map = ai_raw if isinstance(ai_raw, Mapping) else {}
        return OrganizationContextOut(
            id=str(raw.get("id") or ctx.actor.tenant_id),
            code=str(raw.get("code") or ""),
            name=str(raw.get("name") or ""),
            status=str(raw.get("status") or "ACTIVE"),
            role=str(raw.get("role")) if raw.get("role") is not None else ctx.actor.role,
            legal_profile=_extract_legal_summary(raw.get("legalProfile")),
            ai_instructions_enabled=bool(ai_map.get("enabled", True)),
            ai_instructions_is_default=bool(ai_map.get("isDefault", True)),
        )

    async def handle_list_members(ctx: ToolContext, _args: BaseModel) -> MemberListOut:
        raw = await client.request("identity", "GET", "/api/v1/iam/members", ctx)
        if not isinstance(raw, list):
            raise ToolError(
                TOOL_BAD_RESPONSE, "Dịch vụ định danh trả về danh sách thành viên không hợp lệ."
            )
        items = [OrganizationMemberOut.model_validate(item) for item in raw if isinstance(item, Mapping)]
        return MemberListOut(items=items, total=len(items))

    async def handle_list_roles(ctx: ToolContext, _args: BaseModel) -> RoleListOut:
        raw = await client.request("identity", "GET", "/api/v1/iam/roles", ctx)
        if not isinstance(raw, list):
            raise ToolError(
                TOOL_BAD_RESPONSE, "Dịch vụ định danh trả về danh sách vai trò không hợp lệ."
            )
        items = [OrganizationRoleOut.model_validate(item) for item in raw if isinstance(item, Mapping)]
        return RoleListOut(items=items, total=len(items))

    registry.register(
        ToolSpec(
            name="get_my_workspace_context",
            description=(
                "Get the current user's active organization, assigned roles, and effective permissions "
                "in the current workspace."
            ),
            input_model=EmptyIn,
            output_model=WorkspaceContextOut,
            handler=handle_workspace_context,
            required_permission=None,
            risk_level=RiskLevel.READ,
            target_service="identity",
        )
    )
    registry.register(
        ToolSpec(
            name="get_current_organization",
            description=(
                "Get details of the active organization (code, name, legal address summary, "
                "and AI custom instructions status)."
            ),
            input_model=EmptyIn,
            output_model=OrganizationContextOut,
            handler=handle_current_organization,
            required_permission=None,
            risk_level=RiskLevel.READ,
            target_service="identity",
        )
    )
    registry.register(
        ToolSpec(
            name="list_organization_members",
            description="List active members and their assigned roles in the current organization.",
            input_model=EmptyIn,
            output_model=MemberListOut,
            handler=handle_list_members,
            required_permission=READ_MEMBERS,
            risk_level=RiskLevel.READ,
            target_service="identity",
        )
    )
    registry.register(
        ToolSpec(
            name="list_organization_roles",
            description="List roles, member counts, and permission counts defined in the current organization.",
            input_model=EmptyIn,
            output_model=RoleListOut,
            handler=handle_list_roles,
            required_permission=READ_ROLES,
            risk_level=RiskLevel.READ,
            target_service="identity",
        )
    )
