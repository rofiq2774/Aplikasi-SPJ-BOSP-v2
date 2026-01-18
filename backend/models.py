from sqlalchemy import Column, Integer, String, Float, DateTime, Boolean, Text
from database import Base
from datetime import datetime

class Transaksi(Base):
    __tablename__ = "transaksi"

    id = Column(Integer, primary_key=True, index=True)
    tanggal = Column(String, nullable=False)
    kode_kegiatan = Column(String, default="")
    kode_rekening = Column(String, default="")
    no_bukti = Column(String, nullable=False)
    uraian = Column(String, nullable=False, default="")
    volume = Column(Float, nullable=False, default=0)
    satuan = Column(String, nullable=False, default="")
    harga_satuan = Column(Float, nullable=False, default=0)
    penerimaan = Column(Float, default=0)
    pengeluaran = Column(Float, default=0)
    saldo = Column(Float, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class Pengaturan(Base):
    __tablename__ = "pengaturan"
    
    id = Column(Integer, primary_key=True, index=True)
    nama_pemda = Column(String, default="") 
    logo_pemda = Column(String, default="") 
    logo_sekolah = Column(String, default="") 
    nama_sekolah = Column(String, default="")
    nama_kepala_sekolah = Column(String, default="")
    nip_kepala_sekolah = Column(String, default="")
    nama_bendahara = Column(String, default="")
    nip_bendahara = Column(String, default="")
    nama_pengurus_barang = Column(String, default="")
    nip_pengurus_barang = Column(String, default="")
    alamat_sekolah = Column(String, default="")
    tempat_surat = Column(String, default="")
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class MasterKegiatan(Base):
    __tablename__ = "master_kegiatan"
    
    id = Column(Integer, primary_key=True, index=True)
    kode_kegiatan = Column(String, unique=True, nullable=False)
    nama_kegiatan = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class MasterRekeningBelanja(Base):
    __tablename__ = "master_rekening_belanja"

    id = Column(Integer, primary_key=True, index=True)
    kode_rekening_belanja = Column(String, unique=True, nullable=False)
    nama_rekening_belanja = Column(String, nullable=False)
    rekap_rekening_belanja = Column(String, default="")
    nilai_kapitalisasi_belanja = Column(Float, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Kwitansi(Base):
    __tablename__ = "kwitansi"
    
    id = Column(Integer, primary_key=True, index=True)
    nomor_kwitansi = Column(String, unique=True, nullable=False)
    no_bukti = Column(String, nullable=False)
    kode_kegiatan = Column(String, default="")
    nama_kegiatan = Column(String, default="")
    tanggal = Column(String, nullable=False)
    thp = Column(String, default="")
    tahun = Column(String, default="")
    jumlah = Column(Float, default=0)
    tanggal_nota = Column(String, default="")
    no_bast = Column(String, default="")
    nama_toko = Column(String, default="")
    npwp_toko = Column(String, default="")
    alamat_toko = Column(String, default="")
    foto_bukti = Column(Text, default="[]", nullable=False, comment="List path foto bukti (JSON array)")
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
