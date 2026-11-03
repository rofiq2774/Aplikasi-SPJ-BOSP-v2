from logging.config import fileConfig
import sys
from pathlib import Path

from alembic import context
from sqlalchemy import create_engine, pool

# Menambahkan path backend agar bisa import database.py
sys.path.append(str(Path(__file__).resolve().parent.parent))

# Import DATABASE_URL dan Base
from database import Base, DATABASE_URL

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Jalankan migrasi dari URL tanpa membuka koneksi langsung."""
    migration_url = str(DATABASE_URL).replace(
        "sqlite+aiosqlite:///", "sqlite:///"
    )
    context.configure(
        url=migration_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Buka koneksi sinkron agar Alembic dapat menerapkan migrasi."""
    sync_database_url = str(DATABASE_URL).replace(
        "sqlite+aiosqlite:///", "sqlite:///"
    )
    migration_engine = create_engine(
        sync_database_url,
        poolclass=pool.NullPool,
    )

    with migration_engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,
        )

        with context.begin_transaction():
            context.run_migrations()

if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()