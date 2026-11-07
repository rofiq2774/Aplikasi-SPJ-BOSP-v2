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
import os
import subprocess
import sys
from datetime import datetime, timedelta
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
    from models import (
        IdentitasPeriode,
        Kwitansi,
        MasterKegiatan,
        MasterRekeningBelanja,
        Transaksi,
    )

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
            s.add_all([
                MasterRekeningBelanja(
                    kode_rekening_belanja="5.2.1.01.01",
                    nama_rekening_belanja="Belanja Alat Tulis",
                ),
                MasterRekeningBelanja(
                    kode_rekening_belanja="5.2.1.02.01",
                    nama_rekening_belanja="Belanja Bahan",
                ),
            ])
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
        c.test_session_maker = maker
        yield c

    main.app.dependency_overrides.clear()


def test_manual_kwitansi_supports_account_code_per_detail_row(spj_client):
    payload = {
        "no_bukti": "BKT-MANUAL",
        "kode_kegiatan": "K-01",
        "tanggal": "2026-11-06",
        "uraian_json": json.dumps([
            {
                "nama_barang": "Pulpen",
                "kode_rekening": "5.2.1.01.01",
                "volume": 2,
                "satuan": "buah",
                "harga_satuan": 1000,
                "pengeluaran": 2000,
            },
            {
                "nama_barang": "Kertas",
                "kode_rekening": "5.2.1.02.01",
                "volume": 1,
                "satuan": "rim",
                "harga_satuan": 5000,
                "pengeluaran": 5000,
            },
        ]),
    }

    response = spj_client.post("/api/kwitansi/manual", data=payload)

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "success"

    from sqlalchemy import select
    from models import Transaksi

    async def get_saved_account_codes():
        async with spj_client.test_session_maker() as session:
            result = await session.execute(
                select(Transaksi.kode_rekening)
                .where(Transaksi.no_bukti == "BKT-MANUAL")
                .order_by(Transaksi.uraian)
            )
            return result.scalars().all()

    loop = asyncio.new_event_loop()
    try:
        saved_account_codes = loop.run_until_complete(get_saved_account_codes())
    finally:
        loop.close()

    assert saved_account_codes == ["5.2.1.02.01", "5.2.1.01.01"]


def test_manual_kwitansi_rejects_unknown_detail_account_code(spj_client):
    response = spj_client.post(
        "/api/kwitansi/manual",
        data={
            "no_bukti": "BKT-INVALID",
            "uraian_json": json.dumps([
                {
                    "nama_barang": "Pulpen",
                    "kode_rekening": "5.9.9.99.99",
                    "volume": 1,
                    "harga_satuan": 1000,
                    "pengeluaran": 1000,
                },
            ]),
        },
    )

    assert response.status_code == 400
    assert "Kode rekening tidak ditemukan" in response.json()["detail"]


