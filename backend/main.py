# 1. Python Standard Libraries
import asyncio
import base64
import io
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import traceback
import uuid
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import quote, unquote, urlparse

# 2. Third-Party Libraries
import fitz  # PyMuPDF
import httpx
import openpyxl
from alembic import command
from alembic.config import Config
from dateutil.parser import parse as parse_date
from dotenv import load_dotenv
from fastapi import (
    APIRouter, Depends, FastAPI, File, Form,
    HTTPException, Query, Request, UploadFile
)
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fpdf import FPDF
from num2words import num2words
from PIL import Image
from pydantic import BaseModel
from PyPDF2 import PdfMerger
from reportlab.lib import colors
from reportlab.lib.units import cm, mm
from reportlab.lib.utils import simpleSplit
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas
from sqlalchemy import and_, delete, func, insert, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.middleware.cors import CORSMiddleware

# 3. Local Application Imports
from database import BASE_DIR, AsyncSessionLocal, Base, engine, get_db
from models import (
    IdentitasPeriode, Kwitansi, MasterKegiatan,
    MasterRekeningBelanja, Pengaturan, Transaksi
)
_migrated = False

# ===============================
# ENV & MODE
# ===============================
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

IS_DEV = os.getenv("PYTHON_ENV") == "development"

# ===============================
# LOGGING (SATU KALI SAJA)
# ===============================
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
log_level = getattr(logging, LOG_LEVEL, logging.INFO)

logging.basicConfig(
    level=log_level,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)

logger = logging.getLogger(__name__)

# Matikan log SQLAlchemy di production
if not IS_DEV:
    logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)
    logging.getLogger("sqlalchemy.pool").setLevel(logging.WARNING)
    logging.getLogger("sqlalchemy.dialects").setLevel(logging.WARNING)

log_file = BASE_DIR / "app.log"

file_handler = logging.FileHandler(log_file, encoding="utf-8")
file_handler.setLevel(log_level)
formatter = logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
file_handler.setFormatter(formatter)

# 1. Tambahkan ke Root Logger (untuk aplikasi ini & library umum)
root_logger = logging.getLogger()
root_logger.addHandler(file_handler)

# 2. Tambahkan khusus ke Uvicorn (agar log request HTTP & Startup masuk file)
# Gunakan try-except karena logging uvicorn mungkin belum terinit jika dijalankan manual
try:
    logging.getLogger("uvicorn").addHandler(file_handler)
    logging.getLogger("uvicorn.error").addHandler(file_handler)
    logging.getLogger("uvicorn.access").addHandler(file_handler)
except Exception:
    pass

# 3. Tangkap SEMUA print() dan tulisan langsung ke stdout/stderr (kode lama memakai
#    print() di banyak tempat) agar ikut tercatat di app.log. Ini wajib karena
#    Electron tidak lagi membaca pipe stdout/stderr untuk logging — satu-satunya
#    catatan kejadian backend adalah file app.log.
class _TeeToLogStream:
    """Teruskan tulisan ke stream asli, sekaligus mencatatnya ke app.log."""
    def __init__(self, original, logger_name):
        self._original = original
        self._logger = logging.getLogger(logger_name)

    def write(self, data):
        try:
            if isinstance(data, (bytes, bytearray)):
                data = data.decode("utf-8", errors="replace")
        except Exception:
            pass
        try:
            text = str(data)
            if self._original:
                try:
                    self._original.write(text)
                    self._original.flush()
                except Exception:
                    pass
            for line in text.splitlines():
                if line.strip():
                    self._logger.info(line.rstrip())
        except Exception:
            pass
        return len(data) if isinstance(data, str) else 0

    def flush(self):
        try:
            if self._original:
                self._original.flush()
        except Exception:
            pass

    def isatty(self):
        return False

    def writable(self):
        return True

sys.stdout = _TeeToLogStream(sys.__stdout__, "backend.stdout")
sys.stderr = _TeeToLogStream(sys.__stderr__, "backend.stderr")

logger.info(f"Log file aktif di: {log_file}")

# ===============================
# FASTAPI APP (with lifespan)
# ===============================
@asynccontextmanager
async def lifespan(app):
    logger.info("Inisialisasi database...")
    try:
        run_migrations()
    except Exception as e:
        logger.exception("run_migrations gagal: %s", e)
    # create_all hanya membuat tabel yang belum ada — kolom baru pada tabel
    # lama (mis. identitas_periode.tempat_surat) harus ditambahkan terpisah,
    # jika tidak endpoint seperti GET /api/identitas-periode akan 500 dengan
    # "no such column". Lihat _sync_schema_columns().
    #
    # PENTING (bug v1.2.4): sinkronisasi kolom WAJIB dijalankan sebelum
    # request pertama dilayani. Dahulu ia hanya dipanggil di sini (lifespan),
    # sehingga bila lifespan gagal/terlewat — atau DB berubah di antara dua
    # startup — endpoint tetap menjawab 500 "no such column". Sekarang fungsi
    # yang sama juga dipanggil sebagai penambal otomatis saat error kolom
    # terjadi di tengah request (lihat _ensure_schema_columns_for()).
    # Sinkronkan kolom pada tabel yang SUDAH ada lebih dulu, lalu create_all
    # untuk membuat tabel yang belum ada, lalu sinkronkan sekali lagi.
    # Urutan ini penting (bug v1.2.4): bila create_all dijalankan terlebih
    # dahulu pada DB rusak/kosong, beberapa kondisi membuat lifespan berhenti
    # sebelum penyelarasan sempat berjalan — request pertama kemudian
    # menjawab 500 "no such column".
    try:
        added_columns = _sync_schema_columns()
        if added_columns:
            logger.info(
                "Penyelarasan skema (pra-create): "
                f"{added_columns} kolom baru ditambahkan."
            )
    except Exception as e:
        logger.exception("Penyelarasan kolom skema (pra-create) gagal: %s", e)
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    except Exception as e:
        logger.exception("create_all gagal (diteruskan ke sinkronisasi): %s", e)
    try:
        added_columns = _sync_schema_columns()
        if added_columns:
            logger.info(
                f"Penyelarasan skema: {added_columns} kolom baru ditambahkan."
            )
    except Exception as e:
        logger.exception("Penyelarasan kolom skema gagal: %s", e)
    if _schema_sync_ok:
        logger.info("Database siap")
    else:
        # Jangan biarkan /health melaporkan "siap" bila skema masih bermasalah;
        # middleware penambal akan mencoba memulihkan pada request berikutnya.
        logger.warning(
            "Skema database belum sepenuhnya selaras — penambal otomatis "
            "akan dicoba ulang saat ada request masuk."
        )
    yield

app = FastAPI(title="Aplikasi SPJ BOSP", lifespan=lifespan)

# ===============================
# HEALTH CHECK (UNTUK ELECTRON)
# ===============================
@app.get("/health")
async def health_check():
    # Electron memakai /health untuk menentukan kapan renderer boleh memuat
    # UI dan menembak API. Bila penyelarasan skema belum berhasil, JANGAN
    # melaporkan "siap" — cobalah menambalnya sekali lagi sekarang; jika masih
    # gagal, jawab 503 agar frontend tetap menunggu (retry) alih-alih langsung
    # menerima HTTP 500 pada GET /api/identitas-periode (bug v1.2.4).
    if not _schema_sync_ok:
        try:
            # Batasi waktu penambalan agar /health tidak menggantung; bila
            # masih gagal, frontend akan mencoba lagi pada polling berikutnya.
            await asyncio.wait_for(
                asyncio.to_thread(_ensure_schema_columns_for, Base.metadata.sorted_tables),
                timeout=10,
            )
        except Exception as e:
            logger.warning("Health check: penambalan skema gagal: %s", e)
    ready = _schema_sync_ok
    body = {
        "status": "siap" if ready else "menyiapkan-skema",
        "skema_siap": ready,
        # ISO string, BUKAN objek datetime — JSONResponse memakai json.dumps
        # standar yang tidak bisa mengserialisasi datetime (TypeError -> 500).
        "waktu": datetime.now(timezone.utc).isoformat(),
    }
    if not ready:
        return JSONResponse(status_code=503, content=body)
    return body

# ===============================
# CORS
# ===============================
cors_origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logger.info(f"CORS allow_origins={cors_origins}")

# ===============================
# LOGGING SEMUA KEJADIAN HTTP (app.log wajib mencatat segalanya)
# ===============================
@app.middleware("http")
async def log_all_requests_middleware(request, call_next):
    """Catat SETIAP request & response REST API ke app.log."""
    start = datetime.now(timezone.utc)
    try:
        response = await call_next(request)
    except Exception as exc:
        dur_ms = (datetime.now(timezone.utc) - start).total_seconds() * 1000
        logger.exception(
            f"HTTP {request.method} {request.url.path} -> 500 UNHANDLED "
            f"({dur_ms:.1f} ms): {exc}"
        )
        raise
    dur_ms = (datetime.now(timezone.utc) - start).total_seconds() * 1000
    level = logging.WARNING if response.status_code >= 400 else logging.INFO
    logger.log(
        level,
        f"HTTP {request.method} {request.url.path}{'?' + request.url.query if request.url.query else ''}"
        f" -> {response.status_code} ({dur_ms:.1f} ms)"
    )
    return response


@app.exception_handler(Exception)
async def log_unhandled_exception_handler(request, exc):
    """Pintu terakhir: semua exception tak tertangkap dicatat ke app.log."""
    logger.exception(
        f"Unhandled exception pada {request.method} {request.url.path}: {exc}"
    )
    return JSONResponse(
        status_code=500,
        content={"status": "error", "detail": "Kesalahan internal server (lihat app.log)"}
    )
# ===============================
# DIRECTORIES (PAKAI BASE_DIR DARI database.py)
# ===============================
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_LOGO_DIR = UPLOAD_DIR / "logos"
UPLOAD_KWITANSI_DIR = UPLOAD_DIR / "kwitansi"
UPLOAD_LOGO_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_KWITANSI_DIR.mkdir(parents=True, exist_ok=True)


# ===============================
# STATIC FILES (DENGAN CORS HEADER UNTUK RENDERER PDF)
# ===============================
class CORSStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "*"
        return response

app.mount(
    "/uploads",
    CORSStaticFiles(directory=str(UPLOAD_DIR)),
    name="uploads"
)
# ===============================
# ROUTER API
# ===============================
api_router = APIRouter(prefix="/api")

# (endpoint-endpoint Anda lanjutkan di bawah sini)

app.include_router(api_router)

# Definisi Class
class AIImageRequest(BaseModel):
    prompt_items: str
    jenis_foto: str
# Pydantic Models
class TransaksiItem(BaseModel):
    tanggal: str
    kode_kegiatan: Optional[str] = ""
    kode_rekening: Optional[str] = ""
    no_bukti: str
    uraian: str
    nama_kegiatan: Optional[str] = ""
    penerimaan: float = 0
    pengeluaran: float = 0
    saldo: float = 0
    volume: float = 0
    satuan: Optional[str] = ""
    harga_satuan: float = 0.0
    nama_toko: Optional[str] = ""
    alamat_toko: Optional[str] = ""
    no_telp_toko: Optional[str] = ""
    npwp_toko: Optional[str] = ""
    no_nota: Optional[str] = ""
    tanggal_nota: Optional[str] = ""


class BKUData(BaseModel):
    no_bukti: Optional[str] = ""
    transaksi: List[TransaksiItem] = []


class ArkasImportRequest(BaseModel):
    mode: str = "keep"
    transaksi: List[TransaksiItem]


class KwitansiRequest(BaseModel):
    transaksi: TransaksiItem
    nama_sekolah: Optional[str] = ""
    alamat_sekolah: Optional[str] = ""
    bulan: Optional[str] = ""
    tahun: Optional[str] = ""
    format: str = "pdf"


class PengaturanRequest(BaseModel):
    nama_sekolah: str = ""
    nama_kepala_sekolah: str = ""
    nip_kepala_sekolah: str = ""
    nama_bendahara: str = ""
    nip_bendahara: str = ""
    nama_pengurus_barang: str = ""
    nip_pengurus_barang: str = ""    
    alamat_sekolah: str = ""
    tempat_surat: str = ""


# Kolom identitas yang disatukan (kop/letterhead + pejabat) — dipakai untuk
# entri IdentitasPeriode. Menu "Identitas Satuan Pendidikan" dan "Logo dan Kop
# Surat" kini menyatu dalam satu entri per periode tanggal.
IDENTITAS_KOLOM = [
    "label", "tanggal_awal", "tanggal_akhir", "is_active",
    "nama_pemda", "nama_sekolah", "alamat_sekolah", "tempat_surat",
    "logo_pemda", "logo_sekolah",
    "nama_kepala_sekolah", "nip_kepala_sekolah",
    "nama_bendahara", "nip_bendahara",
    "nama_pengurus_barang", "nip_pengurus_barang",
]

# Kolom tabel Pengaturan legacy yang dibaca sebagai identitas (fallback).
PENGATURAN_IDENTITAS_KOLOM = [
    "nama_pemda", "nama_sekolah", "alamat_sekolah", "tempat_surat",
    "logo_pemda", "logo_sekolah",
    "nama_kepala_sekolah", "nip_kepala_sekolah",
    "nama_bendahara", "nip_bendahara",
    "nama_pengurus_barang", "nip_pengurus_barang",
]


class IdentitasPeriodeRequest(BaseModel):
    """Payload JSON identitas satuan pendidikan per periode.

    ``tanggal_akhir`` kosong berarti periode masih berlaku (open-ended).
    Logo dikirim sebagai data URI base64; bila None saat update, logo lama
    tetap dipertahankan.
    """
    id: Optional[int] = None
    label: Optional[str] = ""
    tanggal_awal: Optional[str] = ""
    tanggal_akhir: Optional[str] = ""
    is_active: Optional[bool] = True
    nama_pemda: Optional[str] = ""
    nama_sekolah: Optional[str] = ""
    alamat_sekolah: Optional[str] = ""
    tempat_surat: Optional[str] = ""
    logo_pemda: Optional[str] = None
    logo_sekolah: Optional[str] = None
    nama_kepala_sekolah: Optional[str] = ""
    nip_kepala_sekolah: Optional[str] = ""
    nama_bendahara: Optional[str] = ""
    nip_bendahara: Optional[str] = ""
    nama_pengurus_barang: Optional[str] = ""
    nip_pengurus_barang: Optional[str] = ""


class MasterKegiatanRequest(BaseModel):
    kode_kegiatan: str
    nama_kegiatan: str


class MasterKegiatanBulkRequest(BaseModel):
    data: List[MasterKegiatanRequest]


class MasterRekeningBelanjaRequest(BaseModel):
    kode_rekening_belanja: str
    nama_rekening_belanja: str
    rekap_rekening_belanja: Optional[str] = ""
    nilai_kapitalisasi_belanja: Optional[float] = 0.0


class MasterRekeningBelanjaBulkRequest(BaseModel):
    data: List[MasterRekeningBelanjaRequest]


# ===============================
# AUTO MIGRATION KOLOM (SQLite)
# ===============================
# Catatan bug (v1.2.4): GET /api/identitas-periode menjawab 500 dengan
# "no such column: identitas_periode.tempat_surat" pada database milik
# pengguna lama. Penyebabnya: tabel ``identitas_periode`` dibuat oleh
# ``Base.metadata.create_all``, yang HANYA membuat tabel yang belum ada dan
# tidak pernah menambah kolom baru pada tabel yang sudah eksis. Alembic juga
# tidak menolong karena satu-satunya revisi (b7b597ac8a84) hanya menyentuh
# tabel ``pengaturan`` — sehingga DB lama yang ber-revisi == head di-"upgrade"
# tanpa apa-apa, sementara model menuntut kolom tambahan (tempat_surat, label,
# is_active, dst).
#
# Solusi: perbandingan ringan model vs skema aktual (PRAGMA table_info) dan
# ALTER TABLE ADD COLUMN untuk kolom yang hilang. SQLite mengizinkan
# penambahan kolom dengan default konstan secara aman, jadi data lama tetap
# utuh. Fungsi ini dipanggil SETELAH create_all agar tabel baru pun ikut
# dilengkapi bila perlu.
def _table_columns_safe(conn, table_name: str) -> set:
    """Kembalikan HIMPUNAN NAMA kolom sebuah tabel SQLite.

    BUG ROOT CAUSE (HTTP 500 GET /api/identitas-periode): kode lama memakai
    ``{r[0] for r in PRAGMA table_info(...)}`` yang menghasilkan nomor posisi
    kolom (0, 1, 2, ...) — BUKAN nama kolom. Akibatnya setiap kolom model
    dianggap "belum ada" dan ALTER TABLE gagal dengan "duplicate column
    name"; karena seluruh DDL dibungkus satu transaksi, kegagalan itu ikut
    membatalkan penambahan kolom yang sebenarnya hilang (mis. tempat_surat),
    sehingga query tetap menabrak "no such column" dan endpoint menjawab 500.

    Nama kolom pada hasil PRAGMA table_info ada di indeks 1; fungsi ini tahan
    terhadap bentuk baris apa pun (Row / tuple / Mapping). Kegagalan membaca
    dikembalikan sebagai None agar pemanggil melewatkan tabel tsb. tanpa
    membatalkan transaksi.
    """
    from sqlalchemy import text

    def _extract(rows):
        names = set()
        for r in rows:
            try:
                n = r[1]
            except Exception:
                try:
                    n = r["name"]
                except Exception:
                    continue
            if n is not None:
                names.add(str(n))
        return names

    try:
        rows = conn.execute(
            text(f'PRAGMA table_info("{table_name}")')
        ).fetchall()
        return _extract(rows)
    except Exception as e:
        logger.warning(f"Gagal membaca PRAGMA table_info({table_name}): {e}")
        try:
            insp = sa_inspect(conn)
            return {c["name"] for c in insp.get_columns(table_name)}
        except Exception as e2:
            logger.warning(f"Gagal membaca kolom via inspector: {e2}")
            return None


def _sync_schema_columns() -> int:
    """Tambahkan kolom model yang belum ada di tabel SQLite. Return jumlah."""
    global _schema_sync_ok
    from sqlalchemy import create_engine as create_sync_engine, inspect as sa_inspect, text

    sync_url = str(engine.url).replace("sqlite+aiosqlite:///", "sqlite:///")
    if not sync_url.startswith("sqlite"):
        return 0  # hanya diperlukan untuk SQLite (skema aplikasi ini)

    added = 0
    failed = 0
    try:
        eng = create_sync_engine(sync_url)
    except Exception as e:
        logger.error(f"Gagal membuka engine sinkron untuk cek skema: {e}")
        return 0
    try:
        with eng.begin() as conn:
            inspector = sa_inspect(conn)
            existing_tables = set(inspector.get_table_names())
            for table in Base.metadata.sorted_tables:
                if table.name not in existing_tables:
                    continue  # akan dibuat oleh create_all
                actual_cols = _table_columns_safe(conn, table.name)
                if actual_cols is None:
                    failed += 1
                    continue
                for col in table.columns:
                    if col.name in actual_cols:
                        continue
                    coltype = col.type.compile(dialect=eng.dialect)
                    parts = [
                        f'ALTER TABLE "{table.name}" '
                        f'ADD COLUMN "{col.name}" {coltype}'
                    ]
                    if not col.nullable:
                        # Kolom NOT NULL pada SQLite WAJIB punya default non-null;
                        # tipe integer butuh 0, bukan '' (menambah '' ke kolom
                        # INTEGER adalah kesalahan transaksional yang membatalkan
                        # seluruh ALTER lain dalam transaksi yang sama).
                        is_int = "INT" in coltype.upper()
                        parts.append("NOT NULL DEFAULT 0" if is_int
                                     else "NOT NULL DEFAULT ''")
                    elif col.default is not None and getattr(
                        col.default, "is_scalar", False
                    ):
                        dv = col.default.arg
                        if isinstance(dv, bool):
                            parts.append(f"DEFAULT {1 if dv else 0}")
                        elif isinstance(dv, (int, float)):
                            parts.append(f"DEFAULT {dv}")
                        else:
                            escaped = str(dv).replace("'", "''")
                            parts.append(f"DEFAULT '{escaped}'")
                    ddl = " ".join(parts)
                    try:
                        conn.execute(text(ddl))
                        added += 1
                        actual_cols.add(col.name)
                        logger.info(f"Auto migration kolom: {ddl}")
                    except Exception as e:
                        # Jangan batalkan seluruh penambalan karena satu kolom;
                        # catat dan lanjutkan ke kolom/tabel berikutnya.
                        failed += 1
                        logger.warning(
                            f"ALTER TABLE dilewati ({table.name}.{col.name}): {e}"
                        )
                        # Transaksi mungkin ikut rusak — coba pulihkan titik
                        # simpan bila dialect mendukung (SQLite: rollback per
                        # statement sudah cukup karena DDL implicit-commit).
    except Exception as e:
        logger.exception("Gagal menyelaraskan kolom skema database: %s", e)
        failed += 1
    finally:
        try:
            eng.close()
        except Exception:
            pass
    _schema_sync_ok = (failed == 0)
    return added


# ---- Penambal otomatis "no such column" saat request berjalan ----
# Cache nama tabel yang sudah dipastikan cocok dengan model, agar cek ulang
# tidak dilakukan pada setiap request.
_schema_synced_tables: set = set()

# Penanda apakah penyelarasan kolom terakhir berjalan tanpa kegagalan.
# Dipakai oleh middleware penambal di bawah: bila masih False, setiap request
# baru akan mencoba menyelaraskan sekali lagi (harga ceknya murah — satu
# PRAGMA per tabel) sehingga backend yang startup-nya sempat balapan dengan
# request pertama tetap pulih dengan sendirinya.
_schema_sync_ok: bool = False


def _is_missing_column_error(exc: Exception) -> bool:
    """True bila exception (atau rantai penyebabnya) adalah OperationalError
    SQLite 'no such column' / 'has no column named'."""
    e = exc
    while e is not None:
        msg = str(e).lower()
        if "no such column" in msg or "has no column named" in msg:
            return True
        e = e.__cause__ if e.__cause__ is not e else None
    return False


def _ensure_schema_columns_for(tables) -> bool:
    """Panggil ulang penyelarasan skema untuk tabel tertentu dan buang cache-nya.

    Dipakai ketika sebuah query gagal dengan "no such column" di tengah
    request — biasanya karena skema DB pengguna lama belum bertambah kolom
    baru (bug v1.2.4 pada GET /api/identitas-periode). Sebagai langkah
    pertama, revisi Alembic yang tertunda dicoba ulang secara paksa (mis.
    DB ber-revisi b7b597ac8a84 yang belum pernah di-upgrade ke
    c2f1a9d3e5b7). Return True bila penambalan layak dicoba ulang, yaitu
    bila minimal satu kolom berhasil ditambahkan ATAU penyelarasan berjalan
    bersih tanpa kegagalan (kasus: kolom sebenarnya sudah ada tetapi sesi
    membaca skema usang, atau penambahan dilakukan revisi Alembic).
    """
    global _schema_synced_tables
    names = {t if isinstance(t, str) else getattr(t, "__tablename__", None)
             for t in tables}
    names.discard(None)
    _schema_synced_tables -= names
    # 1) Coba jalankan revisi Alembic yang tertunda (idempoten & aman).
    try:
        run_migrations(force=True)
    except Exception as e:
        logger.warning(f"Retry run_migrations gagal: {e}")
    # 2) Jaminan terakhir: tambahkan langsung kolom model yang hilang.
    added = _sync_schema_columns()
    # Setelah sinkron berhasil penuh, tandai semua tabel sebagai sudah cocok.
    if _schema_sync_ok:
        try:
            _schema_synced_tables |= {
                t.name for t in Base.metadata.sorted_tables
            }
        except Exception:
            pass
    if added:
        logger.info(
            f"Penambal skema otomatis: {added} kolom ditambahkan "
            f"(tabel terkait: {', '.join(sorted(names))})."
        )
    return bool(added) or _schema_sync_ok


def run_migrations(force: bool = False):
    """Jalankan upgrade Alembic sekali saat startup, atau ulangi saat dipaksa."""
    global _migrated

    # force=True dipakai oleh penambal otomatis "no such column" agar
    # revisi Alembic (mis. c2f1a9d3e5b7) benar-benar dicoba ulang walaupun
    # proses ini sudah pernah menjalankan migrasi saat startup.
    if _migrated and not force:
        logger.info("Migration sudah pernah dijalankan, skip.")
        return
    _migrated = True

    logger.info("Menjalankan auto migration...")

    try:
        # ===============================
        # 1. DETEKSI PATH (UNTUK EXE)
        # ===============================
        if getattr(sys, 'frozen', False):
            # Jika berjalan sebagai .exe (PyInstaller)
            base_path = Path(sys._MEIPASS)
        else:
            # Jika berjalan sebagai script .py biasa
            base_path = Path(__file__).parent

        alembic_ini = base_path / "alembic.ini"
        alembic_dir = base_path / "alembic"

        # Pastikan database diarahkan ke lokasi permanen (AppData), bukan temp folder
        db_path = BASE_DIR / "aplikasi_spj.db"
        db_url = f"sqlite:///{db_path}"

        if not alembic_ini.exists() or not alembic_dir.exists():
            logger.warning("File atau folder Alembic tidak ditemukan. Melewati migrasi.")
            return

        # ===============================
        # 2. KONFIGURASI ALEMBIC
        # ===============================
        cfg = Config(str(alembic_ini))
        cfg.set_main_option("script_location", str(alembic_dir))
        cfg.set_main_option("sqlalchemy.url", db_url)

        from alembic.runtime.migration import MigrationContext
        from sqlalchemy import create_engine
        from alembic.script import ScriptDirectory

        engine_sync = create_engine(db_url)
        script = ScriptDirectory.from_config(cfg)

        with engine_sync.connect() as conn:
            context = MigrationContext.configure(conn)
            current_rev = context.get_current_revision()

        logger.info(f"Current DB revision: {current_rev}")

        heads = script.get_heads()
        head = heads[0] if heads else None

        if not head:
            logger.warning("Tidak ada revision head ditemukan di folder versions.")
            return

        # ===============================
        # 3. STRATEGI UPGRADE (HARDENING)
        # ===============================
        if current_rev is None:
            # Kondisi: Database baru atau tabel alembic_version kosong
            logger.warning("DB belum memiliki revision. Mencoba menjalankan upgrade ke head...")
            try:
                # Upgrade akan mencoba membuat tabel atau menambah kolom yang kurang
                command.upgrade(cfg, "head")
                logger.info("Upgrade database awal berhasil.")
            except Exception as e:
                # Jika upgrade gagal (misal tabel sudah ada tapi manual), kita paksa stamp
                logger.error(f"Upgrade gagal: {e}. Melakukan stamp sebagai fallback.")
                command.stamp(cfg, "head")
        else:
            # Kondisi: Database sudah punya nomor versi
            try:
                # Validasi apakah revisi di DB dikenali oleh script yang dibawa EXE
                script.get_revision(current_rev)
                logger.info(f"Revisi {current_rev} valid. Memastikan database up-to-date...")
                command.upgrade(cfg, "head")
            except Exception as e:
                logger.warning(f"Revision mismatch atau error: {e}. Memaksa sinkronisasi...")
                # Jika revisi DB tidak dikenal (mungkin karena ganti file migrasi),
                # kita tandai yang sekarang sebagai yang terbaru lalu upgrade.
                command.stamp(cfg, "head")
                command.upgrade(cfg, "head")

        logger.info("Auto migration selesai dengan sukses.")

    except Exception:
        # Logging exception tanpa menghentikan startup aplikasi utama
        logger.exception("Terjadi kesalahan fatal pada proses migrasi")


def resolve_foto_path(foto_rel_path: str) -> Path | None:
    """Cari foto berurutan dari path absolut lalu lokasi relatif terhadap BASE_DIR."""
    if not foto_rel_path:
        return None

    try:
        p = Path(foto_rel_path)

        # absolute langsung
        if p.is_absolute() and p.exists():
            return p

        # dari BASE_DIR
        p2 = Path(BASE_DIR) / foto_rel_path
        if p2.exists():
            return p2

        # strip slash
        p3 = Path(BASE_DIR) / foto_rel_path.lstrip("/\\")
        if p3.exists():
            return p3

        logger.error(f"[FOTO] Tidak ditemukan: {foto_rel_path}")
        return None

    except Exception:
        logger.exception(f"[FOTO] Error resolve: {foto_rel_path}")
        return None

def resolve_logo(path_input: str) -> str:
    """
    Menerima:
    - URL: http://localhost:8000/uploads/logos/a.png
    - Relatif: uploads/logos/a.png
    - Nama file: a.png

    Mengembalikan:
    - Absolute filesystem path
    """

    if not path_input:
        return ""

    try:
        # Kalau berupa URL → ambil path-nya saja
        if path_input.startswith("http://") or path_input.startswith("https://"):
            parsed = urlparse(path_input)
            path_input = parsed.path  # /uploads/logos/a.png

        p = Path(path_input)

        # 1. Kalau sudah absolute dan ada
        if p.is_absolute() and p.exists():
            return str(p)

        # 2. Dari BASE_DIR
        p2 = Path(BASE_DIR) / path_input.lstrip("/")
        if p2.exists():
            return str(p2)

        # 3. Dari uploads/logos
        p3 = UPLOAD_LOGO_DIR / p.name
        if p3.exists():
            return str(p3)

        # 4. Fallback: nama file tersimpan di DB beda ekstensi dengan file di disk
        #    (mis. DB masih "logo_pemda.png" padahal file sekarang "logo_pemda.jpg")
        stem = p.name.rsplit(".", 1)[0]
        for cand in sorted(UPLOAD_LOGO_DIR.glob(f"{stem}.*")):
            if cand.suffix.lower() in (".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"):
                logger.warning(
                    "resolve_logo: '%s' tidak ada, memakai fallback '%s'",
                    path_input, cand.name,
                )
                return str(cand)

        # 5. Fallback kanonik: kolom DB kosong / nama lama tidak lagi ada di disk.
        #    Logo kop disimpan dengan nama baku logo_pemda.* / logo_sekolah.*,
        #    jadi pakai saja file baku itu selama wujud di disk. Ini menyelamatkan
        #    dokumen lama yang menyimpan URL/UUID absolut ke uploads/logos sehingga
        #    logos tetap muncul walau pengaturan sudah diganti/diubah.
        for prefix in (f"logo_{stem}", "logo_pemda", "logo_sekolah"):
            for cand in sorted(UPLOAD_LOGO_DIR.glob(f"{prefix}.*")):
                if cand.suffix.lower() in (".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"):
                    logger.warning(
                        "resolve_logo: '%s' tidak ditemukan, memakai logo baku '%s'",
                        path_input, cand.name,
                    )
                    return str(cand)

        logger.error(f"Logo tidak ditemukan: {path_input}")
        return ""

    except Exception as e:
        logger.exception(f"Error resolve_logo: {path_input} -> {e}")
        return ""


def extract_bulan_from_tanggal(tanggal: str) -> str:
    """Extract month from date string (supports DD/MM/YYYY or DD-MM-YYYY)"""
    if not tanggal:
        return "1"
    match = re.search(r'\d{1,2}[-/](\d{1,2})[-/]\d{2,4}', tanggal)
    if match:
        return match.group(1)
    
    return "1"


def extract_tahun_from_tanggal(tanggal: str) -> str:
    """Extract year from date string"""
    if not tanggal:
        return str(datetime.now().year)
    
    match = re.search(r'(\d{4})', tanggal)
    if match:
        return match.group(1)
    
    return str(datetime.now().year)


# ============================================================================
# IDENTITAS SATUAN PENDIDIKAN PER PERIODE
# Menu "Identitas Satuan Pendidikan" kini menyatu dengan "Logo dan Kop Surat":
# satu entri berisi kop (nama pemda/sekolah/alamat/tempat surat/logo) DAN
# pejabat (kepala, bendahara, pengurus barang), berlaku antara tanggal_awal
# s.d. tanggal_akhir. Beberapa entri dapat dibuat; dokumen (PDF) otomatis
# memakai entri yang periodanya mencakup tanggal dokumen.
# ============================================================================

def parse_tanggal_flex(tgl) -> Optional[datetime]:
    """Parse tanggal fleksibel (YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY) -> datetime."""
    if not tgl:
        return None
    s = str(tgl).strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(s[:10] if fmt == "%Y-%m-%d" else s, fmt)
        except ValueError:
            continue
    try:
        return parse_date(s, dayfirst=True)
    except Exception:
        return None


