# -*- coding: utf-8 -*-
"""Runtime hook PyInstaller: sediakan database zona waktu IANA untuk ZoneInfo.

Masalah yang diperbaiki: pada Windows tanpa tzdata terpasang, aplikasi frozen
melempar "No time zone found with key Asia/Jakarta" (lihat backend/app.log).

Cara kerja:
  - main.spec mengemas package `tzdata` (berikut seluruh file zoneinfo IANA)
    ke dalam `_internal/tzdata/zoneinfo` pada build modern (COLLECT) atau
    `sys._MEIPASS/tzdata/zoneinfo` pada build one-folder lama.
  - Hook ini menambahkan direktori tersebut ke TZPATH search path ZoneInfo
    (PEP 615) saat startup, SEBELUM kode aplikasi memanggil ZoneInfo.
  - Tidak ada perubahan timezone sistem dan tidak ada fallback ke zona lain:
    bila file 'Asia/Jakarta' tetap tidak ditemukan, ZoneInfo akan menaikkan
    KeyError seperti semula (error jelas, bukan waktu salah).
"""
import os
import sys

try:
    import zoneinfo
except ImportError:
    zoneinfo = None

if zoneinfo is not None:
    bases = []
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            bases.append(meipass)
        bases.append(os.path.dirname(os.path.abspath(sys.executable)))
        # Build COLLECT modern menaruh data di _internal/
        bases.append(os.path.join(os.path.dirname(os.path.abspath(sys.executable)), "_internal"))
    for base in bases:
        for rel in (
            os.path.join("tzdata", "zoneinfo"),
            "zoneinfo",
        ):
            cand = os.path.join(base, rel)
            if os.path.isfile(os.path.join(cand, "Asia", "Jakarta")):
                paths = list(zoneinfo.TZPATH)
                if cand not in paths:
                    zoneinfo.reset_tzpath([cand] + paths)
                break
        else:
            continue
        break
