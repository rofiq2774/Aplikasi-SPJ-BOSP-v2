"""tambah kolom identitas_periode (kop surat per periode)

Revision ID: c2f1a9d3e5b7
Revises: b7b597ac8a84
Create Date: 2026-11-01 00:00:00.000000

Perbaikan bug v1.2.4: GET /api/identitas-periode mengembalikan HTTP 500
("no such column: identitas_periode.tempat_surat") pada database lama.

Tabel ``identitas_periode`` sebelumnya dibuat otomatis oleh
``Base.metadata.create_all`` sehingga database yang sudah memiliki tabel itu
(sebelum kolom ``tempat_surat`` ditambahkan ke model) tidak pernah menerima
kolom baru. Revisi ini menambahkan kolom yang hilang secara idempoten —
kolom yang sudah ada dilewati — dan sekaligus menyalin nilai ``tempat_surat``
dari baris ``pengaturan`` legacy agar data lama tidak hilang.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c2f1a9d3e5b7'
down_revision: Union[str, Sequence[str], None] = 'b7b597ac8a84'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _table_columns(table: str) -> set:
    bind = op.get_bind()
    return {r[0] for r in bind.exec_driver_sql(f'PRAGMA table_info("{table}")')}


def upgrade():
    if "identitas_periode" not in sa.inspect(op.get_bind()).get_table_names():
        # Database baru: tabel akan dibuat lengkap oleh create_all/migrasi lain.
        return
    cols = _table_columns("identitas_periode")
    with op.batch_alter_table("identitas_periode") as batch_op:
        if "tanggal_akhir" not in cols:
            batch_op.add_column(sa.Column("tanggal_akhir", sa.String(), nullable=True))
        if "label" not in cols:
            batch_op.add_column(sa.Column("label", sa.String(), nullable=True))
        if "is_active" not in cols:
            batch_op.add_column(sa.Column("is_active", sa.Boolean(), nullable=True))
        if "nama_pemda" not in cols:
            batch_op.add_column(sa.Column("nama_pemda", sa.String(), nullable=True))
        if "alamat_sekolah" not in cols:
            batch_op.add_column(sa.Column("alamat_sekolah", sa.String(), nullable=True))
        if "tempat_surat" not in cols:
            batch_op.add_column(sa.Column("tempat_surat", sa.String(), nullable=True))
        if "logo_pemda" not in cols:
            batch_op.add_column(sa.Column("logo_pemda", sa.String(), nullable=True))
        if "logo_sekolah" not in cols:
            batch_op.add_column(sa.Column("logo_sekolah", sa.String(), nullable=True))
        if "nama_kepala_sekolah" not in cols:
            batch_op.add_column(sa.Column("nama_kepala_sekolah", sa.String(), nullable=True))
        if "nip_kepala_sekolah" not in cols:
            batch_op.add_column(sa.Column("nip_kepala_sekolah", sa.String(), nullable=True))
        if "nama_bendahara" not in cols:
            batch_op.add_column(sa.Column("nama_bendahara", sa.String(), nullable=True))
        if "nip_bendahara" not in cols:
            batch_op.add_column(sa.Column("nip_bendahara", sa.String(), nullable=True))
        if "nama_pengurus_barang" not in cols:
            batch_op.add_column(sa.Column("nama_pengurus_barang", sa.String(), nullable=True))
        if "nip_pengurus_barang" not in cols:
            batch_op.add_column(sa.Column("nip_pengurus_barang", sa.String(), nullable=True))

    # Normalisasi: is_active lama bernilai NULL dianggap aktif; tempat_surat
    # kosong diisi dari pengaturan legacy bila tersedia.
    bind = op.get_bind()
    bind.exec_driver_sql(
        "UPDATE identitas_periode SET is_active = 1 WHERE is_active IS NULL"
    )
    try:
        peng_cols = _table_columns("pengaturan")
        if "tempat_surat" in peng_cols and "tempat_surat" in _table_columns("identitas_periode"):
            bind.exec_driver_sql(
                """
                UPDATE identitas_periode
                   SET tempat_surat = COALESCE(
                        (SELECT tempat_surat FROM pengaturan ORDER BY id LIMIT 1), '')
                 WHERE tempat_surat IS NULL OR tempat_surat = ''
                """
            )
    except Exception:
        pass


def downgrade():
    if "identitas_periode" not in sa.inspect(op.get_bind()).get_table_names():
        return
    cols = _table_columns("identitas_periode")
    drop_map = [
        ("nip_pengurus_barang",), ("nama_pengurus_barang",), ("nip_bendahara",),
        ("nama_bendahara",), ("nip_kepala_sekolah",), ("nama_kepala_sekolah",),
        ("logo_sekolah",), ("logo_pemda",), ("tempat_surat",), ("alamat_sekolah",),
        ("nama_pemda",), ("is_active",), ("label",), ("tanggal_akhir",),
    ]
    with op.batch_alter_table("identitas_periode") as batch_op:
        for (name,) in drop_map:
            if name in cols:
                batch_op.drop_column(name)