def _identitas_to_dict(p: Pengaturan, sumber: str = "pengaturan") -> dict:
    """Konversi baris Pengaturan lama menjadi bentuk identitas seragam."""
    return {
        "id": getattr(p, "id", None),
        "sumber": sumber,
        "label": "",
        "tanggal_awal": "",
        "tanggal_akhir": "",
        "is_active": True,
        "nama_pemda": p.nama_pemda or "",
        "nama_sekolah": p.nama_sekolah or "",
        "alamat_sekolah": p.alamat_sekolah or "",
        "tempat_surat": p.tempat_surat or "",
        "logo_pemda": p.logo_pemda or "",
        "logo_sekolah": p.logo_sekolah or "",
        "nama_kepala_sekolah": p.nama_kepala_sekolah or "",
        "nip_kepala_sekolah": p.nip_kepala_sekolah or "",
        "nama_bendahara": p.nama_bendahara or "",
        "nip_bendahara": p.nip_bendahara or "",
        "nama_pengurus_barang": p.nama_pengurus_barang or "",
        "nip_pengurus_barang": p.nip_pengurus_barang or "",
    }


def _periode_to_dict(ip: IdentitasPeriode) -> dict:
    d = {c: getattr(ip, c, "") for c in IDENTITAS_KOLOM}
    d["id"] = ip.id
    d["sumber"] = "periode"
    return d


async def _execute_with_schema_retry(db: AsyncSession, make_stmt):
    """Jalankan query buatan ``make_stmt()`` dengan penambalan otomatis.

    Bila gagal karena kolom model belum ada di tabel SQLite lama
    (OperationalError "no such column" — bug v1.2.4 pada GET
    /api/identitas-periode), jalankan ulang migrasi & penyelarasan kolom
    lalu coba query-nya sekali lagi sebelum error diteruskan ke pemanggil.

    PENTING (bug v1.2.4 lanjutan): parameter kedua adalah FUNGSI pembuat
    statement, bukan statement jadi. Setelah terjadi OperationalError,
    SQLAlchemy 2.x meletakkan AsyncSession dalam keadaan "expired"; memakai
    ulang objek statement yang sama pada sesi itu dapat memunculkan
    "Statement is already attached to a different session" sehingga retry
    justru gagal dan endpoint tetap menjawab 500. Karena itu statement selalu
    dibangun ulang lewat ``make_stmt()`` sebelum dieksekusi pada sesi bersih.
    """
    from sqlalchemy.exc import OperationalError

    try:
        return await db.execute(make_stmt())
    except OperationalError as e:
        if not _is_missing_column_error(e):
            raise
        logger.warning(
            "Query menabrak 'no such column'; mencoba menyelaraskan skema "
            "lalu mengulang query: %s", e
        )
        # Sesi async saat ini berada dalam keadaan gagal — tutup transaksi
        # yang rusak dan pakai sesi BARU yang bersih untuk eksekusi ulang.
        try:
            await db.rollback()
        except Exception:
            pass
        finally:
            try:
                await db.close()
            except Exception:
                pass
        if not _ensure_schema_columns_for([IdentitasPeriode]):
            raise
        async with AsyncSessionLocal() as fresh:
            return await fresh.execute(make_stmt())


async def _query_identitas_periode_list(db: AsyncSession):
    """Daftar seluruh entri IdentitasPeriode (terlama → terbaru) tahan-skema."""
    def _make_stmt():
        return select(IdentitasPeriode).order_by(
            IdentitasPeriode.tanggal_awal.asc(), IdentitasPeriode.id.asc()
        )

    result = await _execute_with_schema_retry(db, _make_stmt)
    return result.scalars().all()


async def get_identitas_base(db: AsyncSession) -> dict:
    """Identitas default (fallback): periode aktif terbaru, jika kosong pakai
    baris Pengaturan lama (kompatibilitas data existing)."""
    def _make_stmt():
        return (
            select(IdentitasPeriode)
            .where(IdentitasPeriode.is_active == True)  # noqa: E712
            .order_by(IdentitasPeriode.tanggal_awal.desc(), IdentitasPeriode.id.desc())
            .limit(1)
        )

    ip = (await _execute_with_schema_retry(db, _make_stmt)).scalar_one_or_none()
    if ip is not None:
        return _periode_to_dict(ip)
    p = (await db.execute(select(Pengaturan).limit(1))).scalar_one_or_none()
    if p is not None:
        return _identitas_to_dict(p)
    return _identitas_to_dict(Pengaturan())


async def resolve_identitas_for_tanggal(
    db: AsyncSession, tanggal_terbit: Optional[str]
) -> dict:
    """Pilih identitas yang periodanya mencakup ``tanggal_terbit``.

    Entri periode aktif yang tercocokan menang; bila tidak ada, dipakai
    fallback (get_identitas_base). Hasil selalu dict dengan kolom lengkap.
    """
    base = await get_identitas_base(db)
    tgl = parse_tanggal_flex(tanggal_terbit)
    if tgl is None:
        return base

    def _make_stmt():
        return (
            select(IdentitasPeriode)
            .where(IdentitasPeriode.is_active == True)  # noqa: E712
            .order_by(IdentitasPeriode.tanggal_awal.desc(), IdentitasPeriode.id.desc())
        )

    rows = (await _execute_with_schema_retry(db, _make_stmt)).scalars().all()
    for ip in rows:
        awal = parse_tanggal_flex(ip.tanggal_awal)
        akhir = parse_tanggal_flex(ip.tanggal_akhir)
        if awal and tgl < awal:
            continue
        if akhir and tgl > akhir:
            continue
        if not awal and not akhir:
            continue  # entri tanpa periode tidak ikut mencocokkan tanggal
        return _periode_to_dict(ip)
    return base


async def ensure_pengaturan_row(db: AsyncSession) -> Pengaturan:
    """Ambil (atau buat) baris Pengaturan legacy — dipakai sebagai cadangan
    sinkronisasi agar fitur lama tetap berfungsi."""
    p = (await db.execute(select(Pengaturan).limit(1))).scalar_one_or_none()
    if p is None:
        p = Pengaturan()
        db.add(p)
        await db.flush()
    return p


async def sync_pengaturan_from_identitas(db: AsyncSession, ident: dict):
    """Salin identitas terpilih ke baris Pengaturan legacy (kop + pejabat),
    sehingga kode/diagnostik lama yang membaca tabel pengaturan tidak rusak."""
    p = await ensure_pengaturan_row(db)
    _terapkan_identitas_ke_pengaturan(p, ident)


def _terapkan_identitas_ke_pengaturan(p: "Pengaturan", ident: dict):
    """Salin (in-memory) dict identitas seragam ke objek Pengaturan tanpa
    commit — dipakai renderer PDF agar kop/pejabat/logo mengikuti periode."""
    for f in (
        "nama_pemda", "nama_sekolah", "alamat_sekolah", "tempat_surat",
        "logo_pemda", "logo_sekolah",
        "nama_kepala_sekolah", "nip_kepala_sekolah",
        "nama_bendahara", "nip_bendahara",
        "nama_pengurus_barang", "nip_pengurus_barang",
    ):
        setattr(p, f, ident.get(f) or "")


def _terbilang_safe(jumlah) -> str:
    """Terbilang yang tidak pernah melempar — dipakai payload SPJ & renderer."""
    try:
        return f"{terbilang(_to_float(jumlah)).capitalize()} rupiah"
    except Exception as e:  # pragma: no cover - defensip
        logger.warning("terbilang gagal untuk %r -> %s", jumlah, e)
        return "................ rupiah"


def _rab_tanggal_surat(lokasi: str, thp: str, thn: str) -> str:
    """SATU formatter tanggal surat RAB (dipakai backend & dikirim ke frontend).

    Dulu menghasilkan '..., ... Juli 2026' (hari '...' terbawa dari template
    lama). Kini: '<Kota>, ... <Bulan> <Tahun>' dengan satu titik-titik sebagai
    placeholder tanggal penandatanganan. Bulan mengikuti label tahap
    (THP I -> Januari, THP II -> Juli); logika filter data TIDAK berubah.
    """
    bulan = "Januari"  # Default
    if thp:
        thp_str = str(thp).upper()
        if "THP II" in thp_str or "2" in thp_str or "DUA" in thp_str:
            bulan = "Juli"
        elif "THP I" in thp_str or "1" in thp_str or "SATU" in thp_str:
            bulan = "Januari"
    return f"{lokasi or 'Jember'}, ... {bulan} {thn or ''}".strip()


def _foto_bukti_list(kwitansi) -> list:
    """Daftar mentah foto bukti kwitansi (support string lama & object baru)."""
    raw = getattr(kwitansi, "foto_bukti", None)
    if isinstance(raw, list):
        return raw
    try:
        parsed = json.loads(raw or "[]")
        return parsed if isinstance(parsed, list) else []
    except Exception:
        return []


def _data_lampiran_dict(kwitansi) -> dict:
    """Parse data form lampiran dengan fallback aman untuk database lama."""
    raw = getattr(kwitansi, "data_lampiran", None)
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(raw or "{}")
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, ValueError):
        return {}


JENIS_BELANJA_VALID = {
    "honor_jasa", "makanan_minuman", "perjalanan_dinas",
    "sewa", "jasa_tukang", "fotokopi", "telepon_listrik_air", "umum",
    "bahan_bangunan",
}
JENIS_BELANJA_DENGAN_BAST = {"fotokopi", "umum", "bahan_bangunan"}
JENIS_BELANJA_DENGAN_RAB = {"jasa_tukang", "bahan_bangunan"}


def _jenis_foto_tersedia(kwitansi) -> list:
    jenis_foto = set()
    for item in _foto_bukti_list(kwitansi):
        if isinstance(item, str) and item:
            jenis_foto.add("barang")
        elif isinstance(item, dict) and item.get("path"):
            jenis = item.get("jenis", "barang")
            if isinstance(jenis, str) and jenis:
                jenis_foto.add(jenis)
    return sorted(jenis_foto)


def _lampiran_foto_payload(kwitansi) -> dict:
    """Kelompokkan foto bukti per jenis untuk frontend (data URI base64 atau path relatif /uploads)."""
    grouped: dict = {}
    for item in _foto_bukti_list(kwitansi):
        if isinstance(item, str):
            path, jenis = item, "barang"
        elif isinstance(item, dict):
            path = item.get("path") or ""
            jenis = item.get("jenis", "barang")
        else:
            continue
        if not path:
            continue
        p = resolve_foto_path(path)
        img_src = None
        if p and p.exists():
            try:
                mime = mimetypes.guess_type(str(p))[0] or "image/jpeg"
                with open(p, "rb") as f:
                    b64 = base64.b64encode(f.read()).decode("ascii")
                img_src = f"data:{mime};base64,{b64}"
            except Exception as e:
                logger.warning("Gagal encode foto bukti ke base64 (%s): %s", p, e)

        if not img_src:
            relative_path = Path(path).as_posix().lstrip("/\\")
            if relative_path.startswith("uploads/"):
                relative_path = relative_path[len("uploads/"):]
            img_src = f"/uploads/{relative_path}"

        grouped.setdefault(jenis, []).append({
            "path": img_src,
            "available": bool(p),
        })
    return grouped


def _parse_bast_tanggal(raw_date_str) -> datetime:
    """Parser tanggal BAST yang selama ini hanya ada di dalam
    generate_bast_pdf — diangkat ke level modul agar endpoint data SPJ bisa
    memakai pemformatan yang SAMA dengan renderer backend (satu sumber
    kebenaran)."""
    try:
        if not raw_date_str:
            return datetime.now()
        s = str(raw_date_str)
        if "/" in s:
            return datetime.strptime(s, "%d/%m/%Y")
        if "-" in s and s.find("-") == 4:
            return datetime.strptime(s, "%Y-%m-%d")
        if "-" in s:
            return datetime.strptime(s, "%d-%m-%Y")
    except Exception:
        pass
    return datetime.now()


# Lokasi database zona waktu sistem standar (Linux/macOS). Di Windows biasanya
# tidak ada — di situ tzdata (dependency) / hasil kemasan main.spec yang berperan.
TZDB_SYSTEM_DIRS = ("/usr/share/zoneinfo", "/usr/lib/zoneinfo", "/usr/lib64/zoneinfo")


def _zone_wib():
    """Zona Asia/Jakarta (WIB, UTC+7) dengan urutan pencarian eksplisit.

    Error produksi yang diperbaiki: pada Windows (dan executable PyInstaller)
    `ZoneInfo("Asia/Jakarta")` melempar KeyError 'No time zone found with key
    Asia/Jakarta' bila OS tidak menyediakan database zona waktu IANA dan paket
    `tzdata` tidak terpasang/terprovisioning.

    Urutan pencarian (semuanya adalah WIB ASLI — TIDAK ADA fallback diam-diam
    ke waktu lokal komputer atau zona lain):
      1. tzdata yang ter-provisioning lewat PEP 653 (`pip install tzdata`).
      2. Direktori sistem standar Linux/macOS (/usr/share/zoneinfo).
      3. Folder `_internal/tzdata/zoneinfo` milik executable PyInstaller
         (main.spec mengemas tzdata ke sana; TzPathFinder membaca dari sana).
    Bila ketiganya gagal, KeyError dibiarkan naik apa adanya supaya muncul di
    log/error response — bukan digantikan waktu yang salah.
    """
    from zoneinfo import ZoneInfo, reset_tzpath

    try:
        return ZoneInfo("Asia/Jakarta")
    except (KeyError, FileNotFoundError):
        pass
    # Cari database zona waktu di lokasi yang diketahui, lalu ulangi SEKALI.
    candidates = []
    for p in TZDB_SYSTEM_DIRS:
        if os.path.isdir(p) and os.path.exists(os.path.join(p, "Asia", "Jakarta")):
            candidates.append(p)
    if getattr(sys, "frozen", False):
        base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(sys.executable)))
        for rel in ("tzdata/zoneinfo", "zoneinfo"):
            p = os.path.join(base, rel)
            if os.path.isdir(p) and os.path.exists(os.path.join(p, "Asia", "Jakarta")):
                candidates.insert(0, p)
    if candidates:
        reset_tzpath(candidates + [str(x) for x in __import__("zoneinfo").TZPATH])
        try:
            return ZoneInfo("Asia/Jakarta")
        except (KeyError, FileNotFoundError):
            pass
    raise RuntimeError(
        "Database zona waktu 'Asia/Jakarta' tidak ditemukan. "
        "Instal dependency 'tzdata' (pip install -r requirements.txt) atau, "
        "untuk aplikasi terpaket, pastikan build memakai main.spec terbaru "
        "(yang mengemas tzdata ke _internal/tzdata)."
    )


def _waktu_terbit_iso() -> str:
    """Timestamp `generated_at` payload SPJ: waktu Asia/Jakarta nyata, format
    ISO-8601 dengan offset +07:00 (contoh: 2026-11-01T18:47:28+07:00)."""
    return datetime.now(_zone_wib()).isoformat(timespec="seconds")


async def kumpulkan_data_spj(db: AsyncSession, kwitansi_id: int) -> dict:
    """Satu-satunya sumber kebenaran data dokumen SPJ (schema_version 1).

    Dipakai oleh GET /api/kwitansi/{id}/spj-data (rendering frontend/pdfmake)
    dan tetap konsisten dengan aturan renderer lama:
      - identitas dipilih PERIODE-nya berdasarkan tanggal kwitansi
        (resolve_identitas_for_tanggal), bukan baris `pengaturan` mentah;
      - BAST: transaksi dengan no_bukti sama (urut id);
      - RAB: transaksi kegiatan + thp kwitansi, pengeluaran > 0, join
        master rekening belanja untuk kategori rekap;
      - status tiap bagian eksplisit (included/skip + alasan) supaya PDF
        parsial tidak diam-diam dianggap lengkap.
    """
    kw = (await db.execute(select(Kwitansi).where(Kwitansi.id == kwitansi_id))).scalar_one_or_none()
    if not kw:
        raise HTTPException(status_code=404, detail="Kwitansi tidak ditemukan")

    jenis_belanja = getattr(kw, "jenis_belanja", None) or "umum"
    perlu_bast = jenis_belanja in JENIS_BELANJA_DENGAN_BAST
    perlu_rab = jenis_belanja in JENIS_BELANJA_DENGAN_RAB

    ident = await resolve_identitas_for_tanggal(db, getattr(kw, "tanggal", None))

    logo_pemda_uri = _logo_datauri_from_db(
        ident.get("logo_pemda") or "", "logo_pemda", "")
    logo_sekolah_uri = _logo_datauri_from_db(
        ident.get("logo_sekolah") or "", "logo_sekolah", "")

    # WIB via _zone_wib(): tahan-Windows/tahan-frozen (lihat dokstring fungsi).
    generated_at = _waktu_terbit_iso()
    safe_no = re.sub(r"[^A-Za-z0-9._-]", "-", (kw.no_bukti or str(kw.id)))
    filename = f"SPJ-{safe_no}.pdf"

    # ---------- Bagian KWITANSI (wajib) ----------
    uraian_rab_text = " | ".join(
        [t.uraian for t in (await db.execute(
            select(Transaksi).where(Transaksi.no_bukti == kw.no_bukti)
        )).scalars().all() if t.uraian]
    ) or (kw.nama_kegiatan or "")
    def _kop_bersama():
        """SATU definisi kop (baris pemda/sekolah/alamat + logo data URI) yang
        dipakai HANYA oleh bagian BAST dan RAB — frontend menggambar kop dari
        objek ini pada kedua halaman tersebut.
        ATURAN PRODUK: halaman KWITANSI WAJIB TANPA KOP — karena itu objek ini
        TIDAK boleh dikirim pada kwitansi_payload, document.kop, maupun
        document.kop_wajib (lihat normalisasi anti-kop di bawah).
        Sumber identitas: resolve_identitas_for_tanggal() di atas; logo lewat
        load_logo_source() sehingga JANGAN ada path lokal (D:\\...) yang ikut
        terkirim ke renderer."""
        return {
            "baris1": (ident.get("nama_pemda") or "").upper(),
            "baris2": (ident.get("nama_sekolah") or "").upper(),
            "alamat": ident.get("alamat_sekolah") or "",
            "logo_pemda": logo_pemda_uri or "",
            "logo_sekolah": logo_sekolah_uri or "",
        }

    kwitansi_payload = {
        "id": kw.id,
        "nomor_kwitansi": kw.nomor_kwitansi or "-",
        "no_bukti": kw.no_bukti or "",
        "no_bast": kw.no_bast or "",
        "tanggal": kw.tanggal or "",
        "tanggal_indo": format_tanggal_indo(kw.tanggal or "")["full"],
        "jumlah": _to_float(kw.jumlah),
        "jumlah_rupiah": format_rupiah(_to_float(kw.jumlah)),
        "terbilang": _terbilang_safe(kw.jumlah),
        "uraian_pembayaran": kw.nama_kegiatan or "",
        "uraian_detail": uraian_rab_text,
        "nama_toko": kw.nama_toko or "",
        "npwp_toko": kw.npwp_toko or "",
        "alamat_toko": kw.alamat_toko or "",
        "no_telp_toko": kw.no_telp_toko or "",
        "no_nota": kw.no_nota or "",
        "thp": kw.thp or "",
        "tahun": kw.tahun or "",
        "kode_kegiatan": kw.kode_kegiatan or "",
        "nama_kegiatan": kw.nama_kegiatan or "",
        "kota_tempat_surat": ident.get("tempat_surat") or "Jember",
        # ATURAN PRODUK: KWITANSI TANPA KOP. Field "kop" sengaja TIDAK dikirim
        # pada bagian kwitansi (renderer frontend juga memfilter, lihat
        # stripKwitansiKop() di frontend/src/pdf/spjPdf.js).
    }

    # ---------- Bagian BAST (opsional: butuh no_bukti + transaksi) ----------
    bast_items: list = []
    bast_total_num = 0.0
    if perlu_bast and kw.no_bukti:
        trx_rows = (await db.execute(
            select(Transaksi).where(Transaksi.no_bukti == kw.no_bukti).order_by(Transaksi.id)
        )).scalars().all()
        for idx, t in enumerate(trx_rows, start=1):
            vol = _to_float(t.volume)
            hrg = _to_float(t.harga_satuan)
            sub = vol * hrg
            bast_total_num += sub
            bast_items.append({
                "no": idx,
                "uraian": t.uraian or "-",
                "volume": int(vol) if float(vol).is_integer() else vol,
                "satuan": t.satuan or "-",
                "harga_satuan": hrg,
                "harga_satuan_fmt": format_rupiah(hrg),
                "jumlah": sub,
                "jumlah_fmt": format_rupiah(sub),
            })
    if kw.no_bukti and bast_items:
        tgl_bast_obj = _parse_bast_tanggal(kw.tanggal_nota or kw.tanggal)
        tb = format_tanggal_indo(tgl_bast_obj.strftime("%Y-%m-%d"))
        bast_payload = {
            "nomor_surat": kw.no_bast or "-",
            "hari_ini": tb.get("hari", ""),
            "tgl_terbilang": tb.get("terbilang_tanggal", ""),
            "bulan_indo": tb.get("bulan", ""),
            "tahun_terbilang": tb.get("terbilang_tahun", ""),
            "tgl_full": tb.get("full", ""),
            "nama_penyedia": kw.nama_toko or "",
            "nama_penerima": ident.get("nama_pengurus_barang") or "",
            "nip_penerima": ident.get("nip_pengurus_barang") or "",
            "jabatan_penerima": "Pengurus Barang",
            "kota": ident.get("tempat_surat") or "Jember",
            "kop": _kop_bersama(),
            "items": bast_items,
            "total_volume": None,  # dihitung di bawah dari jumlah item
            "grand_total": bast_total_num,
            "grand_total_fmt": format_rupiah(bast_total_num),
        }
        total_vol = sum(_to_float(i["volume"]) for i in bast_items)
        bast_payload["total_volume"] = int(total_vol) if float(total_vol).is_integer() else total_vol
        bast_status = {"status": "included", "alasan": None}
    else:
        bast_payload = None
        bast_status = {
            "status": "skip",
            "alasan": (
                "Jenis belanja tidak memerlukan BAST" if not perlu_bast
                else "Kwitansi tidak memiliki no_bukti" if not kw.no_bukti
                else "Tidak ada transaksi untuk no_bukti ini"
            ),
        }

    # ---------- Bagian RAB (opsional: butuh kode_kegiatan + thp) ----------
    kegiatan_data = None
    if kw.kode_kegiatan:
        kegiatan_data = (await db.execute(
            select(MasterKegiatan).where(MasterKegiatan.kode_kegiatan == kw.kode_kegiatan)
        )).scalar_one_or_none()

    if perlu_rab and kegiatan_data and kw.thp:
        rab_raw = (await db.execute(
            select(Transaksi, MasterRekeningBelanja.rekap_rekening_belanja)
            .join(Kwitansi, Transaksi.no_bukti == Kwitansi.no_bukti)
            .join(MasterRekeningBelanja,
                  Transaksi.kode_rekening == MasterRekeningBelanja.kode_rekening_belanja,
                  isouter=True)
            .where(and_(
                Transaksi.kode_kegiatan == kw.kode_kegiatan,
                Kwitansi.thp == kw.thp,
                Transaksi.pengeluaran > 0,
            ))
            .order_by(Transaksi.tanggal, Transaksi.id)
        )).all()
        rab_rows = []
        rab_grand = 0.0
        no_row = 1
        for row in rab_raw:
            trx = row[0]
            jenis = row[1] or "-"
            uraian_l = (trx.uraian or "").lower()
            if "ppn" in uraian_l or "pph" in uraian_l:
                continue  # aturan lama: buang pajak, tanpa filter tahap
            vol = _to_float(trx.volume)
            hrg = _to_float(trx.harga_satuan)
            sub = vol * hrg
            rab_grand += sub
            rab_rows.append({
                "no": no_row,
                "uraian": trx.uraian or "-",
                "volume": int(vol) if float(vol).is_integer() else vol,
                "satuan": trx.satuan or "",
                "harga_satuan": hrg,
                "harga_satuan_fmt": format_rupiah(hrg),
                "jumlah": sub,
                "jumlah_fmt": format_rupiah(sub),
                "jenis_belanja": str(jenis),
                "keterangan": "",
            })
            no_row += 1
        if rab_rows:
            lokasi_rab = ident.get("tempat_surat") or "Jember"
            rab_payload = {
                "kegiatan": kegiatan_data.nama_kegiatan or "-",
                "thp_label": kw.thp or "",
                "tahun": kw.tahun or "",
                "rows": rab_rows,
                "grand_total": rab_grand,
                "grand_total_fmt": format_rupiah(rab_grand),
                "tanggal_surat": _rab_tanggal_surat(lokasi_rab, kw.thp, kw.tahun),
                "satuan_pendidikan": ident.get("nama_sekolah") or "",
                "kop": _kop_bersama(),
            }
            rab_status = {"status": "included", "alasan": None}
        else:
            rab_payload = None
            rab_status = {"status": "skip",
                          "alasan": "Tidak ada transaksi non-pajak untuk kegiatan/thap ini"}
    else:
        rab_payload = None
        rab_status = {"status": "skip",
                      "alasan": ("Jenis belanja tidak memerlukan RAB" if not perlu_rab
                                 else "Kode kegiatan kosong" if not kegiatan_data
                                 else "Label tahap (thp) kosong")}
    if perlu_rab and rab_payload is None:
        lokasi_rab = ident.get("tempat_surat") or "Jember"
        rab_payload = {
            "kegiatan": (
                kegiatan_data.nama_kegiatan if kegiatan_data else kw.nama_kegiatan
            ) or "-",
            "thp_label": kw.thp or "",
            "tahun": kw.tahun or "",
            "rows": [],
            "grand_total": 0.0,
            "grand_total_fmt": format_rupiah(0),
            "tanggal_surat": _rab_tanggal_surat(lokasi_rab, kw.thp, kw.tahun),
            "satuan_pendidikan": ident.get("nama_sekolah") or "",
            "kop": _kop_bersama(),
        }
        rab_status = {"status": "included", "alasan": None}

    # ---------- Normalisasi anti-kop kwitansi (WAJIB, dua lapis) ----------
    # Aturan produk: kop hanya untuk BAST & RAB. Pastikan tidak ada salinan
    # objek kop / instruksi "kop wajib" yang tertinggal di payload pada level
    # dokumen maupun bagian kwitansi — renderer frontend memakai data.kop ini
    # sebagai FALLBACK saat bagian bast/rab tidak membawa kop sendiri.
    if kwitansi_payload.pop("kop", None) is not None:
        logger.warning(
            "kwitansi_payload unexpectedly carried 'kop' — stripped per "
            "no-kop rule (kwitansi id=%s)", kw.id,
        )

    return {
        "schema_version": 1,
        "document": {
            "filename": filename,
            "generated_at": generated_at,
            # Keputusan produk: KOP hanya dipakai oleh bagian BAST dan RAB;
            # halaman KWITANSI WAJIB TANPA KOP (tidak ada field "kop" pada
            # document maupun kwitansi, dan kop_wajib=False).
            "order": ["kwitansi", "bast", "rab"],
            "paper": {"width_mm": 215, "height_mm": 330, "margin_mm": 15},
            "kop_wajib": False,
        },
        "kwitansi": dict(kwitansi_payload, id=kw.id),
        "jenis_belanja": jenis_belanja,
        "data_lampiran": _data_lampiran_dict(kw),
        "identitas": {
            "id": ident.get("id"),
            "sumber": ident.get("sumber", ""),
            "label": ident.get("label") or "",
            "tanggal_awal": ident.get("tanggal_awal") or "",
            "tanggal_akhir": ident.get("tanggal_akhir") or "",
            "nama_pemda": ident.get("nama_pemda") or "",
            "nama_sekolah": ident.get("nama_sekolah") or "",
            "alamat_sekolah": ident.get("alamat_sekolah") or "",
            "tempat_surat": ident.get("tempat_surat") or "Jember",
            "logo_pemda": logo_pemda_uri or "",
            "logo_sekolah": logo_sekolah_uri or "",
            "nama_kepala_sekolah": ident.get("nama_kepala_sekolah") or "",
            "nip_kepala_sekolah": ident.get("nip_kepala_sekolah") or "",
            "nama_bendahara": ident.get("nama_bendahara") or "",
            "nip_bendahara": ident.get("nip_bendahara") or "",
            "nama_pengurus_barang": ident.get("nama_pengurus_barang") or "",
            "nip_pengurus_barang": ident.get("nip_pengurus_barang") or "",
        },
        "transaksi_bast": bast_payload["items"] if bast_payload else [],
        "bast": bast_payload,
        "transaksi_rab": rab_payload["rows"] if rab_payload else [],
        "rab": rab_payload,
        "lampiran_foto": _lampiran_foto_payload(kw),
        "sections": {
            "kwitansi": {"status": "included", "alasan": None},
            "bast": bast_status,
            "rab": rab_status,
        },
    }


def _logo_datauri_from_db(value: str, col: str, base_url: str) -> Optional[str]:
    """Konversi nilai kolom logo (base64 / nama file / URL) menjadi data URI
    untuk preview web; fallback URL statis bila file pun tak ditemukan."""
    src = load_logo_source(value or "", col=col)
    if not src:
        return None
    s = str(src)
    if s.startswith("data:image/"):
        return s
    b64 = s.split(",", 1)[1] if s.startswith("data:") else s
    if _looks_like_base64(f"data:image/jpeg;base64,{b64}"):
        return f"data:image/jpeg;base64,{b64}"
    return f"{base_url}/uploads/logos/{Path(s).name}"


async def get_nama_kegiatan_from_kode(
    kode_kegiatan: str,
    db: AsyncSession
) -> str:
    if not kode_kegiatan:
        return ""

    stmt = select(MasterKegiatan.nama_kegiatan)\
        .where(MasterKegiatan.kode_kegiatan == kode_kegiatan)

    result = await db.execute(stmt)
    return result.scalar() or ""

# --- SETUP LOGGING ---
logger = logging.getLogger(__name__)

# --- UPDATE KONFIGURASI INI ---

# Naikkan toleransi Y agar teks yang sedikit tidak rata tetap dianggap satu baris
Y_TOLERANCE = 10  # Sebelumnya 5, naikkan jadi 10-12

COLUMNS = {
    "tanggal": (30, 85),
    "kode_kegiatan": (85, 140),
    "kode_rekening": (130, 198), 
    "no_bukti": (195, 270), 
    "uraian": (240, 610),      # Tetap mulai dari 240 untuk menangkap "Saldo Bank"
    "penerimaan": (610, 720),
    "pengeluaran": (720, 790),
    "saldo": (790, 950),
}

# --- HELPER FUNCTIONS ---

def parse_amount(val: str) -> float:
    """Normalisasi format rupiah Indonesia menjadi angka untuk kolom transaksi."""
    if not val:
        return 0.0
    # Hilangkan Rp, spasi, dan titik ribuan
    clean_val = str(val).replace("Rp", "").replace(" ", "").replace(".", "")
    # Ganti koma desimal menjadi titik
    clean_val = clean_val.replace(",", ".")
    
    # Ambil hanya karakter yang valid untuk angka (termasuk tanda negatif)
    clean_val = re.sub(r"[^0-9.\-]", "", clean_val)
    
    try:
        return float(clean_val) if clean_val else 0.0
    except:
        return 0.0

def detect_column(x: float):
    """Menentukan kolom berdasarkan koordinat X"""
    for name, (xmin, xmax) in COLUMNS.items():
        if xmin <= x < xmax:
            return name
    return None

def extract_lines_with_position(page):
    """Mengambil teks dan koordinat dari PDF"""
    blocks = page.get_text("dict")["blocks"]
    lines = []
    for block in blocks:
        if block["type"] != 0: continue
        for line in block["lines"]:
            for span in line["spans"]:
                text = span["text"].strip()
                if not text: continue
                x0, y0, x1, y1 = span["bbox"]
                # Debug output moved to logger; keep available in dev or when LOG_TO_TERMINAL=true
                if IS_DEV:
                    logger.debug(f"DEBUG: Teks '{text:30}' | X: {x0:7.2f} | Y: {y0:7.2f}") #jangan dihapus!
                lines.append({
                    "text": text,
                    "x": x0,
                    "y": y0,
                    "height": y1 - y0
                })
    return lines