def test_arkas_tax_sync_persists_rows_and_filters_by_fiscal_scope(spj_client):
    base_tax = {
        "tanggal": "2026-03-12",
        "no_bukti": "BPU-01",
        "uraian": "Belanja jasa pemeliharaan",
        "jenis_pajak": "PPh 23",
        "persentase_pajak": 2,
        "nominal_pajak": 20000,
        "nominal_wajib_disetor": 15000,
        "ntpn": "NTPN-2026",
        "source_fund_id": "1",
        "source_fund_name": "BOSP Reguler",
        "budget_id": "budget-1",
        "budget_name": "Anggaran 2026",
    }

    for year, arkas_id in ((2025, "arkas-tax-2025-1"), (2026, "arkas-tax-2026-1")):
        tax = {
            **base_tax,
            "arkas_id": arkas_id,
            "fiscal_year": year,
            "ntpn": f"NTPN-{year}",
        }
        taxes = [tax]
        if year == 2025:
            taxes.append(
                {
                    **tax,
                    "arkas_id": "arkas-tax-2025-2",
                    "jenis_pajak": "PPN",
                    "nominal_pajak": 10000,
                }
            )
        response = spj_client.post(
            "/api/transaksi/import-arkas",
            json={"mode": "keep", "transaksi": [], "pajak": taxes},
        )
        assert response.status_code == 200, response.text
        assert response.json()["saved_tax_count"] == len(taxes)

    repeated = spj_client.post(
        "/api/transaksi/import-arkas",
        json={
            "mode": "keep",
            "transaksi": [],
            "pajak": [{
                **base_tax,
                "arkas_id": "arkas-tax-2025-1",
                "fiscal_year": 2025,
                "ntpn": "NTPN-2025",
            }],
        },
    )
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["saved_tax_count"] == 0

    response = spj_client.get(
        "/api/rekap-pajak",
        params={
            "fiscal_year": "2026",
            "source_fund_id": "1",
            "budget_id": "budget-1",
        },
    )

    assert response.status_code == 200, response.text
    result = response.json()
    assert result["status"] == "success"
    assert len(result["data"]) == 1
    assert result["data"][0]["ntpn"] == "NTPN-2026"
    assert result["data"][0]["fiscal_year"] == 2026
    assert result["data"][0]["nominal_wajib_disetor"] == 0

    from sqlalchemy import select
    from models import RekapPajak

    async def get_saved_payable_amount():
        async with spj_client.test_session_maker() as session:
            saved = await session.execute(
                select(RekapPajak.nominal_wajib_disetor).where(
                    RekapPajak.arkas_id == "arkas-tax-2026-1"
                )
            )
            return saved.scalar_one()

    loop = asyncio.new_event_loop()
    try:
        assert loop.run_until_complete(get_saved_payable_amount()) == 0
    finally:
        loop.close()

    updated = spj_client.post(
        "/api/transaksi/import-arkas",
        json={
            "mode": "keep",
            "transaksi": [],
            "pajak": [{
                **base_tax,
                "arkas_id": "arkas-tax-2026-1",
                "fiscal_year": 2026,
                "ntpn": "",
            }],
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["updated_tax_count"] == 1

    refreshed = spj_client.get(
        "/api/rekap-pajak",
        params={
            "fiscal_year": "2026",
            "source_fund_id": "1",
            "budget_id": "budget-1",
        },
    )
    assert refreshed.status_code == 200, refreshed.text
    refreshed_row = next(
        row for row in refreshed.json()["data"] if row["arkas_id"] == "arkas-tax-2026-1"
    )
    assert refreshed_row["ntpn"] == ""
    assert refreshed_row["nominal_wajib_disetor"] == 15000

    previous_year = spj_client.get(
        "/api/rekap-pajak",
        params={
            "fiscal_year": "2025",
            "source_fund_id": "1",
            "budget_id": "budget-1",
        },
    )
    assert previous_year.status_code == 200, previous_year.text
    assert len(previous_year.json()["data"]) == 2

    duplicate_type = spj_client.post(
        "/api/transaksi/import-arkas",
        json={
            "mode": "keep",
            "transaksi": [],
            "pajak": [
                {
                    **base_tax,
                    "arkas_id": "arkas-tax-2026-duplicate-1",
                    "fiscal_year": 2026,
                    "no_bukti": "BPU-57",
                    "ntpn": "",
                },
                {
                    **base_tax,
                    "arkas_id": "arkas-tax-2026-duplicate-2",
                    "fiscal_year": 2026,
                    "no_bukti": "BPU-57",
                    "nominal_pajak": 5000,
                    "nominal_wajib_disetor": 3000,
                    "ntpn": "",
                },
            ],
        },
    )
    assert duplicate_type.status_code == 200, duplicate_type.text
    duplicate_rows = spj_client.get(
        "/api/rekap-pajak",
        params={
            "fiscal_year": "2026",
            "source_fund_id": "1",
            "budget_id": "budget-1",
        },
    ).json()["data"]
    duplicate_receipt_rows = [
        row for row in duplicate_rows if row["no_bukti"] == "BPU-57"
    ]
    assert len(duplicate_receipt_rows) == 1
    assert duplicate_receipt_rows[0]["nominal_pajak"] == 25000
    assert duplicate_receipt_rows[0]["nominal_wajib_disetor"] == 18000


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
    assert data["sections"]["rab"]["status"] == "skip"
    # identitas dipilih per periode
    assert data["identitas"]["label"] == "Periode 2026"
    assert data["kwitansi"]["jumlah"] == 1500000.0
    assert data["kwitansi"]["terbilang"]
    # URI logo harus data: (bukan path lokal D:\...)
    assert data["bast"]["kop"]["logo_pemda"].startswith("data:image/")
    assert "\\" not in data["bast"]["kop"]["logo_pemda"]


def test_update_kwitansi_persists_purchase_type_and_dynamic_form_data(spj_client):
    payload = {
        "nama_kegiatan": "Perjalanan dinas",
        "no_bast": "BA/001",
        "tanggal_nota": "05-11-2026",
        "nama_toko": "Penyedia",
        "npwp_toko": "01.111.222.3-444.000",
        "alamat_toko": "Jl. Penyedia",
        "no_telp_toko": "08123456789",
        "no_nota": "NOTA-PENYEDIA",
        "jenis_belanja": "perjalanan_dinas",
        "data_lampiran": {
            "sppd_nomor": "SPPD/001",
            "sppd_petugas": "Nama Petugas",
            "sppd_tujuan": "Banyuwangi",
            "surat_tugas_nomor": "094/123/2026",
            "surat_tugas_tanggal": "2026-11-03",
            "surat_tugas_dasar": "Surat undangan kegiatan",
            "surat_tugas_petugas": "Nama yang ditugaskan",
            "surat_tugas_nip": "198001012010011001",
            "surat_tugas_pangkat_golongan": "Penata, III/c",
            "surat_tugas_jabatan": "Guru",
            "surat_tugas_tujuan": "Mengikuti kegiatan di Jember",
        },
        "uraian": [{
            "nama_barang": "Transport",
            "volume": 1,
            "satuan": "paket",
            "harga_satuan": 150000,
        }],
    }
    update = spj_client.post("/api/kwitansi/1/update-detail", json=payload)
    assert update.status_code == 200, update.text

    detail = spj_client.get("/api/kwitansi/1").json()["data"]
    assert detail["jenis_belanja"] == "perjalanan_dinas"
    assert detail["data_lampiran"]["sppd_nomor"] == "SPPD/001"
    assert detail["data_lampiran"]["surat_tugas_nomor"] == "094/123/2026"
    assert detail["data_lampiran"]["surat_tugas_tanggal"] == "2026-11-03"
    assert detail["data_lampiran"]["surat_tugas_dasar"] == "Surat undangan kegiatan"
    assert detail["data_lampiran"]["surat_tugas_petugas"] == "Nama yang ditugaskan"
    assert detail["data_lampiran"]["surat_tugas_tujuan"] == "Mengikuti kegiatan di Jember"
    assert detail["tanggal_nota"] == "2026-11-05"

    bku_response = spj_client.get("/api/transaksi", params={"no_bukti": "BKT-001"})
    assert bku_response.status_code == 200
    bku_row = bku_response.json()["data"][0]
    assert bku_row["nama_toko"] == "Penyedia"
    assert bku_row["npwp_toko"] == "01.111.222.3-444.000"
    assert bku_row["alamat_toko"] == "Jl. Penyedia"
    assert bku_row["no_telp_toko"] == "08123456789"
    assert bku_row["no_nota"] == "NOTA-PENYEDIA"
    assert bku_row["tanggal_nota"] == "2026-11-05"

    invalid_date_payload = {**payload, "tanggal_nota": "tanggal-salah"}
    invalid_date = spj_client.post(
        "/api/kwitansi/1/update-detail", json=invalid_date_payload
    )
    assert invalid_date.status_code == 400
    assert "YYYY-MM-DD" in invalid_date.json()["detail"]

    spj_data = spj_client.get("/api/kwitansi/1/spj-data").json()["data"]
    assert spj_data["jenis_belanja"] == "perjalanan_dinas"
    assert spj_data["data_lampiran"]["sppd_tujuan"] == "Banyuwangi"
    assert spj_data["data_lampiran"]["surat_tugas_nomor"] == "094/123/2026"
    assert spj_data["data_lampiran"]["surat_tugas_tanggal"] == "2026-11-03"
    assert spj_data["data_lampiran"]["surat_tugas_dasar"] == "Surat undangan kegiatan"
    assert spj_data["data_lampiran"]["surat_tugas_petugas"] == "Nama yang ditugaskan"
    assert spj_data["data_lampiran"]["surat_tugas_tujuan"] == "Mengikuti kegiatan di Jember"
    assert spj_data["sections"]["bast"]["status"] == "skip"
    assert spj_data["sections"]["rab"]["status"] == "skip"

    payload["jenis_belanja"] = "jasa_tukang"
    update = spj_client.post("/api/kwitansi/1/update-detail", json=payload)
    assert update.status_code == 200, update.text
    spj_data = spj_client.get("/api/kwitansi/1/spj-data").json()["data"]
    assert spj_data["sections"]["bast"]["status"] == "skip"
    assert spj_data["sections"]["rab"]["status"] == "included"
    assert spj_data["rab"] is not None

    payload["jenis_belanja"] = "fotokopi"
    update = spj_client.post("/api/kwitansi/1/update-detail", json=payload)
    assert update.status_code == 200, update.text
    spj_data = spj_client.get("/api/kwitansi/1/spj-data").json()["data"]
    assert spj_data["sections"]["bast"]["status"] == "included"
    assert spj_data["sections"]["rab"]["status"] == "skip"


def test_sewa_type_and_vehicle_stnk_photo_are_persisted(spj_client):
    """Pastikan isian sewa dan kategori foto kendaraan/STNK tersimpan dan terbaca."""
    update_response = spj_client.post(
        "/api/kwitansi/1/update-detail",
        json={
            "nama_kegiatan": "Sewa kendaraan",
            "tanggal_nota": "2026-11-05",
            "jenis_belanja": "sewa",
            "data_lampiran": {
                "penerima_list": [{
                    "nama": "Pemilik Kendaraan",
                    "jabatan": "Pemilik",
                    "honor": 150000,
                    "pph23": 3450,
                }],
            },
            "uraian": [{
                "nama_barang": "Sewa kendaraan",
                "volume": 1,
                "satuan": "hari",
                "harga_satuan": 150000,
            }],
        },
    )
    assert update_response.status_code == 200, update_response.text

    upload_response = spj_client.post(
        "/api/kwitansi/1/upload-foto",
        files=[("files", ("kendaraan.png", b"test-image", "image/png"))],
        data={"jenis_foto": "kendaraan_stnk"},
    )
    assert upload_response.status_code == 200, upload_response.text

    detail = spj_client.get("/api/kwitansi/1").json()["data"]
    assert detail["jenis_belanja"] == "sewa"
    assert detail["data_lampiran"]["penerima_list"][0]["nama"] == "Pemilik Kendaraan"
    assert detail["data_lampiran"]["penerima_list"][0]["pph23"] == 3450
    assert len(detail["foto_bukti"]["kendaraan_stnk"]) == 1

    spj_data = spj_client.get("/api/kwitansi/1/spj-data").json()["data"]
    assert spj_data["jenis_belanja"] == "sewa"
    assert spj_data["data_lampiran"]["penerima_list"][0]["nama"] == "Pemilik Kendaraan"
    assert spj_data["data_lampiran"]["penerima_list"][0]["pph23"] == 3450
    assert spj_data["sections"]["bast"]["status"] == "skip"
    assert spj_data["sections"]["rab"]["status"] == "skip"
    assert spj_data["lampiran_foto"]["kendaraan_stnk"]


def test_kwitansi_section_has_no_kop_metadata(spj_client):
    """Aturan produk: metadata kop tidak boleh mengalir ke bagian kwitansi."""
    data = spj_client.get("/api/kwitansi/1/spj-data").json()["data"]
    assert "kop" not in data["kwitansi"]
    assert "kop" not in data["document"]
    assert data["document"]["kop_wajib"] is False
    # BAST may carry a kop; RAB is excluded for Pembelanjaan Umum.
    assert data["bast"]["kop"]["baris2"] == "SDN CONTOH 1"
    assert data["rab"] is None


def test_legacy_pdf_endpoint_is_gone(spj_client):
    res = spj_client.get("/api/kwitansi/1/pdf")
    assert res.status_code == 410
    assert "application/pdf" not in (res.headers.get("content-type") or "")
    assert "spj-data" in res.json()["detail"]


def test_spj_data_missing_kwitansi_404(spj_client):
    res = spj_client.get("/api/kwitansi/999/spj-data")
    assert res.status_code == 404


def test_generate_ai_image_uses_huggingface_router(spj_client, monkeypatch, tmp_path):
    from io import BytesIO
    import random

    import httpx
    import main

    image = main.Image.frombytes(
        "RGB",
        (128, 128),
        random.Random(42).randbytes(128 * 128 * 3),
    )
    image_buffer = BytesIO()
    image.save(image_buffer, format="PNG")
    image_base64 = base64.b64encode(image_buffer.getvalue()).decode("ascii")

    class HuggingFaceClient:
        request = None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, **kwargs):
            self.request = (url, kwargs)
            return httpx.Response(
                200,
                request=httpx.Request("POST", url),
                headers={"content-type": "application/json"},
                json={"data": [{"b64_json": image_base64}]},
            )

    hf_client = HuggingFaceClient()
    monkeypatch.setenv("HUGGINGFACE_TOKEN", "test-token")
    monkeypatch.setattr(main, "UPLOAD_KWITANSI_DIR", tmp_path)
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda: hf_client)

    res = spj_client.post(
        "/api/kwitansi/1/generate-ai-image",
        json={
            "prompt_items": "Pulpen",
            "jenis_foto": "barang",
            "orientation": "landscape",
            "provider": "huggingface",
            "api_key": "test-token",
        },
    )

    assert res.status_code == 200, res.text
    assert hf_client.request is not None
    url, options = hf_client.request
    assert url == "https://router.huggingface.co/nscale/v1/images/generations"
    assert options["headers"]["Authorization"] == "Bearer test-token"
    assert options["json"]["model"] == "black-forest-labs/FLUX.1-schnell"
    assert options["json"]["size"] == "640x480"
    saved_path = tmp_path / "1" / res.json()["data"]["path"].rsplit("/", 1)[-1]
    assert saved_path.is_file()


