"""Remove duplicate monthly RKAS details and restore the logical unique key.

Revision ID: e3a6c81d2f50
Revises: d8f4a2c91b63
Create Date: 2026-11-09 22:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e3a6c81d2f50"
down_revision: Union[str, Sequence[str], None] = "d8f4a2c91b63"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade():
    inspector = sa.inspect(op.get_bind())
    if "rkas_item" not in inspector.get_table_names():
        return

    unique_columns = ["rkas_anggaran_id", "item_id", "month"]
    existing_constraints = inspector.get_unique_constraints("rkas_item")
    if any(
        constraint.get("column_names") == unique_columns
        for constraint in existing_constraints
    ):
        return

    bind = op.get_bind()
    bind.exec_driver_sql(
        """
        DELETE FROM rkas_item
         WHERE id NOT IN (
             SELECT MAX(id)
               FROM rkas_item
              GROUP BY rkas_anggaran_id, item_id, month
         )
        """
    )
    with op.batch_alter_table("rkas_item") as batch_op:
        batch_op.create_unique_constraint(
            "uq_rkas_item_scope_month",
            unique_columns,
        )


def downgrade():
    inspector = sa.inspect(op.get_bind())
    if "rkas_item" not in inspector.get_table_names():
        return
    if not any(
        constraint.get("name") == "uq_rkas_item_scope_month"
        for constraint in inspector.get_unique_constraints("rkas_item")
    ):
        return
    with op.batch_alter_table("rkas_item") as batch_op:
        batch_op.drop_constraint("uq_rkas_item_scope_month", type_="unique")
