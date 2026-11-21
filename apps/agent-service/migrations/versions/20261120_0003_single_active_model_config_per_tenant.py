"""Enforce one active model configuration per tenant.

Revision ID: 20261120_0003
Revises: 20261118_0002
Create Date: 2026-11-20
"""

from typing import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20261120_0003"
down_revision: str | Sequence[str] | None = "20261118_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Do not silently delete or choose a winner when existing data violates
    # the new invariant. The operator must resolve duplicates deliberately.
    op.execute(
        sa.text(
            """
            DO $$
            DECLARE duplicate_tenants text;
            BEGIN
                SELECT string_agg(tenant_id::text, ', ' ORDER BY tenant_id::text)
                INTO duplicate_tenants
                FROM (
                    SELECT tenant_id
                    FROM agent.llm_provider_configs
                    WHERE tenant_id IS NOT NULL
                      AND is_active = true
                      AND deleted_at IS NULL
                    GROUP BY tenant_id
                    HAVING COUNT(*) > 1
                ) duplicates;

                IF duplicate_tenants IS NOT NULL THEN
                    RAISE EXCEPTION
                        'Cannot enforce one active model config per tenant; duplicate tenant IDs: %',
                        duplicate_tenants;
                END IF;
            END $$;
            """
        )
    )

    op.drop_index(
        "ux_active_tenant_provider_config",
        table_name="llm_provider_configs",
        schema="agent",
    )
    op.create_index(
        "ux_active_tenant_model_config",
        "llm_provider_configs",
        ["tenant_id"],
        unique=True,
        schema="agent",
        postgresql_where=sa.text(
            "tenant_id IS NOT NULL AND is_active = true AND deleted_at IS NULL"
        ),
    )


def downgrade() -> None:
    op.drop_index(
        "ux_active_tenant_model_config",
        table_name="llm_provider_configs",
        schema="agent",
    )
    op.create_index(
        "ux_active_tenant_provider_config",
        "llm_provider_configs",
        ["tenant_id", "provider"],
        unique=True,
        schema="agent",
        postgresql_where=sa.text(
            "tenant_id IS NOT NULL AND is_active = true AND deleted_at IS NULL"
        ),
    )