def group_lines_into_rows(lines, y_tolerance=Y_TOLERANCE):
    """Menggabungkan teks yang berada di baris (Y) yang sama"""
    lines.sort(key=lambda item: item["y"])
    rows = []
    current_row = {}
    last_y = -100

    for item in lines:
        col_name = detect_column(item["x"])
        if not col_name: continue

        if abs(item["y"] - last_y) > y_tolerance:
            if current_row: rows.append(current_row)
            current_row = defaultdict(str)
            last_y = item["y"]
        
        if current_row[col_name]:
            current_row[col_name] += " " + item["text"]
        else:
            current_row[col_name] = item["text"]
            
    if current_row: rows.append(current_row)
    return rows

def print_debug_table(transaksi_list):
    """Tampilan tabel terminal yang disesuaikan dengan kolom BKU di gambar.
    Fungsi ini hanya menulis output ketika `IS_DEV` True untuk membantu debugging
    ekstraksi PDF (menggunakan `logger.debug`)."""
    header = (f"{'TANGGAL':<12} | {'KODE KEG':<12} | {'KODE REK':<15} | {'NO BUKTI':<12} | "
              f"{'URAIAN (Potongan)':<40} | {'MASUK':>12} | {'KELUAR':>12} | {'SALDO':>12}")

    if not transaksi_list:
        if IS_DEV:
            logger.debug("DEBUG: Tidak ada transaksi untuk ditampilkan")
        return

    if IS_DEV:
        logger.debug(header)
        logger.debug('-' * len(header))
        for t in transaksi_list:
            # Ambil atribut dengan safe-get agar fungsi tidak fail jika struktur berubah
            tanggal = getattr(t, 'tanggal', '') or ''
            kode_keg = getattr(t, 'kode_kegiatan', '') or '-'
            kode_rek = getattr(t, 'kode_rekening', '') or '-'
            no_bukti = getattr(t, 'no_bukti', '') or '-'
            uraian = getattr(t, 'uraian', '') or ''
            u_short = (uraian[:37] + '...') if len(uraian) > 40 else uraian
            masuk = getattr(t, 'penerimaan', 0) or 0
            keluar = getattr(t, 'pengeluaran', 0) or 0
            saldo = getattr(t, 'saldo', 0) or 0

            line = (f"{tanggal:<12} | {kode_keg:<12} | {kode_rek:<15} | {no_bukti:<12} | "
                    f"{u_short:<40} | {masuk:12.2f} | {keluar:12.2f} | {saldo:12.2f}")

            logger.debug(line)
    # Jika bukan mode development, jangan output table
    return

# --- MAIN EXTRACTION FUNCTION ---
async def extract_bku_data(pdf_content: bytes, db):
    """Petakan kata PDF ke kolom BKU, wariskan tanggal, dan cari nama kegiatan."""
    pdf_document = fitz.open(stream=pdf_content, filetype="pdf")
    transaksi_list = []

    BLACKLIST = [
        "BUKU KAS UMUM", "BUKUKASUMUM", "NPSN", "NAMA SEKOLAH", "NAMASEKOLAH", 
        "MENYETUJUI", "KEPALA SEKOLAH", "KEPALASEKOLAH", "BENDAHARA", 
        "DITUTUP DENGAN", "DITUTUPDENGAN", "HALAMAN", "NIP.", 
        "TOTAL PENERIMAAN", "TOTAL PENGELUARAN"
    ]
    
    # Keyword khusus untuk footer baris jumlah/total di bawah tabel
    FOOTER_KEYWORDS = ["JUMLAH", "TOTAL", "SISA"]

    bpu_pattern = re.compile(r'(\d*BPU\s*\d+)', re.IGNORECASE)
    # Update regex tanggal agar support spasi (jika OCR kurang pas) e.g 03 09 2025
    date_pattern = re.compile(r'\d{2}[-/\s]\d{2}[-/\s]\d{4}')

    try:
        last_valid_date = ""

        for page in pdf_document:
            words = page.get_text("words")
            words_by_y = {}
            
            # --- LOGIKA GROUPING BARIS ---
            for word in words:
                word_y = round(word[1])
                matched_existing_row = False
                for row_y in list(words_by_y.keys()):
                    if abs(word_y - row_y) <= 8: # Tolerance y
                        words_by_y[row_y].append(word)
                        matched_existing_row = True
                        break
                if not matched_existing_row:
                    words_by_y[word_y] = [word]

            for row_y in sorted(words_by_y.keys()):
                words_in_row = sorted(words_by_y[row_y], key=lambda word: word[0])
                full_line_text = " ".join(
                    word[4] for word in words_in_row
                ).strip()
                
                if not full_line_text:
                    continue

                normalized_line_text = full_line_text.replace(" ", "").upper()

                date_at_line_start = date_pattern.search(full_line_text[:12])
                
                if not date_at_line_start:
                    if any(k in normalized_line_text for k in BLACKLIST):
                        continue
                    # Cek footer khusus (Jumlah/Total)
                    if any(
                        full_line_text.upper().startswith(k)
                        for k in FOOTER_KEYWORDS
                    ):
                        continue

                # Filter baris nomor kolom (hanya angka 1 s.d 8)
                if re.fullmatch(r'[\d\s\.]+', full_line_text):
                    continue

                tanggal, nomor_bukti = "", ""
                uraian_parts, kode_kegiatan_parts, kode_rekening_parts = [], [], []
                penerimaan, pengeluaran, saldo = 0, 0, 0

                # --- PARSING KOLOM (KOORDINAT DISESUAIKAN) ---
                for word in words_in_row:
                    x0, text = word[0], word[4].strip()
                    if not text:
                        continue

                    # Cek tanggal duluan sebelum cek koordinat
                    if not tanggal and date_pattern.search(text):
                        tanggal = text
                        continue
                    if 80 <= x0 < 132:
                        kode_kegiatan_parts.append(text)  # Kode Kegiatan
                    elif 132 <= x0 < 195:
                        kode_rekening_parts.append(text)  # Kode Rekening
                    elif 195 <= x0 < 240:                        # Bukti / Awal Uraian
                        if bpu_pattern.search(text):
                            nomor_bukti = text
                        else:
                            uraian_parts.append(text)
                    elif 240 <= x0 < 600:
                        uraian_parts.append(text)  # Uraian
                    elif 600 <= x0 < 675:                        # Penerimaan
                        amount = parse_amount(text)
                        if amount:
                            penerimaan = amount
                    elif 675 <= x0 < 755:                        # Pengeluaran
                        amount = parse_amount(text)
                        if amount:
                            pengeluaran = amount
                    elif x0 >= 755:                              # Saldo
                        amount = parse_amount(text)
                        if amount:
                            saldo = amount

                uraian_final = " ".join(uraian_parts).strip()
                
                # --- LOGIKA VALIDASI BARIS ---
                is_financial_row = (penerimaan > 0 or pengeluaran > 0)
                # Baris dianggap konten jika punya Tanggal ATAU Bukti ATAU Kode Rekening
                has_content = (
                    tanggal != "" or nomor_bukti != "" or len(kode_rekening_parts) > 0
                )
                
                # Header kolom (seperti "URAIAN", "NO BUKTI") biasanya tidak punya uang & tidak punya kode rekening valid
                if not is_financial_row and not has_content:
                    # Cek tambahan: jika uraian sangat pendek/kosong, skip
                    if len(uraian_final) < 3: 
                        continue
                    # Jika hanya teks header kolom, skip
                    if "URAIAN" in uraian_final.upper() or "BUKTI" in uraian_final.upper():
                        continue

                # Pewarisan Tanggal
                if tanggal:
                    last_valid_date = tanggal
                elif last_valid_date and (
                    is_financial_row or nomor_bukti or len(uraian_final) > 3
                ):
                    # Wariskan tanggal jika ini terlihat seperti lanjutan baris transaksi
                    tanggal = last_valid_date
                
                if not tanggal:
                    continue

                # --- CLEANING KODE ---
                raw_kode_rekening = "".join(kode_rekening_parts).replace(" ", "")
                match_rekening = re.search(r'(\d+(?:\.\d+)+)', raw_kode_rekening)
                clean_rekening = (
                    match_rekening.group(1) if match_rekening else raw_kode_rekening
                )

                raw_kode_kegiatan = "".join(kode_kegiatan_parts).replace(" ", "")
                match_kegiatan = re.search(
                    r'(\d{2}\.\d{2}\.\d{2}\.?)', raw_kode_kegiatan
                )
                clean_kegiatan = (
                    match_kegiatan.group(1) if match_kegiatan else raw_kode_kegiatan
                )

                nama_kegiatan = ""
                if clean_kegiatan:
                    kode_kegiatan_lookup = clean_kegiatan.rstrip('.')
                    nama_kegiatan = await get_nama_kegiatan_from_kode(
                        kode_kegiatan_lookup, db
                    )

                transaksi_list.append(
                    TransaksiItem(
                        tanggal=tanggal or "",
                        kode_kegiatan=clean_kegiatan or "",
                        kode_rekening=clean_rekening or "",
                        no_bukti=nomor_bukti or "",
                        uraian=uraian_final,
                        nama_kegiatan=nama_kegiatan,
                        penerimaan=penerimaan,
                        pengeluaran=pengeluaran,
                        saldo=saldo,
                    )
                )

        if IS_DEV:
            print_debug_table(transaksi_list)

        return BKUData(transaksi=transaksi_list)

    finally:
        pdf_document.close()