def test_generate_ai_image_reports_huggingface_dns_failure(spj_client, monkeypatch):
    import httpx
    import main

    class HuggingFaceUnavailable:
        calls = 0

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, **kwargs):
            self.calls += 1
            raise httpx.ConnectError(
                "[Errno 11001] getaddrinfo failed",
                request=httpx.Request("POST", url),
            )

    async def skip_delay(_seconds):
        return None

    unavailable = HuggingFaceUnavailable()
    monkeypatch.setenv("HUGGINGFACE_TOKEN", "test-token")
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda: unavailable)
    monkeypatch.setattr(main.asyncio, "sleep", skip_delay)

    res = spj_client.post(
        "/api/kwitansi/1/generate-ai-image",
        json={
            "prompt_items": "Pulpen",
            "jenis_foto": "barang",
            "provider": "huggingface",
            "api_key": "test-token",
        },
    )

    assert res.status_code == 503
    assert "Periksa koneksi internet dan DNS" in res.json()["detail"]
    assert "Internal Server Error" not in res.json()["detail"]
    assert unavailable.calls == 3


def test_generate_ai_image_reports_huggingface_billing_error(spj_client, monkeypatch):
    import httpx
    import main

    class HuggingFaceBillingRequired:
        calls = 0

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, **kwargs):
            self.calls += 1
            return httpx.Response(
                402,
                request=httpx.Request("POST", url),
                json={"error": "Payment required"},
            )

    provider = HuggingFaceBillingRequired()
    monkeypatch.setenv("HUGGINGFACE_TOKEN", "test-token")
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda: provider)

    res = spj_client.post(
        "/api/kwitansi/1/generate-ai-image",
        json={
            "prompt_items": "Pulpen",
            "jenis_foto": "barang",
            "provider": "huggingface",
            "api_key": "test-token",
        },
    )

    assert res.status_code == 402
    assert "billing" in res.json()["detail"].lower()
    assert "budget API key" in res.json()["detail"]
    assert provider.calls == 1


def test_generate_ai_image_uses_pollinations_secret_key(spj_client, monkeypatch, tmp_path):
    from io import BytesIO
    import random

    import httpx
    import main

    image = main.Image.frombytes(
        "RGB",
        (128, 128),
        random.Random(13).randbytes(128 * 128 * 3),
    )
    image_buffer = BytesIO()
    image.save(image_buffer, format="PNG")

    class PollinationsClient:
        request = None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url, **kwargs):
            self.request = (url, kwargs)
            return httpx.Response(
                200,
                request=httpx.Request("GET", url),
                headers={"content-type": "image/png"},
                content=image_buffer.getvalue(),
            )

    pollinations = PollinationsClient()
    monkeypatch.delenv("POLLINATIONS_API_KEY", raising=False)
    monkeypatch.setattr(main, "UPLOAD_KWITANSI_DIR", tmp_path)
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda: pollinations)

    res = spj_client.post(
        "/api/kwitansi/1/generate-ai-image",
        json={
            "prompt_items": "Pulpen",
            "jenis_foto": "barang",
            "provider": "pollinations",
            "model": "flux",
            "api_key": "sk_test-secret",
        },
    )

    assert res.status_code == 200, res.text
    assert pollinations.request is not None
    url, options = pollinations.request
    assert url.startswith("https://gen.pollinations.ai/image/")
    assert options["params"]["model"] == "flux"
    assert options["headers"]["Authorization"].startswith("Bearer ")


