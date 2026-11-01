# -*- mode: python ; coding: utf-8 -*-
# Perbaikan error Windows "No time zone found with key Asia/Jakarta":
# kemas database zona waktu IANA dari paket `tzdata` + runtime hook yang
# mendaftarkannya ke TZPATH ZoneInfo saat aplikasi frozen start.
from PyInstaller.utils.hooks import collect_data_files, copy_metadata

block_cipher = None

tz_datas = collect_data_files('tzdata')
# copy_metadata agar dist-info tzdata ikut terprovisioning (PEP 653/tzsearch).
tz_datas += copy_metadata('tzdata')

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=[
        # Menambahkan folder alembic dan filenya ke dalam EXE
        ('alembic', 'alembic'),
        ('alembic.ini', '.'),
        ('.env', '.'),
    ] + tz_datas,
    hiddenimports=[
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
        'asgiref',
        'aiosqlite', 
        'greenlet', 
        'reportlab.graphics.barcode.code128', 
        'reportlab.graphics.barcode.code39', 
        'reportlab.graphics.barcode.common', 
        'reportlab.graphics.barcode.code93', 
        'reportlab.graphics.barcode.usps', 
        'reportlab.graphics.barcode.usps4s', 
        'reportlab.graphics.barcode.ecc200datamatrix', 
        'reportlab.graphics.barcode.fourstate',
        'sqlalchemy.ext.asyncio',
        'sqlalchemy.dialects.sqlite',
        'zoneinfo',
        'tzdata',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=['runtime_hook_tz.py'],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='main',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True, # Set ke True jika ingin melihat error di terminal saat debug
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)