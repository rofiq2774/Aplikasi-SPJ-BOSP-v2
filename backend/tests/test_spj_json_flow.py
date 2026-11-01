# -*- coding: utf-8 -*-
"""Tes alur SPJ JSON-only (rendering PDF sepenuhnya di frontend).

Cakupan:
  1. GET /api/kwitansi/{id}/spj-data  -> 200, application/json, payload valid
     (schema_version, sections, identitas periode, BAST/RAB).
  2. ATURAN ANTI-KOP KWITANSI: tidak ada `kop` pada document/kwitansi dan
     `kop_wajib` harus False; BAST & RAB tetap membawa kop (aturan lama).
  3. Endpoint PDF legacy GET /api/kwitansi/{id}/pdf -> 410 Gone (bukan PDF).
  4. Tidak ada respons application/pdf pada alur unduh SPJ (content-type).

Semua DB memakai sqlite temporer di tmp_path — TIDAK menyentuh data produksi.
"""
import asyncio
import base64
import json
import sys
from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

import database  # noqa: E402  (patch engine/maker sebelum request dijalankan)


# 1x1 PNG merah (valid untuk pdfmake + cukup kecil untuk tes)
PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
LOGO_DATAURI = "data:image/png;base64," + base64.b64encode(PNG_1PX).decode()


@pytest.fixture()
def spj_client(tmp_path, monkeypatch):
    """TestClient dengan DB sqlite temporer terisi data contoh."""
    db_file = tmp_path / "test_aplikasi_spj.db"
    url = f"sqlite+aiosqlite:///{db_file.as_posix()}"

    engine = create_async_engine(url, future=True)
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    import main

    async def _get_db_override():
        async with maker() as session:
            yield session

    main.app.dependency_overrides[main.get_db] = _get_db_override
    # jangan jalankan startup penuh (alembic/create_all pada DB produksi)
    monkeypatch.setattr(main, "run_migrations", lambda force=False: None)

    from database import Base
    from models import IdentitasPeriode, Kwitansi, MasterKegiatan, Transaksi

    async def setup():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with maker() as s:
            s.add(Kwitansi(
                nomor_kwitansi="001/KW/SPJ/XI/2026",
                no_bukti="BKT-001",
                kode_kegiatan="K-01",
                nama_kegiatan="Belanja ATK",
                tanggal="2026-11-05",
                thp="Tahap I",
                tahun="2026",
                jumlah=1500000.0,
                no_bast="BA/001/XI/2026",
                nama_toko="Toko Makmur",
                npwp_toko="01.234.567.8-901.000",
                alamat_toko="Jl. Merdeka 1",
                foto_bukti="[]",
            ))
            s.add(IdentitasPeriode(
                tanggal_awal="2026-01-01",
                tanggal_akhir=None,
                label="Periode 2026",
                is_active=True,
                nama_pemda="PEMDA CONTOH",
                nama_sekolah="SDN CONTOH 1",
                alamat_sekolah="Jl. Sekolah No. 2",
                tempat_surat="Jember",
                logo_pemda=LOGO_DATAURI,
                logo_sekolah=LOGO_DATAURI,
                nama_kepala_sekolah="Kepala Contoh",
                nip_kepala_sekolah="123456",
                nama_bendahara="Bendahara Contoh",
                nip_bendahara="234567",
                nama_pengurus_barang="Pengurus Contoh",
                nip_pengurus_barang="345678",
            ))
            s.add(MasterKegiatan(kode_kegiatan="K-01", nama_kegiatan="Belanja ATK"))
            s.add(Transaksi(
                tanggal="2026-11-01",
                kode_kegiatan="K-01",
                kode_rekening="5.2.1.01.01",
                no_bukti="BKT-001",
                uraian="Pulpen 1 lusin",
                volume=10,
                satuan="lusin",
                harga_satuan=15000,
                penerimaan=0,
                pengeluaran=150000,
                saldo=0,
            ))
            await s.commit()

    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(setup())
    finally:
        loop.close()

    from fastapi.testclient import TestClient

    with TestClient(main.app) as c:
        yield c

    main.app.dependency_overrides.clear()


def test_spj_data_returns_json_and_valid_payload(spj_client):
    res = spj_client.get("/api/kwitansi/1/spj-data")
    assert res.status_code == 200, res.text
    assert "application/json" in res.headers["content-type"]
    body = res.json()
    assert body["status"] == "success"
    data = body["data"]
    assert data["schema_version"] == 1
    assert data["sections"]["kwitansi"]["status"] == "included"
    assert data["sections"]["bast"]["status"] == "included"
    # identitas dipilih per periode
    assert data["identitas"]["label"] == "Periode 2026"
    assert data["kwitansi"]["jumlah"] == 1500000.0
    assert data["kwitansi"]["terbilang"]
    # URI logo harus data: (bukan path lokal D:\...)
    for kop in (data["bast"]["kop"], data["rab"]["kop"]):
        assert kop["logo_pemda"].startswith("data:image/")
        assert "\\" not in kop["logo_pemda"]


def test_kwitansi_section_has_no_kop_metadata(spj_client):
    """Aturan produk: metadata kop tidak boleh mengalir ke bagian kwitansi."""
    data = spj_client.get("/api/kwitansi/1/spj-data").json()["data"]
    assert "kop" not in data["kwitansi"]
    assert "kop" not in data["document"]
    assert data["document"]["kop_wajib"] is False
    # BAST & RAB boleh (dan memang) membawa kop sendiri
    assert data["bast"]["kop"]["baris2"] == "SDN CONTOH 1"
    assert data["rab"]["kop"]["baris2"] == "SDN CONTOH 1"


def test_legacy_pdf_endpoint_is_gone(spj_client):
    res = spj_client.get("/api/kwitansi/1/pdf")
    assert res.status_code == 410
    assert "application/pdf" not in (res.headers.get("content-type") or "")
    assert "spj-data" in res.json()["detail"]


def test_spj_data_missing_kwitansi_404(spj_client):
    res = spj_client.get("/api/kwitansi/999/spj-data")
    assert res.status_code == 404


def test_no_pdf_media_type_anywhere_in_spj_flow(spj_client):
    """Alur SPJ baru tidak pernah menghasilkan/mengirim PDF dari backend."""
    res = spj_client.get("/api/kwitansi/1/spj-data")
    ct = res.headers.get("content-type", "")
    assert "pdf" not in ct.lower()
    # payload harus serializable sebagai JSON murni
    json.loads(res.text)