@api_router.post("/extract-bku")
async def extract_bku(
    files: List[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
):
    """Validasi PDF, gabungkan hasil ekstraksi, lalu kembalikan datanya."""
    all_transaksi = []

    for uploaded_file in files:
        try:
            if not uploaded_file.filename.lower().endswith(".pdf"):
                raise HTTPException(
                    status_code=400,
                    detail=f"File bukan PDF: {uploaded_file.filename}"
                )

            pdf_bytes = await uploaded_file.read()

            if not pdf_bytes:
                raise ValueError("File PDF kosong")


            parsed_bku = await extract_bku_data(pdf_bytes, db)

            if not parsed_bku or not hasattr(parsed_bku, "transaksi"):
                raise ValueError("Hasil extract BKU tidak valid")

            all_transaksi.extend(parsed_bku.transaksi)

        except HTTPException:
            raise  # biarkan FastAPI tangani

        except Exception as e:
            logger.exception(
                f"❌ Gagal memproses file {uploaded_file.filename}"
            )
            raise HTTPException(
                status_code=500,
                detail=f"Gagal memproses file {uploaded_file.filename}: {str(e)}"
            )

    # logger.info(f"TOTAL transaksi gabungan: {len(all_transaksi)}")

    return {
        "status": "success",
        "data": {
            "transaksi": all_transaksi
        }
    }


# -----------------------------
# BHP/BHM extraction and apply
# -----------------------------
class BHPItem(BaseModel):
    tanggal: Optional[str] = ""
    kode_kegiatan: Optional[str] = ""
    kode_rekening: Optional[str] = ""
    no_bukti: Optional[str] = ""
    id_barang: Optional[str] = ""
    uraian: Optional[str] = ""
    jumlah_barang: Optional[float] = 0
    harga_satuan: Optional[float] = 0
    realisasi: Optional[float] = 0


def normalize_no_bukti_backend(val: str) -> str:
    if not val: return ''
    return re.sub(r'\W', '', val).strip().lower()


def normalize_date_backend(val: str) -> str:
    # Attempt to parse many formats and return dd-mm-yyyy
    if not val: return ''
    try:
        d = parse_date(val, dayfirst=True)
        return d.strftime('%d-%m-%Y')
    except Exception:
        # fallback: return original if looks like dd-mm-yyyy
        if re.match(r'\d{2}[-/]\d{2}[-/]\d{4}', val):
            return val.replace('/', '-')
        return ''

async def extract_bhp_data(pdf_content: bytes, filename: Optional[str] = None):
    """Extract simple BHP/BHM table rows from PDF pages. Returns list of dicts.
    Adds detailed logging for debugging: prints per-file, per-page token x,y,text and a final summary."""
    doc = fitz.open(stream=pdf_content, filetype='pdf')
    results = []

    try:
 
        for page_num, page in enumerate(doc, start=1):
            words = page.get_text('words')
            lines = {}
            for w in words:
                y = round(w[1])
                found = False
                for existing in list(lines.keys()):
                    if abs(existing - y) <= 8:
                        lines[existing].append(w)
                        found = True
                        break
                if not found:
                    lines[y] = [w]

            for y in sorted(lines.keys()):
                row_words = sorted(lines[y], key=lambda x: x[0])
                # build token objects with x,y,text and cleaned text for robust matching
                token_objs = []
                for w in row_words:
                    text = w[4].strip()
                    if not text:
                        continue
                    token_objs.append({
                        'x': round(w[0]),
                        'y': round(w[1]),
                        'text': text,
                        'clean': text.rstrip('.,')
                    })
                if not token_objs:
                    continue
                # prepare lists
                tokens = [t['text'] for t in token_objs]
                clean_tokens = [t['clean'] for t in token_objs]

                # Try to find date token using cleaned tokens
                date_token = None
                date_idx = None
                for i, tok in enumerate(clean_tokens):
                    if re.match(r'\d{2}[-/]\d{2}[-/]\d{4}', tok) or re.match(r'\d{1,2}[-/]\d{1,2}[-/]\d{2,4}', tok):
                        date_token = tokens[i]  # original form
                        date_idx = i
                        break

                # require date + at least 5 tokens to consider as table row
                if date_token is None or len(clean_tokens) - (date_idx + 1) < 4:
                    continue

                # pointer after date
                ptr = date_idx + 1

                # prepare fields and location maps
                kode_kegiatan = ''
                kode_rekening = ''
                no_bukti = ''
                id_barang = ''
                jumlah_barang = 0
                harga_satuan = 0
                realisasi = 0
                uraian = ''
                field_locs: Dict[str, List[dict]] = {}

                # find kode_kegiatan: first dotted token after date
                for i in range(ptr, len(clean_tokens)):
                    tok = clean_tokens[i]
                    if re.match(r'^\d+(?:\.\d+)+$', tok):
                        raw_kode = tokens[i].strip().rstrip('.')
                        # ensure trailing dot so it matches entries in master_kegiatan like '03.03.19.'
                        kode_kegiatan = raw_kode + '.' if raw_kode else ''
                        field_locs['kode_kegiatan'] = [{'x': token_objs[i]['x'], 'y': token_objs[i]['y'], 'text': token_objs[i]['text']}]
                        ptr = i+1
                        break

                # find kode_rekening: next dotted token
                for i in range(ptr, len(clean_tokens)):
                    tok = clean_tokens[i]
                    if re.match(r'^\d+(?:\.\d+)+$', tok):
                        kode_rekening = tokens[i].rstrip('.')
                        field_locs['kode_rekening'] = [{'x': token_objs[i]['x'], 'y': token_objs[i]['y'], 'text': token_objs[i]['text']}]
                        ptr = i+1
                        break

                # next possible no_bukti (should be non-dotted / alphanumeric like BPU01)
                if ptr < len(clean_tokens):
                    no_bukti = tokens[ptr]
                    field_locs['no_bukti'] = [{'x': token_objs[ptr]['x'], 'y': token_objs[ptr]['y'], 'text': token_objs[ptr]['text']}]
                    ptr += 1

                # next possible id_barang
                if ptr < len(clean_tokens) and re.match(r'^\d+(?:\.\d+)+$', clean_tokens[ptr]):
                    id_barang = tokens[ptr].rstrip('.')
                    field_locs['id_barang'] = [{'x': token_objs[ptr]['x'], 'y': token_objs[ptr]['y'], 'text': token_objs[ptr]['text']}]
                    ptr += 1

                # capture numeric tokens at end (scan backward to find up to 3 numbers)
                num_indices = []
                for i in range(len(clean_tokens)-1, ptr-1, -1):
                    if re.search(r'\d', clean_tokens[i]):
                        num_indices.append(i)
                        if len(num_indices) >= 3:
                            break
                num_indices = list(reversed(num_indices))
                # assign numeric values if present
                if len(num_indices) >= 1:
                    try:
                        # map last three numbers to jumlah, harga, realisasi where possible
                        if len(num_indices) >= 3:
                            j_idx, h_idx, r_idx = num_indices[0], num_indices[1], num_indices[2]
                            jumlah_text = token_objs[j_idx]['text']
                            harga_text = token_objs[h_idx]['text']
                            real_text = token_objs[r_idx]['text']
                            jumlah_barang = float(re.sub(r'[^0-9\-,.]','', jumlah_text).replace('.', '').replace(',', '.'))
                            harga_satuan = float(re.sub(r'[^0-9\-,.]','', harga_text).replace('.', '').replace(',', '.'))
                            realisasi = float(re.sub(r'[^0-9\-,.]','', real_text).replace('.', '').replace(',', '.'))
                            field_locs['jumlah'] = [{'x': token_objs[j_idx]['x'], 'y': token_objs[j_idx]['y'], 'text': jumlah_text}]
                            field_locs['harga'] = [{'x': token_objs[h_idx]['x'], 'y': token_objs[h_idx]['y'], 'text': harga_text}]
                            field_locs['realisasi'] = [{'x': token_objs[r_idx]['x'], 'y': token_objs[r_idx]['y'], 'text': real_text}]
                        elif len(num_indices) == 2:
                            h_idx, r_idx = num_indices[0], num_indices[1]
                            harga_text = token_objs[h_idx]['text']
                            real_text = token_objs[r_idx]['text']
                            harga_satuan = float(re.sub(r'[^0-9\-,.]','', harga_text).replace('.', '').replace(',', '.'))
                            realisasi = float(re.sub(r'[^0-9\-,.]','', real_text).replace('.', '').replace(',', '.'))
                            field_locs['harga'] = [{'x': token_objs[h_idx]['x'], 'y': token_objs[h_idx]['y'], 'text': harga_text}]
                            field_locs['realisasi'] = [{'x': token_objs[r_idx]['x'], 'y': token_objs[r_idx]['y'], 'text': real_text}]
                    except Exception:
                        pass
                uraian_parts = []
                for i in range(ptr, len(token_objs)):
                    if i in num_indices:
                        break
                    text = token_objs[i]['text']
                    # include tokens that have alphabetic chars
                    if re.search(r'[A-Za-z]', text):
                        uraian_parts.append(text)
                uraian = ' '.join(uraian_parts).strip()
                if uraian_parts:
                    field_locs['uraian'] = [{'x': token_objs[i]['x'], 'y': token_objs[i]['y'], 'text': token_objs[i]['text']} for i in range(ptr, ptr+len(uraian_parts))]
                results.append({
                    'tanggal': date_token,
                    'kode_kegiatan': kode_kegiatan,
                    'kode_rekening': kode_rekening,
                    'no_bukti': no_bukti,
                    'id_barang': id_barang,
                    'uraian': uraian,
                    'jumlah_barang': jumlah_barang,
                    'harga_satuan': harga_satuan,
                    'realisasi': realisasi,
                    'page': page_num,
                    'y': y,
                    'locations': field_locs,
                })
    finally:
        doc.close()

    return results

@api_router.post('/extract-bhp')
async def extract_bhp(
    files: List[UploadFile] = File(...),
    jenis: str = Form('BHP')
):
    """Extract BHP/BHM files and return list of parsed rows."""
    if len(files) > 24:
        raise HTTPException(status_code=400, detail='Maksimal 24 file diperbolehkan')

    all_rows = []
    for idx, f in enumerate(files, start=1):
        if not f.filename.lower().endswith('.pdf'):
            raise HTTPException(status_code=400, detail=f'File bukan PDF: {f.filename}')
        pdf = await f.read()
        rows = await extract_bhp_data(pdf, filename=f.filename)
        # annotate rows with filename for combined summary
        for r in rows:
            r['filename'] = f.filename
        # logger.info(f"Extract endpoint: file {f.filename} parsed {len(rows)} rows")
        all_rows.extend(rows)
    return {'status': 'success', 'data': all_rows}


@api_router.post('/apply-bhp')
async def apply_bhp(
    items: List[BHPItem],
    preview: bool = Query(False, description="If true, do not modify DB; return planned deletions/insertions"),
    db: AsyncSession = Depends(get_db)
):
    """Apply BHP/BHM records: for each no_bukti group, detect existing transaksi with same normalized no_bukti.
    If `preview=True` the endpoint returns planned deletions and insert counts without changing the DB.
    If `preview=False` (default) existing matching rows are deleted and replaced with extracted rows.
    """
    stmt = select(Transaksi) 
    res = await db.execute(stmt)
    transaksi_rows = res.scalars().all()

    # Group extracted items by normalized no_bukti
    groups = {}
    for b in items:
        nb = normalize_no_bukti_backend(b.no_bukti or '')
        if not nb:
            continue
        groups.setdefault(nb, []).append(b)
    group_rows = []
    planned_changes = {}
    for nb, rows in groups.items():
        # Filtering in Python (Memory) is slower than SQL filtering
        matches = [t for t in transaksi_rows if normalize_no_bukti_backend(t.no_bukti) == nb]
        
        # group_rows.append([nb, len(rows), len(matches)]) # DI-COMMENT (Bagian logging)
        
        # prepare planned delete details for preview
        planned_changes[nb] = {
            'extracted_count': len(rows),
            'existing_matches': [
                {
                    'id': t.id,
                    'tanggal': t.tanggal,
                    'no_bukti': t.no_bukti,
                    'uraian': t.uraian,
                    'volume': t.volume,
                    'harga_satuan': t.harga_satuan,
                    'pengeluaran': t.pengeluaran
                }
                for t in matches
            ]
        }
    if preview:
        total_planned_deletes = sum(len(v['existing_matches']) for v in planned_changes.values())
        total_planned_inserts = sum(v['extracted_count'] for v in planned_changes.values())
        return {
            'status': 'preview',
            'groups': planned_changes,
            'planned_deletes': total_planned_deletes,
            'planned_inserts': total_planned_inserts
        }

    # Otherwise perform delete+insert and report details
    modified_insert = 0
    modified_delete = 0
    deleted_ids: List[int] = []
    deleted_rows_details: List[dict] = []
    inserted_rows: List[dict] = []

    try:
        for nb, rows in groups.items():
            # find existing transaksi matching this no_bukti
            matches = [t for t in transaksi_rows if normalize_no_bukti_backend(t.no_bukti) == nb]

            # delete existing matches and record their details
            for t in matches:
                deleted_ids.append(t.id if getattr(t, 'id', None) is not None else None)
                deleted_rows_details.append({
                    'id': t.id,
                    'tanggal': t.tanggal,
                    'no_bukti': t.no_bukti,
                    'uraian': t.uraian,
                    'volume': t.volume,
                    'harga_satuan': t.harga_satuan,
                    'pengeluaran': t.pengeluaran
                })
                await db.delete(t)
                modified_delete += 1

            # insert new transaksi rows based on BHP items for this no_bukti
            for b in rows:
                tanggal = normalize_date_backend(b.tanggal or '') or ''
                kode_kegiatan = b.kode_kegiatan or ''
                kode_rekening = b.kode_rekening or ''
                no_bukti = b.no_bukti or ''
                uraian = b.uraian or ''

                vol = float(b.jumlah_barang or 0) if b.jumlah_barang and b.jumlah_barang > 0 else 1.0
                harga = 0.0
                if b.harga_satuan and b.harga_satuan > 0:
                    harga = float(b.harga_satuan)
                elif b.realisasi and vol > 0:
                    harga = float(b.realisasi) / vol

                pengeluaran = float(b.realisasi) if b.realisasi and b.realisasi > 0 else (vol * harga)

                new_t = Transaksi(
                    tanggal=tanggal,
                    kode_kegiatan=kode_kegiatan,
                    kode_rekening=kode_rekening,
                    no_bukti=no_bukti,
                    uraian=uraian,
                    volume=vol,
                    satuan='',
                    harga_satuan=harga,
                    penerimaan=0,
                    pengeluaran=pengeluaran,
                    saldo=0
                )
                db.add(new_t)
                await db.flush() 
                
                inserted_rows.append({
                    'id': getattr(new_t, 'id', None),
                    'tanggal': new_t.tanggal,
                    'no_bukti': new_t.no_bukti,
                    'uraian': new_t.uraian,
                    'volume': new_t.volume,
                    'harga_satuan': new_t.harga_satuan,
                    'pengeluaran': new_t.pengeluaran,
                })
                modified_insert += 1

        await db.commit()            
    except Exception as e:
        await db.rollback()
        logger.error(f"apply_bhp failed: {str(e)}")
        raise HTTPException(status_code=500, detail=f'Gagal apply BHP: {str(e)}')

    return {
        'status': 'success',
        'deleted': modified_delete,
        'inserted': modified_insert,
        'deleted_ids': deleted_ids,
        'deleted_rows': deleted_rows_details,
        'inserted_rows': inserted_rows
    }

@api_router.post("/save-transaksi")
async def save_transaksi(
    data: BKUData,
    db: AsyncSession = Depends(get_db),
    force: bool = Query(False, description="Set true to actually perform the delete+insert. Without it the endpoint returns a preview.")
):
    """
    Save transaksi data: Mengosongkan tabel transaksi and re-insert payload.
    By default (force=False) returns a preview with counts of rows that would be deleted/inserted.
    Set force=true to actually commit the changes.
    """
    try:
        # Fetch current transaksi for preview computation
        stmt = select(Transaksi)
        res = await db.execute(stmt)
        current_rows = res.scalars().all()
        total_current = len(current_rows)

        # Build sets of normalized no_bukti values from current DB and payload
        existing_no_bukti = set()
        for t in current_rows:
            if t.no_bukti:
                existing_no_bukti.add(normalize_no_bukti_backend(t.no_bukti))

        payload_no_bukti = set()
        for t in data.transaksi:
            if getattr(t, 'no_bukti', None):
                payload_no_bukti.add(normalize_no_bukti_backend(t.no_bukti))

        # no_bukti values that would be removed (present in DB but NOT in payload)
        to_remove_no_bukti = set(x for x in existing_no_bukti if x and x not in payload_no_bukti)

        # count rows that would be removed (by matching normalized no_bukti)
        remove_rows_count = sum(1 for t in current_rows if t.no_bukti and normalize_no_bukti_backend(t.no_bukti) in to_remove_no_bukti)

        # specifically count BPU-like rows among those (BHP/BHM typical prefix)
        remove_bpu_count = sum(1 for t in current_rows if t.no_bukti and normalize_no_bukti_backend(t.no_bukti).startswith('bpu') and normalize_no_bukti_backend(t.no_bukti) in to_remove_no_bukti)

        # If not forced, return preview information instead of committing
        if not force:
            logger.info(f"save_transaksi preview: total_current={total_current}, would_delete_rows={remove_rows_count}, would_delete_bpu={remove_bpu_count}, would_insert={len(data.transaksi)}")
            return {
                "status": "preview",
                "total_current": total_current,
                "would_delete_rows": remove_rows_count,
                "would_delete_bpu_rows": remove_bpu_count,
                "would_delete_no_bukti": list(to_remove_no_bukti)[:200],
                "would_insert": len(data.transaksi)
            }

        await db.execute(delete(Transaksi))

        # 2. INSERT payload
        saved_count = 0
        for t in data.transaksi:
            # Ambil nama kegiatan dari master jika tidak ada di payload
            nama_kegiatan = t.nama_kegiatan
            if not nama_kegiatan and t.kode_kegiatan:
                nama_kegiatan = await get_nama_kegiatan_from_kode(t.kode_kegiatan, db)
            
            new_item = Transaksi(
                tanggal=t.tanggal,
                kode_kegiatan=t.kode_kegiatan or "",
                kode_rekening=t.kode_rekening or "",
                no_bukti=t.no_bukti,
                uraian=t.uraian,
                # preserve volume/satuan/harga_satuan if provided by payload
                volume=float(t.volume or 0),
                satuan=t.satuan or '',
                harga_satuan=float(t.harga_satuan or 0.0),
                penerimaan=t.penerimaan,
                pengeluaran=t.pengeluaran,
                saldo=t.saldo
            )
            db.add(new_item)
            saved_count += 1
        
        # Commit once
        await db.commit()
        logger.info(f"Regenerate Berhasil: {saved_count} transaksi baru disimpan.")
        return {
            "status": "success", 
            "message": "Data lama telah dihapus dan diganti dengan data baru",
            "saved_count": saved_count
        }

    except Exception as e:
        await db.rollback()
        logger.error(f"Error saat regenerate transaksi: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Gagal memproses data: {str(e)}")

@api_router.post("/transaksi/import-arkas")
async def import_arkas_transactions(
    data: ArkasImportRequest,
    db: AsyncSession = Depends(get_db),
):
    """Synchronize ARKAS BPU rows by receipt number."""
    valid_modes = {"replace_all", "keep", "update"}
    if data.mode not in valid_modes:
        raise HTTPException(
            status_code=400,
            detail="Mode sinkron tidak valid. Pilih replace_all, keep, atau update.",
        )

    transactions = data.transaksi
    if not transactions:
        raise HTTPException(
            status_code=400,
            detail="Tidak ada transaksi ARKAS untuk disinkronkan.",
        )
    if any(
        not normalize_no_bukti_backend(item.no_bukti).startswith("bpu")
        for item in transactions
    ):
        raise HTTPException(
            status_code=400,
            detail="Sinkron ARKAS hanya menerima transaksi dengan no bukti BPU.",
        )

    try:
        current_result = await db.execute(select(Transaksi))
        current_rows = current_result.scalars().all()
        incoming_receipts = {
            normalize_no_bukti_backend(item.no_bukti) for item in transactions
        }
        deleted_count = 0
        skipped_count = 0

        if data.mode == "replace_all":
            deleted_count = len(current_rows)
            if deleted_count:
                await db.execute(delete(Transaksi))
        elif data.mode == "keep":
            existing_receipts = {
                normalize_no_bukti_backend(item.no_bukti)
                for item in current_rows
                if item.no_bukti
            }
            kept_receipts = incoming_receipts & existing_receipts
            transactions = [
                item
                for item in transactions
                if normalize_no_bukti_backend(item.no_bukti) not in kept_receipts
            ]
            skipped_count = len(data.transaksi) - len(transactions)
        else:
            rows_to_update = [
                item
                for item in current_rows
                if normalize_no_bukti_backend(item.no_bukti) in incoming_receipts
            ]
            if rows_to_update:
                await db.execute(
                    delete(Transaksi).where(
                        Transaksi.id.in_([item.id for item in rows_to_update])
                    )
                )
                deleted_count = len(rows_to_update)

        for item in transactions:
            db.add(
                Transaksi(
                    tanggal=normalize_date_backend(item.tanggal) or item.tanggal,
                    kode_kegiatan=item.kode_kegiatan or "",
                    kode_rekening=item.kode_rekening or "",
                    no_bukti=item.no_bukti,
                    uraian=item.uraian or "",
                    volume=float(item.volume or 0),
                    satuan=item.satuan or "",
                    harga_satuan=float(item.harga_satuan or 0),
                    nama_toko=item.nama_toko or "",
                    alamat_toko=item.alamat_toko or "",
                    no_telp_toko=item.no_telp_toko or "",
                    npwp_toko=item.npwp_toko or "",
                    no_nota=item.no_nota or "",
                    tanggal_nota=(
                        normalize_date_backend(item.tanggal_nota)
                        or item.tanggal_nota
                        or ""
                    ),
                    penerimaan=float(item.penerimaan or 0),
                    pengeluaran=float(item.pengeluaran or 0),
                    saldo=float(item.saldo or 0),
                )
            )

        source_groups = defaultdict(list)
        for item in data.transaksi:
            receipt_key = normalize_no_bukti_backend(item.no_bukti)
            source_groups[receipt_key].append(item)

        kwitansi_result = await db.execute(select(Kwitansi))
        existing_kwitansi = kwitansi_result.scalars().all()
        kwitansi_by_receipt = defaultdict(list)
        for kwitansi in existing_kwitansi:
            receipt_key = normalize_no_bukti_backend(kwitansi.no_bukti)
            if receipt_key in source_groups:
                kwitansi_by_receipt[receipt_key].append(kwitansi)

        synced_kwitansi_count = 0
        created_kwitansi_count = 0
        identity_by_receipt = {}
        for receipt_key, items in source_groups.items():
            source = items[0]
            identity_fields = {
                "nama_toko": next((item.nama_toko for item in items if item.nama_toko), ""),
                "alamat_toko": next((item.alamat_toko for item in items if item.alamat_toko), ""),
                "no_telp_toko": next((item.no_telp_toko for item in items if item.no_telp_toko), ""),
                "npwp_toko": next((item.npwp_toko for item in items if item.npwp_toko), ""),
                "no_nota": next((item.no_nota for item in items if item.no_nota), ""),
                "tanggal_nota": next(
                    (
                        normalize_date_backend(item.tanggal_nota)
                        or item.tanggal_nota
                        for item in items
                        if item.tanggal_nota
                    ),
                    "",
                ),
            }
            identity_by_receipt[receipt_key] = identity_fields
            for kwitansi in kwitansi_by_receipt[receipt_key]:
                for field, value in identity_fields.items():
                    if value and value.strip():
                        setattr(kwitansi, field, value.strip())
                synced_kwitansi_count += 1

        for receipt_key, items in source_groups.items():
            source = items[0]
            code = next(
                (item.kode_kegiatan.strip() for item in items if item.kode_kegiatan),
                "",
            )
            nama_kegiatan = next(
                (item.nama_kegiatan.strip() for item in items if item.nama_kegiatan),
                "",
            )
            receipt_kwitansi = kwitansi_by_receipt[receipt_key]
            kwitansi = receipt_kwitansi[0] if receipt_kwitansi else None
            if kwitansi is None:
                identity_fields = identity_by_receipt[receipt_key]
                tanggal = normalize_date_backend(source.tanggal) or source.tanggal or ""
                parsed_date = None
                if tanggal:
                    try:
                        parsed_date = parse_date(tanggal, dayfirst=True)
                    except (TypeError, ValueError, OverflowError):
                        parsed_date = None
                thp = ""
                tahun = ""
                nomor_kwitansi = source.no_bukti
                if parsed_date:
                    thp = "THP I" if parsed_date.month <= 6 else "THP II"
                    tahun = str(parsed_date.year)
                    nomor_kwitansi = (
                        f"{source.no_bukti}/{code or '-'} /{thp}/{tahun}"
                    )

                existing_numbers = {
                    row.nomor_kwitansi for row in existing_kwitansi
                }
                base_nomor_kwitansi = nomor_kwitansi
                suffix = 1
                while nomor_kwitansi in existing_numbers:
                    nomor_kwitansi = (
                        f"{base_nomor_kwitansi}/{code or 'ARKAS'}-{suffix}"
                    )
                    suffix += 1
                kwitansi = Kwitansi(
                    nomor_kwitansi=nomor_kwitansi,
                    no_bukti=source.no_bukti,
                    kode_kegiatan=code,
                    nama_kegiatan=nama_kegiatan or "",
                    tanggal=tanggal,
                    thp=thp,
                    tahun=tahun,
                    jumlah=sum(float(item.pengeluaran or 0) for item in items),
                    tanggal_nota=identity_fields["tanggal_nota"],
                    nama_toko=identity_fields["nama_toko"],
                    alamat_toko=identity_fields["alamat_toko"],
                    no_telp_toko=identity_fields["no_telp_toko"],
                    npwp_toko=identity_fields["npwp_toko"],
                    no_nota=identity_fields["no_nota"],
                )
                db.add(kwitansi)
                receipt_kwitansi.append(kwitansi)
                existing_kwitansi.append(kwitansi)
                created_kwitansi_count += 1
            else:
                if code:
                    kwitansi.kode_kegiatan = code
                if nama_kegiatan:
                    kwitansi.nama_kegiatan = nama_kegiatan

        saved_count = len(transactions)
        if (
            saved_count
            or deleted_count
            or synced_kwitansi_count
            or created_kwitansi_count
        ):
            await db.commit()
        logger.info(
            "Sinkron ARKAS mode %s selesai: %s transaksi disimpan, %s transaksi dihapus, %s baris dilewati.",
            data.mode,
            saved_count,
            deleted_count,
            skipped_count,
        )
        return {
            "status": "success",
            "mode": data.mode,
            "saved_count": saved_count,
            "deleted_count": deleted_count,
            "skipped_count": skipped_count,
            "synced_kwitansi_count": synced_kwitansi_count,
            "created_kwitansi_count": created_kwitansi_count,
        }
    except Exception as e:
        await db.rollback()
        logger.exception("Gagal mengimpor transaksi ARKAS.")
        raise HTTPException(
            status_code=500,
            detail=f"Gagal mengimpor transaksi ARKAS: {str(e)}",
        )

def terbilang(n: float) -> str:
    satuan = ["", "satu", "dua", "tiga", "empat", "lima", "enam", "tujuh", "delapan", "sembilan", "sepuluh", "sebelas"]
    n = int(n)
    if n < 0:
        return "minus " + terbilang(-n)
    if n == 0:
        return "" 
    if n < 12:
        return satuan[n]
    if n < 20:
        return terbilang(n - 10) + " belas"
    if n < 100:
        hasil = terbilang(n // 10) + " puluh"
        sisa = terbilang(n % 10)
        return f"{hasil} {sisa}".strip()
    if n < 200:
        return ("seratus " + terbilang(n - 100)).strip()
    if n < 1000:
        hasil = terbilang(n // 100) + " ratus"
        sisa = terbilang(n % 100)
        return f"{hasil} {sisa}".strip()
    if n < 2000:
        return ("seribu " + terbilang(n - 1000)).strip()
    if n < 1000000:
        hasil = terbilang(n // 1000) + " ribu"
        sisa = terbilang(n % 1000)
        return f"{hasil} {sisa}".strip()
    if n < 1000000000:
        hasil = terbilang(n // 1000000) + " juta"
        sisa = terbilang(n % 1000000)
        return f"{hasil} {sisa}".strip()
    return "angka terlalu besar"

def get_thp_from_bulan(bulan: str) -> str:
    """Determine THP based on month (1-6 = THP I, 7-12 = THP II)"""
    try:
        bulan_num = int(bulan)
        if 1 <= bulan_num <= 6:
            return "THP I"
        else:
            return "THP II"
    except:
        return "THP I"

def generate_nomor_kwitansi(no_bukti: str, kode_kegiatan: str, bulan: str, tahun: str) -> str:
    """Generate kwitansi number with format: no_bukti/kode_kegiatan/THP/tahun"""
    thp = get_thp_from_bulan(bulan)
    return f"{no_bukti}/{kode_kegiatan}/{thp}/{tahun}"

def draw_hatching_pattern(c, x, y, width, height, density=3):
    """
    Membuat efek arsir (hatching) silang untuk background.
    """
    c.saveState()
    path = c.beginPath()
    path.rect(x, y, width, height)
    c.clipPath(path, stroke=0)
    
    c.setStrokeColor(colors.grey)
    c.setLineWidth(0.3)
    for i in range(-int(height), int(width), density):
        c.line(x + i, y, x + i + height, y + height)
    for i in range(0, int(width + height), density):
        c.line(x + i, y + height, x + i + height, y)
        
    c.restoreState()

def draw_wrapped_text_with_lines(c, text, x_label, x_colon, x_text, x_end, y, font_name, font_size, label_text=""):
    """
    Fungsi helper untuk menulis label, titik dua, dan teks isian yang bisa wrap (turun baris).
    Otomatis menggambar garis bawah di setiap baris isian.
    """
    # Teks isian boleh None/kosong — normalisasi agar tidak crash saat render
    text = _safe_text(text)

    # 1. Gambar Label dan Titik Dua (hanya di baris pertama)
    c.setFont(font_name, font_size)
    if label_text:
        c.drawString(x_label, y, label_text)
        c.drawString(x_colon, y, ":")

    # 2. Hitung lebar area teks yang tersedia
    available_width = x_end - x_text
    
    # 3. Pecah teks menjadi beberapa baris jika panjang
    lines = simpleSplit(text, font_name, font_size, available_width)
    
    # Jika teks kosong, setidaknya buat satu garis kosong
    if not lines:
        lines = [""]

    line_height = font_size + 4  # Jarak antar baris
    
    for i, line in enumerate(lines):
        # Tulis teks
        c.drawString(x_text, y, line)
        
        # Gambar garis bawah (Underline) full sampai ujung kanan
        c.setLineWidth(0.5) # Garis tipis untuk isian
        c.line(x_text, y - 2, x_end, y - 2)
        
        # Kurangi Y untuk baris berikutnya
        y -= line_height
        
    return y # Kembalikan posisi Y terakhir agar elemen berikutnya menyesuaikan

def _safe_text(value):
    """Konversi nilai apa pun ke string aman untuk digambar di PDF."""
    if value is None:
        return ""
    s = str(value).strip()
    return s


def _to_float(value, default=0.0):
    """Konversi nilai (float/int/string '1.234,56' dll.) ke float dengan aman."""
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    if not s:
        return default
    # Normalkan format angka Indonesia ("1.500.000" -> 1500000, "1.500,50" -> 1500.50)
    s = s.replace("Rp", "").replace("rp", "").strip()
    if "," in s and "." in s:
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    else:
        s = s.replace(".", "").replace(",", ".") if s.count(",") == 1 and "." not in s else s.replace(",", "")
    try:
        return float(s)
    except ValueError:
        return default


def flatten_image_to_jpeg(source, quality: int = 95):
    """Muat gambar dari PATH file ATAU bytes mentah/base64 dengan Pillow lalu
    'flattening' transparansi ke latar putih dan simpan sebagai JPEG solid di
    io.BytesIO() — format yang paling kompatibel untuk ReportLab maupun
    FPDF/fpdf2.

    Sumber yang diterima (`source`):
    - str/Path berisi path file di disk;
    - bytes mentah isi gambar;
    - string base64 telanjang ("iVBORw0...") maupun data URI
      ("data:image/png;base64,...").
    Ini adalah inti perbaikan metode baru: logo disimpan di DB sebagai BASE64
    dan kop PDF dirender langsung dari base64 itu — tanpa rantai path/nama
    file/ekstensi di uploads yang selama ini menjadi sumber bug "logo hilang".

    Aturan:
    1. Image.open() -> validasi dimensi.
    2. Deteksi alpha channel: RGBA, LA, P palet-transparan, atau 1-bit mask.
    3. Bila ber-alpha: tempel (paste) dengan masking alpha ke latar RGB putih.
       (Ini memperbaiki bug PNG transparan gagal render / tampil kotak hitam.)
    4. Bila tidak ber-alpha: convert langsung ke RGB.
    5. Simpan ke BytesIO format JPEG quality=95.
    6. Buffer diberi nama palsu "logo.jpg" agar fpdf2 bisa mendeteksi
       ekstensi/format saat deteksi MIME (fallback bila parameter format
       tidak didukung versi fpdf yang terpasang).
    Mengembalikan tuple (buffer_bytesio, (lebar_px, tinggi_px)).
    """
    if isinstance(source, (bytes, bytearray)):
        raw = bytes(source)
    elif isinstance(source, Path):
        raw = source.read_bytes()
    else:
        s = str(source or "").strip()
        if not s:
            raise ValueError("Sumber logo kosong")
        if s.startswith("data:image/"):
            # data URI "data:image/png;base64,xxxx" (metode baru: DB berisi base64)
            b64 = s.split(",", 1)[1]
            raw = base64.b64decode(b64)
        elif _looks_like_base64(s):
            raise ValueError(
                f"Sumber logo mirip base64 tapi bukan data URI valid: {s[:60]}..."
            )
        else:
            # nilai berupa path / URL file di disk. Base64 telanjang ("iVBORw0...",
            # tanpa prefix data:) TIDAK mungkin menjadi nama file yang valid —
            # ia selalu lewat percobaan decode+validasi PIL lebih dulu sebelum
            # dianggap path, sehingga tidak pernah menabrak batas panjang filename.
            looks_b64ish = bool(re.fullmatch(r"[A-Za-z0-9+/=\s]{120,}", s))
            pth_obj = None
            if not looks_b64ish:
                pth = urlparse(s).path if s.startswith(("http://", "https://")) else s
                try:
                    pth_obj = Path(pth)
                except Exception:
                    pth_obj = None
                if pth_obj is not None and not pth_obj.exists():
                    alt = resolve_logo(s)
                    pth_obj = Path(alt) if alt else None
            if pth_obj is not None and pth_obj.exists():
                raw = pth_obj.read_bytes()
            else:
                # percobaan: base64 telanjang tanpa prefix data:
                try:
                    cand = base64.b64decode(s + "=" * (-len(s) % 4), validate=False)
                except Exception:
                    cand = b""
                if len(cand) > 512:
                    raw = cand
                else:
                    raise ValueError(f"Sumber logo tidak dikenali (bukan path/base64): {s[:60]}...")

    with Image.open(io.BytesIO(raw)) as _im:
        im = _im
        has_alpha = (
            im.mode in ("RGBA", "LA")
            or (im.mode == "P" and "transparency" in im.info)
            or (im.mode == "1" and "transparency" in im.info)
        )
        if has_alpha:
            rgba = im.convert("RGBA")
            bg = Image.new("RGB", rgba.size, (255, 255, 255))
            bg.paste(rgba, mask=rgba.split()[-1])  # masking alpha
            flat = bg
        else:
            flat = im.convert("RGB")
        size = flat.size
        out = io.BytesIO()
        flat.save(out, format="JPEG", quality=quality)
    out.seek(0)
    out.name = "logo.jpg"  # nama file palsu utk deteksi ekstensi FPDF
    return out, size


# Nama lama tetap tersedia (compat) — sekarang hanya delegasi ke helper umum.
def flatten_logo_to_jpeg(path, quality: int = 95):
    return flatten_image_to_jpeg(path, quality=quality)


def _looks_like_base64(s: str) -> bool:
    """True bila string adalah DATA URI gambar yang valid ("data:image/...;base64,...").

    Catatan desain: deteksi TIDAK lagi memakai regex heuristik panjang-karakter
    pada base64 telanjang. Regex longgar dulu salah mengenali spasi dalam path
    Windows (mis. "D:\\SERVER WEBSITE\\...\\logo.png") sebagai base64, sehingga
    nilai terlewat dari disk dan logo tidak muncul di kop. Kini hanya data URI
    eksplisit yang dianggap base64; base64 telanjang tetap didukung oleh
    flatten_image_to_jpeg melalui decode+validasi PIL.
    """
    s = (s or "").strip()
    if not s.startswith("data:image/"):
        return False
    _, _, payload = s.partition(",")
    return len(payload) >= 100 and bool(re.fullmatch(r"[A-Za-z0-9+/=\s]+", payload))


# Kolom DB tempat base64 logo disimpan ( utk migrasi otomatis warisan file ).
_LOGO_COL_BY_STEM = {
    "pemda": "logo_pemda",
    "logo_pemda": "logo_pemda",
    "sekolah": "logo_sekolah",
    "satdik": "logo_sekolah",
    "logo_sekolah": "logo_sekolah",
}


def _file_to_datauri(path) -> Optional[str]:
    """Baca file gambar -> normalisasi (resize, JPEG kompak) -> kembalikan string
    data URI base64. None bila gagal/tidak valid."""
    try:
        raw = Path(path).read_bytes()
        if not raw:
            return None
        data_out, _ext = normalize_logo_file(raw)
        mime = "image/png" if _ext == ".png" else "image/jpeg"
        return f"data:{mime};base64," + base64.b64encode(data_out).decode("ascii")
    except Exception as e:
        logger.warning("_file_to_datauri: gagal konversi %s -> %s", str(path)[:80], e)
        return None


def _raw_to_storage_b64(raw: bytes) -> str:
    """Bytes gambar mentah -> data URI base64 SIAP SIMPAN ke DB untuk kop PDF.

    PENTING: transparansi SELALU di-flatten ke latar putih dan disimpan sebagai
    JPEG RGB — bukan PNG RGBA. Alasannya: kolom DB kini menjadi satu-satunya
    sumber logo yang dirender langsung oleh FPDF/ReportLab; PNG RGBA/LA/P-transparan
    yang dikirim mentah ke library PDF adalah penyebab klasik "logo tidak muncul
    / kotak hitam". Preview web juga tetap tampil karena JPEG solid valid.
    """
    with Image.open(io.BytesIO(raw)) as im:
        im.load()
        has_alpha = (
            im.mode in ("RGBA", "LA")
            or (im.mode == "P" and "transparency" in im.info)
            or (im.mode == "1" and "transparency" in im.info)
        )
        w, h = im.size
        if max(w, h) > LOGO_MAX_DIMENSION_PX:
            ratio = LOGO_MAX_DIMENSION_PX / float(max(w, h))
            im = im.resize((max(1, int(w * ratio)), max(1, int(h * ratio))), Image.LANCZOS)
        if im.mode == "CMYK":
            im = im.convert("RGB")
        if has_alpha:
            rgba = im.convert("RGBA")
            bg = Image.new("RGB", rgba.size, (255, 255, 255))
            bg.paste(rgba, mask=rgba.split()[-1])  # masking alpha -> latar putih
            flat = bg
        else:
            flat = im.convert("RGB")
        quality = 92
        buf = io.BytesIO()
        for _ in range(5):
            buf = io.BytesIO()
            flat.save(buf, format="JPEG", quality=quality, optimize=True)
            if buf.tell() <= LOGO_MAX_FILE_SIZE or quality <= 55:
                break
            quality -= 12
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


async def _persist_logo_b64(col: str, value: str):
    """Simpan data URI base64 ke kolom `col` tabel pengaturan (row id=1).
    Best-effort: pakai koneksi engine baru agar aman dipanggil dari dalam
    request/session yang sedang berjalan maupun dari konteks sinkron."""
    from sqlalchemy.ext.asyncio import async_sessionmaker
    from sqlalchemy import text as sql_text
    Session = async_sessionmaker(engine, expire_on_commit=False)
    async with Session() as session:
        await session.execute(
            sql_text(f"UPDATE pengaturan SET {col} = :v WHERE id = 1"), {"v": value}
        )
        await session.execute(
            sql_text(f"UPDATE pengaturan SET {col} = :v WHERE id = (SELECT MIN(id) FROM pengaturan)")
        )
        await session.commit()


def _schedule_migrate_logo_b64(col: str, value: str):
    """Jadwalkan migrasi kolom logo ke base64 tanpa memblokir render.
    - Bila loop asyncio aktif (khas FastAPI): buat task.
    - Bila tidak (jalur sinkron/test): jalankan asyncio.run sendiri."""
    import asyncio
    try:
        loop = asyncio.get_running_loop()
        t = loop.create_task(_persist_logo_b64(col, value))

        def _log_fail(task):
            exc = task.exception()
            if exc:
                logger.warning("Migrasi base64 logo '%s' gagal: %s", col, exc)

        t.add_done_callback(_log_fail)
    except RuntimeError:
        try:
            asyncio.run(_persist_logo_b64(col, value))
            logger.info("Migrasi base64 logo '%s' selesai (jalur sinkron)", col)
        except Exception as e:
            logger.warning("Migrasi base64 logo '%s' gagal: %s", col, e)


def load_logo_source(nama_db: str, *, col: str = "") -> str:
    """SATU sumber kebenaran logo kop untuk SEMUA renderer (FPDF, ReportLab,
    preview web get-pemda). Hasil selalu berupa string yang siap diberikan ke
    flatten_image_to_jpeg():

    - METODE BARU: kolom `logo_pemda`/`logo_sekolah` berisi BASE64
      (data URI "data:image/jpeg;base64,..." atau base64 telanjang)
      -> dikembalikan apa adanya; dirender langsung dari memori TANPA disk.
    - WARISAN (nama file / URL / path): file dibaca dari disk lalu
      DIKONVERSI KE BASE64 + dimigrasikan otomatis ke kolom DB (sekali jalan),
      sehingga dokumen berikutnya tidak lagi bergantung pada rantai
      path/nama file/ekstensi yang menjadi akar bug "logo hilang".
    - BILA KOSONG ATAU FILE WARISAN TIDAK ADA: fallback ke file baku
      logo_pemda.* / logo_sekolah.* di uploads/logos, dikonversi ke base64
      (dan ikut dimigrasikan) — ini menyelamatkan data lama yang kolomnya
      tereset kosong padahal filenya masih ada di disk.
    """
    s = (nama_db or "").strip()

    def _col_from_name(name: str) -> str:
        low = (name or "").lower()
        for key, c in _LOGO_COL_BY_STEM.items():
            if key in low:
                return c
        return ""

    target_col = col or _col_from_name(s) or _col_from_name(
        "pemda" if "pemda" in (col or s).lower() else "sekolah"
    )

    # 1) Base64 / data URI (metode baru) — tidak menyentuh disk sama sekali.
    if s.startswith("data:image/") or _looks_like_base64(s):
        return s
    if s and _looks_like_base64(s.split(",", 1)[-1]) and "," in s and s.split(",", 1)[0].startswith("data:"):
        return s

    # 2) Warisan: nama file / URL / path -> baca dari disk, konversi ke base64.
    migrated_value = None
    p = resolve_logo(s) if s else ""
    if p:
        try:
            raw = Path(p).read_bytes()
            if raw:
                # Konversi ke base64 SIAP-PDF (flatten alpha -> JPEG RGB solid),
                # lalu kolom DB dimigrasikan otomatis sehingga render berikutnya
                # murni dari memori tanpa menyentuh disk.
                migrated_value = _raw_to_storage_b64(raw)
        except Exception as e:
            logger.warning("load_logo_source: gagal baca %s -> %s", p, e)

    # 3) Fallback file baku bila DB kosong / file warisan tidak ditemukan.
    if migrated_value is None:
        canonical = "logo_pemda" if target_col == "logo_pemda" else "logo_sekolah"
        for ext in (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"):
            cand = UPLOAD_LOGO_DIR / f"{canonical}{ext}"
            if cand.exists():
                migrated_value = _file_to_datauri(cand)
                if migrated_value:
                    logger.info(
                        "load_logo_source: DB '%s' kosong/tak ditemukan, fallback file baku %s",
                        target_col or "?", cand.name,
                    )
                break

    if migrated_value:
        _schedule_migrate_logo_b64(target_col or "logo_sekolah", migrated_value)
        return migrated_value

    # 4) Benar-benar tidak ada sumber — kembalikan path warisan bila ada
    #    (renderer akan log warning), kalau tidak ada pun -> string kosong.
    return p or ""


def draw_pdf_kop_reportlab(c, logo_pemda_path, logo_sekolah_path, baris1, baris2, baris3, x_left, y_top, content_width):
    """
    Menggambar kop surat rapi pada canvas ReportLab:
    - Logo Pemda kiri, Logo Sekolah kanan, tinggi seragam maks 20mm
      (lebar logo dibatasi agar tidak pernah mendesak teks tengah)
    - Teks kop rata tengah pada ruang DI ANTARA kedua logo (khas kop resmi),
      otomatis mengecil bila terlalu panjang, dan alamat di-wrap rapi
    - Garis ganda tebal-tipis sebagai pembatas kop
    Mengembalikan posisi Y (pt) tepat di bawah garis kop.
    """
    from reportlab.lib.utils import ImageReader

    max_logo_h = 20 * mm
    max_logo_w = 24 * mm

    def _logo_ok(src):
        # Sumber bisa berupa data URI base64 (langsung siap render dari memori),
        # base64 telanjang, atau path file warisan.
        if not src:
            return False
        s = str(src)
        if s.startswith("data:image/"):
            return True
        if _looks_like_base64(s):
            return True
        try:
            cand = base64.b64decode(s + "=" * (-len(s) % 4), validate=False)
            if len(cand) > 512:
                with Image.open(io.BytesIO(cand)) as _t:
                    _t.verify()
                return True
        except Exception:
            pass
        return Path(s).exists()

    has_pemda = _logo_ok(logo_pemda_path)
    has_sekolah = _logo_ok(logo_sekolah_path)

    # Area teks = ruang di antara kedua logo (bukan seluruh lebar halaman)
    pad_l = (max_logo_w + 4 * mm) if has_pemda else 0
    pad_r = (max_logo_w + 4 * mm) if has_sekolah else 0
    text_x_start = x_left + pad_l
    text_x_end = x_left + content_width - pad_r
    text_area_w = max(text_x_end - text_x_start, 3 * cm)
    cx_text = (text_x_start + text_x_end) / 2.0  # rata tengah antar logo

    def _draw_logo(src, right_align=False):
        if not src:
            return
        try:
            label = "base64" if str(src).startswith("data:") or _looks_like_base64(str(src)) else Path(str(src)).name
            # Sumber base64/path keduanya diterima flatten_image_to_jpeg.
            # Flattening transparansi -> JPEG solid RGB (kompatibel ReportLab).
            # PNG RGBA/LA/P-transparan yang dilempar mentah ke ImageReader
            # dengan mask='auto' sering gagal/gambar hilang — tidak dipakai lagi.
            out, (iw, ih) = flatten_image_to_jpeg(src)
            if iw <= 0 or ih <= 0:
                return
            # Skala proporsional: batasi tinggi DAN lebar sehingga logo apa pun
            # (termasuk yang sangat besar/persegi) tetap rapi di sudut kop
            scale = min(max_logo_h / ih, max_logo_w / iw)
            h, w = ih * scale, iw * scale
            y = y_top - max_logo_h + (max_logo_h - h) / 2.0
            x = (x_left + content_width - w) if right_align else x_left
            c.saveState()
            c.drawImage(ImageReader(out), x, y, width=w, height=h, preserveAspectRatio=True)
            c.restoreState()
            logger.info("KOP (ReportLab): logo OK %s (%dx%d px -> %.1fx%.1f pt)", label, iw, ih, w, h)
        except Exception as e:
            logger.warning("Gagal render logo PDF: %s -> %s", str(src)[:60], e)

    _draw_logo(logo_pemda_path, right_align=False)
    _draw_logo(logo_sekolah_path, right_align=True)

    c.setFillColor(colors.black)

    def _fit_font(text, bold, base_size, min_size=8.5):
        """Pilih ukuran font agar baris teks muat di area tersedia."""
        size = base_size
        face = "Times-Bold" if bold else "Times-Roman"
        while size > min_size and stringWidth(text, face, size) > text_area_w:
            size -= 0.5
        return face, size

    yy = y_top - 0.8 * cm
    b1 = _safe_text(baris1)
    if b1:
        face, size = _fit_font(b1.upper(), True, 12.5)
        c.setFont(face, size)
        c.drawCentredString(cx_text, yy, b1.upper())
        yy -= size * 1.55
    b2 = _safe_text(baris2)
    if b2:
        face, size = _fit_font(b2.upper(), True, 17, min_size=11)
        c.setFont(face, size)
        c.drawCentredString(cx_text, yy, b2.upper())
        yy -= size * 1.5
    b3 = _safe_text(baris3)
    if b3:
        c.setFont("Times-Roman", 9.5)
        for ln in simpleSplit(b3, "Times-Roman", 9.5, text_area_w):
            c.drawCentredString(cx_text, yy, ln)
            yy -= 0.42 * cm

    # Garis kop: pastikan tidak memotong logo meski teks kop sedikit
    kop_line_y = min(yy - 0.12 * cm, y_top - max_logo_h - 0.3 * cm)
    c.setStrokeColor(colors.black)
    c.setLineWidth(1.6)
    c.line(x_left, kop_line_y, x_left + content_width, kop_line_y)
    c.setLineWidth(0.4)
    c.line(x_left, kop_line_y - 1.8, x_left + content_width, kop_line_y - 1.8)

    return kop_line_y - 0.8 * cm


def generate_kwitansi_pdf_v2(kwitansi, pengaturan):
    buffer = BytesIO()
    
    # --- KONFIGURASI HALAMAN ---
    F4_WIDTH = 21.5 * cm
    F4_HEIGHT = 33.0 * cm
    # Canvas portrait, tapi kita menggambar di area tertentu (simulasi landscape)
    c = canvas.Canvas(buffer, pagesize=(F4_WIDTH, F4_HEIGHT))

    # --- SETTING LAYOUT AREA ---
    margin_x = 1.0 * cm
    top_y = F4_HEIGHT - 2.0 * cm
    
    kwitansi_width = F4_WIDTH - (2 * margin_x)
    # Tinggi area dinamis, tapi kita set base area dulu
    kwitansi_height = 14.0 * cm 
    bottom_y = top_y - kwitansi_height

    # --- 1. KOP SURAT + JUDUL ---
    # (Perubahan: kuitansi kini BERkop — karena endpoint GET /kwitansi/{id}/pdf
    #  menggabungkan kuitansi sebagai HALAMAN PERTAMA berkas SPJ, logo harus
    #  tampil di sana. Sumber identitas tetap objek `pengaturan` yang sudah
    #  di-resolve per periode oleh resolve_identitas_for_tanggal() sebelum
    #  fungsi ini dipanggil — jangan ambil logo dari baris `pengaturan` mentah
    #  tanpa fallback periode karena logo bisa berbeda antarperiode.)
    kop_x = margin_x + 1.0 * cm
    kop_w = kwitansi_width - 2.0 * cm
    kop_top = top_y - 0.6 * cm

    logo_pemda = load_logo_source(
        getattr(pengaturan, "logo_pemda", "") or "",
        col="logo_pemda",
    )
    logo_sekolah = load_logo_source(
        getattr(pengaturan, "logo_sekolah", "") or "",
        col="logo_sekolah",
    )

    after_kop_y = draw_pdf_kop_reportlab(
        c,
        logo_pemda,
        logo_sekolah,
        (getattr(pengaturan, "nama_pemda", "") or "").upper(),
        (getattr(pengaturan, "nama_sekolah", "") or "").upper(),
        getattr(pengaturan, "alamat_sekolah", "") or "",
        kop_x,
        kop_top,
        kop_w,
    )

    judul_y = after_kop_y - 0.7 * cm
    c.setFillColor(colors.black)
    c.setFont("Times-Bold", 18)
    c.drawCentredString(F4_WIDTH / 2, judul_y, "KWITANSI")
    c.setFont("Times-Roman", 11)
    c.drawCentredString(F4_WIDTH / 2, judul_y - 0.55 * cm, f"Nomor: {kwitansi.nomor_kwitansi or '-'}")

    # --- 2. ISI FORMULIR ---
    # content_start_y dihitung DARI judul_y sehingga seluruh isi ikut turun
    # otomatis mengikuti tinggi kop (judul dan isi tidak pernah bertumpuk).
    content_start_y = judul_y - 1.6 * cm
    
    # Koordinat Kolom
    left_col_x = margin_x + 1.0 * cm     # Label
    colon_x = margin_x + 4.5 * cm        # Titik dua
    value_x = margin_x + 4.8 * cm        # Awal isian
    line_end_x = margin_x + kwitansi_width - 1.0 * cm # Ujung kanan garis
    
    c.setFont("Times-Roman", 12)
    current_y = content_start_y
    line_gap = 0.8 * cm # Jarak antar field utama

    # A. Telah Terima Dari (baris "Tanggal" dihilangkan sesuai permintaan;
    #    tanggal tetap tampil pada blok tanda tangan di bawah)
    current_y = draw_wrapped_text_with_lines(
        c, f"BENDAHARA BOSP {_safe_text(pengaturan.nama_sekolah).upper()}", 
        left_col_x, colon_x, value_x, line_end_x,
        current_y, "Times-Roman", 12, "Telah terima dari"
    )
    current_y -= line_gap

    # C. Uang Sejumlah (Terbilang) - Font Bold
    # Convert jumlah ke terbilang (pastikan fungsi terbilang ada)
    try:
        txt_terbilang = f"{terbilang(_to_float(kwitansi.jumlah)).capitalize()} rupiah"
    except Exception as e:
        logger.warning("kwitansi: terbilang gagal untuk %r -> %s", kwitansi.jumlah, e)
        txt_terbilang = "................ rupiah" # Fallback

    current_y = draw_wrapped_text_with_lines(
        c, txt_terbilang, 
        left_col_x, colon_x, value_x, line_end_x,
        current_y, "Times-Roman", 12, "Uang sejumlah"
    )
    current_y -= line_gap

    # D. Untuk Pembayaran (WRAP TEXT PENTING DISINI)
    # Ini akan otomatis turun baris dan mendorong elemen di bawahnya
    current_y = draw_wrapped_text_with_lines(
        c, kwitansi.nama_kegiatan, 
        left_col_x, colon_x, value_x, line_end_x,
        current_y, "Times-Roman", 12, "Untuk pembayaran"
    )
    sep_y = current_y - 0.5 * cm
    c.setLineWidth(0.5)
    # c.line(left_col_x, sep_y, line_end_x, sep_y) # (Opsional: garis pemisah form dan ttd)

    # --- 4. TANDA TANGAN (proporsional: blok rata tepi kiri-tengah-kanan) ---
    ttd_base_y = sep_y - 1.0 * cm

    # Koordinat X kolom tanda tangan (kiri / tengah / kanan)
    col_1_x = margin_x + 1.0 * cm                       # Kiri (KS)
    col_3_w = 5.5 * cm                                  # Lebar area kolom kanan
    col_3_x = margin_x + kwitansi_width - col_3_w       # Kanan (Penerima)
    col_c_end = line_end_x                              # Tengah dibatasi ujung garis value
    col_2_cx = (col_1_x + col_3_x) / 2.0                # Titik tengah blok ttd

    c.setFont("Times-Roman", 11)

    def _ttd_text(x, y, text, align="L"):
        if align == "C":
            c.drawCentredString(x, y, text)
        elif align == "R":
            c.drawRightString(x, y, text)
        else:
            c.drawString(x, y, text)

    # Header TTD
    _ttd_text(col_1_x, ttd_base_y, "Setuju Dibayar")
    _ttd_text(col_1_x, ttd_base_y - 0.5*cm, "Kepala Sekolah")

    _ttd_text(col_2_cx, ttd_base_y, f"Lunas Dibayar {_safe_text(kwitansi.tanggal)}", "C")
    _ttd_text(col_2_cx, ttd_base_y - 0.5*cm, "Bendahara BOSP", "C")

    kota_ttd = _safe_text(getattr(pengaturan, 'tempat_surat', None)) or 'Jember'
    _ttd_text(col_c_end, ttd_base_y, f"{kota_ttd}, {_safe_text(kwitansi.tanggal)}", "R")
    _ttd_text(col_c_end, ttd_base_y - 0.5*cm, "Penerima", "R")

    # Nama & NIP (jarak tetap dari header)
    name_y = ttd_base_y - 3.0 * cm
    nip_y = name_y - 0.5 * cm

    def _nama(value):
        return _safe_text(value) or "................................."

    def _nip(value):
        s = _safe_text(value)
        return f"NIP. {s}" if s else "NIP. ............................."

    def _fit_name(text, max_w):
        """Perkecil font bertahap agar nama tidak menabrak kolom sebelah."""
        size = 11
        while size > 8 and c.stringWidth(text, "Times-Bold", size) > max_w:
            size -= 0.5
        return size

    # TTD Kiri (KS)
    max_w_1 = col_2_cx - col_1_x - 1.0 * cm
    nm1 = _nama(pengaturan.nama_kepala_sekolah)
    c.setFont("Times-Bold", _fit_name(nm1, max_w_1))
    _ttd_text(col_1_x, name_y, nm1)
    c.setFont("Times-Roman", 11)
    _ttd_text(col_1_x, nip_y, _nip(pengaturan.nip_kepala_sekolah))

    # TTD Tengah (Bendahara)
    nm2 = _nama(pengaturan.nama_bendahara)
    c.setFont("Times-Bold", _fit_name(nm2, min(max_w_1, col_3_x - col_2_cx - 1.0 * cm) * 2))
    _ttd_text(col_2_cx, name_y, nm2, "C")
    c.setFont("Times-Roman", 11)
    _ttd_text(col_2_cx, nip_y, _nip(pengaturan.nip_bendahara), "C")

    # TTD Kanan (Penerima) — garis bantu tanda tangan di atas nama
    c.setLineWidth(0.5)
    c.line(col_3_x, name_y + 0.15*cm, col_3_x + 4.5*cm, name_y + 0.15*cm)

    # --- 5. KOTAK NOMINAL (Rp.) ---
    # Posisi di bawah NIP KS
    rp_box_y = nip_y - 1.5 * cm 
    rp_box_x = col_1_x + 1.0 * cm 
    rp_box_w = 6.0 * cm
    rp_box_h = 1.0 * cm

    # Arsir Kotak Rp
    draw_hatching_pattern(c, rp_box_x, rp_box_y, rp_box_w, rp_box_h, density=3)
    c.setStrokeColor(colors.black)
    c.setLineWidth(1)
    c.rect(rp_box_x, rp_box_y, rp_box_w, rp_box_h)

    # Label Rp. (Di luar kotak sebelah kiri)
    c.setFont("Times-Bold", 14)
    c.drawString(rp_box_x - 1.0 * cm, rp_box_y + 0.3*cm, "Rp.")
    
    # Angka Nominal (Di dalam kotak) — konversi aman (jumlah bisa berupa string)
    formatted_jumlah = f"{_to_float(kwitansi.jumlah):,.0f}".replace(",", "X").replace(".", ",").replace("X", ".")
    center_x_box = rp_box_x + (rp_box_w / 2)
    c.drawCentredString(center_x_box, rp_box_y + 0.3*cm, formatted_jumlah)

    # --- DRAW BORDER LUAR (FINAL) ---
    # Gambar border luar berdasarkan posisi paling bawah konten agar dinamis
    # Tapi untuk menjaga tampilan kartu, kita pakai fix height minimal
    final_bottom_y = rp_box_y - 1.0 * cm
    
    # Jika konten meluber melebihi area standar kwitansi, sesuaikan border
    if final_bottom_y < bottom_y:
        actual_bottom_y = final_bottom_y
    else:
        actual_bottom_y = bottom_y
        
    actual_height = top_y - actual_bottom_y

    # Garis Tebal Luar
    c.setLineWidth(1.5)
    c.rect(margin_x, actual_bottom_y, kwitansi_width, actual_height)
    
    # Garis Tipis Dalam
    c.setLineWidth(0.5)
    gap = 0.15 * cm
    c.rect(margin_x + gap, actual_bottom_y + gap, kwitansi_width - 2*gap, actual_height - 2*gap)

    c.showPage()
    c.save()
    buffer.seek(0)
    return buffer.getvalue()

@api_router.get("/transaksi")
async def get_transaksi(
    db: AsyncSession = Depends(get_db),
    no_bukti: Optional[str] = None
):
    try:
        if no_bukti:
            stmt = select(Transaksi).where(Transaksi.no_bukti == no_bukti)
        else:
            # FILTER & URUTKAN
            stmt = select(Transaksi).where(
                and_(
                    Transaksi.no_bukti.isnot(None),
                    Transaksi.no_bukti != "",
                    Transaksi.no_bukti.like("BPU%")
                )
            ).order_by(
                # 1. Urutkan berdasarkan jumlah karakter (agar BPU1-9 di atas BPU10-99)
                func.length(Transaksi.no_bukti).asc(), 
                # 2. Urutkan secara alfabetis untuk nomor dengan jumlah karakter yang sama
                Transaksi.no_bukti.asc()
            )
        
        result = await db.execute(stmt)
        transaksi_list = result.scalars().all()
        
        return {"status": "success", "data": transaksi_list}
    except Exception as e:
        logger.error(f"Error getting transaksi: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@api_router.get("/transaksi/sumif/{no_bukti}")
async def get_sumif_no_bukti(
    no_bukti: str,
    db: AsyncSession = Depends(get_db)
):
    """Get SUMIF total for no_bukti (like Excel SUMIF)"""
    try:
        total = await calculate_sumif_no_bukti(no_bukti, db)
        return {"status": "success", "no_bukti": no_bukti, "total": total}
    except Exception as e:
        logger.error(f"Error calculating SUMIF: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error calculating SUMIF: {str(e)}")


# Helper: calculate SUM of pengeluaran for a given no_bukti (Excel-like SUMIF)
async def calculate_sumif_no_bukti(no_bukti: str, db: AsyncSession) -> float:
    try:
        stmt = select(func.sum(Transaksi.pengeluaran)).where(Transaksi.no_bukti == no_bukti)
        result = await db.execute(stmt)
        total = result.scalar() or 0.0
        return float(total)
    except Exception as e:
        logger.error(f"Error in calculate_sumif_no_bukti: {str(e)}")
        return 0.0


# Pastikan import ini ada
# Pastikan Anda mengimport Kwitansi dari models/file tempat class didefinisikan
# from models import Transaksi, Kwitansi 

@api_router.delete("/transaksi/{no_bukti}")
async def delete_transaksi(no_bukti: str, db: AsyncSession = Depends(get_db)):
    # 1. Decode no_bukti (jaga-jaga karakter spesial)
    clean_no_bukti = unquote(no_bukti)
    
    # 2. Hapus data dari Tabel Transaksi
    stmt_transaksi = delete(Transaksi).where(Transaksi.no_bukti == clean_no_bukti)
    await db.execute(stmt_transaksi)

    # 3. Hapus data dari Tabel Kwitansi (TAMBAHAN BARU)
    # Ini akan menghapus baris di tabel kwitansi yang punya no_bukti sama
    stmt_kwitansi = delete(Kwitansi).where(Kwitansi.no_bukti == clean_no_bukti)
    await db.execute(stmt_kwitansi)

    # 4. Commit perubahan (Simpan kedua penghapusan sekaligus)
    await db.commit()
    
    return {
        "status": "success", 
        "message": f"Data Transaksi dan Kwitansi untuk no bukti '{clean_no_bukti}' berhasil dihapus"
    }

@api_router.get("/kwitansi")
async def get_kwitansi_final(db: AsyncSession = Depends(get_db)):
    """
    Menampilkan semua kwitansi lengkap, termasuk tanggal_nota, no_bast, nama_toko, npwp_toko, alamat_toko.
    """
    try:
        stmt = select(Kwitansi).order_by(Kwitansi.tanggal.asc(), Kwitansi.no_bukti.asc())
        result = await db.execute(stmt)
        kwitansi_list = result.scalars().all()

        data = []
        for k in kwitansi_list:
            data.append({
                "id": k.id,
                "nomor_kwitansi": k.nomor_kwitansi,
                "no_bukti": k.no_bukti,
                "kode_kegiatan": k.kode_kegiatan,
                "nama_kegiatan": k.nama_kegiatan,
                "tanggal": k.tanggal,
                "thp": k.thp,
                "tahun": k.tahun,
                "jumlah": k.jumlah,
                "tanggal_nota": k.tanggal_nota,
                "no_bast": k.no_bast,
                "nama_toko": k.nama_toko,
                "npwp_toko": k.npwp_toko,
                "alamat_toko": k.alamat_toko,
                "no_telp_toko": k.no_telp_toko or "",
                "no_nota": k.no_nota or "",
                "jenis_belanja": getattr(k, "jenis_belanja", None) or "umum",
                "data_lampiran": _data_lampiran_dict(k),
                "jenis_foto_tersedia": _jenis_foto_tersedia(k),
                "created_at": k.created_at,
                "updated_at": k.updated_at
            })

        return {"status": "success", "data": data}

    except Exception as e:
        logger.error(f"Error getting kwitansi: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@api_router.post("/kwitansi/generate")
async def generate_kwitansi_final(db: AsyncSession = Depends(get_db)):
    """
    Generate kwitansi berdasarkan transaksi.
    Data tambahan seperti tanggal_nota, no_bast, nama_toko, npwp_toko, alamat_toko diisi kosong.
    Format tanggal otomatis dikenali.
    """
    try:
        # Hapus semua kwitansi lama
        await db.execute(delete(Kwitansi))
        await db.commit()

        stmt = (
            select(Transaksi)
            .where(
                Transaksi.no_bukti.isnot(None),
                func.length(func.trim(Transaksi.no_bukti)) > 0,
                Transaksi.pengeluaran > 0,
            )
            .order_by(Transaksi.tanggal.asc(), Transaksi.id.asc())
        )
        result = await db.execute(stmt)
        transaction_rows = result.scalars().all()
        kegiatan_result = await db.execute(select(MasterKegiatan))
        kegiatan_names = {
            item.kode_kegiatan: item.nama_kegiatan
            for item in kegiatan_result.scalars().all()
        }
        groups = {}
        for transaction in transaction_rows:
            group = groups.setdefault(
                transaction.no_bukti,
                {
                    "items": [],
                    "jumlah": 0.0,
                    "tanggal": transaction.tanggal,
                    "kode_kegiatan": transaction.kode_kegiatan or "",
                    "identity": {},
                },
            )
            group["items"].append(transaction)
            group["jumlah"] += float(transaction.pengeluaran or 0)
            if not group["kode_kegiatan"] and transaction.kode_kegiatan:
                group["kode_kegiatan"] = transaction.kode_kegiatan
            for field in (
                "nama_toko",
                "alamat_toko",
                "no_telp_toko",
                "npwp_toko",
                "no_nota",
                "tanggal_nota",
            ):
                if not group["identity"].get(field) and getattr(transaction, field, ""):
                    group["identity"][field] = getattr(transaction, field)

        generated = 0

        for no_bukti, group in groups.items():
            if not group["tanggal"] or not group["jumlah"]:
                continue

            try:
                tgl = parse_date(group["tanggal"], dayfirst=True)
            except (TypeError, ValueError, OverflowError):
                continue

            bulan = tgl.month
            tahun = tgl.year
            thp = "THP I" if bulan <= 6 else "THP II"
            kode_kegiatan = group["kode_kegiatan"]

            nomor_kwitansi = f"{no_bukti}/{kode_kegiatan or '-'} /{thp}/{tahun}"

            kw = Kwitansi(
                nomor_kwitansi=nomor_kwitansi,
                no_bukti=no_bukti,
                kode_kegiatan=kode_kegiatan,
                nama_kegiatan=kegiatan_names.get(
                    kode_kegiatan, "Tanpa Nama Kegiatan"
                ),
                tanggal=group["tanggal"],
                thp=thp,
                tahun=str(tahun),
                jumlah=group["jumlah"],
                tanggal_nota=group["identity"].get("tanggal_nota", ""),
                no_bast="",
                nama_toko=group["identity"].get("nama_toko", ""),
                npwp_toko=group["identity"].get("npwp_toko", ""),
                alamat_toko=group["identity"].get("alamat_toko", ""),
                no_telp_toko=group["identity"].get("no_telp_toko", ""),
                no_nota=group["identity"].get("no_nota", ""),
            )

            db.add(kw)
            generated += 1

        await db.commit()
        return {"status": "success", "generated": generated}

    except Exception as e:
        await db.rollback()
        logger.exception("ERROR GENERATE KWITANSI")
        raise HTTPException(status_code=500, detail=str(e))


# ======================================================================
# IDENTITAS SATUAN PENDIDIKAN PER PERIODE
# Menu "Identitas Satuan Pendidikan" kini MENYATU dengan kop & surat
# (nama pemda, alamat, tempat surat, logo) serta pejabat penanda tangan.
# Beberapa entri dapat dibuat berdasarkan tanggal_awal s.d. tanggal_akhir
# sehingga dokumen otomatis memakai identitas yang berlaku pada tanggalnya.
# ======================================================================

def _normalisasi_logo(value) -> str:
    """Validasi nilai logo (data URI base64). Return string bersih atau ''."""
    if value is None:
        return ""
    s = str(value).strip()
    if not s or s == "#":
        return ""
    if s.startswith("data:image/"):
        return s
    if _looks_like_base64(s):
        return f"data:image/jpeg;base64,{s}"
    # Nilai warisan (nama file/path) dipertahankan apa adanya
    return s


@api_router.get("/identitas-periode")
async def list_identitas_periode(
    tanggal: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """Daftar seluruh entri identitas per periode (terlama → terbaru).

    Bila ``tanggal`` (yyyy-mm-dd) diberikan, respons juga memuat ``aktif``
    yaitu entri yang periodanya mencakup tanggal tersebut — dipakai UI untuk
    menandai identitas mana yang akan tercetak pada dokumen bertanggal itu.
    """
    try:
        rows = await _query_identitas_periode_list(db)
        data = []
        for ip in rows:
            d = _periode_to_dict(ip)
            # Jangan kirim base64 penuh ke daftar — hanya penanda keberadaan
            d["logo_pemda"] = bool(d.get("logo_pemda"))
            d["logo_sekolah"] = bool(d.get("logo_sekolah"))
            data.append(d)
        aktif_id = None
        if tanggal:
            ident = await resolve_identitas_for_tanggal(db, tanggal)
            if ident.get("sumber") == "periode":
                aktif_id = ident.get("id")
        return {"status": "success", "data": data, "aktif_id": aktif_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error listing identitas periode: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@api_router.get("/identitas-periode/{item_id}")
async def get_identitas_periode(item_id: int, db: AsyncSession = Depends(get_db)):
    """Detail satu entri identitas, termasuk logo sebagai data URI base64."""
    try:
        ip = (
            await db.execute(
                select(IdentitasPeriode).where(IdentitasPeriode.id == item_id)
            )
        ).scalar_one_or_none()
        if ip is None:
            raise HTTPException(status_code=404, detail="Entri identitas tidak ditemukan")
        return {"status": "success", "data": _periode_to_dict(ip)}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting identitas periode: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@api_router.post("/identitas-periode")
async def save_identitas_periode(
    request: IdentitasPeriodeRequest,
    db: AsyncSession = Depends(get_db),
):
    """Buat/perbarui entri identitas per periode.

    - ``id`` kosong → buat entri baru; ``id`` diisi → update entri tsb.
    - Logo bernilai ``None`` saat update berarti "pertahankan logo lama".
    - Entri terpilih (atau terbaru) disinkronkan ke tabel Pengaturan legacy
      agar fitur lama tetap berjalan.
    """
    try:
        if not (request.tanggal_awal or "").strip():
            raise HTTPException(
                status_code=400, detail="Tanggal awal keberlakuan wajib diisi"
            )

        if request.id:
            ip = (
                await db.execute(
                    select(IdentitasPeriode).where(IdentitasPeriode.id == request.id)
                )
            ).scalar_one_or_none()
            if ip is None:
                raise HTTPException(status_code=404, detail="Entri identitas tidak ditemukan")
        else:
            ip = IdentitasPeriode()
            db.add(ip)

        for col in ("label", "tanggal_awal", "tanggal_akhir",
                    "nama_pemda", "nama_sekolah", "alamat_sekolah", "tempat_surat",
                    "nama_kepala_sekolah", "nip_kepala_sekolah",
                    "nama_bendahara", "nip_bendahara",
                    "nama_pengurus_barang", "nip_pengurus_barang"):
            setattr(ip, col, getattr(request, col, "") or "")
        if request.is_active is not None:
            ip.is_active = bool(request.is_active)

        logo_pemda = _normalisasi_logo(request.logo_pemda)
        logo_sekolah = _normalisasi_logo(request.logo_sekolah)
        if logo_pemda:
            ip.logo_pemda = logo_pemda
        if logo_sekolah:
            ip.logo_sekolah = logo_sekolah

        await db.flush()

        # Segarkan baris Pengaturan legacy (kop + pejabat) dari identitas
        # terbaru/tercocok agar fitur lama yang membaca tabel pengaturan tetap
        # konsisten — berlaku juga saat entri dinonaktifkan atau diedit periodanya.
        ident_now = await get_identitas_base(db)
        await sync_pengaturan_from_identitas(db, ident_now)

        await db.commit()
        await db.refresh(ip)
        return {
            "status": "success",
            "message": "Identitas satuan pendidikan berhasil disimpan",
            "data": _periode_to_dict(ip),
        }
    except HTTPException:
        await db.rollback()
        raise
    except Exception as e:
        await db.rollback()
        logger.error(f"Error saving identitas periode: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@api_router.delete("/identitas-periode/{item_id}")
async def delete_identitas_periode(item_id: int, db: AsyncSession = Depends(get_db)):
    """Hapus satu entri identitas periode, lalu segarkan sinkronisasi legacy."""
    try:
        ip = (
            await db.execute(
                select(IdentitasPeriode).where(IdentitasPeriode.id == item_id)
            )
        ).scalar_one_or_none()
        if ip is None:
            raise HTTPException(status_code=404, detail="Entri identitas tidak ditemukan")
        await db.delete(ip)
        await db.flush()
        # Refresh baris legacy dari sisa identitas (atau fallback Pengaturan)
        ident = await get_identitas_base(db)
        await sync_pengaturan_from_identitas(db, ident)
        await db.commit()
        return {"status": "success", "message": "Entri identitas berhasil dihapus"}
    except HTTPException:
        await db.rollback()
        raise
    except Exception as e:
        await db.rollback()
        logger.error(f"Error deleting identitas periode: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


# Pengaturan (Settings) Routes
@api_router.get("/pengaturan")
async def get_pengaturan(
    db: AsyncSession = Depends(get_db)
):
    """Get application settings"""
    try:
        stmt = select(Pengaturan).limit(1)
        result = await db.execute(stmt)
        pengaturan = result.scalar_one_or_none()
        
        if not pengaturan:
            return {"status": "success", "data": None}
        
        return {
            "status": "success", 
            "data": {
                "id": pengaturan.id,
                "nama_sekolah": pengaturan.nama_sekolah,
                "nama_kepala_sekolah": pengaturan.nama_kepala_sekolah,
                "nip_kepala_sekolah": pengaturan.nip_kepala_sekolah,
                "nama_bendahara": pengaturan.nama_bendahara,
                "nip_bendahara": pengaturan.nip_bendahara,
                "nama_pengurus_barang": pengaturan.nama_pengurus_barang,
                "nip_pengurus_barang": pengaturan.nip_pengurus_barang,
                "alamat_sekolah": pengaturan.alamat_sekolah,
                "tempat_surat": pengaturan.tempat_surat or ""
            }
        }
    except Exception as e:
        logger.error(f"Error getting pengaturan: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error getting pengaturan: {str(e)}")


@api_router.post("/pengaturan")
async def save_pengaturan(
    request: PengaturanRequest,
    db: AsyncSession = Depends(get_db)
):
    """Save or update application settings

    Data dari menu lama ditulis ke entri IdentitasPeriode "umum" (tanpa batas
    tanggal) sekaligus ke baris Pengaturan legacy, sehingga kedua sumber tetap
    sinkron dengan model identitas per periode.
    """
    try:
        ip = (
            await db.execute(
                select(IdentitasPeriode)
                .where(IdentitasPeriode.tanggal_awal == "")
                .order_by(IdentitasPeriode.id.asc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if ip is None:
            ip = IdentitasPeriode(tanggal_awal="", is_active=True)
            db.add(ip)

        for col in (
            "nama_sekolah", "nama_kepala_sekolah", "nip_kepala_sekolah",
            "nama_bendahara", "nip_bendahara",
            "nama_pengurus_barang", "nip_pengurus_barang",
            "alamat_sekolah", "tempat_surat",
        ):
            setattr(ip, col, getattr(request, col, "") or "")

        await db.flush()

        # Salin hasil ke baris Pengaturan legacy (kompatibilitas fitur lama)
        p_legacy = await ensure_pengaturan_row(db)
        _terapkan_identitas_ke_pengaturan(p_legacy, await get_identitas_base(db))

        await db.commit()
        return {"status": "success", "message": "Pengaturan berhasil disimpan"}
        return {"status": "success", "message": "Pengaturan berhasil disimpan"}
    except Exception as e:
        await db.rollback()
        logger.error(f"Error saving pengaturan: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error saving pengaturan: {str(e)}")


# Master Kegiatan Routes
@api_router.get("/master-kegiatan")
async def get_master_kegiatan(
    db: AsyncSession = Depends(get_db)
):
    """Get all master kegiatan"""
    try:
        stmt = select(MasterKegiatan).order_by(MasterKegiatan.kode_kegiatan)
        result = await db.execute(stmt)
        kegiatan_list = result.scalars().all()
        
        return {"status": "success", "data": kegiatan_list}
    except Exception as e:
        logger.error(f"Error getting master kegiatan: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error getting master kegiatan: {str(e)}")


@api_router.post("/master-kegiatan")
async def save_master_kegiatan(
    request: MasterKegiatanRequest,
    db: AsyncSession = Depends(get_db)
):
    """Save or update master kegiatan"""
    try:
        stmt = select(MasterKegiatan).where(MasterKegiatan.kode_kegiatan == request.kode_kegiatan)
        result = await db.execute(stmt)
        kegiatan = result.scalar_one_or_none()
        
        if kegiatan:
            kegiatan.nama_kegiatan = request.nama_kegiatan
        else:
            kegiatan = MasterKegiatan(
                kode_kegiatan=request.kode_kegiatan,
                nama_kegiatan=request.nama_kegiatan
            )
            db.add(kegiatan)
        
        await db.commit()
        return {"status": "success", "message": "Master kegiatan berhasil disimpan"}
    except Exception as e:
        await db.rollback()
        logger.error(f"Error saving master kegiatan: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error saving master kegiatan: {str(e)}")

@api_router.post("/master-kegiatan/bulk")
async def save_master_kegiatan_bulk(
    request: MasterKegiatanBulkRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    Bulk import master kegiatan (Replace All).
    Metode: HAPUS semua data lama, lalu INSERT data baru.
    """
    try:
        # 1. Hapus seluruh baris data di tabel MasterKegiatan
        await db.execute(delete(MasterKegiatan))
        
        # 2. Siapkan objek baru dari request
        new_data_list = []
        for item in request.data:
            kegiatan = MasterKegiatan(
                kode_kegiatan=item.kode_kegiatan,
                nama_kegiatan=item.nama_kegiatan
            )
            new_data_list.append(kegiatan)
            
        # 3. Masukkan data baru sekaligus (lebih efisien daripada add satu per satu di loop)
        if new_data_list:
            db.add_all(new_data_list)
        
        # 4. Commit transaksi (Delete dan Insert terjadi dalam satu transaksi)
        await db.commit()
        
        return {"status": "success", "saved_count": len(new_data_list)}

    except Exception as e:
        await db.rollback()
        logger.error(f"Error bulk replacing master kegiatan: {str(e)}")
        # Menangani error Foreign Key jika data ini sedang dipakai di tabel lain
        if "foreign key constraint" in str(e).lower():
             raise HTTPException(
                status_code=400, 
                detail="Gagal menghapus data lama karena data sedang digunakan di tabel lain (Foreign Key Error)."
            )
        raise HTTPException(status_code=500, detail=f"Error bulk replacing master kegiatan: {str(e)}")


from sqlalchemy import delete  # <--- Pastikan ini diimport

@api_router.post("/master-rekening-belanja/bulk")
async def save_master_rekening_belanja_bulk(
    request: MasterRekeningBelanjaBulkRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    Bulk import master rekening belanja (Replace All).
    Metode: HAPUS semua data lama, lalu INSERT data baru.
    """
    try:
        # 1. Hapus seluruh data di tabel MasterRekeningBelanja
        await db.execute(delete(MasterRekeningBelanja))

        # 2. Siapkan list objek baru dari request
        new_rekening_list = []
        for item in request.data:
            rek = MasterRekeningBelanja(
                kode_rekening_belanja=item.kode_rekening_belanja,
                nama_rekening_belanja=item.nama_rekening_belanja,
                # Pastikan logic default value tetap ada seperti kode asli
                rekap_rekening_belanja=item.rekap_rekening_belanja or "",
                nilai_kapitalisasi_belanja=item.nilai_kapitalisasi_belanja or 0
            )
            new_rekening_list.append(rek)

        # 3. Masukkan data baru sekaligus (lebih efisien)
        if new_rekening_list:
            db.add_all(new_rekening_list)

        # 4. Commit transaksi (Delete dan Insert terjadi bersamaan)
        await db.commit()
        
        return {"status": "success", "saved_count": len(new_rekening_list)}

    except Exception as e:
        await db.rollback()
        logger.error(f"Error bulk replacing master rekening belanja: {str(e)}")
        
        # Penanganan khusus jika gagal hapus karena Foreign Key Constraint
        if "foreign key constraint" in str(e).lower():
             raise HTTPException(
                status_code=400, 
                detail="Gagal melakukan replace data. Data Rekening Belanja lama masih digunakan di tabel lain (transaksi/anggaran)."
            )
            
        raise HTTPException(status_code=500, detail=f"Error bulk replacing master rekening belanja: {str(e)}")


@api_router.get("/master-rekening-belanja")
async def get_master_rekening_belanja(
    db: AsyncSession = Depends(get_db)
):
    """Get all master rekening belanja"""
    try:
        stmt = select(MasterRekeningBelanja).order_by(MasterRekeningBelanja.kode_rekening_belanja)
        result = await db.execute(stmt)
        rekening_list = result.scalars().all()

        # Serialize to simple dicts for JSON response
        data = []
        for r in rekening_list:
            data.append({
                "id": r.id,
                "kode_rekening_belanja": r.kode_rekening_belanja,
                "nama_rekening_belanja": r.nama_rekening_belanja,
                "rekap_rekening_belanja": r.rekap_rekening_belanja,
                "nilai_kapitalisasi_belanja": r.nilai_kapitalisasi_belanja,
                "created_at": r.created_at,
                "updated_at": r.updated_at,
            })

        return {"status": "success", "data": data}
    except Exception as e:
        logger.error(f"Error getting master rekening belanja: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error getting master rekening belanja: {str(e)}")

@api_router.delete("/master-rekening-belanja/{id}")
async def delete_master_rekening(id: int, db: AsyncSession = Depends(get_db)):
    await db.execute(delete(MasterRekeningBelanja).where(MasterRekeningBelanja.id == id))
    await db.commit()
    return {"status": "success"}

@api_router.get("/rekap-transaksi")
async def get_rekap_transaksi(
    details: int = 0,
    thp: str = "all",
    db: AsyncSession = Depends(get_db)
):
    """Generate rekap:
    - Only transactions that have a matching `kode_rekening` in `master_rekening_belanja` are considered.
    - First classification is per transaction: if master.rekap_rekening_belanja is 'KIB B' or 'KIB E',
      that transaction is labeled either '<KIB> Kapitalisasi' (if harga_satuan >= nilai_kapitalisasi_belanja)
      or 'Non Kapitalisasi' otherwise.
    - All transactions are then aggregated (sum of `pengeluaran`) grouped by the final label.
    - Pass ?details=1 to include transaction-level items in each group.
    """
    try:
        # Inner join ensures only transactions with a matching master rekening are considered.
        # Exclude transactions where kode_rekening or no_bukti are null/empty
        # Build base stmt joining MasterRekening
        base_stmt = select(Transaksi, MasterRekeningBelanja).join(
            MasterRekeningBelanja,
            MasterRekeningBelanja.kode_rekening_belanja == Transaksi.kode_rekening
        ).where(Transaksi.kode_rekening != None).where(Transaksi.kode_rekening != "").where(Transaksi.no_bukti != None).where(Transaksi.no_bukti != "")

        # If thp filter is specified (1 or 2), join Kwitansi and filter by its `thp` column
        if str(thp).strip() in ("1", "2"):
            thp_map = {"1": "THP I", "2": "THP II"}
            target_thp = thp_map[str(thp).strip()]
            base_stmt = base_stmt.join(Kwitansi, Kwitansi.no_bukti == Transaksi.no_bukti).where(Kwitansi.thp == target_thp)

        result = await db.execute(base_stmt)
        rows = result.all()

        groups = {}

        for trans, master in rows:
            # base rekap from master
            base_rekap = (master.rekap_rekening_belanja or "").strip()

            # Special KIB handling: produce explicit labels per KIB type
            if base_rekap in ("KIB B", "KIB E"):
                threshold = float(master.nilai_kapitalisasi_belanja or 0)
                harga = float(trans.harga_satuan or 0)
                if harga >= threshold:
                    label = f"{base_rekap} Kapitalisasi"
                else:
                    label = f"{base_rekap} Non Kapitalisasi"
            else:
                label = base_rekap or "Unspecified"

            g = groups.get(label)
            if not g:
                g = {
                    "rekap": label,
                    "count": 0,
                    "total_pengeluaran": 0.0,
                    "kode_rekening_breakdown": {},
                    "items": []
                }
                groups[label] = g

            pel = float(trans.pengeluaran or 0)
            g["count"] += 1
            g["total_pengeluaran"] += pel

            # breakdown per kode_rekening
            kr = trans.kode_rekening or ""
            g["kode_rekening_breakdown"][kr] = g["kode_rekening_breakdown"].get(kr, 0.0) + pel

            if details:
                g["items"].append({
                    "no_bukti": trans.no_bukti,
                    "kode_rekening": trans.kode_rekening,
                    "kode_kegiatan": trans.kode_kegiatan,
                    "harga_satuan": trans.harga_satuan,
                    "pengeluaran": trans.pengeluaran
                })

        # Convert to list and sort by rekap name
        data = sorted(list(groups.values()), key=lambda x: x.get("rekap") or "")
        return {"status": "success", "data": data}

    except Exception as e:
        logger.error(f"Error generating rekap transaksi: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error generating rekap transaksi: {str(e)}")

def generate_placeholder_code(text: str) -> str:
    """Mengubah 'Belanja Bahan-Bahan' menjadi 'BELANJA_BAHAN_BAHAN'"""
    if not text:
        return ""
    # Ganti karakter non-alphanumeric (spasi, -, /) dengan underscore, lalu uppercase
    return re.sub(r'[^A-Z0-9]', '_', text.strip().upper())

# --- ENDPOINT: Generate Excel dari Template User ---
@api_router.post("/generate-rekap-excel")
async def generate_rekap_excel(
    file: UploadFile = File(...),
    thp: str = Form("all"),
    db: AsyncSession = Depends(get_db)
):
    try:
        # 1. === AMBIL DATA ===
        base_stmt = select(Transaksi, MasterRekeningBelanja).join(
            MasterRekeningBelanja,
            MasterRekeningBelanja.kode_rekening_belanja == Transaksi.kode_rekening
        ).where(
            Transaksi.kode_rekening != None, 
            Transaksi.kode_rekening != "", 
            Transaksi.no_bukti != None, 
            Transaksi.no_bukti != ""
        )

        if str(thp).strip() in ("1", "2"):
            thp_map = {"1": "THP I", "2": "THP II"}
            target_thp = thp_map[str(thp).strip()]
            base_stmt = base_stmt.join(Kwitansi, Kwitansi.no_bukti == Transaksi.no_bukti).where(Kwitansi.thp == target_thp)

        result = await db.execute(base_stmt)
        rows = result.all()

        # 2. === HITUNG TOTAL ===
        rekap_totals = {}
        for trans, master in rows:
            base_rekap = (master.rekap_rekening_belanja or "").strip()
            if base_rekap in ("KIB B", "KIB E"):
                threshold = float(master.nilai_kapitalisasi_belanja or 0)
                harga = float(trans.harga_satuan or 0)
                label = f"{base_rekap} Kapitalisasi" if harga >= threshold else f"{base_rekap} Non Kapitalisasi"
            else:
                label = base_rekap or "Unspecified"

            key_code = generate_placeholder_code(label)
            pel = float(trans.pengeluaran or 0)
            rekap_totals[key_code] = rekap_totals.get(key_code, 0.0) + pel

        # 3. === PROSES EXCEL ===
        content = await file.read()
        wb = openpyxl.load_workbook(io.BytesIO(content))

        for sheet in wb.worksheets:
            for row in sheet.iter_rows():
                for cell in row:
                    if isinstance(cell.value, str):
                        cell_text = cell.value.strip().upper()
                        if cell_text in rekap_totals:
                            cell.value = rekap_totals[cell_text]
                            cell.number_format = '#,##0' 

        # 4. === SIMPAN ===
        output = io.BytesIO()
        wb.save(output)
        output.seek(0)

        original_name = file.filename
        
        # --- PERBAIKAN REGEX DI SINI ---
        # Menambahkan backslash sebelum tanda minus: [_\-\s]
        clean_name = re.sub(r'[_\-\s]*template[_\-\s]*', '', original_name, flags=re.IGNORECASE)

        if len(clean_name) < 5: 
            clean_name = f"Rekap_Result_{thp}.xlsx"

        return StreamingResponse(
            output,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename={clean_name}"}
        )

    except Exception as e:
        print(f"Error generating excel: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Gagal memproses Excel: {str(e)}")


@api_router.delete("/master-kegiatan/{kode_kegiatan}")
async def delete_master_kegiatan(
    kode_kegiatan: str,
    db: AsyncSession = Depends(get_db)
):
    """Delete master kegiatan"""
    try:
        stmt = select(MasterKegiatan).where(MasterKegiatan.kode_kegiatan == kode_kegiatan)
        result = await db.execute(stmt)
        kegiatan = result.scalar_one_or_none()
        
        if not kegiatan:
            raise HTTPException(status_code=404, detail="Master kegiatan tidak ditemukan")
        
        await db.delete(kegiatan)
        await db.commit()
        return {"status": "success", "message": "Master kegiatan berhasil dihapus"}
    except HTTPException:
        raise
    except Exception as e:
        await db.rollback()
        logger.error(f"Error deleting master kegiatan: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error deleting master kegiatan: {str(e)}")

# --- GET detail kwitansi ---
@api_router.get("/kwitansi/{kwitansi_id}")
async def get_kwitansi_detail(
    kwitansi_id: int,
    db: AsyncSession = Depends(get_db)
):
    # =========================
    # 1. Ambil data Kwitansi
    # =========================
    result = await db.execute(
        select(Kwitansi).where(Kwitansi.id == kwitansi_id)
    )
    kw = result.scalar_one_or_none()

    if not kw:
        raise HTTPException(status_code=404, detail="Kwitansi tidak ditemukan")

    # =========================
    # 2. Ambil transaksi (uraian)
    # =========================
    transaksi_list = []
    if kw.no_bukti:
        transaksi_result = await db.execute(
            select(Transaksi).where(Transaksi.no_bukti == kw.no_bukti)
        )
        transaksi_list = transaksi_result.scalars().all()

    uraian_list = [
        {
            "nama_barang": t.uraian,
            "volume": t.volume or 0,
            "satuan": t.satuan or "",
            "harga_satuan": t.harga_satuan or 0,
            "pengeluaran": t.pengeluaran or 0
        }
        for t in transaksi_list
    ]

    # =========================
    # 3. PROSES FOTO BUKTI
    # =========================
    try:
        raw_foto = json.loads(kw.foto_bukti or "[]")
    except Exception:
        raw_foto = []

    # Grouping foto berdasarkan jenis
    foto_grouped = {}

    for item in raw_foto:
        # Support data lama (string)
        if isinstance(item, str):
            jenis = "barang"
            path = item

        # Support data baru (object)
        elif isinstance(item, dict):
            jenis = item.get("jenis", "barang")
            path = item.get("path")

        else:
            continue

        if not path:
            continue

        foto_grouped.setdefault(jenis, []).append(path)

    # =========================
    # 4. RESPONSE FINAL
    # =========================
    return {
        "status": "success",
        "data": {
            "id": kw.id,
            "nomor_kwitansi": kw.nomor_kwitansi,
            "no_bukti": kw.no_bukti,
            "no_bast": kw.no_bast,
            "kode_kegiatan": kw.kode_kegiatan,
            "nama_kegiatan": kw.nama_kegiatan,
            "tanggal": kw.tanggal,
            "tanggal_nota": kw.tanggal_nota,
            "nama_toko": kw.nama_toko,
            "npwp_toko": kw.npwp_toko,
            "alamat_toko": kw.alamat_toko,
            "no_telp_toko": kw.no_telp_toko or "",
            "no_nota": kw.no_nota or "",
            "jenis_belanja": getattr(kw, "jenis_belanja", None) or "umum",
            "data_lampiran": _data_lampiran_dict(kw),

            # Data transaksi
            "uraian": uraian_list,

            # ✅ FOTO TERKELOMPOK
            # contoh:
            # {
            #   "barang": [...],
            #   "proses": [...],
            #   "sesudah": [...]
            # }
            "foto_bukti": foto_grouped
        }
    }



@api_router.delete("/kwitansi/{kwitansi_id}/foto/{foto_index}")
async def delete_foto_kwitansi(
    kwitansi_id: int,
    foto_index: int,
    db: AsyncSession = Depends(get_db)
):
    # =========================
    # 1. Ambil kwitansi
    # =========================
    result = await db.execute(
        select(Kwitansi).where(Kwitansi.id == kwitansi_id)
    )
    kw = result.scalar_one_or_none()

    if not kw:
        raise HTTPException(status_code=404, detail="Kwitansi tidak ditemukan")

    # =========================
    # 2. Parse foto_bukti
    # =========================
    try:
        foto_list = json.loads(kw.foto_bukti or "[]")
    except Exception:
        foto_list = []

    if not isinstance(foto_list, list):
        foto_list = []

    if foto_index < 0 or foto_index >= len(foto_list):
        raise HTTPException(status_code=400, detail="Index foto tidak valid")

    # =========================
    # 3. Ambil path foto
    # =========================
    foto_item = foto_list[foto_index]

    # Support data lama & baru
    if isinstance(foto_item, str):
        foto_path = foto_item
    elif isinstance(foto_item, dict):
        foto_path = foto_item.get("path")
    else:
        foto_path = None

    # =========================
    # 4. Hapus file fisik
    # =========================
    if foto_path:
        # Pastikan path relatif ke root project
        full_path = Path(foto_path)

        if full_path.exists() and full_path.is_file():
            try:
                full_path.unlink()
            except Exception as e:
                logger.error(f"Gagal hapus file {full_path}: {e}")

    # =========================
    # 5. Hapus dari list & update DB
    # =========================
    foto_list.pop(foto_index)
    kw.foto_bukti = json.dumps(foto_list)

    await db.commit()

    # =========================
    # 6. Response
    # =========================
    return {
        "status": "success",
        "message": "Foto berhasil dihapus",
        "sisa_foto": len(foto_list)
    }


@api_router.post("/kwitansi/{kwitansi_id}/update-detail")
async def update_kwitansi_detail(kwitansi_id: int, payload: dict, db: AsyncSession = Depends(get_db)):
    # 1. Ambil data kwitansi
    result = await db.execute(select(Kwitansi).where(Kwitansi.id == kwitansi_id))
    kw = result.scalars().first()
    if not kw:
        raise HTTPException(status_code=404, detail="Kwitansi tidak ditemukan")

    # 2. Ambil semua transaksi asli untuk backup data keuangan per baris
    trans_res = await db.execute(
        select(Transaksi).where(Transaksi.no_bukti == kw.no_bukti).order_by(Transaksi.id.asc())
    )
    old_transaksi = trans_res.scalars().all()
    
    if not old_transaksi:
        raise HTTPException(status_code=404, detail="Data transaksi tidak ditemukan")

    tanggal_nota_str = payload.get("tanggal_nota", "")
    tanggal_nota_value = None
    if tanggal_nota_str:
        tanggal_nota_text = str(tanggal_nota_str).strip()
        try:
            tanggal_nota_value = datetime.fromisoformat(
                tanggal_nota_text.replace("Z", "+00:00")
            ).date()
        except ValueError:
            for date_format in ("%d-%m-%Y", "%d/%m/%Y", "%Y/%m/%d"):
                try:
                    tanggal_nota_value = datetime.strptime(
                        tanggal_nota_text, date_format
                    ).date()
                    break
                except ValueError:
                    continue
        if tanggal_nota_value is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Format tanggal nota tidak valid. Gunakan YYYY-MM-DD "
                    "atau DD-MM-YYYY."
                ),
            )

    jenis_belanja = payload.get("jenis_belanja", "umum")
    if not isinstance(jenis_belanja, str) or jenis_belanja not in JENIS_BELANJA_VALID:
        raise HTTPException(
            status_code=400,
            detail=f"Jenis belanja tidak valid: {jenis_belanja!r}",
        )
    data_lampiran = payload.get("data_lampiran", {})
    if not isinstance(data_lampiran, dict):
        raise HTTPException(
            status_code=400,
            detail="Data lampiran harus berupa objek JSON.",
        )

    # 3. Update data identitas di tabel Kwitansi
    kw.nama_kegiatan = payload.get("nama_kegiatan", kw.nama_kegiatan)
    kw.no_bast = payload.get("no_bast", "")

    if tanggal_nota_value is not None:
        kw.tanggal_nota = tanggal_nota_value
    
    kw.nama_toko = payload.get("nama_toko", kw.nama_toko or "")
    kw.npwp_toko = payload.get("npwp_toko", kw.npwp_toko or "")
    kw.alamat_toko = payload.get("alamat_toko", kw.alamat_toko or "")
    kw.no_telp_toko = payload.get("no_telp_toko", kw.no_telp_toko or "")
    kw.no_nota = payload.get("no_nota", kw.no_nota or "")
    kw.jenis_belanja = jenis_belanja
    kw.data_lampiran = json.dumps(data_lampiran, ensure_ascii=False)

    # 4. Sinkronisasi Uraian tanpa menghilangkan nominal
    new_uraian_list = payload.get("uraian") or []

    # Hapus transaksi lama tapi backup di memori
    await db.execute(delete(Transaksi).where(Transaksi.no_bukti == kw.no_bukti))
    
    for i, item in enumerate(new_uraian_list):
        source = old_transaksi[i] if i < len(old_transaksi) else None
        
        # Gunakan tanggal kwitansi yang sudah diparse, fallback aman ke kw.tanggal_nota
        t = Transaksi(
            no_bukti=kw.no_bukti,
            kode_kegiatan=kw.kode_kegiatan,
            tanggal=kw.tanggal_nota,
            uraian=item.get("nama_barang") or "",
            volume=item.get("volume") or 0,
            satuan=item.get("satuan") or "",
            harga_satuan=item.get("harga_satuan") or 0,
            kode_rekening=source.kode_rekening if source else old_transaksi[0].kode_rekening,
            nama_toko=kw.nama_toko or "",
            alamat_toko=kw.alamat_toko or "",
            no_telp_toko=kw.no_telp_toko or "",
            npwp_toko=kw.npwp_toko or "",
            no_nota=kw.no_nota or "",
            tanggal_nota=(
                kw.tanggal_nota.isoformat()
                if hasattr(kw.tanggal_nota, "isoformat")
                else kw.tanggal_nota or ""
            ),
            penerimaan=source.penerimaan if source else 0,
            pengeluaran=source.pengeluaran if source else 0,
            saldo=source.saldo if source else 0
        )
        db.add(t)

    db.add(kw)
    await db.commit()
    
    return {
        "status": "success",
        "message": f"Kwitansi '{kw.nama_kegiatan}' berhasil diperbarui tanpa mengubah nilai pengeluaran."
    }


@api_router.post("/kwitansi/{kwitansi_id}/upload-foto")
async def upload_foto_kwitansi(
    kwitansi_id: int,
    files: List[UploadFile] = File(...),
    jenis_foto: str = Form("barang"),  # ⬅⬅⬅ TAMBAHAN PENTING
    db: AsyncSession = Depends(get_db)
):
    """Validasi kategori, simpan gambar, lalu kaitkan dengan kwitansi."""
    # =========================
    # 1. Validasi jenis foto
    # =========================
    JENIS_VALID = [
        "barang", "kegiatan", "sebelum", "proses", "sesudah", "ktp",
        "qr_master", "kendaraan_stnk",
    ]
    if jenis_foto not in JENIS_VALID:
        raise HTTPException(
            status_code=400,
            detail=f"Jenis foto tidak valid. Pilihan: {', '.join(JENIS_VALID)}"
        )

    # =========================
    # 2. Validasi file
    # =========================
    if not files:
        raise HTTPException(status_code=400, detail="Tidak ada file diupload")

    if len(files) > 15:
        raise HTTPException(status_code=400, detail="Maksimal 15 foto")

    # =========================
    # 3. Ambil kwitansi
    # =========================
    result = await db.execute(
        select(Kwitansi).where(Kwitansi.id == kwitansi_id)
    )
    kwitansi = result.scalar_one_or_none()

    if not kwitansi:
        raise HTTPException(status_code=404, detail="Kwitansi tidak ditemukan")

    # =========================
    # 4. Folder upload
    # =========================
    kw_dir = UPLOAD_KWITANSI_DIR / str(kwitansi_id)
    kw_dir.mkdir(parents=True, exist_ok=True)

    foto_baru = []

    # =========================
    # 5. Simpan file
    # =========================
    for file in files:
        ext = os.path.splitext(file.filename)[1].lower()
        if ext not in [".jpg", ".jpeg", ".png"]:
            continue

        filename = f"{uuid.uuid4().hex}{ext}"
        filepath = kw_dir / filename

        with open(filepath, "wb") as f:
            f.write(await file.read())

        foto_baru.append({
            "path": f"uploads/kwitansi/{kwitansi_id}/{filename}",
            "jenis": jenis_foto
        })

    if not foto_baru:
        raise HTTPException(status_code=400, detail="Tidak ada file gambar valid")

    # =========================
    # 6. Gabung dengan foto lama (AMAN)
    # =========================
    foto_lama = []
    try:
        raw = json.loads(kwitansi.foto_bukti or "[]")
        for item in raw:
            if isinstance(item, str):
                foto_lama.append({
                    "path": item,
                    "jenis": "barang"  # default aman
                })
            elif isinstance(item, dict):
                foto_lama.append({
                    "path": item.get("path"),
                    "jenis": item.get("jenis", "barang")
                })
    except Exception:
        pass

    merged = foto_lama + foto_baru
    kwitansi.foto_bukti = json.dumps(merged)
    await db.commit()

    return {"status": "success", "message": "Foto berhasil diupload", "uploaded": len(foto_baru)}


# ===============================
# KOMPRESI GAMBAR HASIL GENERATE / UPLOAD
# ===============================
FOTO_MAX_DIMENSION_PX = 1200   # dimensi terbesar (lebar/tinggi) disamakan ke sini
FOTO_MAX_FILE_SIZE    = 350_000  # target ukuran file maks +/- 350 KB
FOTO_JPEG_QUALITY     = 82


def compress_image_bytes(data: bytes, filename_hint: str = "") -> tuple[bytes, str]:
    """Kompres gambar hasil generate/upload agar ukurannya proporsional dengan
    area tampilnya di dokumen (kop & lampiran PDF dirender maks ~70 mm tinggi).

    - Gambar yang lebih besar dari FOTO_MAX_DIMENSION_PX di-resize proporsional
      (LANCZOS) sehingga dimensinya menyesuaikan ruang cetak pada kop/lampiran.
    - Transparansi (PNG RGBA/P) dibuang dengan menempelkan latar putih.
    - Disimpan sebagai JPEG; jika masih melebihi FOTO_MAX_FILE_SIZE, kualitas
      dan dimensi diturunkan bertahap sampai cukup kecil.

    Mengembalikan (bytes_hasil, ekstensi_baru). Jika terjadi error, data asli
    dikembalikan apa adanya agar proses utama tidak gagal.
    """
    try:
        img = Image.open(io.BytesIO(data))
        img.load()

        # Buang kanal alpha / palette transparan -> latar putih
        if img.mode in ("RGBA", "LA", "P"):
            has_alpha = (
                img.mode in ("RGBA", "LA")
                or (img.mode == "P" and "transparency" in img.info)
            )
            if has_alpha:
                bg = Image.new("RGB", img.size, (255, 255, 255))
                rgba = img.convert("RGBA")
                bg.paste(rgba, mask=rgba.split()[-1])
                img = bg
            else:
                img = img.convert("RGB")
        elif img.mode != "RGB":
            img = img.convert("RGB")

        # Resize proporsional jika dimensi asli jauh lebih besar dari area cetak
        w, h = img.size
        largest = max(w, h)
        if largest > FOTO_MAX_DIMENSION_PX:
            ratio = FOTO_MAX_DIMENSION_PX / float(largest)
            img = img.resize(
                (max(1, int(w * ratio)), max(1, int(h * ratio))),
                Image.LANCZOS,
            )

        # Simpan sebagai JPEG; turunkan kualitas lalu dimensi bila masih terlalu besar
        quality = FOTO_JPEG_QUALITY
        for _ in range(6):
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=quality, optimize=True)
            out = buf.getvalue()
            if len(out) <= FOTO_MAX_FILE_SIZE:
                return out, ".jpg"
            if quality > 60:
                quality -= 10
            else:
                w2, h2 = img.size
                img = img.resize(
                    (max(1, int(w2 * 0.85)), max(1, int(h2 * 0.85))),
                    Image.LANCZOS,
                )
                quality = FOTO_JPEG_QUALITY
        return out, ".jpg"
    except Exception as e:
        logger.warning("Gagal kompres gambar (%s): %s", filename_hint, e)
        return data, os.path.splitext(filename_hint)[1].lower() or ".jpg"


# ===============================
# NORMALISASI LOGO KOP (PEMDA / SATUAN PENDIDIKAN)
# ===============================
LOGO_MAX_DIMENSION_PX = 800     # logo kop dirender maks 24x20 mm; >800 px percuma
LOGO_MAX_FILE_SIZE    = 400_000 # target ukuran file logo +/- 400 KB


def normalize_logo_file(data: bytes) -> tuple[bytes, str]:
    """Normalisasi file logo kop agar tidak bermasalah saat dirender ke PDF/HTML.

    Masalah yang sering terjadi pada logo kop (pemda / satuan pendidikan):
    - File sangat besar (3000-5000 px) -> render lambat/memakan memori.
    - Format eksotis (TIFF/BMP/WEBM) -> FPDF/ReportLab gagal decode sehingga
      logo hilang di kop padahal preview web tampil (browser lebih toleran).
    - CMYK JPEG -> warna tertukar/terbalik saat dicetak.
    - GIF/APNG multi-frame atau mode aneh -> decode error.

    Solusi: validasi + resize proporsional (maks LOGO_MAX_DIMENSION_PX) lalu
    simpan ulang sebagai PNG RGBA (jika ada transparansi, supaya tetap bening
    di web & mask='auto' ReportLab bekerja benar) atau JPEG RGB (latar penuh).
    Mengembalikan (bytes_hasil, ekstensi_baru); raise ValueError bila file
    bukan gambar valid.
    """
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as e:
        raise ValueError(f"File bukan gambar yang valid: {e}")

    fmt = (img.format or "?").upper()
    w, h = img.size
    if w <= 0 or h <= 0:
        raise ValueError("Dimensi gambar tidak valid")

    # Deteksi transparansi sebelum konversi
    has_alpha = (
        img.mode in ("RGBA", "LA")
        or (img.mode == "P" and "transparency" in img.info)
    )
    if img.mode == "CMYK":
        img = img.convert("RGB")
    elif has_alpha:
        img = img.convert("RGBA")
    elif img.mode != "RGB":
        img = img.convert("RGB")

    # Resize proporsional bila jauh melebihi area cetak kop
    largest = max(w, h)
    if largest > LOGO_MAX_DIMENSION_PX:
        ratio = LOGO_MAX_DIMENSION_PX / float(largest)
        img = img.resize((max(1, int(w * ratio)), max(1, int(h * ratio))), Image.LANCZOS)

    buf = io.BytesIO()
    if has_alpha:
        # PNG mempertahankan transparansi; buang frame animasi dengan copy statis
        for _ in range(5):
            buf = io.BytesIO()
            img.save(buf, format="PNG", optimize=True)
            if len(buf.getvalue()) <= LOGO_MAX_FILE_SIZE:
                break
            w2, h2 = img.size
            img = img.resize((max(1, int(w2 * 0.8)), max(1, int(h2 * 0.8))), Image.LANCZOS)
        out_ext = ".png"
    else:
        quality = 90
        for _ in range(5):
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=quality, optimize=True)
            if len(buf.getvalue()) <= LOGO_MAX_FILE_SIZE:
                break
            quality -= 15
        out_ext = ".jpg"

    logger.info(
        "[LOGO] dinormalisasi: %s %dx%d -> %s %dx%d (%d KB)",
        fmt, w, h, out_ext, img.size[0], img.size[1], len(buf.getvalue()) // 1024,
    )
    return buf.getvalue(), out_ext


# --- 1. SCHEMAS (Pydantic) ---
class AIImageRequest(BaseModel):
    prompt_items: str  # Contoh: "Laptop Asus ROG" atau "Rapat koordinasi guru"
    jenis_foto: str    # Valid: "barang", "kegiatan", "sebelum", "proses", "sesudah"
    orientation: str = "landscape"  # "landscape" (4:3, pas utk lampiran kop) atau "portrait" (3:4)
    provider: str = "pollinations"
    model: str = ""
    api_key: str = ""
    api_endpoint: str = ""

# --- 2. HELPER: PROMPT ENGINEER ---
def build_professional_prompt(item: str, jenis: str) -> str:
    """
    Membuat prompt spesifik agar hasil terlihat seperti foto dokumentasi asli Indonesia.
    Menggunakan model FLUX untuk realisme.
    """
    base_style = (
        "realistic photo taken with smartphone camera, "
        "poor indoor lighting, authentic amateur photography, "
        "no filter, slight motion blur, documentary style, "
        "high texture, taken in Indonesia, "
    )
    
    if jenis == "kegiatan" or jenis == "proses":
        # Prompt untuk aktivitas (ada orang, suasana kantor)
        return (
            f"{base_style} "
            f"wide shot of people doing {item}, "
            f"people wearing Indonesian civil servant uniform or Batik shirt, "
            f"busy office background, piles of paper on tables, "
            f"candid shot, messy real environment, "
            f"faces slightly blurred for privacy."
        )
    else:
        # Prompt untuk barang (benda mati di meja)
        return (
            f"{base_style} "
            f"close up photo of {item}, "
            f"placed on a scratched wooden office desk, "
            f"background is a blurry administration room wall, "
            f"top down angle or eye level, "
            f"sharp focus on the object, real object proportions."
        )

# --- 3. ENDPOINT ---
@api_router.post("/kwitansi/{kwitansi_id}/generate-ai-image")
async def generate_ai_image(
    kwitansi_id: int,
    request: AIImageRequest,
    db: AsyncSession = Depends(get_db)  # Pastikan ini sesuai dependency injection Anda
):
    # A. Validasi Input
    JENIS_VALID = ["barang", "kegiatan", "sebelum", "proses", "sesudah"]
    if request.jenis_foto not in JENIS_VALID:
        raise HTTPException(status_code=400, detail=f"Jenis foto harus salah satu dari: {JENIS_VALID}")

    # B. Cek Data di Database
    result = await db.execute(select(Kwitansi).where(Kwitansi.id == kwitansi_id))
    kwitansi = result.scalar_one_or_none()
    
    if not kwitansi:
        raise HTTPException(status_code=404, detail="Kwitansi tidak ditemukan")

    # C. Siapkan Folder
    kw_dir = UPLOAD_KWITANSI_DIR / str(kwitansi_id)
    kw_dir.mkdir(parents=True, exist_ok=True)

    try:
        # D. Generate Prompt & URL
        clean_prompt = build_professional_prompt(request.prompt_items, request.jenis_foto)
        
        # Dimensi hasil disesuaikan dengan area tampil foto pada kop/lampiran PDF
        orientation = (getattr(request, "orientation", None) or "landscape").lower()
        if orientation == "portrait":
            gen_w, gen_h = 480, 640   # 3:4 -> foto lebih tinggi (dokumentasi orang)
        else:
            gen_w, gen_h = 640, 480   # 4:3 -> landscape, pas untuk lampiran/kop

        provider = request.provider.strip().lower()
        if provider not in {
            "pollinations",
            "huggingface",
            "gemini",
            "openai",
            "custom",
        }:
            raise HTTPException(
                status_code=400,
                detail="Provider AI gambar tidak dikenal.",
            )

        model = request.model.strip()[:160]
        api_key = request.api_key.strip()
        headers = {"Accept": "image/*, application/json"}
        payload = None
        query_params = None

        if provider == "pollinations":
            model = model or "flux"
            api_url = (
                "https://gen.pollinations.ai/image/"
                f"{quote(clean_prompt, safe='')}"
            )
            query_params = {
                "model": model,
                "width": gen_w,
                "height": gen_h,
                "nologo": "true",
            }
            api_key = api_key or os.environ.get("POLLINATIONS_API_KEY", "")
            if not api_key:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Pollinations memerlukan secret API key berawalan sk_. "
                        "Buat atau kelola key di https://enter.pollinations.ai/keys."
                    ),
                )
            if api_key.startswith("pk_"):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "App Key Pollinations berawalan pk_ tidak dapat dipakai "
                        "langsung. Gunakan secret key berawalan sk_."
                    ),
                )
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
        elif provider == "huggingface":
            model = model or "black-forest-labs/FLUX.1-schnell"
            api_key = (
                api_key
                or os.environ.get("HUGGINGFACE_TOKEN", "")
                or os.environ.get("HF_TOKEN", "")
            )
            if not api_key:
                raise HTTPException(
                    status_code=400,
                    detail="Masukkan token Hugging Face pada pengaturan provider AI.",
                )
            api_url = "https://router.huggingface.co/nscale/v1/images/generations"
            headers["Content-Type"] = "application/json"
            payload = {
                "prompt": clean_prompt,
                "model": model,
                "n": 1,
                "size": f"{gen_w}x{gen_h}",
                "response_format": "b64_json",
            }
            headers["Authorization"] = f"Bearer {api_key}"
        elif provider == "gemini":
            model = model or "gemini-nano-banana-2.1"
            api_key = api_key or os.environ.get("GEMINI_API_KEY", "")
            if not api_key:
                raise HTTPException(
                    status_code=400,
                    detail="Masukkan API key Google AI Studio pada pengaturan provider AI.",
                )
            api_url = "https://generativelanguage.googleapis.com/v1beta/interactions"
            headers["Content-Type"] = "application/json"
            headers["x-goog-api-key"] = api_key
            payload = {
                "model": model,
                "input": clean_prompt,
            }
        elif provider == "openai":
            model = model or "gpt-image-2.5-flare"
            api_key = api_key or os.environ.get("OPENAI_API_KEY", "")
            if not api_key:
                raise HTTPException(
                    status_code=400,
                    detail="Masukkan OpenAI API key pada pengaturan provider AI.",
                )
            api_url = "https://api.openai.com/v1/images/generations"
            headers["Authorization"] = f"Bearer {api_key}"
            headers["Content-Type"] = "application/json"
            payload = {
                "prompt": clean_prompt,
                "model": model,
                "n": 1,
                "size": "1024x1536" if orientation == "portrait" else "1536x1024",
                "output_format": "png",
            }
        else:
            model = model or "black-forest-labs/FLUX.1-schnell"
            api_url = request.api_endpoint.strip()
            parsed_endpoint = urlparse(api_url)
            if (
                parsed_endpoint.scheme not in {"https", "http"}
                or not parsed_endpoint.hostname
                or parsed_endpoint.username
                or parsed_endpoint.password
                or (
                    parsed_endpoint.scheme == "http"
                    and parsed_endpoint.hostname.lower()
                    not in {"localhost", "127.0.0.1", "::1"}
                )
            ):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Endpoint kustom harus berupa URL HTTPS (HTTP hanya "
                        "diizinkan untuk localhost)."
                    ),
                )
            if not api_key:
                raise HTTPException(
                    status_code=400,
                    detail="Masukkan API key provider kustom.",
                )
            headers["Authorization"] = f"Bearer {api_key}"
            headers["Content-Type"] = "application/json"
            payload = {
                "prompt": clean_prompt,
                "model": model,
                "n": 1,
                "size": f"{gen_w}x{gen_h}",
                "response_format": "b64_json",
            }

        image_bytes = None
        last_error = ""
        failure_status = 502

        for attempt in range(1, 4):
            try:
                async with httpx.AsyncClient() as client:
                    if provider == "pollinations":
                        candidate = await client.get(
                            api_url,
                            headers=headers,
                            params=query_params,
                            timeout=90.0,
                        )
                    else:
                        candidate = await client.post(
                            api_url,
                            headers=headers,
                            json=payload,
                            timeout=90.0,
                        )
                candidate.raise_for_status()

                content_type = candidate.headers.get("content-type", "").lower()
                if content_type.startswith("image/"):
                    generated_image = candidate.content
                else:
                    try:
                        result_data = candidate.json()
                        if provider == "gemini":
                            encoded_image = result_data["output_image"]["data"]
                        else:
                            encoded_image = result_data["data"][0]["b64_json"]
                        generated_image = base64.b64decode(encoded_image, validate=True)
                    except (IndexError, KeyError, TypeError, ValueError):
                        generated_image = b""

                if len(generated_image) > 3000:
                    image_bytes = generated_image
                    break

                last_error = "Provider tidak mengembalikan data gambar yang valid."
                logger.warning(
                    "AI generate percobaan %d bukan gambar valid (content-type=%s)",
                    attempt,
                    content_type or "-",
                )
            except httpx.TimeoutException:
                last_error = f"Waktu habis saat menghubungi provider {provider}."
                failure_status = 504
                logger.warning("AI generate percobaan %d: timeout", attempt)
                if attempt < 3:
                    await asyncio.sleep(1)
            except httpx.ConnectError as e:
                last_error = (
                    f"Gagal terhubung ke provider {provider}. "
                    "Periksa koneksi internet dan DNS pada server."
                )
                failure_status = 503
                logger.warning("AI generate percobaan %d: koneksi gagal: %s", attempt, e)
                if attempt < 3:
                    await asyncio.sleep(1)
            except httpx.HTTPStatusError as e:
                status_code = e.response.status_code
                if status_code == 429:
                    try:
                        error_data = e.response.json().get("error", {})
                    except (ValueError, AttributeError):
                        error_data = {}
                    provider_message = (
                        error_data.get("message", "")
                        if isinstance(error_data, dict)
                        else ""
                    )
                    provider_message = str(provider_message).strip()[:500]
                    if provider == "gemini":
                        last_error = (
                            "Google Gemini membatasi permintaan ini. Periksa "
                            "kuota RPM/IPM/RPD dan tier proyek di "
                            "https://aistudio.google.com/rate-limit."
                        )
                    else:
                        last_error = (
                            f"Provider {provider} membatasi jumlah permintaan "
                            "atau kuota penggunaan."
                        )
                    if provider_message:
                        last_error += f" Detail provider: {provider_message}"
                    logger.warning(
                        "AI generate ditolak karena rate limit provider %s: %s",
                        provider,
                        provider_message or "pesan detail tidak tersedia",
                    )
                    raise HTTPException(
                        status_code=429,
                        detail=f"Layanan AI gambar {provider} terkena batas kuota. "
                        f"{last_error}",
                    ) from e

                if status_code == 503 or status_code >= 500:
                    last_error = (
                        f"Provider {provider} sementara tidak tersedia (HTTP {status_code})."
                    )
                    failure_status = 503
                    logger.warning("AI generate percobaan %d: %s", attempt, last_error)
                    if attempt < 3:
                        await asyncio.sleep(2)
                    continue

                if status_code in (401, 403):
                    try:
                        error_data = e.response.json().get("error", {})
                    except (ValueError, AttributeError):
                        error_data = {}
                    provider_message = (
                        error_data.get("message", "")
                        if isinstance(error_data, dict)
                        else ""
                    )
                    provider_message = str(provider_message).strip()[:500]
                    if provider == "pollinations":
                        auth_help = (
                            "Gunakan secret key Pollinations berawalan sk_ "
                            "(bukan App Key pk_), dan pastikan key belum "
                            "kedaluwarsa serta memiliki izin/model dan budget "
                            "yang cukup. Kelola secret key di "
                            "https://enter.pollinations.ai/keys."
                        )
                        if provider_message:
                            auth_help += f" Detail provider: {provider_message}"
                        raise HTTPException(
                            status_code=502,
                            detail=(
                                "Pollinations menolak autentikasi atau izin "
                                f"provider. {auth_help}"
                            ),
                        ) from e

                    raise HTTPException(
                        status_code=502,
                        detail=(
                            f"Provider {provider} menolak API key atau belum "
                            "memberikan akses untuk model ini."
                        ),
                    ) from e

                if status_code == 402:
                    raise HTTPException(
                        status_code=402,
                        detail=(
                            f"Provider {provider} meminta kredit/pembayaran. "
                            "Periksa billing, kuota, saldo, atau budget API key provider."
                        ),
                    ) from e

                last_error = (
                    f"Permintaan ditolak provider {provider} (HTTP {status_code})."
                )
                logger.warning("AI generate percobaan %d: %s", attempt, last_error)
                break
            except httpx.HTTPError as e:
                last_error = f"Terjadi gangguan jaringan saat menghubungi {provider}."
                failure_status = 503
                logger.warning("AI generate percobaan %d error: %s", attempt, e)
                if attempt < 3:
                    await asyncio.sleep(1)

        if image_bytes is None:
            raise HTTPException(
                status_code=failure_status,
                detail=(
                    f"Layanan AI gambar {provider} gagal memproses permintaan. "
                    f"{last_error}"
                ),
            )

        # Validasi hasil benar-benar gambar yang bisa dibaca PIL sebelum disimpan
        try:
            probe = Image.open(io.BytesIO(image_bytes))
            probe.verify()
        except Exception as e:
            logger.error("Respons AI bukan gambar valid: %s", e)
            raise HTTPException(
                status_code=502,
                detail="Layanan AI mengembalikan data yang bukan gambar valid, coba lagi.",
            )

        # F. Kompres & sesuaikan dimensi gambar, lalu simpan ke Disk
        compressed, ext = compress_image_bytes(image_bytes, "generate.jpg")
        filename = f"ai_{request.jenis_foto}_{uuid.uuid4().hex[:8]}{ext}"
        filepath = kw_dir / filename

        with open(filepath, "wb") as f:
            f.write(compressed)

        logger.info(
            "AI image saved: %s (%d bytes -> %d bytes setelah kompres)",
            filename, len(image_bytes), len(compressed),
        )

        # G. Update Database (JSON Append)
        foto_list = []
        if kwitansi.foto_bukti:
            try:
                raw_data = json.loads(kwitansi.foto_bukti)
                # Normalisasi data lama ke format dict
                for item in raw_data:
                    if isinstance(item, str):
                        foto_list.append({"path": item, "jenis": "barang", "source": "manual"})
                    elif isinstance(item, dict):
                        foto_list.append(item)
            except json.JSONDecodeError:
                foto_list = []

        # Tambah foto baru
        new_photo_entry = {
            "path": f"uploads/kwitansi/{kwitansi_id}/{filename}",
            "jenis": request.jenis_foto,
            "source": "ai",
            "prompt_used": request.prompt_items
        }
        foto_list.append(new_photo_entry)

        kwitansi.foto_bukti = json.dumps(foto_list)
        await db.commit()
        await db.refresh(kwitansi)

        return {
            "status": "success",
            "message": "Gambar berhasil digenerate",
            "data": new_photo_entry
        }

    except HTTPException:
        await db.rollback()
        raise
    except httpx.TimeoutException as e:
        await db.rollback()
        logger.warning("AI generate timeout: %s", e)
        raise HTTPException(
            status_code=504,
            detail="Waktu habis saat menghubungi layanan AI gambar.",
        ) from e
    except Exception as e:
        await db.rollback()
        logger.exception("Gagal generate gambar AI untuk kwitansi %s", kwitansi_id)
        raise HTTPException(status_code=500, detail=f"Internal Server Error: {str(e)}")

@api_router.post("/kwitansi/manual")
async def create_manual_kwitansi(
    no_bukti: str = Form(...),
    kode_kegiatan: str = Form(""),
    kode_rekening: str = Form(""),
    tanggal: str = Form(None),
    tanggal_nota: str = Form(""),
    no_bast: str = Form(""),
    nama_toko: str = Form(""),
    npwp_toko: str = Form(""),
    alamat_toko: str = Form(""),
    no_telp_toko: str = Form(""),
    no_nota: str = Form(""),
    uraian_json: str = Form(...),
    files: List[UploadFile] = File(None),
    jenis_foto: str = Form("barang"),
    db: AsyncSession = Depends(get_db)
):
    """Validate form data, create one transaksi per detail row, then save the kwitansi and photos.

    Each detail may include its own kode_rekening. The top-level kode_rekening remains
    available as a fallback for older clients that send a single account code.
    """
    try:
        if not no_bukti or not no_bukti.strip():
            raise HTTPException(status_code=400, detail="no_bukti is required")

        try:
            uraian = json.loads(uraian_json)
            if not isinstance(uraian, list) or len(uraian) == 0:
                raise ValueError()
        except Exception:
            raise HTTPException(status_code=400, detail="uraian_json harus berupa JSON array yang valid dan tidak kosong")

        if any(not isinstance(item, dict) for item in uraian):
            raise HTTPException(status_code=400, detail="Setiap rincian belanja harus berupa objek yang valid")

        # Validate all row codes together so mixed account codes are supported.
        detail_account_codes = [
            str(item.get("kode_rekening") or "").strip()
            or str(kode_rekening or "").strip()
            for item in uraian
        ]
        requested_account_codes = {code for code in detail_account_codes if code}
        if requested_account_codes:
            result = await db.execute(
                select(MasterRekeningBelanja.kode_rekening_belanja).where(
                    MasterRekeningBelanja.kode_rekening_belanja.in_(requested_account_codes)
                )
            )
            known_account_codes = set(result.scalars().all())
            unknown_account_codes = requested_account_codes - known_account_codes
            if unknown_account_codes:
                raise HTTPException(
                    status_code=400,
                    detail="Kode rekening tidak ditemukan di master: "
                    + ", ".join(sorted(unknown_account_codes)),
                )

        total_pengeluaran = 0.0
        transaksi_objs = []
        for item, detail_account_code in zip(uraian, detail_account_codes):
            nama_barang = item.get("nama_barang") or item.get("uraian") or ""
            volume = float(item.get("volume") or 0)
            satuan = item.get("satuan") or ""
            harga_satuan = float(item.get("harga_satuan") or 0)
            pengeluaran = float(item.get("pengeluaran") or 0)

            t = Transaksi(
                tanggal=tanggal or (item.get("tanggal") or ""),
                kode_kegiatan=kode_kegiatan or "",
                kode_rekening=detail_account_code,
                no_bukti=no_bukti,
                uraian=nama_barang,
                volume=volume,
                satuan=satuan,
                harga_satuan=harga_satuan,
                penerimaan=0,
                pengeluaran=pengeluaran,
            )
            db.add(t)
            transaksi_objs.append(t)
            total_pengeluaran += pengeluaran

        await db.commit()

        # Determine tanggal/thp/tahun for kwitansi
        tanggal_for_kw = None
        for t in transaksi_objs:
            if t.tanggal:
                try:
                    parsed = parse_date(t.tanggal, dayfirst=True)
                    tanggal_for_kw = parsed if not tanggal_for_kw or parsed < tanggal_for_kw else tanggal_for_kw
                except Exception:
                    pass
        if not tanggal_for_kw and tanggal:
            try:
                tanggal_for_kw = parse_date(tanggal, dayfirst=True)
            except Exception:
                tanggal_for_kw = None

        if tanggal_for_kw:
            bulan = tanggal_for_kw.month
            tahun = tanggal_for_kw.year
            thp = "THP I" if bulan <= 6 else "THP II"
        else:
            thp = ""
            tahun = ""

        # Resolve nama_kegiatan from master_kegiatan if possible
        nama_kegiatan = ""
        if kode_kegiatan:
            r = await db.execute(select(MasterKegiatan).where(MasterKegiatan.kode_kegiatan == kode_kegiatan))
            mk = r.scalar_one_or_none()
            if mk:
                nama_kegiatan = mk.nama_kegiatan

        nomor_kwitansi = f"{no_bukti}/{kode_kegiatan or '-'} /{thp}/{tahun}" if thp and tahun else None

        kw = Kwitansi(
            nomor_kwitansi=nomor_kwitansi or (no_bukti),
            no_bukti=no_bukti,
            kode_kegiatan=kode_kegiatan or "",
            nama_kegiatan=nama_kegiatan or "",
            tanggal=(tanggal_for_kw.strftime("%d-%m-%Y") if tanggal_for_kw else (tanggal or "")),
            thp=thp,
            tahun=str(tahun) if tahun else "",
            jumlah=total_pengeluaran,
            tanggal_nota=tanggal_nota or "",
            no_bast=no_bast or "",
            nama_toko=nama_toko or "",
            npwp_toko=npwp_toko or "",
            alamat_toko=alamat_toko or "",
            no_telp_toko=no_telp_toko or "",
            no_nota=no_nota or "",
            foto_bukti=json.dumps([]),
        )

        db.add(kw)
        await db.commit()
        await db.refresh(kw)

        # Handle file uploads (if any)
        foto_baru = []
        if files:
            # reuse upload logic
            kw_dir = UPLOAD_KWITANSI_DIR / str(kw.id)
            kw_dir.mkdir(parents=True, exist_ok=True)
            for file in files:
                ext = os.path.splitext(file.filename)[1].lower()
                if ext not in [".jpg", ".jpeg", ".png"]:
                    continue
                filename = f"{uuid.uuid4().hex}{ext}"
                filepath = kw_dir / filename
                with open(filepath, "wb") as f:
                    f.write(await file.read())
                foto_baru.append({"path": f"uploads/kwitansi/{kw.id}/{filename}", "jenis": jenis_foto})

            if foto_baru:
                raw_old = []
                try:
                    raw_old = json.loads(kw.foto_bukti or "[]")
                except Exception:
                    raw_old = []

                merged = []
                for it in raw_old:
                    if isinstance(it, str):
                        merged.append({"path": it, "jenis": "barang"})
                    elif isinstance(it, dict):
                        merged.append({"path": it.get("path"), "jenis": it.get("jenis", "barang")})
                merged.extend(foto_baru)
                kw.foto_bukti = json.dumps(merged)
                await db.commit()

        return {"status": "success", "message": "Kwitansi & transaksi berhasil dibuat", "kwitansi_id": kw.id, "nomor_kwitansi": kw.nomor_kwitansi}

    except HTTPException:
        await db.rollback()
        raise
    except Exception as e:
        await db.rollback()
        logger.error(f"Error creating manual kwitansi: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error creating manual kwitansi: {str(e)}")
    # =========================
    # 1. Validasi jenis foto
    # =========================
    JENIS_VALID = ["barang", "kegiatan", "sebelum", "proses", "sesudah"]
    if jenis_foto not in JENIS_VALID:
        raise HTTPException(
            status_code=400,
            detail=f"Jenis foto tidak valid. Pilihan: {', '.join(JENIS_VALID)}"
        )

    # =========================
    # 2. Validasi file
    # =========================
    if not files:
        raise HTTPException(status_code=400, detail="Tidak ada file diupload")

    if len(files) > 15:
        raise HTTPException(status_code=400, detail="Maksimal 15 foto")

    # =========================
    # 3. Ambil kwitansi
    # =========================
    result = await db.execute(
        select(Kwitansi).where(Kwitansi.id == kwitansi_id)
    )
    kwitansi = result.scalar_one_or_none()

    if not kwitansi:
        raise HTTPException(status_code=404, detail="Kwitansi tidak ditemukan")

    # =========================
    # 4. Folder upload
    # =========================
    kw_dir = UPLOAD_KWITANSI_DIR / str(kwitansi_id)
    kw_dir.mkdir(parents=True, exist_ok=True)

    foto_baru = []

    # =========================
    # 5. Simpan file
    # =========================
    for file in files:
        ext = os.path.splitext(file.filename)[1].lower()
        if ext not in [".jpg", ".jpeg", ".png"]:
            continue

        filename = f"{uuid.uuid4().hex}{ext}"
        filepath = kw_dir / filename

        with open(filepath, "wb") as f:
            f.write(await file.read())

        foto_baru.append({
            "path": f"uploads/kwitansi/{kwitansi_id}/{filename}",
            "jenis": jenis_foto
        })

    if not foto_baru:
        raise HTTPException(status_code=400, detail="Tidak ada file gambar valid")

    # =========================
    # 6. Gabung dengan foto lama (AMAN)
    # =========================
    foto_lama = []
    try:
        raw = json.loads(kwitansi.foto_bukti or "[]")
        for item in raw:
            if isinstance(item, str):
                foto_lama.append({
                    "path": item,
                    "jenis": "barang"  # default aman
                })
            elif isinstance(item, dict):
                foto_lama.append({
                    "path": item.get("path"),
                    "jenis": item.get("jenis", "barang")
                })
    except Exception:
        pass

    kwitansi.foto_bukti = json.dumps(foto_lama + foto_baru)
    await db.commit()

    # =========================
    # 7. Response
    # =========================
    return {
        "status": "success",
        "jenis": jenis_foto,
        "jumlah": len(foto_baru),
        "files": foto_baru
    }


# --- ENDPOINT BARU UNTUK LOGO & PEMDA ---

@api_router.post("/save-pemda")
async def save_pemda(
    nama_pemda: str = Form(...),
    nama_sekolah: str = Form(...),
    alamat_sekolah: str = Form(...),
    tempat_surat: str = Form(""),
    logo_pemda: UploadFile = File(None),
    logo_sekolah: UploadFile = File(None),
    db: AsyncSession = Depends(get_db)
):
    """Save Pemda data and logos using multipart/form-data"""
    try:
        # 1. Ambil data pengaturan ID 1
        stmt = select(Pengaturan).limit(1)
        result = await db.execute(stmt)
        pengaturan = result.scalar_one_or_none()

        if not pengaturan:
            pengaturan = Pengaturan()
            db.add(pengaturan)

        # 2. Update Field Teks
        pengaturan.nama_pemda = nama_pemda
        pengaturan.nama_sekolah = nama_sekolah
        pengaturan.alamat_sekolah = alamat_sekolah
        pengaturan.tempat_surat = tempat_surat

        # Log DB location & values for diagnostics
        try:
            from database import DB_PATH
            logger.info(f"save_pemda: menulis ke DB_PATH={DB_PATH} (exists={DB_PATH.exists()}) | tempat_surat='{pengaturan.tempat_surat}' | pengaturan.id={getattr(pengaturan, 'id', None)}")
        except Exception:
            logger.info("save_pemda: tidak dapat membaca DB_PATH untuk logging")

        # 3. Handle Upload Logo Pemda -> SIMPAN SEBAGAI BASE64 DI DB (metode baru).
        #    Base64 disimpan sebagai JPEG RGB terkompres: transparansi PNG sudah
        #    di-flatten ke latar putih, dimensi dibatasi maks LOGO_MAX_DIMENSION_PX,
        #    ukuran file dijaga <= LOGO_MAX_FILE_SIZE agar kolom DB tetap ringan.
        #    Rantai path/nama file/ekstensi di uploads dipangkas total — inilah
        #    akar bug "logo tidak muncul di kop". File di disk hanya artefak lama.
        if logo_pemda and logo_pemda.filename:
            raw = await logo_pemda.read()
            try:
                # VALIDASI awal (raise ValueError bila bukan gambar) + normalisasi
                normalize_logo_file(raw)
                # METODE BASE64: simpan sebagai JPEG RGB solid (transparansi sudah
                # di-flatten ke putih) agar selalu bisa dirender FPDF/ReportLab.
                pengaturan.logo_pemda = _raw_to_storage_b64(raw)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=f"Logo Pemda tidak valid: {e}")
            logger.info("save_pemda: logo_pemda disimpan sbg BASE64 (%d KB b64)", len(pengaturan.logo_pemda) // 1024)

        # 4. Handle Upload Logo Sekolah -> sama: BASE64 di DB
        if logo_sekolah and logo_sekolah.filename:
            raw = await logo_sekolah.read()
            try:
                normalize_logo_file(raw)
                # sama seperti logo pemda: BASE64 JPEG RGB solid siap render PDF
                pengaturan.logo_sekolah = _raw_to_storage_b64(raw)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=f"Logo Sekolah tidak valid: {e}")
            logger.info("save_pemda: logo_sekolah disimpan sbg BASE64 (%d KB b64)", len(pengaturan.logo_sekolah) // 1024)

        await db.commit()
        # Diagnostika: pastikan kolom DB benar-benar terisi base64.
        # Jika kosong, kop PDF/preview tidak akan menampilkan logo.
        try:
            def _ringkas(v):
                v = (v or "")
                if v.startswith("data:image/") or _looks_like_base64(v) or re.fullmatch(r"[A-Za-z0-9+/=\s]{120,}", v):
                    return f"BASE64({len(v)//1024} KB)"
                return repr(v[:40])
            logger.info(
                "save_pemda selesai | DB: logo_pemda=%s logo_sekolah=%s",
                _ringkas(getattr(pengaturan, "logo_pemda", "")),
                _ringkas(getattr(pengaturan, "logo_sekolah", "")),
            )
            if not (getattr(pengaturan, "logo_pemda", "") or getattr(pengaturan, "logo_sekolah", "")):
                logger.warning("save_pemda: TIDAK ADA logo yang tersimpan — simpan ulang file logo pada form Kop Surat.")
        except Exception as _e:
            logger.warning("save_pemda: diagnostika logo gagal: %s", _e)
        return {"status": "success", "message": "Data berhasil diperbarui"}

    except Exception as e:
        await db.rollback()
        logger.error(f"Error saving pemda: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@api_router.get("/get-pemda")
async def get_pemda(
    request: Request,
    db: AsyncSession = Depends(get_db)
):
    try:
        stmt = select(Pengaturan).limit(1)
        result = await db.execute(stmt)
        p = result.scalar_one_or_none()

        if not p:
            return {"status": "success", "data": None}

        base_url = str(request.base_url).rstrip("/")

        # METODE BARU: logo dikembalikan sebagai data URI base64 dari DB, sehingga
        # preview web TIDAK lagi bergantung pada serve file uploads/logos (rantai
        # path/ekstensi yang selama ini bikin logo hilang). Untuk data lama berupa
        # nama file/URL, load_logo_source membaca file & mengonversi ke base64
        # otomatis (plus migrasi kolom DB), dan fallback URL statis bila file pun
        # tidak ditemukan.
        def _logo_datauri(nama_db, col):
            src = load_logo_source(nama_db or "", col=col)
            if not src:
                return None
            s = str(src)
            if s.startswith("data:image/"):
                return s
            b64 = s.split(",", 1)[1] if s.startswith("data:") else s
            if _looks_like_base64(f"data:image/jpeg;base64,{b64}"):
                return f"data:image/jpeg;base64,{b64}"
            # masih berupa path -> sajikan lewat URL statis sebagai fallback
            return f"{base_url}/uploads/logos/{Path(s).name}"

        return {
            "status": "success",
            "data": {
                "nama_pemda": p.nama_pemda,
                "nama_sekolah": p.nama_sekolah,
                "alamat_sekolah": p.alamat_sekolah,
                "tempat_surat": p.tempat_surat or "",
                "logo_pemda": _logo_datauri(p.logo_pemda, "logo_pemda"),
                "logo_sekolah": _logo_datauri(p.logo_sekolah, "logo_sekolah"),
            }
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@api_router.get("/db-info")
async def db_info(request: Request):
    """Diagnostic endpoint: returns DB path, existence and pengaturan row"""
    try:
        from database import DB_PATH
        conn = None
        import sqlite3
        from pathlib import Path
        p = Path(DB_PATH)
        exists = p.exists()
        rows = None
        peng = None
        if exists:
            conn = sqlite3.connect(str(p))
            cur = conn.cursor()
            cur.execute("PRAGMA table_info('pengaturan')")
            cols = [r[1] for r in cur.fetchall()]
            cur.execute("SELECT * FROM pengaturan LIMIT 1")
            row = cur.fetchone()
            if row:
                peng = dict(zip(cols, row))
        if conn:
            conn.close()
        return {
            "status": "success",
            "db_path": str(p),
            "db_exists": exists,
            "pengaturan": peng
        }
    except Exception as e:
        logger.exception("db_info gagal: %s", e)
        raise HTTPException(status_code=500, detail=str(e))

def format_rupiah(value):
    """Format float ke string Rupiah"""
    try:
        return f"Rp {value:,.0f}".replace(",", ".")
    except:
        return "Rp 0"

def format_tanggal_indo(tanggal_str):
    """Mengubah 'YYYY-MM-DD' menjadi object datetime dan string indo"""
    # Asumsi format tanggal di database string 'YYYY-MM-DD'
    try:
        dt = datetime.strptime(tanggal_str, '%Y-%m-%d')
    except ValueError:
        # Fallback jika formatnya lain atau kosong
        dt = datetime.now()
    
    bulan_indo = ["", "Januari", "Februari", "Maret", "April", "Mei", "Juni", 
                  "Juli", "Agustus", "September", "Oktober", "November", "Desember"]
    
    hari_indo = {
        'Monday': 'Senin', 'Tuesday': 'Selasa', 'Wednesday': 'Rabu',
        'Thursday': 'Kamis', 'Friday': 'Jumat', 'Saturday': 'Sabtu', 'Sunday': 'Minggu'
    }
    
    return {
        'obj': dt,
        'hari': hari_indo[dt.strftime('%A')],
        'tanggal': str(dt.day),
        'bulan': bulan_indo[dt.month],
        'tahun': str(dt.year),
        'full': f"{dt.day} {bulan_indo[dt.month]} {dt.year}",
        'terbilang_tanggal': num2words(dt.day, lang='id').title(),
        'terbilang_tahun': num2words(dt.year, lang='id').title()
    }

class SPJFPDF(FPDF):
    """FPDF dengan kop surat standar: logo kiri/kanan (tinggi seragam),
    teks rata tengah di antara logo, garis ganda tebal-tipis.
    Kop digambar ulang otomatis di setiap halaman baru."""

    def __init__(self, kop_data=None, **kwargs):
        super().__init__(**kwargs)
        self.kop_data = kop_data  # dict atau None

    def _draw_kop(self):
        d = self.kop_data
        if not d:
            return
        # Diagnostika: catat status logo setiap render kop agar mudah melacak
        # "logo tidak muncul" (kosong di DB vs gagal decode). Sumber kini base64.
        for _key in ("logo_pemda", "logo_sekolah"):
            _val = d.get(_key)
            if not _val:
                logger.warning("KOP: %s kosong di DB (belum disimpan / resolve gagal)", _key)
            elif str(_val).startswith("data:") or _looks_like_base64(str(_val)) or re.fullmatch(r"[A-Za-z0-9+/=\s]{120,}", str(_val)):
                pass  # base64 — langsung dirender dari memori, tidak cek disk
            elif not Path(str(_val)).exists():
                logger.warning("KOP: file %s tidak ada di disk: %s", _key, _val)
        top_y = 12
        max_logo_h = 20
        # Margin kop menyesuaikan orientasi halaman (portrait/landscape)
        left_margin = self.l_margin
        right_margin = self.w - self.r_margin
        max_logo_w = 24

        def logo_exists(src):
            # Sumber bisa data URI base64 (siap render dari memori),
            # base64 telanjang, atau path file warisan.
            if not src:
                return False
            s = str(src)
            if s.startswith("data:image/") or _looks_like_base64(s):
                return True
            try:
                cand = base64.b64decode(s + "=" * (-len(s) % 4), validate=False)
                if len(cand) > 512:
                    with Image.open(io.BytesIO(cand)) as _t:
                        _t.verify()
                    return True
            except Exception:
                pass
            return Path(s).exists()

        # Area teks = ruang di antara kedua logo (simetris, khas kop resmi)
        pad_l = (max_logo_w + 4) if logo_exists(d.get('logo_pemda')) else 0
        pad_r = (max_logo_w + 4) if logo_exists(d.get('logo_sekolah')) else 0
        x_text_start = left_margin + pad_l
        x_text_end = right_margin - pad_r
        cx = (x_text_start + x_text_end) / 2.0
        text_w = max(x_text_end - x_text_start, 30)

        def place_logo(src, right_align=False):
            if not src:
                return
            try:
                label = "base64" if str(src).startswith("data:") or _looks_like_base64(str(src)) else Path(str(src)).name
                # METODE BARU: sumber logo adalah BASE64 dari DB (hasil load_logo_source),
                # dirender langsung dari memori — tanpa rantai path/nama file/ekstensi.
                # Flattening transparansi -> JPEG solid RGB via helper bersama.
                # PNG RGBA/P-transparan yang dikirim mentah ke fpdf2 bisa gagal
                # decode / tampil hitam; JPEG solid selalu aman. Buffer sudah
                # diberi nama palsu "logo.jpg" untuk deteksi ekstensi FPDF.
                out, (iw, ih) = flatten_image_to_jpeg(src)
                if iw <= 0 or ih <= 0:
                    return
                # Skala proporsional: batasi tinggi DAN lebar agar logo apa pun
                # tetap rapi di sudut kop dan tidak mendesak teks tengah
                scale = min(max_logo_h / ih, max_logo_w / iw)
                h, w = ih * scale, iw * scale
                y = top_y + (max_logo_h - h) / 2.0
                x = (right_margin - w) if right_align else left_margin
                # CATATAN PENTING: PyFPDF 1.7.2 (paket `fpdf` di
                # requirements.txt) TIDAK menerima objek BytesIO pada
                # self.image() — ia mengharapkan path/nama file dan gagal
                # dengan AttributeError "'_io.BytesIO' object has no
                # attribute 'rfind'". Ini penyebab "logo hilang" di kop
                # BAST/RAB. Solusi: tulis buffer JPEG ke file sementara lalu
                # berikan path-nya ke FPDF; file dihapus segera setelah render.
                # (Alternatif migrasi ke fpdf2 dimungkinkan, tetapi `fpdf` dan
                # `fpdf2` sama-sama memakai modul bernama `fpdf` — JANGAN
                # memasang keduanya bersamaan.)
                temp_path = None
                try:
                    with tempfile.NamedTemporaryFile(
                        prefix="spj-logo-",
                        suffix=".jpg",
                        delete=False,
                    ) as temp_file:
                        temp_file.write(out.getvalue())
                        temp_path = Path(temp_file.name)

                    self.image(str(temp_path), x=x, y=y, h=h, w=w)
                    logger.info("KOP (FPDF): logo OK %s (%dx%d px -> %.1fx%.1f mm)", label, iw, ih, w, h)
                finally:
                    if temp_path is not None:
                        try:
                            temp_path.unlink(missing_ok=True)
                        except OSError as cleanup_error:
                            logger.warning(
                                "Gagal menghapus file logo sementara %s: %s",
                                temp_path, cleanup_error,
                            )
            except Exception as e:
                logger.warning("Kop: gagal render logo %s -> %s", str(src)[:60], e)

        place_logo(d.get('logo_pemda'), right_align=False)
        place_logo(d.get('logo_sekolah'), right_align=True)

        def fit_line(text, style, base_size, min_size):
            """Perkecil font bertahap agar baris muat di area antar-logo."""
            size = base_size
            while size > min_size and self.get_string_width(text) > text_w:
                size -= 0.5
                self.set_font("times", style, size)
            return size

        self.set_y(top_y + 3)
        self.set_text_color(0, 0, 0)

        b1 = (d.get('baris1') or '').strip().upper()
        if b1:
            self.set_font("times", "B", 12)
            fit_line(b1, "B", 12, 8.5)
            self.cell(0, 5.5, b1, align="C", ln=1)
        b2 = (d.get('baris2') or '').strip().upper()
        if b2:
            self.set_font("times", "B", 16)
            fit_line(b2, "B", 16, 10)
            self.cell(0, 7, b2, align="C", ln=1)
        alamat = (d.get('alamat') or '').strip()
        if alamat:
            self.set_font("times", "", 9)
            import textwrap
            wrap_w = max(int(text_w / (self.get_string_width("x") * 1.05)), 20)
            for ln in textwrap.wrap(alamat, width=wrap_w):
                self.cell(0, 4.2, ln, align="C", ln=1)

        posisi_y = max(self.get_y() + 1.5, top_y + max_logo_h + 1)
        self.set_line_width(0.8)
        self.set_draw_color(0, 0, 0)
        self.line(left_margin, posisi_y, right_margin, posisi_y)
        self.set_line_width(0.3)
        self.line(left_margin, posisi_y + 1.2, right_margin, posisi_y + 1.2)
        self.set_y(posisi_y + 6)

    def header(self):
        # Jangan auto-header; kop dipanggil manual agar bisa dikontrol per halaman
        pass


def generate_bast_pdf(kwitansi, pengaturan, transaksi_list):
    # --- 4. OLAH TANGGAL ---
    raw_date_str = kwitansi.tanggal_nota if kwitansi.tanggal_nota else kwitansi.tanggal

    try:
        if not raw_date_str:
            tgl_obj = datetime.now()
        elif "/" in str(raw_date_str):
            tgl_obj = datetime.strptime(raw_date_str, "%d/%m/%Y")
        elif "-" in str(raw_date_str) and str(raw_date_str).find("-") == 4:
            tgl_obj = datetime.strptime(raw_date_str, "%Y-%m-%d")
        elif "-" in str(raw_date_str):
            tgl_obj = datetime.strptime(raw_date_str, "%d-%m-%Y")
        else:
            tgl_obj = datetime.now()
    except Exception:
        tgl_obj = datetime.now()

    # Helper untuk tanggal Indonesia
    tgl_bast = format_tanggal_indo(tgl_obj.strftime("%Y-%m-%d"))

    # 5. Data Header untuk PDF
    data = {
        "pemda": (pengaturan.nama_pemda or "").upper(),
        "sekolah": (pengaturan.nama_sekolah or "").upper(),
        "alamat": pengaturan.alamat_sekolah or "",
        "nama_kepala_sekolah": pengaturan.nama_kepala_sekolah or "",
        "nip_kepala_sekolah": pengaturan.nip_kepala_sekolah or "",
        "nama_bendahara": pengaturan.nama_bendahara or "",
        "nip_bendahara": pengaturan.nip_bendahara or "",
        "logo_pemda": load_logo_source(pengaturan.logo_pemda, col="logo_pemda"),
        "logo_sekolah": load_logo_source(pengaturan.logo_sekolah, col="logo_sekolah"),
        "nomor_surat": kwitansi.no_bast or "-",
        "hari_ini": tgl_bast.get("hari", ""),
        "tgl_terbilang": tgl_bast.get("terbilang_tanggal", ""),
        "bulan_indo": tgl_bast.get("bulan", ""),
        "tahun_terbilang": tgl_bast.get("terbilang_tahun", ""),
        "tgl_full": tgl_bast.get("full", ""), 
        "nama_penerima": pengaturan.nama_pengurus_barang or "",
        "nip_penerima": pengaturan.nip_pengurus_barang or "",
        "jabatan_penerima": "Pengurus Barang",
        "nama_penyedia": kwitansi.nama_toko or "",
        "tgl_nota_full": tgl_bast.get("full", ""),
        "kota": pengaturan.tempat_surat or "Jember",
    }

    # 6. Item barang & Hitung Total
    items = []
    total_volume = 0.0
    grand_total_num = 0.0

    def _parse_number(value):
        if value is None:
            return 0.0
        if isinstance(value, (int, float)):
            return float(value)
        s = str(value).strip()
        if s == "":
            return 0.0
        try:
            return float(s)
        except Exception:
            pass
        try:
            if s.count('.') > 0 and s.count(',') == 0:
                return float(s.replace(',', ''))
            if s.count(',') > 0 and s.count('.') == 0:
                return float(s.replace(',', '.'))
            if s.count('.') > 0 and s.count(',') > 0:
                return float(s.replace('.', '').replace(',', '.'))
        except Exception:
            pass
        s2 = re.sub(r'[^0-9.-]', '', s)
        try:
            return float(s2)
        except Exception:
            logger.warning("Gagal parse angka: %s", s)
            return 0.0

    for idx, trx in enumerate(transaksi_list, start=1):
        try:
            vol = _parse_number(trx.volume)
            hrg = _parse_number(trx.harga_satuan)
        except Exception as e:
            logger.exception("Error parsing angka", e)
            vol = 0.0
            hrg = 0.0

        sub = vol * hrg
        items.append({
            "no": idx,
            "uraian": trx.uraian or "-",
            "harga_satuan": format_rupiah(hrg),
            "satuan": trx.satuan or "-",
            "volume": int(vol) if isinstance(vol, float) and vol.is_integer() else vol,
            "jumlah": format_rupiah(sub)
        })
        total_volume += vol
        grand_total_num += sub

    total_volume_fmt = int(total_volume) if isinstance(total_volume, float) and total_volume.is_integer() else total_volume
    grand_total_str = format_rupiah(grand_total_num)
    
    # 7. Generate PDF
    kop_info = {
        'baris1': data['pemda'],
        'baris2': data['sekolah'],
        'alamat': data['alamat'],
        'logo_pemda': data['logo_pemda'],
        'logo_sekolah': data['logo_sekolah'],
    }
    pdf = SPJFPDF(kop_data=kop_info, orientation='P', unit='mm', format=(215, 330))
    pdf.set_left_margin(15)
    pdf.set_right_margin(15)
    pdf.set_auto_page_break(True, margin=20)

    # --- HALAMAN TANDA TERIMA PEMBAYARAN ---
    pdf.add_page()
    
    # --- KOP SURAT (Page 1) — helper terpadu ---
    pdf._draw_kop()


    # --- JUDUL HALAMAN ---
    pdf.set_font("helvetica", "B", 12)
    pdf.cell(0, 6, "TANDA TERIMA PEMBAYARAN", align="C", ln=1)
    nama_kegiatan_upper = (kwitansi.nama_kegiatan or "").upper()
    pdf.multi_cell(0, 6, nama_kegiatan_upper, align="C")
    pdf.cell(0, 6, f"Nomor Kwitansi : {kwitansi.nomor_kwitansi or '-'}", align="C", ln=1)
    pdf.ln(5)

    # --- TABEL BARANG / JASA ---
    w = [10, 65, 30, 20, 30, 30]
    pdf.set_line_width(0.15)
    pdf.set_font("helvetica", "B", 10)
    headers = ["No", "Rincian Barang/Jasa", "Volume", "Satuan", "Harga", "Jumlah"]
    
    for i, h in enumerate(headers):
        pdf.cell(w[i], 8, h, border=1, align="C")
    pdf.ln()

    pdf.set_font("helvetica", "", 10)
    for item in items:
        start_y = pdf.get_y()
        x_start = pdf.get_x()
        pdf.set_xy(x_start + w[0], start_y)
        pdf.multi_cell(w[1], 8, item['uraian'], border=1, align="L")
        end_y = pdf.get_y()
        h_row = end_y - start_y
        pdf.set_xy(x_start, start_y)
        pdf.cell(w[0], h_row, str(item['no']), border=1, align="C")
        pdf.set_xy(x_start + w[0] + w[1], start_y)
        pdf.cell(w[2], h_row, str(item['volume']), border=1, align="C")
        pdf.cell(w[3], h_row, item['satuan'], border=1, align="C")
        pdf.cell(w[4], h_row, item['harga_satuan'], border=1, align="R")
        pdf.cell(w[5], h_row, item['jumlah'], border=1, align="R")
        pdf.set_y(end_y)

    pdf.set_fill_color(191, 191, 191)
    pdf.set_font("helvetica", "B", 10)
    pdf.cell(sum(w[0:4]), 8, "Jumlah Total", border=1, align="R", fill=True)
    pdf.cell(w[4], 8, "", border=1, fill=True)
    pdf.cell(w[5], 8, grand_total_str, border=1, align="R", fill=True)
    pdf.ln(15)

    # --- TANDA TANGAN ---
    pdf.ln(10)
    pdf.set_font("helvetica", "", 11)
    pdf.set_x(135)
    pdf.cell(60, 5, f"{data['kota']}, {data['tgl_full']}", align="C", ln=1)
    pdf.set_x(15)
    pdf.cell(60, 5, "Bendahara BOSP", align="C")
    pdf.set_x(135)
    pdf.cell(60, 5, "Penerima", align="C")
    pdf.ln(20)
    pdf.set_font("helvetica", "BU", 11)
    pdf.set_x(15)
    pdf.cell(60, 5, data['nama_bendahara'], align="C")
    pdf.set_x(135)
    pdf.cell(60, 5, data['nama_penyedia'], align="C")
    pdf.ln(5)
    pdf.set_font("helvetica", "", 11)
    pdf.set_x(15)
    pdf.cell(60, 5, f"NIP. {data['nip_bendahara']}", align="C")
    pdf.ln(15)
    pdf.set_x(75) 
    pdf.cell(60, 5, "Mengetahui,", align="C", ln=1)
    pdf.set_x(75)
    pdf.cell(60, 5, "Kepala Sekolah", align="C")
    pdf.ln(20)
    pdf.set_font("helvetica", "BU", 11)
    pdf.set_x(75)
    pdf.cell(60, 5, data['nama_kepala_sekolah'], align="C")
    pdf.ln(5)
    pdf.set_font("helvetica", "", 11)
    pdf.set_x(75)
    pdf.cell(60, 5, f"NIP. {data['nip_kepala_sekolah']}", align="C")

    # --- HALAMAN BAST (PAGES 2) ---
    pdf.add_page()
    pdf.set_font("helvetica", "B", 14)
    pdf.cell(0, 5, "FORMAT 2", align="R", ln=1)
    pdf.ln(2)
    
    # --- KOP SURAT (Page 2) — helper terpadu ---
    pdf._draw_kop()
    pdf.set_font("helvetica", "B", 11)
    pdf.cell(0, 5, "BERITA ACARA SERAH TERIMA BARANG", align="C", ln=1)
    pdf.cell(0, 5, "PENGADAAN / PEROLEHAN", align="C", ln=1)
    pdf.set_font("helvetica", "", 10)
    pdf.cell(0, 5, f"nomor: {data['nomor_surat']}", align="C", ln=1)
    pdf.ln(8)
    pdf.set_font("helvetica", "", 11)
    teks_pembuka = f"Pada hari ini {data['hari_ini']} tanggal {data['tgl_terbilang']} bulan {data['bulan_indo']} tahun {data['tahun_terbilang']} yang bertanda tangan di bawah ini :"
    pdf.multi_cell(0, 5, teks_pembuka, align="J")
    pdf.ln(3)
    
    # Detail BAST
    pdf.cell(30, 6, "Nama")
    pdf.cell(0, 6, f": {data['nama_penerima']}", ln=1)
    pdf.cell(30, 6, "Jabatan")
    pdf.cell(0, 6, f": {data['jabatan_penerima']}", ln=1)
    pdf.ln(3)
    teks_isi = f"Telah menerima barang persediaan yang diserahkan oleh {data['nama_penyedia']} sesuai dengan Faktur Pembelian / Nota Pembelian tanggal {data['tgl_nota_full']} sebagaimana daftar terlampir."
    pdf.multi_cell(0, 5, teks_isi, align="J")
    pdf.ln(3)
    pdf.cell(0, 5, "Daftar barang yang diterima sebagai berikut :", ln=1)
    pdf.ln(2)

    # TABEL BAST
    w_bast = [10, 65, 30, 20, 15, 30, 15]
    pdf.set_line_width(0.15)
    pdf.set_font("helvetica", "B", 10)
    headers_bast = ["No", "Uraian Nama Barang", "Harga Satuan", "Satuan", "Volume", "Jumlah", "Ket"]
    for i in range(len(headers_bast)):
        pdf.cell(w_bast[i], 8, headers_bast[i], border=1, align="C")
    pdf.ln()
    pdf.set_font("helvetica", "I", 8)
    sub_h = ["(a)", "(b)", "(c)", "(d)", "(e)", "(f = c*e)", "(g)"]
    for i in range(len(sub_h)):
        pdf.cell(w_bast[i], 5, sub_h[i], border=1, align="C")
    pdf.ln()
    pdf.set_font("helvetica", "", 10)
    for item in items:
        start_y = pdf.get_y()
        x_start = pdf.get_x()
        pdf.set_xy(x_start + w_bast[0], start_y)
        pdf.multi_cell(w_bast[1], 8, item['uraian'], border=1, align="L")
        end_y = pdf.get_y()
        h_row = end_y - start_y
        pdf.set_xy(x_start, start_y)
        pdf.cell(w_bast[0], h_row, str(item['no']), border=1, align="C")
        pdf.set_xy(x_start + w_bast[0] + w_bast[1], start_y)
        pdf.cell(w_bast[2], h_row, item['harga_satuan'], border=1, align="R")
        pdf.cell(w_bast[3], h_row, item['satuan'], border=1, align="C")
        pdf.cell(w_bast[4], h_row, str(item['volume']), border=1, align="C")
        pdf.cell(w_bast[5], h_row, item['jumlah'], border=1, align="R")
        pdf.cell(w_bast[6], h_row, "", border=1, align="C")
        pdf.set_y(end_y)

    pdf.set_fill_color(191, 191, 191)
    pdf.set_font("helvetica", "B", 10)
    pdf.cell(sum(w_bast[0:4]), 8, "Jumlah", border=1, align="R", fill=True)
    pdf.cell(w_bast[4], 8, str(total_volume_fmt), border=1, align="C", fill=True)
    pdf.cell(w_bast[5], 8, grand_total_str, border=1, align="R", fill=True)
    pdf.cell(w_bast[6], 8, "", border=1, fill=True, ln=1)
    pdf.set_fill_color(217, 217, 217)
    pdf.cell(sum(w_bast[0:4]), 8, "Jumlah Total", border=1, align="R", fill=True)
    pdf.cell(w_bast[4], 8, "", border=1, fill=True) 
    pdf.cell(w_bast[5], 8, grand_total_str, border=1, align="R", fill=True)
    pdf.cell(w_bast[6], 8, "", border=1, fill=True, ln=1)

    pdf.set_font("helvetica", "", 11)
    pdf.ln(5)
    pdf.multi_cell(0, 5, "Demikian Berita Acara Serah Terima Barang ini dibuat dalam rangkap 2 (dua) untuk digunakan sebagaimana mestinya.")
    pdf.ln(10)
    pdf.cell(92, 5, "", ln=0)
    pdf.cell(92, 5, f"{data['kota']}, {data['tgl_full']}", align="C", ln=1)
    
    pdf.cell(92, 5, "Yang Menyerahkan", align="C", ln=0)
    pdf.cell(92, 5, "Yang Menerima", align="C", ln=1)
    pdf.cell(92, 5, "Penyedia Barang", align="C", ln=0)
    pdf.cell(92, 5, data['jabatan_penerima'], align="C", ln=1)
    pdf.ln(20) 
    pdf.cell(92, 5, data['nama_penyedia'], align="C", ln=0)
    pdf.set_font("helvetica", "BU", 11)
    pdf.cell(92, 5, data['nama_penerima'], align="C", ln=1)
    pdf.set_font("helvetica", "", 11)
    pdf.cell(92, 5, "", ln=0)
    pdf.cell(92, 5, f"NIP. {data['nip_penerima']}", align="C", ln=1)

    # --- HALAMAN LAMPIRAN FOTO ---
    foto_list = []
    if kwitansi.foto_bukti:
        try:
            foto_list = kwitansi.foto_bukti if isinstance(kwitansi.foto_bukti, list) else json.loads(kwitansi.foto_bukti)
        except Exception:
            foto_list = []

    foto_per_jenis = {k: [] for k in ["barang", "kegiatan", "sebelum", "proses", "sesudah"]}
    for foto in foto_list:
        if isinstance(foto, dict):
            jenis = foto.get("jenis")
            if jenis in foto_per_jenis:
                foto_per_jenis[jenis].append(foto)

    urutan_halaman = [
        ("barang", "FOTO BARANG"), ("kegiatan", "FOTO KEGIATAN"),
        ("sebelum", "FOTO SEBELUM"), ("proses", "FOTO PROSES"), ("sesudah", "FOTO SESUDAH"),
    ]

    # --- KONFIGURASI TAMPILAN ---
    img_height = 70       # Tinggi foto tetap (mm)
    page_margin_x = 10    # Margin kiri/kanan halaman PDF
    max_line_width = pdf.w - (page_margin_x * 2) # Lebar area kerja efektif
    bottom_margin = 20    # Batas bawah halaman sebelum break

    # Fungsi Helper: Render Header Halaman
    def print_header_lampiran(judul_section):
        pdf.set_font("helvetica", "B", 12)
        pdf.cell(0, 8, f"LAMPIRAN {judul_section}", align="C", ln=1)
        pdf.set_font("helvetica", "", 11)
        pdf.cell(0, 6, f"Nomor Kwitansi : {kwitansi.nomor_kwitansi or '-'}", align="C", ln=1)
        pdf.ln(2) # Jarak sedikit setelah header

    for jenis, judul in urutan_halaman:
        daftar_foto = foto_per_jenis.get(jenis, [])
        if not daftar_foto: continue

        # Buat halaman baru untuk setiap jenis kategori (opsional, agar rapi)
        pdf.add_page()
        print_header_lampiran(judul)
        
        # Buffer untuk baris saat ini
        row_buffer = [] 
        current_row_width = 0

        # Fungsi Helper: Flush (Cetak) Buffer ke PDF
        def flush_row(buffer, row_width, current_judul):
            # Cek apakah cukup ruang vertikal?
            if pdf.get_y() + img_height > pdf.h - bottom_margin:
                pdf.add_page()
                print_header_lampiran(current_judul)
            
            # Hitung posisi X awal agar RATA TENGAH
            start_x = (pdf.w - row_width) / 2
            current_x = start_x
            current_y = pdf.get_y()

            for item in buffer:
                # Render Gambar
                if item['valid']:
                    try:
                        pdf.image(str(item['path']), x=current_x, y=current_y, h=img_height)
                    except Exception:
                        # Fallback jika gagal render gambar valid
                        pdf.rect(current_x, current_y, item['width'], img_height)
                else:
                    # Render Placeholder (Kotak Silang/Kosong)
                    pdf.rect(current_x, current_y, item['width'], img_height)
                    pdf.set_xy(current_x, current_y + (img_height/2) - 3)
                    pdf.set_font("helvetica", "I", 7)
                    pdf.multi_cell(item['width'], 3, "Foto Tidak\nDitemukan", align="C")
                
                # Geser X untuk gambar berikutnya (Rapat tanpa spasi)
                current_x += item['width']

            # Pindahkan kursor Y ke bawah untuk baris selanjutnya
            pdf.set_xy(page_margin_x, current_y + img_height)

        # --- LOOP PROSES FOTO ---
        for i, foto in enumerate(daftar_foto):
            foto_path_obj = resolve_foto_path(foto.get("path", ""))
            
            # Default width untuk placeholder jika gambar rusak
            display_width = 50 
            is_valid = False

            # Coba dapatkan dimensi asli gambar untuk hitung lebar proporsional
            if foto_path_obj and foto_path_obj.exists():
                try:
                    with Image.open(foto_path_obj) as img:
                        w_ori, h_ori = img.size
                        aspect_ratio = w_ori / h_ori
                        display_width = img_height * aspect_ratio
                        is_valid = True
                except Exception:
                    is_valid = False
            
            # Siapkan objek data gambar
            img_data = {
                'path': foto_path_obj,
                'width': display_width,
                'valid': is_valid
            }

            # Cek apakah baris penuh?
            if current_row_width + display_width > max_line_width:
                flush_row(row_buffer, current_row_width, judul)
                row_buffer = []     # Kosongkan buffer
                current_row_width = 0 # Reset lebar

            # Masukkan ke buffer
            row_buffer.append(img_data)
            current_row_width += display_width

        # Cetak sisa foto yang ada di buffer terakhir
        if row_buffer:
            flush_row(row_buffer, current_row_width, judul)
            
        # Beri jarak sedikit antar kategori
        pdf.ln(5)

    return pdf.output(dest="S").encode("latin1")

def generate_rab_pdf(pengaturan, kegiatan, transaksi_list, thp_label, tahun):
    # ---------------- HELPER ----------------
    def format_rupiah(value):
        return f"Rp {value:,.0f}".replace(",", ".")

    # Helper hitung bulan surat berdasarkan Label Tahap
    # LOGIKA: Hanya mengubah bulan tanda tangan, TIDAK memfilter data tabel
    def get_tanggal_surat_custom(lokasi, thp, thn):
        bulan = "Januari" # Default
        
        if thp:
            thp_str = str(thp).upper()
            # Cek keyword untuk Juli (Tahap 2)
            if "THP II" in thp_str or "2" in thp_str or "DUA" in thp_str:
                bulan = "Juli"
            # Cek keyword untuk Januari (Tahap 1)
            elif "THP I" in thp_str or "1" in thp_str or "SATU" in thp_str:
                bulan = "Januari"
        
        # Format: [Tempat], ... [Bulan] [Tahun]
        return f"{lokasi}, ... {bulan} {thn}"

    # ---------------- SETUP PDF ----------------
    rab_kop = {
        'baris1': (getattr(pengaturan, 'nama_pemda', '') or '').upper(),
        'baris2': (pengaturan.nama_sekolah or '').upper(),
        'alamat': pengaturan.alamat_sekolah or '',
        'logo_pemda': load_logo_source(getattr(pengaturan, 'logo_pemda', '') or '', col="logo_pemda"),
        'logo_sekolah': load_logo_source(getattr(pengaturan, 'logo_sekolah', '') or '', col="logo_sekolah"),
    }
    pdf = SPJFPDF(kop_data=rab_kop, orientation='L', unit='mm', format=(215, 330))
    pdf.set_margins(15, 15, 15)
    pdf.set_auto_page_break(True, margin=20)
    pdf.add_page()

    # ---------------- KOP SURAT + JUDUL ----------------
    pdf._draw_kop()
    pdf.set_font("helvetica", "B", 14)
    pdf.ln(5)

    pdf.set_font("helvetica", "", 11)
    start_x = 15

    def print_info_row(label, value):
        pdf.set_x(start_x)
        pdf.cell(45, 6, label, 0, 0)
        pdf.cell(5, 6, ":", 0, 0)
        pdf.multi_cell(0, 6, str(value) if value else "-")

    nama_keg = kegiatan.nama_kegiatan if kegiatan else "-"
    
    print_info_row("Kegiatan", nama_keg)
    print_info_row("Tahap", thp_label) # Hanya menampilkan label
    print_info_row("Tahun Anggaran", tahun)
    print_info_row("Satuan Pendidikan", pengaturan.nama_sekolah)
    
    pdf.ln(5)

    # ---------------- TABEL HEADER ----------------
    w = [12, 95, 18, 22, 35, 35, 35, 48] 
    headers = ["No", "Uraian Kegiatan", "Volume", "Satuan", "Harga Satuan", "Jumlah", "Jenis Belanja", "Keterangan"]

    def print_table_header():
        pdf.set_font("helvetica", "B", 10)
        pdf.set_fill_color(230, 230, 230)
        x_curr = 15
        for i, h in enumerate(headers):
            pdf.set_xy(x_curr, pdf.get_y())
            pdf.cell(w[i], 10, h, border=1, align="C", fill=True)
            x_curr += w[i]
        pdf.ln()

    print_table_header()

    pdf.set_font("helvetica", "", 10)
    grand_total = 0
    no = 1

    # ---------------- PRE-PROCESSING DATA ----------------
    # Filter hanya membuang PPh/PPN. 
    # TIDAK ADA filter berdasarkan Tahap (semua data masuk).
    filtered_transaksi = []
    
    for item in transaksi_list:
        # Normalisasi input (bisa berupa object atau tuple)
        if isinstance(item, (list, tuple)) and len(item) >= 2:
            trx_obj = item[0]
            jns = item[1]
        else:
            trx_obj = item
            jns = None
            
        # Cek Pajak
        uraian_check = (trx_obj.uraian or "").lower()
        if "ppn" in uraian_check or "pph" in uraian_check:
            continue # Skip pajak
        
        # Masukkan semua data yang bukan pajak
        filtered_transaksi.append((trx_obj, jns))

    # ---------------- RENDER TABEL ----------------
    for trx, jenis_belanja in filtered_transaksi:
        vol = trx.volume or 0
        hrg = trx.harga_satuan or 0
        subtotal = vol * hrg
        grand_total += subtotal

        uraian_text = trx.uraian or "-"
        satuan = trx.satuan or ""
        jenis_text = str(jenis_belanja) if jenis_belanja else "-"
        
        # Cek Ganti Halaman
        if pdf.get_y() > 175: 
            pdf.add_page()
            print_table_header()
            pdf.set_font("helvetica", "", 10)

        x_start = 15 
        y_start = pdf.get_y()

        # 1. Hitung Tinggi Baris (Max height dari Uraian & Jenis Belanja)
        # Hitung Uraian
        pdf.set_xy(x_start + w[0], y_start)
        pdf.multi_cell(w[1], 6, uraian_text, border=0, align="L")
        h_uraian = pdf.get_y() - y_start
        
        # Hitung Jenis Belanja
        x_jenis = x_start + sum(w[:6])
        pdf.set_xy(x_jenis, y_start)
        pdf.multi_cell(w[6], 6, jenis_text, border=0, align="L")
        h_jenis = pdf.get_y() - y_start

        # Ambil max tinggi
        h_row = max(h_uraian, h_jenis)
        if h_row < 6: h_row = 6

        # 2. Gambar Border/Kotak
        current_x = x_start
        for width in w:
            pdf.rect(current_x, y_start, width, h_row)
            current_x += width

        # 3. Isi Konten
        # No
        pdf.set_xy(x_start, y_start)
        pdf.cell(w[0], 6, str(no), border=0, align="C")

        # Uraian (Tulis ulang di posisi yang benar)
        pdf.set_xy(x_start + w[0], y_start)
        pdf.multi_cell(w[1], 6, uraian_text, border=0, align="L")

        # Vol
        vol_str = f"{int(vol)}" if vol % 1 == 0 else f"{vol}".replace('.', ',')
        pdf.set_xy(x_start + sum(w[:2]), y_start)
        pdf.cell(w[2], 6, vol_str, border=0, align="C")

        # Sat
        pdf.set_xy(x_start + sum(w[:3]), y_start)
        pdf.cell(w[3], 6, satuan, border=0, align="C")

        # Harga
        pdf.set_xy(x_start + sum(w[:4]), y_start)
        pdf.cell(w[4], 6, format_rupiah(hrg), border=0, align="R")

        # Jumlah
        pdf.set_xy(x_start + sum(w[:5]), y_start)
        pdf.cell(w[5], 6, format_rupiah(subtotal), border=0, align="R")

        # Jenis Belanja (Tulis ulang)
        pdf.set_xy(x_start + sum(w[:6]), y_start)
        pdf.multi_cell(w[6], 6, jenis_text, border=0, align="L")

        # Pindah baris
        pdf.set_xy(15, y_start + h_row)
        no += 1

    # ---------------- FOOTER / TOTAL ----------------
    pdf.set_font("helvetica", "B", 10)
    total_width_label = sum(w[:5])
    
    pdf.cell(total_width_label, 8, "Jumlah Total", border=1, align="R", fill=True)
    pdf.cell(w[5], 8, format_rupiah(grand_total), border=1, align="R", fill=True)
    pdf.cell(w[6], 8, "", border=1, fill=True)
    pdf.cell(w[7], 8, "", border=1, fill=True)
    pdf.ln(10)

    # ---------------- TANDA TANGAN ----------------
    if pdf.get_y() > 150:
        pdf.add_page()

    pdf.set_font("helvetica", "", 11)

    # Lokasi & Tanggal — formatter TERPADU (sama dengan payload spj-data;
    # dulu menghasilkan "..., ... Juli 2026" dengan titik-titik ganda).
    lokasi = getattr(pengaturan, 'tempat_surat', '') or "Jember"
    tgl_cetak = _rab_tanggal_surat(lokasi, thp_label, tahun)
    
    x_sign = 230
    y_ttd = pdf.get_y()

    pdf.set_xy(x_sign, y_ttd)
    pdf.cell(70, 5, tgl_cetak, align="C", ln=1)

    pdf.set_xy(x_sign, y_ttd + 5)
    pdf.cell(70, 5, "Mengetahui,", align="C", ln=1)
    pdf.set_xy(x_sign, y_ttd + 10)
    pdf.cell(70, 5, "Kepala Sekolah", align="C", ln=1)

    pdf.ln(25)
    
    y_nama = pdf.get_y()
    pdf.set_font("helvetica", "BU", 11)
    pdf.set_xy(x_sign, y_nama)
    pdf.cell(70, 5, pengaturan.nama_kepala_sekolah or "", align="C", ln=1)

    pdf.set_font("helvetica", "", 11)
    pdf.set_xy(x_sign, y_nama + 5)
    pdf.cell(70, 5, f"NIP. {pengaturan.nip_kepala_sekolah or '-'}", align="C", ln=1)

    try:
        pdf_out = pdf.output(dest="S")
        if isinstance(pdf_out, str):
            return pdf_out.encode("latin1")
        return pdf_out
    except Exception as e:
        print(f"Error output PDF: {e}")
        raise

@api_router.get("/kwitansi/{id}/spj-data")
async def get_kwitansi_spj_data(
    id: int,
    db: AsyncSession = Depends(get_db)
):
    """Payload JSON lengkap satu dokumen SPJ (kuitansi + BAST + RAB + identitas
    periode + lampiran foto) untuk rendering PDF di FRONTEND (pdfmake).

    Prinsip pemisahan tanggung jawab:
      - Backend  : membaca DB, MEMILIH IDENTITAS PERIODE berdasarkan tanggal
                   kwitansi (resolve_identitas_for_tanggal), menyusun baris
                   transaksi & kategori rekening, status tiap bagian.
      - Frontend : memvalidasi payload, menggambar layout PDF, mengunduh Blob.

    Aturan bisnis TIDAK diduplikasi di sini — semuanya lewat
    ``kumpulkan_data_spj()`` yang sama dipakai pengujian.

    Rendering PDF SPJ kini SEPENUHNYA di frontend (pdfmake): backend hanya
    menyiapkan dan mengirim JSON ini — tidak membuat, menggabungkan, atau
    mengirim berkas PDF untuk alur SPJ. Endpoint PDF legacy
    GET /kwitansi/{id}/pdf telah dinonaktifkan (410 Gone) setelah dipastikan
    tidak ada pemanggil lain; endpoint PDF tidak terkait (impor BKU/BHP)
    tidak diubah.
    """
    try:
        data = await kumpulkan_data_spj(db, id)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("spj-data gagal untuk kwitansi %s: %s", id, e)
        raise HTTPException(status_code=500, detail=f"Gagal menyiapkan data SPJ: {e}")
    return {"status": "success", "data": data}


# ---------------------------------------------------------------------------
# ENDPOINT PDF SPJ LEGACY — DINONAKTIFKAN (rendering PDF kini FRONTEND)
# ---------------------------------------------------------------------------
# Dulu: GET /kwitansi/{id}/pdf merender kwitansi+BAST+RAB dengan ReportLab dan
# menggabungkannya dengan PyPDF2.PdfMerger lalu mengirim application/pdf.
# Alur baru: frontend memanggil GET /kwitansi/{id}/spj-data (JSON) dan
# merender PDF sendiri lewat pdfmake (frontend/src/pdf/spjPdf.js).
# Verifikasi pemanggil sebelum penonaktifan: tidak ada satu pun kode frontend
# (app.js, Index.html, preload.js, index.js Electron) yang masih memanggil
# /kwitansi/{id}/pdf — sehingga mengubahnya menjadi 410 Gone tidak memutus
# pemanggil lain. Endpoint PDF lain yang tidak terkait (impor BKU/BHP, dsb.)
# tidak disentuh. Fungsi generator lama (generate_kwitansi_pdf_v2,
# generate_bast_pdf, generate_rab_pdf, draw_pdf_kop_reportlab) tidak dipakai
# endpoint mana pun dan ditinggalkan sebagai artefak transisi terdokumentasi;
# backend untuk alur SPJ HANYA mengirim JSON.
@api_router.get("/kwitansi/{id}/pdf", include_in_schema=False)
async def get_kwitansi_pdf_legacy_disabled(id: int):
    """410 Gone: rendering PDF SPJ pindah ke frontend (lihat /spj-data)."""
    raise HTTPException(
        status_code=410,
        detail=(
            "Endpoint PDF SPJ legacy sudah dinonaktifkan. PDF dirender di "
            "frontend dari data JSON GET /api/kwitansi/{id}/spj-data."
        ),
    )


# Include router in app (harus di akhir setelah semua routes didefinisikan)
app.include_router(api_router)


if __name__ == "__main__":
    import asyncio
    import uvicorn

    # ================= NON-ACTIVE localhost REST SERVICE =================
    # Aplikasi ini TIDAK lagi menyediakan layanan localhost statis (port 8000).
    # Backend FastAPI HANYA boleh dijalankan sebagai child_process oleh Electron,
    # yang mewariskan env PORT dengan port dinamis (ephemeral). Menjalankan
    # main.py secara manual tanpa PORT akan ditolak agar tidak ada "servis
    # localhost" yang tertinggal / bentrok.
    raw_port = os.getenv("PORT")
    if not raw_port:
        logger.error(
            "Backend harus dijalankan sebagai child_process Electron (env PORT wajib diisi). "
            "Layanan REST di localhost statis (8000) sudah DINONAKTIFKAN. "
            "Jalankan lewat aplikasi Electron, atau set PORT=<port> untuk debug."
        )
        sys.exit(2)

    try:
        port = int(raw_port)
    except ValueError:
        port = 0

    if port <= 0:
        logger.error(f"Nilai PORT tidak valid: {raw_port!r}")
        sys.exit(2)

    logger.info(f"Backend child_process startup pada port dinamis {port}")

    async def _serve():
        config = uvicorn.Config(
            app, host="127.0.0.1", port=port, log_config=None
        )
        server = uvicorn.Server(config)
        await server.serve()
        # Setelah server berhenti (SIGTERM/SIGINT), tutup koneksi DB agar proses
        # anak bisa exit bersih tanpa digantung oleh event loop aiosqlite.
        try:
            await engine.dispose()
        except Exception:
            pass

    try:
        asyncio.run(_serve())
    except KeyboardInterrupt:
        pass
    finally:
        logger.info("Backend child_process berhenti.")
        # Paksa exit agar thread/handler yang menggantung tidak menahan proses anak
        logging.shutdown()
        os._exit(0)
