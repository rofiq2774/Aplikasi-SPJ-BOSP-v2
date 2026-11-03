export const JENIS_BELANJA_SPJ = {
  honor_jasa: {
    label: "Honor atau Jasa",
    bast: false,
    rab: false,
    foto: ["kegiatan"],
    dokumen: [
      { key: "tanda_terima", label: "Tanda Terima Pembayaran", recipientTable: true, fields: [
        ["penerima_nama", "Nama penerima"], ["penerima_jabatan", "Jabatan"],
      ] },
      { key: "surat_tugas", label: "Surat Tugas", fields: [
        ["surat_tugas_nomor", "Nomor Surat Tugas"], ["surat_tugas_tanggal", "Tanggal Surat Tugas", "date"],
        ["surat_tugas_dasar", "Dasar Surat Tugas", "textarea"],
        ["surat_tugas_petugas", "Yang Ditugaskan (Nama)"], ["surat_tugas_nip", "NIP"],
        ["surat_tugas_pangkat_golongan", "Pangkat/Golongan"],
        ["surat_tugas_jabatan", "Jabatan"],
        ["surat_tugas_pangkat_kepala_sekolah", "Pangkat/Golongan Kepala Sekolah"],
        ["surat_tugas_tujuan", "Keterangan / Untuk", "textarea"],
      ] },
      { key: "daftar_hadir", label: "Daftar Hadir", fields: [
        ["hadir_tanggal", "Tanggal kegiatan", "date"], ["hadir_tempat", "Tempat kegiatan"],
        ["hadir_peserta", "Daftar peserta (satu nama per baris)", "textarea"],
      ] },
    ],
  },
  makanan_minuman: {
    label: "Makanan dan Minuman",
    bast: false,
    rab: false,
    foto: ["barang", "kegiatan"],
    dokumen: [
      { key: "nota_pembelian", label: "Nota Pembelian", fields: [
        ["nota_nomor", "Nomor nota"], ["nota_keterangan", "Keterangan nota", "textarea"],
      ] },
      { key: "daftar_hadir", label: "Daftar Hadir", fields: [
        ["hadir_tanggal", "Tanggal kegiatan", "date"], ["hadir_tempat", "Tempat kegiatan"],
        ["hadir_peserta", "Daftar peserta (satu nama per baris)", "textarea"],
      ] },
    ],
  },
  perjalanan_dinas: {
    label: "Perjalanan Dinas",
    bast: false,
    rab: false,
    foto: ["kegiatan"],
    dokumen: [
      { key: "tanda_terima", label: "Tanda Terima Pembayaran", recipientTable: true, fields: [
        ["penerima_nama", "Nama penerima"], ["penerima_jabatan", "Jabatan"],
      ] },
      { key: "surat_tugas", label: "Surat Tugas", fields: [
        ["surat_tugas_nomor", "Nomor Surat Tugas"], ["surat_tugas_tanggal", "Tanggal Surat Tugas", "date"],
        ["surat_tugas_dasar", "Dasar Surat Tugas", "textarea"],
        ["surat_tugas_petugas", "Yang Ditugaskan (Nama)"], ["surat_tugas_nip", "NIP"],
        ["surat_tugas_pangkat_golongan", "Pangkat/Golongan"],
        ["surat_tugas_jabatan", "Jabatan"],
        ["surat_tugas_pangkat_kepala_sekolah", "Pangkat/Golongan Kepala Sekolah"],
        ["surat_tugas_tujuan", "Keterangan / Untuk", "textarea"],
      ] },
      { key: "sppd", label: "Surat Perintah Perjalanan Dinas (SPPD)", fields: [
        ["sppd_lampiran_ke", "Lampiran ke"],
        ["sppd_nomor_surat_tugas", "Nomor Surat Tugas"],
        ["sppd_ppk_nama", "Nama Pejabat Pembuat Komitmen"],
        ["sppd_ppk_nip", "NIP Pejabat Pembuat Komitmen"],
        ["sppd_ppk_pangkat_golongan", "Pangkat/Golongan Pejabat Pembuat Komitmen"],
        ["sppd_ppk_jabatan", "Jabatan Pejabat Pembuat Komitmen"],
        ["sppd_petugas", "Nama Pegawai yang Melaksanakan Perjalanan"],
        ["sppd_nip", "NIP Pegawai"],
        ["sppd_pangkat_golongan", "Pangkat/Golongan Pegawai"],
        ["sppd_jabatan", "Jabatan Pegawai"],
        ["sppd_maksud", "Maksud Perjalanan Dinas", "textarea"],
        ["sppd_transportasi", "Alat Angkut yang Dipergunakan"],
        ["sppd_tempat_berangkat", "Tempat Berangkat"],
        ["sppd_tujuan", "Tempat Tujuan"],
        ["sppd_berangkat", "Tanggal Berangkat", "date"],
        ["sppd_kembali", "Tanggal Harus Kembali/Tiba", "date"],
        ["sppd_pengikut_nama", "Nama Pengikut", "text", true],
        ["sppd_pengikut_jabatan", "Jabatan Pengikut", "text", true],
        ["sppd_pengikut_tugas", "Tugas Pengikut", "text", true],
        ["sppd_anggaran_instansi", "Pembebanan Anggaran - Instansi", "text", true],
        ["sppd_anggaran_akun", "Pembebanan Anggaran - Akun", "text", true],
        ["sppd_keterangan", "Keterangan Lain-lain", "textarea", true],
        ["sppd_tanggal_dikeluarkan", "Tanggal Dikeluarkan", "date", true],
      ] },
      { key: "notula", label: "Notula Kegiatan", fields: [
        ["notula_tanggal", "Tanggal kegiatan", "date"], ["notula_tempat", "Tempat kegiatan"],
        ["notula_acara", "Acara"], ["notula_peserta", "Peserta", "textarea"],
        ["notula_hasil", "Ringkasan hasil", "textarea"],
      ] },
      { key: "nota_pembelian", label: "Nota Pembelian (jika ada)", optional: true, fields: [
        ["nota_nomor", "Nomor nota"], ["nota_keterangan", "Keterangan nota", "textarea"],
      ] },
    ],
  },
  sewa: {
    label: "Sewa",
    bast: false,
    rab: false,
    foto: ["ktp", "kegiatan", "kendaraan_stnk"],
    dokumen: [
      {
        key: "tanda_terima",
        label: "Tanda Terima Pembayaran",
        recipientTable: true,
        fields: [
          ["penerima_nama", "Nama penerima"],
          ["penerima_jabatan", "Jabatan"],
        ],
      },
    ],
  },
  jasa_tukang: {
    label: "Jasa Tukang",
    bast: false,
    rab: true,
    foto: ["ktp", "sebelum", "proses", "sesudah"],
    dokumen: [
      { key: "tanda_terima", label: "Tanda Terima Pembayaran", recipientTable: true, fields: [
        ["penerima_nama", "Nama penerima"], ["penerima_jabatan", "Jabatan"],
      ] },
      { key: "daftar_hadir", label: "Daftar Hadir", fields: [
        ["hadir_tanggal_awal", "Tanggal awal kegiatan", "date"],
        ["hadir_tanggal_akhir", "Tanggal akhir kegiatan", "date"],
        ["hadir_tempat", "Tempat kegiatan"],
        ["hadir_peserta", "Daftar peserta (satu nama per baris)", "textarea"],
      ] },
    ],
  },
  fotokopi: {
    label: "Foto copy",
    bast: true,
    rab: false,
    foto: ["barang", "qr_master"],
    dokumen: [
      { key: "nota_pembelian", label: "Nota Pembelian", fields: [
        ["nota_nomor", "Nomor nota"], ["nota_keterangan", "Keterangan nota", "textarea"],
      ] },
      { key: "qr_master", label: "QR Link File Master", fields: [
        ["qr_link", "Tautan file master"],
      ] },
    ],
  },
  telepon_listrik_air: {
    label: "Telepon, Listrik, Air",
    bast: false,
    rab: false,
    foto: [],
    dokumen: [
      { key: "nota_pembelian", label: "Nota Pembelian", fields: [
        ["nota_nomor", "Nomor nota"], ["nota_keterangan", "Keterangan/periode tagihan", "textarea"],
      ] },
    ],
  },
  umum: {
    label: "Pembelanjaan Umum",
    bast: true,
    rab: false,
    foto: ["barang"],
    dokumen: [
      { key: "nota_pembelian", label: "Nota Pembelian", fields: [
        ["nota_nomor", "Nomor nota"], ["nota_keterangan", "Keterangan nota", "textarea"],
      ] },
    ],
  },
  bahan_bangunan: {
    label: "Pembelanjaan Bahan Bangunan",
    bast: true,
    rab: true,
    foto: ["barang"],
    dokumen: [
      { key: "nota_pembelian", label: "Nota Pembelian", fields: [
        ["nota_nomor", "Nomor nota"], ["nota_keterangan", "Keterangan nota", "textarea"],
      ] },
    ],
  },
};

const FOTO_JENIS_LABEL = {
  barang: "Barang",
  kegiatan: "Kegiatan",
  ktp: "KTP",
  qr_master: "QR Master",
  sebelum: "Sebelum",
  proses: "Proses",
  sesudah: "Sesudah",
  kendaraan_stnk: "Kendaraan dan STNK",
};

export function getFotoJenisLabel(jenis) {
  return FOTO_JENIS_LABEL[jenis] || String(jenis || "");
}

export function getJenisBelanjaConfig(jenis) {
  // Gunakan konfigurasi umum agar jenis lama/tidak dikenal tetap dapat diproses.
  return JENIS_BELANJA_SPJ[jenis] || JENIS_BELANJA_SPJ.umum;
}
