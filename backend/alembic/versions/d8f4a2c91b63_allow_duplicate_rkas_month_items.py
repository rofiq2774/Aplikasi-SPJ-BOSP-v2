"""Allow repeated RKAS source rows for the same item and month.

Revision ID: d8f4a2c91b63
Revises: c2f1a9d3e5b7
Create Date: 2026-11-08 13:45:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d8f4a2c91b63"
down_revision: Union[str, Sequence[str], None] = "c2f1a9d3e5b7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade():
    inspector = sa.inspect(op.get_bind())
    if "rkas_item" not in inspector.get_table_names():
        return
    constraints = inspector.get_unique_constraints("rkas_item")
    if any(item.get("name") == "uq_rkas_item_scope_month" for item in constraints):
        with op.batch_alter_table("rkas_item") as batch_op:
            batch_op.drop_constraint("uq_rkas_item_scope_month", type_="unique")


def downgrade():
    # Duplicate monthly rows may have been stored after this migration.
    # Reinstating uniqueness could destroy valid synchronized RKAS data.
    pass
