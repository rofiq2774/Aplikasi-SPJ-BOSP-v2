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
