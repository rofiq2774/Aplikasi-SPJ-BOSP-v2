"""tambah kolom tempat_surat

Revision ID: b7b597ac8a84
Revises: 
Create Date: 2026-01-08 21:18:39.823933

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b7b597ac8a84'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade():
    with op.batch_alter_table("pengaturan") as batch_op:
        batch_op.add_column(
            sa.Column("tempat_surat", sa.String(length=255), nullable=True)
        )


def downgrade():
    with op.batch_alter_table("pengaturan") as batch_op:
        batch_op.drop_column("tempat_surat")