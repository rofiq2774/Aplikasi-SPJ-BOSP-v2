import sqlite3
from pathlib import Path
p = Path(__file__).parent / "aplikasi_spj.db"
if not p.exists():
    print("DB file not found:", p)
    raise SystemExit(1)
conn = sqlite3.connect(p)
rows = list(conn.execute("PRAGMA table_info('pengaturan')"))
conn.close()
print([r[1] for r in rows])
# Print detail rows
for r in rows:
    print(r)
print("Has 'tempat_surat' column:", any(r[1] == 'tempat_surat' for r in rows))