@pytest.mark.parametrize(
    ("api_key", "message"),
    [
        ("", "memerlukan secret API key berawalan sk_"),
        ("pk_test-app-key", "App Key Pollinations"),
    ],
)
def test_generate_ai_image_rejects_missing_or_app_pollinations_key(
    spj_client, monkeypatch, api_key, message
):
    monkeypatch.delenv("POLLINATIONS_API_KEY", raising=False)

    res = spj_client.post(
        "/api/kwitansi/1/generate-ai-image",
        json={
            "prompt_items": "Pulpen",
            "jenis_foto": "barang",
            "provider": "pollinations",
            "api_key": api_key,
        },
    )

    assert res.status_code == 400
    assert message in res.json()["detail"]


@pytest.mark.parametrize("status_code", [401, 403])
def test_generate_ai_image_explains_pollinations_auth_error(
    spj_client, monkeypatch, status_code
):
    import httpx
    import main

    class PollinationsAuthError:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url, **kwargs):
            return httpx.Response(
                status_code,
                request=httpx.Request("GET", url),
                json={"error": {"message": "API key does not have permission."}},
            )

    monkeypatch.setattr(main.httpx, "AsyncClient", PollinationsAuthError)

    res = spj_client.post(
        "/api/kwitansi/1/generate-ai-image",
        json={
            "prompt_items": "Pulpen",
            "jenis_foto": "barang",
            "provider": "pollinations",
            "api_key": "sk_test-secret",
        },
    )

    assert res.status_code == 502
    assert "secret key Pollinations berawalan sk_" in res.json()["detail"]
    assert "permission" in res.json()["detail"]


@pytest.mark.parametrize(
    ("provider", "expected_url", "expected_model"),
    [
        (
            "gemini",
            "https://generativelanguage.googleapis.com/v1beta/interactions",
            "gemini-nano-banana-2.1",
        ),
        (
            "openai",
            "https://api.openai.com/v1/images/generations",
            "gpt-image-2.5-flare",
        ),
    ],
)
def test_generate_ai_image_uses_native_image_providers(
    spj_client, monkeypatch, tmp_path, provider, expected_url, expected_model
):
    from io import BytesIO
    import random

    import httpx
    import main

    image = main.Image.frombytes(
        "RGB",
        (128, 128),
        random.Random(23).randbytes(128 * 128 * 3),
    )
    image_buffer = BytesIO()
    image.save(image_buffer, format="PNG")
    image_base64 = base64.b64encode(image_buffer.getvalue()).decode("ascii")

    class NativeImageClient:
        request = None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, **kwargs):
            self.request = (url, kwargs)
            response_data = (
                {"output_image": {"data": image_base64}}
                if provider == "gemini"
                else {"data": [{"b64_json": image_base64}]}
            )
            return httpx.Response(
                200,
                request=httpx.Request("POST", url),
                headers={"content-type": "application/json"},
                json=response_data,
            )

    native_client = NativeImageClient()
    monkeypatch.setattr(main, "UPLOAD_KWITANSI_DIR", tmp_path)
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda: native_client)

    res = spj_client.post(
        "/api/kwitansi/1/generate-ai-image",
        json={
            "prompt_items": "Pulpen",
            "jenis_foto": "barang",
            "orientation": "portrait",
            "provider": provider,
            "api_key": "test-provider-key",
        },
    )

    assert res.status_code == 200, res.text
    assert native_client.request is not None
    url, options = native_client.request
    assert url == expected_url
    assert options["json"]["model"] == expected_model
    if provider == "gemini":
        assert options["headers"]["x-goog-api-key"] == "test-provider-key"
        assert options["json"]["input"]
    else:
        assert options["headers"]["Authorization"].endswith("test-provider-key")
        assert options["json"]["size"] == "1024x1536"
        assert options["json"]["output_format"] == "png"


def test_generate_ai_image_explains_gemini_rate_limit(spj_client, monkeypatch):
    import httpx
    import main

    class GeminiRateLimited:
        calls = 0

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, **kwargs):
            self.calls += 1
            return httpx.Response(
                429,
                request=httpx.Request("POST", url),
                json={
                    "error": {
                        "code": 429,
                        "message": "Quota exceeded for metric images_per_minute.",
                        "status": "RESOURCE_EXHAUSTED",
                    }
                },
            )

    provider = GeminiRateLimited()
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda: provider)

    res = spj_client.post(
        "/api/kwitansi/1/generate-ai-image",
        json={
            "prompt_items": "Pulpen",
            "jenis_foto": "barang",
            "provider": "gemini",
            "api_key": "test-provider-key",
        },
    )

    assert res.status_code == 429
    assert "kuota RPM/IPM/RPD" in res.json()["detail"]
    assert "images_per_minute" in res.json()["detail"]
    assert provider.calls == 1


def test_generate_ai_image_uses_custom_openai_compatible_endpoint(
    spj_client, monkeypatch, tmp_path
):
    from io import BytesIO
    import random

    import httpx
    import main

    image = main.Image.frombytes(
        "RGB",
        (128, 128),
        random.Random(7).randbytes(128 * 128 * 3),
    )
    image_buffer = BytesIO()
    image.save(image_buffer, format="PNG")
    image_base64 = base64.b64encode(image_buffer.getvalue()).decode("ascii")

    class CustomProviderClient:
        request = None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, **kwargs):
            self.request = (url, kwargs)
            return httpx.Response(
                200,
                request=httpx.Request("POST", url),
                headers={"content-type": "application/json"},
                json={"data": [{"b64_json": image_base64}]},
            )

    custom_client = CustomProviderClient()
    monkeypatch.setattr(main, "UPLOAD_KWITANSI_DIR", tmp_path)
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda: custom_client)

    res = spj_client.post(
        "/api/kwitansi/1/generate-ai-image",
        json={
            "prompt_items": "Pulpen",
            "jenis_foto": "barang",
            "provider": "custom",
            "model": "image-model",
            "api_key": "custom-test-token",
            "api_endpoint": "https://images.example.test/v1/images/generations",
        },
    )

    assert res.status_code == 200, res.text
    assert custom_client.request is not None
    url, options = custom_client.request
    assert url == "https://images.example.test/v1/images/generations"
    assert options["headers"]["Authorization"] == "Bearer custom-test-token"
    assert options["json"]["model"] == "image-model"
    assert options["json"]["size"] == "640x480"


def test_generate_ai_image_rejects_non_local_http_custom_endpoint(spj_client):
    res = spj_client.post(
        "/api/kwitansi/1/generate-ai-image",
        json={
            "prompt_items": "Pulpen",
            "jenis_foto": "barang",
            "provider": "custom",
            "api_key": "test-token",
            "api_endpoint": "http://images.example.test/v1/images/generations",
        },
    )

    assert res.status_code == 400
    assert "HTTPS" in res.json()["detail"]


def test_no_pdf_media_type_anywhere_in_spj_flow(spj_client):
    """Alur SPJ baru tidak pernah menghasilkan/mengirim PDF dari backend."""
    res = spj_client.get("/api/kwitansi/1/spj-data")
    ct = res.headers.get("content-type", "")
    assert "pdf" not in ct.lower()
    # payload harus serializable sebagai JSON murni
    json.loads(res.text)


