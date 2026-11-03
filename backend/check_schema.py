import sqlite3
from pathlib import Path


def inspect_settings_schema():
    """Tampilkan kolom tabel pengaturan dan cek keberadaan tempat_surat."""
    database_path = Path(__file__).parent / "aplikasi_spj.db"
    if not database_path.exists():
        print("DB file not found:", database_path)
        raise SystemExit(1)

    with sqlite3.connect(database_path) as connection:
        column_rows = list(connection.execute("PRAGMA table_info('pengaturan')"))

    column_names = [row[1] for row in column_rows]
    print(column_names)
    for column_row in column_rows:
        print(column_row)
    print("Has 'tempat_surat' column:", "tempat_surat" in column_names)


if __name__ == "__main__":
    inspect_settings_schema()