"""Add locally stored ARKAS item references.

Revision ID: f4b7c92d1a63
Revises: e3a6c81d2f50
Create Date: 2026-11-17 00:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f4b7c92d1a63"
down_revision: Union[str, Sequence[str], None] = "e3a6c81d2f50"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade():
    if "master_barang_arkas" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "master_barang_arkas",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("fiscal_year", sa.Integer(), nullable=False),
        sa.Column("source_fund_id", sa.String(), nullable=False),
        sa.Column("source_fund_name", sa.String(), nullable=False),
        sa.Column("kode_rekening", sa.String(), nullable=False),
        sa.Column("id_barang", sa.String(), nullable=False),
        sa.Column("nama_barang", sa.String(), nullable=False),
        sa.Column("satuan", sa.String(), nullable=False),
        sa.Column("harga_terendah", sa.Float(), nullable=True),
        sa.Column("harga_tertinggi", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "fiscal_year",
            "source_fund_id",
            "kode_rekening",
            "id_barang",
            name="uq_master_barang_arkas_scope_item",
        ),
    )
    op.create_index(
        op.f("ix_master_barang_arkas_id"),
        "master_barang_arkas",
        ["id"],
        unique=False,
    )


def downgrade():
    if "master_barang_arkas" not in sa.inspect(op.get_bind()).get_table_names():
        return
    op.drop_index(op.f("ix_master_barang_arkas_id"), table_name="master_barang_arkas")
    op.drop_table("master_barang_arkas")
