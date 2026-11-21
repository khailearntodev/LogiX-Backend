"""add thread_id to agent.conversations

Revision ID: 20261118_0002
Revises: 20260905_0001
Create Date: 2026-11-18 23:05:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20261118_0002"
down_revision: str | Sequence[str] | None = "20260905_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("thread_id", sa.String(length=200), nullable=True),
        schema="agent",
    )
    op.create_unique_constraint(
        "uq_conversations_tenant_thread",
        "conversations",
        ["tenant_id", "thread_id"],
        schema="agent",
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_conversations_tenant_thread",
        "conversations",
        schema="agent",
        type_="unique",
    )
    op.drop_column("conversations", "thread_id", schema="agent")
