from logging.config import fileConfig
from sqlalchemy import engine_from_config, pool, create_engine # Tambahkan create_engine
from alembic import context
import sys
import os
from pathlib import Path

# Menambahkan path backend agar bisa import database.py
sys.path.append(str(Path(__file__).resolve().parent.parent))

# Import DATABASE_URL dan Base
from database import Base, DATABASE_URL 

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

def run_migrations_offline() -> None:
    # Menggunakan DATABASE_URL dari database.py
    url = str(DATABASE_URL).replace("sqlite+aiosqlite:///", "sqlite:///")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True # PENTING UNTUK SQLITE
    )

    with context.begin_transaction():
        context.run_migrations()

def run_migrations_online() -> None:
    # BUAT ENGINE MANUAL (Mengatasi KeyError: 'url')
    # Ubah format async ke sync karena Alembic butuh koneksi sinkron
    sync_url = str(DATABASE_URL).replace("sqlite+aiosqlite:///", "sqlite:///")
    
    connectable = create_engine(
        sync_url,
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection, 
            target_metadata=target_metadata,
            render_as_batch=True # PENTING AGAR BISA TAMBAH KOLOM DI SQLITE
        )

        with context.begin_transaction():
            context.run_migrations()

if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()