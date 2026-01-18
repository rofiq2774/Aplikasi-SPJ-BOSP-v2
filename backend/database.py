import os
import sys
from pathlib import Path

from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker, declarative_base

# ===============================
# BASE DIR (SELALU Path)
# ===============================
if getattr(sys, "frozen", False):
    # MODE EXE (Electron / PyInstaller)
    BASE_DIR = Path(os.getenv("LOCALAPPDATA")) / "AplikasiSPJ"
else:
    # MODE DEVELOPMENT
    BASE_DIR = Path(__file__).resolve().parent

BASE_DIR.mkdir(parents=True, exist_ok=True)

# If running as packaged (frozen), ensure we don't overwrite an existing DB on first run.
# If a bundled seed DB is provided next to the package, copy it only when the destination DB does not exist.
if getattr(sys, "frozen", False):
    try:
        bundled_db = Path(__file__).resolve().parent / "aplikasi_spj.db"
        target_db = Path(os.path.join(os.getenv('LOCALAPPDATA', ''), 'AplikasiSPJ', 'aplikasi_spj.db'))
        if bundled_db.exists() and not target_db.exists():
            import shutil
            shutil.copy2(bundled_db, target_db)
    except Exception:
        # Don't raise on failure here; we'll log elsewhere if needed
        pass

# ===============================
# DATABASE PATH
# ===============================
DB_PATH = BASE_DIR / "aplikasi_spj.db"
DATABASE_URL = f"sqlite+aiosqlite:///{DB_PATH.as_posix()}"

# ===============================
# SQLALCHEMY ENGINE
# ===============================
engine = create_async_engine(
    DATABASE_URL,
    echo=os.getenv("PYTHON_ENV") == "development",
    future=True,
)

# ===============================
# SESSION
# ===============================
AsyncSessionLocal = sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
)

Base = declarative_base()

# ===============================
# DEPENDENCY
# ===============================
async def get_db():
    async with AsyncSessionLocal() as session:
        yield session