# ---------------------------------------------------------------------------
# Regresi zona waktu (error produksi Windows, lihat backend/app.log):
#   GET /api/kwitansi/{id}/spj-data -> 500 "No time zone found with key
#   Asia/Jakarta" karena runtime tidak punya database TZ IANA.
# ---------------------------------------------------------------------------
def test_zone_survives_without_system_tzdb(tmp_path):
    """Simulasi Windows TANPA database TZ sistem dan TANPA tzdata terpasang.

    Dijalankan pada interpreter Python bersih (subprocess) karena state
    TZPATH/provisioning zoneinfo bersifat per-proses:
      - env TZPATH=<dir kosong>  -> mematikan provisioning PEP 653 paket tzdata
        (persis kondisi user Windows di backend/app.log),
      - zoneinfo.reset_tzpath([kosong]) -> tidak ada database zona sistem,
      - direct ZoneInfo("Asia/Jakarta") -> WAJIB gagal (bukti reproduksi bug),
      - dengan sys.frozen + _MEIPASS berisi tzdata/zoneinfo hasil kemasan
        main.spec -> _zone_wib() harus menemukan WIB ASLI (+07:00).
    """
    empty = tmp_path / "no_zoneinfo"
    empty.mkdir()
    meipass = tmp_path / "_MEIPASS"
    (meipass / "tzdata" / "zoneinfo" / "Asia").mkdir(parents=True)
    import tzdata as _tzpkg
    src_jkt = Path(_tzpkg.__file__).parent / "zoneinfo" / "Asia" / "Jakarta"
    (meipass / "tzdata" / "zoneinfo" / "Asia" / "Jakarta").write_bytes(src_jkt.read_bytes())

    helper_code = r'''
import os, sys
sys.path.insert(0, os.environ["BACKEND_DIR"])
# HANYA menimpa loader Python murni (fallback saat modul C _zoneinfo tidak ada);
# sumber TZ sistem & provisioning PEP 653 dinonaktifkan secara terkendali.
import zoneinfo._tzpath as _tzp
_orig_find = _tzp.find_tzfile
_tzp.find_tzfile = lambda key: None             # simulasi Windows tanpa TZDB sistem
import zoneinfo._zoneinfo as _zimod
_zimod.get_tz_search_paths = lambda: set()      # simulasi tzdata TIDAK terpasang
try:                                            # paksa pakai loader Python murni
    import _zoneinfo as _czi; _czi.ZoneInfo = None
except Exception:
    pass
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
try:
    ZoneInfo("Asia/Jakarta")
    print("direct=FOUND")
except ZoneInfoNotFoundError:
    print("direct=NOTFOUND")
if os.environ.get("SIM_FROZEN") == "1":
    sys.frozen = True
    sys._MEIPASS = os.environ["MEIPASS"]
    def _find_from_meipass(key):
        p = os.path.join(os.environ["MEIPASS"], "tzdata", "zoneinfo", *key.split("/"))
        return p if os.path.isfile(p) else None
    _tzp.find_tzfile = _find_from_meipass       # setara hasil kemasan main.spec
import main
try:
    from datetime import datetime
    tz = main._zone_wib()
    ts = main._waktu_terbit_iso()
    print(f"zone={datetime.now(tz).utcoffset()} ts={ts}")
except Exception as e:
    print(f"error={type(e).__name__}: {e}")
'''

    def run(sim_frozen):
        env = dict(os.environ)
        env.update({
            "BACKEND_DIR": str(BACKEND_DIR),
            "EMPTY_TZPATH": str(empty),
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        if sim_frozen:
            env["SIM_FROZEN"] = "1"
            env["MEIPASS"] = str(meipass)
        else:
            env.pop("SIM_FROZEN", None)
        p = subprocess.run([sys.executable, "-c", helper_code],
                           capture_output=True, text=True, env=env, timeout=180)
        return p.stdout + p.stderr

    out_plain = run(False)
    # Kondisi rusak seperti app.log: tanpa sumber TZ apa pun, lookup gagal...
    assert "direct=NOTFOUND" in out_plain, out_plain
    # ...dan _zone_wib memberi ERROR JELAS, bukan waktu salah.
    assert "error=RuntimeError" in out_plain and "Asia/Jakarta" in out_plain, out_plain

    out_frozen = run(True)
    # Build main.spec (tzdata terkemas + frozen marker) memulihkan WIB asli.
    assert "direct=NOTFOUND" in out_frozen, out_frozen
    assert "zone=7:00:00" in out_frozen, out_frozen
    assert "+07:00" in out_frozen, out_frozen


def test_generated_at_from_production_endpoint(spj_client):
    """Endpoint nyata: generated_at ber-offset +07:00 (diuji juga di atas via
    test_generated_at_offset_wib; ini menegaskan bentuk string ISO penuh)."""
    data = spj_client.get("/api/kwitansi/1/spj-data").json()["data"]
    ts = data["document"]["generated_at"]
    dt = datetime.fromisoformat(ts)
    assert dt.utcoffset() == timedelta(hours=7)


def test_arkas_activity_sync_updates_and_preserves_local_references(spj_client):
    async def add_local_only_activity():
        from models import MasterKegiatan

        async with spj_client.test_session_maker() as session:
            session.add(
                MasterKegiatan(
                    kode_kegiatan="LOCAL-ONLY",
                    nama_kegiatan="Kegiatan lokal",
                )
            )
            await session.commit()

    asyncio.run(add_local_only_activity())
    response = spj_client.post(
        "/api/master-kegiatan/sync-arkas",
        json={
            "data": [
                {"kode_kegiatan": "K-01", "nama_kegiatan": "Kegiatan ARKAS terbaru"},
                {"kode_kegiatan": "K-02", "nama_kegiatan": "Kegiatan baru"},
                {"kode_kegiatan": "K-02", "nama_kegiatan": "Kegiatan baru"},
            ]
        },
    )

    assert response.status_code == 200
    assert response.json()["created_count"] == 1
    assert response.json()["updated_count"] == 1
    assert response.json()["total"] == 2
    rows = spj_client.get("/api/master-kegiatan").json()["data"]
    activities = {item["kode_kegiatan"]: item["nama_kegiatan"] for item in rows}
    assert activities["K-01"] == "Kegiatan ARKAS terbaru"
    assert activities["K-02"] == "Kegiatan baru"
    assert activities["LOCAL-ONLY"] == "Kegiatan lokal"


def test_rekap_transaksi_filters_by_fiscal_year_and_source_fund(spj_client):
    from models import Transaksi

    async def add_scoped_transactions():
        async with spj_client.test_session_maker() as session:
            session.add_all([
                Transaksi(
                    tanggal="2025-11-01",
                    kode_rekening="5.2.1.01.01",
                    no_bukti="BKT-2025-BOS",
                    fiscal_year=2025,
                    source_fund_id="BOS",
                    pengeluaran=110,
                ),
                Transaksi(
                    tanggal="2025-11-01",
                    kode_rekening="5.2.1.01.01",
                    no_bukti="BKT-2025-DAK",
                    fiscal_year=2025,
                    source_fund_id="DAK",
                    pengeluaran=220,
                ),
            ])
            await session.commit()

    asyncio.run(add_scoped_transactions())
    response = spj_client.get(
        "/api/rekap-transaksi?fiscal_year=2025&source_fund_id=BOS&details=1"
    )

    assert response.status_code == 200
    data = response.json()["data"]
    assert sum(group["total_pengeluaran"] for group in data) == 110
    assert [
        item["no_bukti"]
        for group in data
        for item in group["items"]
    ] == ["BKT-2025-BOS"]


def test_kwitansi_list_filters_by_thp(spj_client):
    from models import Kwitansi

    async def add_stage_two_draft():
        async with spj_client.test_session_maker() as session:
            session.add_all([
                Kwitansi(
                    nomor_kwitansi="002/KW/SPJ/XI/2026",
                    no_bukti="BKT-002",
                    kode_kegiatan="K-01",
                    nama_kegiatan="Belanja ATK",
                    tanggal="2026-11-06",
                    thp="THP II",
                    tahun="2026",
                    jumlah=250000,
                    foto_bukti="[]",
                ),
                Kwitansi(
                    nomor_kwitansi="003/KW/SPJ/X/2026",
                    no_bukti="BKT-003",
                    kode_kegiatan="K-01",
                    nama_kegiatan="Belanja ATK",
                    tanggal="15-10-2026",
                    thp="THP I",
                    tahun="2026",
                    jumlah=175000,
                    foto_bukti="[]",
                ),
            ])
            await session.commit()

    asyncio.run(add_stage_two_draft())

    stage_one = spj_client.get("/api/kwitansi?thp=1")
    stage_two = spj_client.get("/api/kwitansi?thp=2")
    october = spj_client.get("/api/kwitansi?month=10")
    october_stage_one = spj_client.get("/api/kwitansi?month=10&thp=1")

    assert stage_one.status_code == 200
    assert {item["thp"] for item in stage_one.json()["data"]} == {
        "THP I",
        "Tahap I",
    }
    assert stage_two.status_code == 200
    assert [item["thp"] for item in stage_two.json()["data"]] == ["THP II"]
    assert october.status_code == 200
    assert [item["no_bukti"] for item in october.json()["data"]] == ["BKT-003"]
    assert october_stage_one.status_code == 200
    assert [
        item["no_bukti"] for item in october_stage_one.json()["data"]
    ] == ["BKT-003"]


def test_arkas_activity_sync_rejects_empty_data(spj_client):
    response = spj_client.post(
        "/api/master-kegiatan/sync-arkas",
        json={"data": []},
    )
    assert response.status_code == 400
    assert "Tidak ada referensi kegiatan ARKAS" in response.json()["detail"]


def test_arkas_import_keeps_existing_receipts_and_vendor_identity(spj_client):
    payload = {
        "mode": "keep",
        "transaksi": [
            {
                "tanggal": "05-11-2026",
                "kode_kegiatan": "02.03.01",
                "kode_rekening": "5.1.02.01",
                "no_bukti": "BPU-001",
                "uraian": "Belanja ATK",
                "volume": 5,
                "satuan": "paket",
                "harga_satuan": 25000,
                "pengeluaran": 125000,
                "nama_toko": "Toko Contoh",
                "alamat_toko": "Jl. Contoh",
                "no_telp_toko": "08123456789",
                "npwp_toko": "01.234.567.8-901.000",
                "no_nota": "NOTA-001",
                "tanggal_nota": "04-11-2026",
            }
        ]
    }

    first = spj_client.post("/api/transaksi/import-arkas", json=payload)
    second = spj_client.post("/api/transaksi/import-arkas", json=payload)

    assert first.status_code == 200
    assert first.json()["saved_count"] == 1
    assert second.status_code == 200
    assert second.json()["saved_count"] == 0
    assert second.json()["skipped_count"] == 1

    async def read_transactions():
        from sqlalchemy import select
        from models import Transaksi

        async with spj_client.test_session_maker() as session:
            result = await session.execute(select(Transaksi))
            return result.scalars().all()

    transactions = asyncio.run(read_transactions())
    assert len(transactions) == 2
    assert {item.no_bukti for item in transactions} == {"BKT-001", "BPU-001"}
    imported = next(item for item in transactions if item.no_bukti == "BPU-001")
    assert imported.kode_kegiatan == "02.03.01"
    assert imported.volume == 5
    assert imported.nama_toko == "Toko Contoh"
    assert imported.alamat_toko == "Jl. Contoh"
    assert imported.no_telp_toko == "08123456789"
    assert imported.npwp_toko == "01.234.567.8-901.000"
    assert imported.no_nota == "NOTA-001"
    response_rows = spj_client.get("/api/transaksi").json()["data"]
    imported_response = next(
        item for item in response_rows if item["no_bukti"] == "BPU-001"
    )
    assert imported_response["nama_toko"] == "Toko Contoh"
    assert imported_response["alamat_toko"] == "Jl. Contoh"


def test_arkas_import_syncs_spj_vendor_and_preserves_manual_fields(spj_client):
    async def add_existing_spj():
        from models import Kwitansi, Transaksi

        async with spj_client.test_session_maker() as session:
            session.add(
                Transaksi(
                    tanggal="01-11-2026",
                    no_bukti="BPU-EXIST",
                    uraian="Data BKU yang dipertahankan",
                )
            )
            session.add(
                Kwitansi(
                    nomor_kwitansi="BPU-EXIST/02.03.01/THP II/2026",
                    no_bukti="BPU-EXIST",
                    kode_kegiatan="02.03.01",
                    nama_kegiatan="Nama lama",
                    tanggal="01-11-2026",
                    no_bast="BAST-MANUAL",
                    nama_toko="Nama lama",
                    foto_bukti='[{"path":"uploads/keep.png","jenis":"barang"}]',
                    data_lampiran='{"catatan":"tetap"}',
                )
            )
            await session.commit()

    asyncio.run(add_existing_spj())
    response = spj_client.post(
        "/api/transaksi/import-arkas",
        json={
            "mode": "keep",
            "transaksi": [
                {
                    "tanggal": "05-11-2026",
                    "kode_kegiatan": "02.03.01",
                    "nama_kegiatan": "Kegiatan ARKAS",
                    "no_bukti": "BPU-EXIST",
                    "uraian": "Belanja ARKAS",
                    "pengeluaran": 125000,
                    "nama_toko": "Toko ARKAS",
                    "alamat_toko": "Jl. ARKAS",
                    "no_telp_toko": "08123456789",
                    "npwp_toko": "01.234.567.8-901.000",
                    "no_nota": "NOTA-ARKAS",
                    "tanggal_nota": "04-11-2026",
                },
                {
                    "tanggal": "06-11-2026",
                    "kode_kegiatan": "02.03.02",
                    "no_bukti": "BPU-NEW",
                    "uraian": "Rincian lain untuk bukti yang sama",
                    "pengeluaran": 50000,
                },
                {
                    "tanggal": "06-11-2026",
                    "kode_kegiatan": "02.03.03",
                    "nama_kegiatan": "Kegiatan Baru",
                    "no_bukti": "BPU-NEW",
                    "uraian": "Rincian tambahan",
                    "pengeluaran": 25000,
                    "nama_toko": "Toko Baru",
                    "alamat_toko": "Jl. Toko Baru",
                    "no_telp_toko": "08123456789",
                    "npwp_toko": "02.345.678.9-012.000",
                    "no_nota": "NOTA-BARU",
                    "tanggal_nota": "05-11-2026",
                },
            ],
        },
    )

    assert response.status_code == 200
    assert response.json()["skipped_count"] == 1
    assert response.json()["synced_kwitansi_count"] == 1
    assert response.json()["created_kwitansi_count"] == 1

    async def read_spj():
        from sqlalchemy import select
        from models import Kwitansi

        async with spj_client.test_session_maker() as session:
            result = await session.execute(select(Kwitansi))
            return result.scalars().all()

    kwitansi = asyncio.run(read_spj())
    existing = next(row for row in kwitansi if row.no_bukti == "BPU-EXIST")
    created = next(row for row in kwitansi if row.no_bukti == "BPU-NEW")
    assert sum(row.no_bukti == "BPU-NEW" for row in kwitansi) == 1
    assert existing.nama_toko == "Toko ARKAS"
    assert existing.alamat_toko == "Jl. ARKAS"
    assert existing.no_telp_toko == "08123456789"
    assert existing.npwp_toko == "01.234.567.8-901.000"
    assert existing.no_nota == "NOTA-ARKAS"
    assert existing.tanggal_nota == "04-11-2026"
    assert existing.no_bast == "BAST-MANUAL"
    assert existing.foto_bukti == '[{"path":"uploads/keep.png","jenis":"barang"}]'
    assert existing.data_lampiran == '{"catatan":"tetap"}'
    assert created.nama_toko == "Toko Baru"
    assert created.kode_kegiatan == "02.03.02"
    assert created.alamat_toko == "Jl. Toko Baru"
    assert created.no_telp_toko == "08123456789"
    assert created.npwp_toko == "02.345.678.9-012.000"
    assert created.no_nota == "NOTA-BARU"
    assert created.jumlah == 75000

    spj_rows = spj_client.get("/api/kwitansi").json()["data"]
    synced_row = next(row for row in spj_rows if row["no_bukti"] == "BPU-EXIST")
    assert synced_row["no_telp_toko"] == "08123456789"
    assert synced_row["no_nota"] == "NOTA-ARKAS"
    detail = spj_client.get(f"/api/kwitansi/{created.id}").json()["data"]
    assert detail["nama_toko"] == "Toko Baru"
    assert detail["no_telp_toko"] == "08123456789"
    assert detail["no_nota"] == "NOTA-BARU"


def test_generate_spj_groups_same_receipt_and_copies_arkas_vendor(spj_client):
    async def add_transactions():
        from models import Transaksi

        async with spj_client.test_session_maker() as session:
            session.add_all(
                [
                    Transaksi(
                        tanggal="05-11-2026",
                        kode_kegiatan="02.03.01",
                        no_bukti="BPU-GROUP",
                        uraian="Barang pertama",
                        pengeluaran=100000,
                        nama_toko="Toko Sama",
                        alamat_toko="Jl. Sama",
                        no_telp_toko="08123456789",
                        npwp_toko="01.234.567.8-901.000",
                        no_nota="NOTA-GROUP",
                        tanggal_nota="04-11-2026",
                    ),
                    Transaksi(
                        tanggal="05-11-2026",
                        kode_kegiatan="02.03.02",
                        no_bukti="BPU-GROUP",
                        uraian="Barang kedua",
                        pengeluaran=50000,
                        nama_toko="Toko Sama",
                        alamat_toko="Jl. Sama",
                        no_telp_toko="08123456789",
                        npwp_toko="01.234.567.8-901.000",
                        no_nota="NOTA-GROUP",
                        tanggal_nota="04-11-2026",
                    ),
                ]
            )
            await session.commit()

    asyncio.run(add_transactions())
    response = spj_client.post("/api/kwitansi/generate")

    assert response.status_code == 200
    rows = spj_client.get("/api/kwitansi").json()["data"]
    grouped_rows = [row for row in rows if row["no_bukti"] == "BPU-GROUP"]
    assert len(grouped_rows) == 1
    assert grouped_rows[0]["jumlah"] == 150000
    assert grouped_rows[0]["nama_toko"] == "Toko Sama"
    assert grouped_rows[0]["alamat_toko"] == "Jl. Sama"
    assert grouped_rows[0]["no_telp_toko"] == "08123456789"
    assert grouped_rows[0]["npwp_toko"] == "01.234.567.8-901.000"
    assert grouped_rows[0]["no_nota"] == "NOTA-GROUP"


def test_arkas_import_update_replaces_rows_by_receipt_number(spj_client):
    async def add_existing_rows():
        from models import Transaksi

        async with spj_client.test_session_maker() as session:
            session.add_all(
                [
                    Transaksi(
                        tanggal="01-11-2026",
                        no_bukti="BPU-UPDATE",
                        uraian="Data lama 1",
                    ),
                    Transaksi(
                        tanggal="01-11-2026",
                        no_bukti="BPU-UPDATE",
                        uraian="Data lama 2",
                    ),
                    Transaksi(
                        tanggal="01-11-2026",
                        no_bukti="BPU-KEEP",
                        uraian="Jangan diubah",
                    ),
                ]
            )
            await session.commit()

    asyncio.run(add_existing_rows())
    response = spj_client.post(
        "/api/transaksi/import-arkas",
        json={
            "mode": "update",
            "transaksi": [
                {
                    "tanggal": "05-11-2026",
                    "no_bukti": "BPU-UPDATE",
                    "uraian": "Data ARKAS 1",
                    "volume": 1,
                    "pengeluaran": 100,
                },
                {
                    "tanggal": "05-11-2026",
                    "no_bukti": "BPU-UPDATE",
                    "uraian": "Data ARKAS 2",
                    "volume": 2,
                    "pengeluaran": 200,
                },
            ],
        },
    )
    assert response.status_code == 200
    assert response.json()["deleted_count"] == 2
    assert response.json()["saved_count"] == 2

    async def read_rows():
        from sqlalchemy import select
        from models import Transaksi

        async with spj_client.test_session_maker() as session:
            result = await session.execute(select(Transaksi))
            return result.scalars().all()

    rows = asyncio.run(read_rows())
    assert sorted(row.uraian for row in rows) == [
        "Data ARKAS 1",
        "Data ARKAS 2",
        "Jangan diubah",
        "Pulpen 1 lusin",
    ]


def test_arkas_import_replace_all_removes_existing_transactions(spj_client):
    response = spj_client.post(
        "/api/transaksi/import-arkas",
        json={
            "mode": "replace_all",
            "transaksi": [
                {
                    "tanggal": "05-11-2026",
                    "no_bukti": "BPU-REPLACE",
                    "uraian": "Data pengganti",
                    "pengeluaran": 500,
                }
            ],
        },
    )
    assert response.status_code == 200
    assert response.json()["deleted_count"] == 1
    assert response.json()["saved_count"] == 1

    async def read_rows():
        from sqlalchemy import select
        from models import Transaksi

        async with spj_client.test_session_maker() as session:
            result = await session.execute(select(Transaksi))
            return result.scalars().all()

    rows = asyncio.run(read_rows())
    assert len(rows) == 1
    assert rows[0].no_bukti == "BPU-REPLACE"


def test_arkas_replace_scope_preserves_same_receipt_in_other_fiscal_context(spj_client):
    async def seed_scoped_rows():
        from models import Kwitansi, Transaksi

        async with spj_client.test_session_maker() as session:
            session.add_all(
                [
                    Transaksi(
                        tanggal="01-11-2025",
                        no_bukti="BPU-DUP",
                        uraian="Target lama",
                        fiscal_year=2025,
                        source_fund_id="1",
                        source_fund_name="BOS",
                        budget_id="101",
                        budget_name="Anggaran 2025 BOS",
                    ),
                    Transaksi(
                        tanggal="01-11-2026",
                        no_bukti="BPU-DUP",
                        uraian="Di luar lingkup",
                        fiscal_year=2026,
                        source_fund_id="2",
                        source_fund_name="DAK",
                        budget_id="202",
                        budget_name="Anggaran 2026 DAK",
                    ),
                ]
            )
            session.add(
                Kwitansi(
                    nomor_kwitansi="BPU-DUP-OUTSIDE",
                    no_bukti="BPU-DUP",
                    tanggal="01-11-2026",
                    fiscal_year=2026,
                    source_fund_id="2",
                    source_fund_name="DAK",
                    budget_id="202",
                    budget_name="Anggaran 2026 DAK",
                )
            )
            await session.commit()

    asyncio.run(seed_scoped_rows())
    response = spj_client.post(
        "/api/transaksi/import-arkas",
        json={
            "mode": "replace_all",
            "transaksi": [
                {
                    "tanggal": "05-11-2025",
                    "no_bukti": "BPU-DUP",
                    "uraian": "Target baru",
                    "pengeluaran": 500,
                    "fiscal_year": 2025,
                    "source_fund_id": "1",
                    "source_fund_name": "BOS",
                    "budget_id": "101",
                    "budget_name": "Anggaran 2025 BOS",
                }
            ],
        },
    )
    assert response.status_code == 200
    assert response.json()["deleted_count"] == 1

    async def read_scope_rows():
        from sqlalchemy import select
        from models import Kwitansi, Transaksi

        async with spj_client.test_session_maker() as session:
            transactions = (await session.execute(select(Transaksi))).scalars().all()
            kwitansi = (await session.execute(select(Kwitansi))).scalars().all()
            return transactions, kwitansi

    transactions, kwitansi = asyncio.run(read_scope_rows())
    assert {(item.fiscal_year, item.uraian) for item in transactions if item.no_bukti == "BPU-DUP"} == {
        (2025, "Target baru"),
        (2026, "Di luar lingkup"),
    }
    assert any(item.nomor_kwitansi == "BPU-DUP-OUTSIDE" for item in kwitansi)


def test_arkas_import_update_key_includes_fiscal_context(spj_client):
    payload = {
        "mode": "update",
        "transaksi": [
            {
                "tanggal": "05-11-2025",
                "no_bukti": "BPU-COLLIDE",
                "uraian": "BOS",
                "pengeluaran": 100,
                "fiscal_year": 2025,
                "source_fund_id": "1",
                "budget_id": "101",
            },
            {
                "tanggal": "05-11-2026",
                "no_bukti": "BPU-COLLIDE",
                "uraian": "DAK",
                "pengeluaran": 200,
                "fiscal_year": 2026,
                "source_fund_id": "2",
                "budget_id": "202",
            },
        ],
    }
    response = spj_client.post("/api/transaksi/import-arkas", json=payload)
    assert response.status_code == 400
    assert "satu tahun" in response.json()["detail"]


def test_arkas_activity_references_are_scoped_by_year_and_source(spj_client):
    for year, source_id, name in (
        (2025, "1", "Kegiatan BOS 2025"),
        (2026, "2", "Kegiatan DAK 2026"),
    ):
        response = spj_client.post(
            "/api/master-kegiatan/sync-arkas",
            json={
                "data": [
                    {
                        "kode_kegiatan": "02.03.01",
                        "nama_kegiatan": name,
                        "fiscal_year": year,
                        "source_fund_id": source_id,
                        "source_fund_name": f"Sumber {source_id}",
                    }
                ]
            },
        )
        assert response.status_code == 200
        assert response.json()["created_count"] == 1

    first = spj_client.get(
        "/api/master-kegiatan?fiscal_year=2025&source_fund_id=1"
    )
    second = spj_client.get(
        "/api/master-kegiatan?fiscal_year=2026&source_fund_id=2"
    )
    assert first.status_code == second.status_code == 200
    assert {
        item["nama_kegiatan"]
        for item in first.json()["data"]
        if item["kode_kegiatan"] == "02.03.01"
    } == {"Kegiatan BOS 2025"}
    assert {
        item["nama_kegiatan"]
        for item in second.json()["data"]
        if item["kode_kegiatan"] == "02.03.01"
    } == {"Kegiatan DAK 2026"}


def test_fiscal_filters_keep_legacy_rows_separate(spj_client):
    async def add_other_scope():
        from models import Transaksi

        async with spj_client.test_session_maker() as session:
            session.add(
                Transaksi(
                    tanggal="05-11-2026",
                    no_bukti="BPU-FILTER",
                    uraian="Scoped row",
                    fiscal_year=2026,
                    source_fund_id="BOS",
                    budget_id="budget-2026",
                )
            )
            session.add(
                Transaksi(
                    tanggal="05-11-2026",
                    no_bukti="BPU-LEGACY",
                    uraian="Legacy row",
                )
            )
            await session.commit()

    asyncio.run(add_other_scope())
    scoped = spj_client.get(
        "/api/transaksi?fiscal_year=2026&source_fund_id=BOS&budget_id=budget-2026"
    )
    unspecified = spj_client.get(
        "/api/transaksi?fiscal_year=unspecified&source_fund_id=unspecified&budget_id=unspecified"
    )
    assert scoped.status_code == unspecified.status_code == 200
    assert [row["no_bukti"] for row in scoped.json()["data"]] == ["BPU-FILTER"]
    assert "BPU-LEGACY" in {
        row["no_bukti"] for row in unspecified.json()["data"]
    }


def test_spj_generation_groups_receipts_per_fiscal_context(spj_client):
    async def add_receipt_collisions():
        from models import Transaksi

        async with spj_client.test_session_maker() as session:
            session.add_all(
                [
                    Transaksi(
                        tanggal="05-11-2025",
                        no_bukti="BPU-CROSS-CONTEXT",
                        kode_kegiatan="K-01",
                        uraian="BOS detail",
                        pengeluaran=100,
                        fiscal_year=2025,
                        source_fund_id="1",
                        budget_id="101",
                    ),
                    Transaksi(
                        tanggal="05-11-2026",
                        no_bukti="BPU-CROSS-CONTEXT",
                        kode_kegiatan="K-01",
                        uraian="DAK detail",
                        pengeluaran=200,
                        fiscal_year=2026,
                        source_fund_id="2",
                        budget_id="202",
                    ),
                ]
            )
            await session.commit()

    asyncio.run(add_receipt_collisions())
    response = spj_client.post("/api/kwitansi/generate")
    assert response.status_code == 200
    rows = spj_client.get("/api/kwitansi").json()["data"]
    grouped = [
        item for item in rows if item["no_bukti"] == "BPU-CROSS-CONTEXT"
    ]
    assert len(grouped) == 2
    assert {
        (item["fiscal_year"], item["source_fund_id"], item["budget_id"])
        for item in grouped
    } == {(2025, "1", "101"), (2026, "2", "202")}
    assert all(
        "/1-101" not in item["nomor_kwitansi"]
        and "/2-202" not in item["nomor_kwitansi"]
        for item in grouped
    )
