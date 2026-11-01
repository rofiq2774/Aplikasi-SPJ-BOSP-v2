# -*- mode: python ; coding: utf-8 -*-

block_cipher = None

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=[
        # Menambahkan folder alembic dan filenya ke dalam EXE
        ('alembic', 'alembic'),
        ('alembic.ini', '.'),
        ('.env', '.'),
    ],
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
        'sqlalchemy.dialects.sqlite'
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
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