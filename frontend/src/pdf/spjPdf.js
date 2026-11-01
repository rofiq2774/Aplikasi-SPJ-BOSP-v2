// ============================================================================
// spjPdf.js — Renderer PDF SPJ di FRONTEND (pdfmake)
// ----------------------------------------------------------------------------
// Kontrak: backend (GET /api/kwitansi/{id}/spj-data) menyiapkan SELURUH data
// (identitas per periode, baris transaksi BAST/RAB, total, status tiap
// bagian). Modul ini hanya mengurus PRESENTASI: layout kop, tabel, tanda
// tangan, page break, dan menghasilkan Blob PDF. Aturan bisnis TIDAK boleh
// diduplikasi di sini.
//
// Keputusan produk (dokumentasi — lihat juga field `document` pada payload):
//   1. Kuitansi HALAMAN PERTAMA WAJIB memakai kop + logo (sama dengan
//      BAST/RAB). Backend mengirim `document.kop_wajib = true` dan objek
//      `kop` per bagian; bila keputusan berubah, frontend tinggal tidak
//      menggambar kop saat flag mati.
//   2. Ukuran kertas F4 portrait 215 x 330 mm untuk SEMUA bagian (sama
//      dengan renderer backend lama), margin 15 mm.
//   3. Urutan dokumen: kuitansi -> BAST -> RAB (`document.order`).
//   4. BAST/RAB BOLEH tidak disertakan bila backend menandai
//      sections.<bagian>.status !== "included" (alasan ada di `alasan`).
//      KWITANSI bersifat WAJIB: jika datanya tidak ada, build melempar
//      error — jangan pernah diam-diam membuat dokumen yang tampak lengkap.
//
// Catatan pustaka: SATU library saja (pdfmake 0.3.x, build browser UMD +
// vfs_fonts untuk font standar embedded). Jangan campur jsPDF/renderer lain.
// ============================================================================

import pdfMake from "pdfmake/build/pdfmake";
import * as pdfFontsNs from "pdfmake/build/vfs_fonts";

// pdfmake >= 0.2 expects the virtual file system to be registered explicitly.
// Bentuk ekspor vfs_fonts berbeda antar-build (namespace .pdfMake.vfs / .vfs),
// jadi cek semua kemungkinan sekali di sini.
const _vfsMod = pdfFontsNs?.default ?? pdfFontsNs;
const _vfs =
  _vfsMod?.pdfMake?.vfs ??
  _vfsMod?.vfs ??
  (typeof window !== "undefined" ? window.pdfMakeVfsFonts?.pdfMake?.vfs : null);
if (_vfs) pdfMake.vfs = _vfs;

/**
 * Ambil URL origin backend (untuk foto lampiran yang dikirim sebagai path
 * relatif "/uploads/..."). Di Electron renderer halaman dimuat via file://,
 * sehingga URL relatif harus dijahit ke origin child_process. app.js
 * menyuntikkan getter ini sekali saat boot lewat setBackendOriginGetter().
 */
let _originGetter = () => "";
export function setBackendOriginGetter(fn) {
  _originGetter = typeof fn === "function" ? fn : () => "";
}
function absoluteize(url) {
  if (!url) return url;
  if (/^(https?:|data:|blob:|file:)/i.test(url)) return url;
  const origin = _originGetter();
  if (!origin) return url;
  return `${origin}${String(url).startsWith("/") ? "" : "/"}${url}`;
}

const SUPPORTED_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Helper format bersama (presentasi saja — nilai angka/total dari backend)
// ---------------------------------------------------------------------------

/** "Rp 1.234.567" — sama persis dengan format_rupiah() backend. */
export function formatRupiah(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "Rp 0";
  return `Rp ${Math.round(n).toLocaleString("de-DE")}`;
}

const BULAN_ID = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

const HARI_ID = {
  Monday: "Senin", Tuesday: "Selasa", Wednesday: "Rabu",
  Thursday: "Kamis", Friday: "Jumat", Saturday: "Sabtu", Sunday: "Minggu",
};

/** Tanggal Indo dari "YYYY-MM-DD" (fallback DD/MM/YYYY & DD-MM-YYYY). */
export function formatTanggalIndo(tanggalStr) {
  if (!tanggalStr) return "";
  const s = String(tanggalStr).trim();
  let y, m, d;
  let mt = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (mt) {
    [, y, m, d] = mt;
  } else {
    mt = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (mt) {
      [, d, m, y] = mt;
    } else {
      return s; // format tak dikenal: tampilkan apa adanya, jangan menebak
    }
  }
  return `${Number(d)} ${BULAN_ID[Number(m) - 1]} ${y}`;
}

/** Nama hari Indonesia ("Senin") untuk tanggal surat BAST. */
export function hariIndo(tanggalStr) {
  const s = String(tanggalStr || "").trim();
  let dt = null;
  let mt = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (mt) dt = new Date(Number(mt[1]), Number(mt[2]) - 1, Number(mt[3]));
  else {
    mt = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (mt) dt = new Date(Number(mt[3]), Number(mt[2]) - 1, Number(mt[1]));
  }
  if (!dt || Number.isNaN(dt.getTime())) return "";
  return HARI_ID[dt.toLocaleDateString("en-US", { weekday: "long" })] || "";
}

function num(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Number.isInteger(n) ? n : n;
}

function fmtVolume(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return Number.isInteger(n) ? String(n) : String(n).replace(".", ",");
}

// ---------------------------------------------------------------------------
// Validasi payload
// ---------------------------------------------------------------------------

function fail(msg) {
  throw new Error(`Data SPJ tidak valid: ${msg}`);
}

/**
 * Validasi field wajib payload spj-data (schema_version 1).
 * Melempar Error dengan pesan yang bisa langsung ditampilkan UI.
 */
export function validateSpjPayload(data) {
  if (!data || typeof data !== "object") fail("payload kosong/bukan objek");
  if (data.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    fail(
      `schema_version ${data.schema_version} tidak didukung ` +
        `(frontend mendukung ${SUPPORTED_SCHEMA_VERSION}). Perbarui aplikasi.`,
    );
  }
  for (const key of ["kwitansi", "identitas", "sections"]) {
    if (!data[key] || typeof data[key] !== "object") fail(`field '${key}' hilang`);
  }
  const kw = data.kwitansi;
  for (const f of ["nomor_kwitansi", "tanggal", "jumlah"]) {
    if (kw[f] === undefined || kw[f] === null) fail(`kwitansi.${f} hilang`);
  }
  if (num(kw.jumlah) <= 0) fail("kwitansi.jumlah harus > 0");

  const sec = data.sections || {};
  const st = (s) => (s && (s.status || s.included)) || null;
  const included = (name) => {
    const v = st(sec[name]);
    return v === true || v === "included";
  };
  if (!included("kwitansi")) fail("bagian kwitansi wajib tetapi ditandai tidak termasuk");

  // Konsistensi: bagian bertanda included tapi datanya tidak ada -> error,
  // bukan PDF parsial yang tampak sukses.
  if (included("bast") && !data.bast) fail("sections.bast=included tetapi data bast kosong");
  if (included("rab") && !data.rab) fail("sections.rab=included tetapi data rab kosong");
  if (data.bast && Array.isArray(data.bast.items) === false) fail("bast.items bukan array");
  if (data.rab && Array.isArray(data.rab.rows) === false) fail("rab.rows bukan array");

  // Logo HARUS data URI (bukan path lokal D:\...) bila diisi.
  for (const [k, v] of Object.entries(data.identitas)) {
    if (k.startsWith("logo_") && v && !/^data:image\//.test(String(v))) {
      fail(`identitas.${k} bukan data URI image (kemungkinan path lokal)`);
    }
  }
  return { included };
}

// ---------------------------------------------------------------------------
// Blok presentasi bersama
// ---------------------------------------------------------------------------

const PAGE = { size: [215, 330], margins: [15, 15, 15, 20] }; // mm
// Lebar area teks kop antar-logo: lebar konten (215 - 2*15) dikurangi dua
// kolom logo (24mm) + jarak (2mm) masing-masing sisi.
const KOP_TEXT_W = PAGE.size[0] - PAGE.margins[0] - PAGE.margins[2] - 2 * 28;

function kopStack(kop) {
  // Kop surat: logo kiri/kanan + teks tengah + garis ganda (seperti backend).
  // Batas ukuran logo (width+height = fit proporsional dalam kotak) agar
  // gambar apa pun tidak pernah menekan teks kop.
  const logoStyle = { width: 24, height: 20 };
  const hasL = !!kop?.logo_pemda;
  const hasR = !!kop?.logo_sekolah;
  const stack = [];
  if (kop?.baris1) {
    stack.push({
      text: String(kop.baris1).toUpperCase(),
      bold: true, fontSize: 12, alignment: "center",
    });
  }
  if (kop?.baris2) {
    stack.push({
      text: String(kop.baris2).toUpperCase(),
      bold: true, fontSize: 16, alignment: "center",
    });
  }
  if (kop?.alamat) {
    stack.push({ text: kop.alamat, fontSize: 9, alignment: "center" });
  }
  return [
    {
      columns: [
        hasL ? { image: kop.logo_pemda, ...logoStyle } : { text: "", width: 0 },
        { stack, width: "*", margin: [2, 0, 2, 2] },
        hasR ? { image: kop.logo_sekolah, ...logoStyle } : { text: "", width: 0 },
      ],
      columnWidths: [hasL ? 24 : 0, "*", hasR ? 24 : 0],
    },
    {
      canvas: [
        { type: "line", x1: 0, y1: 0, x2: KOP_TEXT_W, y2: 0, lineWidth: 1.6 },
        { type: "line", x1: 0, y1: 2.5, x2: KOP_TEXT_W, y2: 2.5, lineWidth: 0.5 },
      ],
    },
    { text: "", fontSize: 6 },
  ];
}

function sectionTitle(title, subtitle) {
  const out = [{ text: title, bold: true, fontSize: 14, alignment: "center" }];
  if (subtitle) {
    out.push({ text: subtitle, fontSize: 10, alignment: "center", margin: [0, 1, 0, 0] });
  }
  return out;
}

function labelRow(label, value, labelW = 32) {
  return {
    columns: [
      { text: label, width: labelW, noWrap: false },
      { text: `: ${value ?? "-"}`, flex: {}, colSpan: 1 },
    ],
    margin: [0, 1.5, 0, 1.5],
    fontSize: 11,
  };
}

function ttdBlock(name, nip, align = "left") {
  // Blok nama + NIP dengan ruang tanda tangan di atasnya (jarak tetap).
  return [
    { text: name || ".................................", bold: true, fontSize: 11, alignment: align, margin: [0, 20, 0, 0] },
    { text: nip ? `NIP. ${nip}` : "NIP. .............................", fontSize: 11, alignment: align },
  ];
}

// ---------------------------------------------------------------------------
// Bagian 1: KWITANSI (Tanda Terima Pembayaran) — WAJIB berkop sesuai keputusan
// ---------------------------------------------------------------------------

export function buildKwitansiSection(data) {
  const kw = data.kwitansi;
  const ident = data.identitas;
  const content = [];

  content.push(...kopStack(kw.kop || data.document?.kop));
  content.push(...sectionTitle("KWITANSI", `Nomor: ${kw.nomor_kwitansi || "-"}`));
  content.push({ text: "", fontSize: 8 });

  const jumlahFmt = kw.jumlah_rupiah || formatRupiah(kw.jumlah);
  const terbilang = kw.terbilang || "................ rupiah";

  content.push(labelRow("Telah terima dari", `BENDAHARA BOSP ${(ident.nama_sekolah || "").toUpperCase()}`, 36));
  content.push(labelRow("Uang sejumlah", `${terbilang} (${jumlahFmt})`, 36));
  content.push(labelRow("Untuk pembayaran", kw.uraian_pembayaran || kw.nama_kegiatan || "-", 36));
  if (kw.no_bast) content.push(labelRow("No. BAST", kw.no_bast, 36));
  if (kw.nama_toko) content.push(labelRow("Penyedia", `${kw.nama_toko}${kw.npwp_toko ? ` (NPWP: ${kw.npwp_toko})` : ""}`, 36));
  if (kw.alamat_toko) content.push(labelRow("Alamat", kw.alamat_toko, 36));

  content.push({ text: "", fontSize: 10 });

  // Tabel rincian barang/jasa (dari transaksi_bast bila ada; fallback uraian)
  const rows = [
    [
      { text: "No", bold: true, alignment: "center" },
      { text: "Rincian Barang/Jasa", bold: true, alignment: "center" },
      { text: "Jumlah", bold: true, alignment: "center" },
    ],
  ];
  const items = Array.isArray(data.transaksi_bast) ? data.transaksi_bast : [];
  if (items.length) {
    items.forEach((it) => {
      rows.push([
        { text: String(it.no ?? ""), alignment: "center" },
        { text: it.uraian || "-", alignment: "left" },
        { text: it.jumlah_fmt || formatRupiah(it.jumlah), alignment: "right" },
      ]);
    });
  } else {
    rows.push([
      { text: "1", alignment: "center" },
      { text: kw.uraian_detail || kw.uraian_pembayaran || "-", alignment: "left" },
      { text: jumlahFmt, alignment: "right" },
    ]);
  }
  rows.push([
    { text: "", border: [false, false, false, false] },
    { text: "JUMLAH", bold: true, alignment: "right", colSpan: 2 },
    { text: jumlahFmt, bold: true, alignment: "right" },
  ]);
  content.push({
    table: {
      headerRows: 1,
      widths: [10, "*", 35],
      body: rows,
    },
    layout: {
      fillColor: (_, rowIndex) => (rowIndex === rows.length - 1 ? "#dfdfdf" : null),
    },
    fontSize: 10,
    margin: [0, 6, 0, 4],
  });

  content.push({ text: "", fontSize: 12 });

  // Blok tanda tangan tiga kolom (KS / Bendahara / Penerima)
  const kota = kw.kota_tempat_surat || ident.tempat_surat || "Jember";
  const tgl = formatTanggalIndo(kw.tanggal);
  content.push({
    columns: [
      {
        stack: [
          { text: "Setuju Dibayar", fontSize: 11 },
          { text: "Kepala Sekolah", fontSize: 11 },
          ...ttdBlock(ident.nama_kepala_sekolah, ident.nip_kepala_sekolah, "left"),
        ],
        width: "*",
      },
      {
        stack: [
          { text: "Lunas Dibayar", fontSize: 11, alignment: "center" },
          { text: "Bendahara BOSP", fontSize: 11, alignment: "center" },
          ...ttdBlock(ident.nama_bendahara, ident.nip_bendahara, "center"),
        ],
        width: "*",
      },
      {
        stack: [
          { text: `${kota}, ${tgl}`, fontSize: 11, alignment: "right" },
          { text: "Penerima", fontSize: 11, alignment: "right" },
          { text: kw.nama_toko || ".................................", bold: true, fontSize: 11, alignment: "right", margin: [0, 20, 0, 0] },
        ],
        width: "*",
      },
    ],
    margin: [0, 4, 0, 0],
    preserveLeadingSpaces: true,
  });

  // Kotak nominal Rp.
  content.push({
    table: {
      widths: ["*", 60],
      body: [
        [
          { text: "", border: [false, false, false, false] },
          { text: `Rp. ${jumlahFmt.replace("Rp ", "")}`, bold: true, alignment: "center", fillColor: "#eeeeee" },
        ],
      ],
    },
    layout: {
      hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0 : 0.5),
      vLineWidth: (i) => (i === 1 ? 0.5 : 0),
      hLineColor: () => "#000",
      vLineColor: () => "#000",
    },
    margin: [0, 10, 0, 0],
    fontSize: 12,
  });

  return content;
}

// ---------------------------------------------------------------------------
// Bagian 2: BAST (Berita Acara Serah Terima) — Format 2 + Lampiran Foto
// ---------------------------------------------------------------------------

export function buildBastSection(data) {
  const b = data.bast;
  const ident = data.identitas;
  const content = [];

  content.push({ text: "FORMAT 2", bold: true, fontSize: 10, alignment: "right" });
  content.push(...kopStack(b.kop || data.document?.kop));
  content.push(
    ...sectionTitle(
      "BERITA ACARA SERAH TERIMA BARANG",
      "PENGADAAN / PEROLEHAN",
    ),
  );
  content.push({ text: `nomor: ${b.nomor_surat || "-"}`, fontSize: 10, alignment: "center", margin: [0, 1, 0, 6] });

  const hari = b.hari_ini || hariIndo(data.kwitansi?.tanggal_nota || data.kwitansi?.tanggal);
  const pembuka =
    `Pada hari ini ${hari || "..."} tanggal ${b.tgl_terbilang || "..."} ` +
    `bulan ${b.bulan_indo || "..."} tahun ${b.tahun_terbilang || "..."} ` +
    "yang bertanda tangan di bawah ini :";
  content.push({ text: pembuka, fontSize: 11, alignment: "justify", margin: [0, 0, 0, 4] });
  content.push(labelRow("Nama", b.nama_penerima || ident.nama_pengurus_barang || "-", 20));
  content.push(labelRow("Jabatan", b.jabatan_penerima || "Pengurus Barang", 20));
  content.push({
    text:
      `Telah menerima barang persediaan yang diserahkan oleh ${b.nama_penyedia || "-"} ` +
      `sesuai dengan Faktur Pembelian / Nota Pembelian tanggal ${b.tgl_full || "-"} ` +
      "sebagaimana daftar terlampir.",
    fontSize: 11,
    alignment: "justify",
    margin: [0, 4, 0, 4],
  });
  content.push({ text: "Daftar barang yang diterima sebagai berikut :", fontSize: 11, margin: [0, 0, 0, 3] });

  const body = [
    [
      { text: "No", bold: true, alignment: "center" },
      { text: "Uraian Nama Barang", bold: true, alignment: "center" },
      { text: "Harga Satuan", bold: true, alignment: "center" },
      { text: "Satuan", bold: true, alignment: "center" },
      { text: "Volume", bold: true, alignment: "center" },
      { text: "Jumlah", bold: true, alignment: "center" },
      { text: "Ket", bold: true, alignment: "center" },
    ],
    [
      { text: "(a)", italics: true, fontSize: 8, alignment: "center" },
      { text: "(b)", italics: true, fontSize: 8, alignment: "center" },
      { text: "(c)", italics: true, fontSize: 8, alignment: "center" },
      { text: "(d)", italics: true, fontSize: 8, alignment: "center" },
      { text: "(e)", italics: true, fontSize: 8, alignment: "center" },
      { text: "(f = c*e)", italics: true, fontSize: 8, alignment: "center" },
      { text: "(g)", italics: true, fontSize: 8, alignment: "center" },
    ],
  ];
  for (const it of b.items || []) {
    body.push([
      { text: String(it.no ?? ""), alignment: "center" },
      { text: it.uraian || "-", alignment: "left" },
      { text: it.harga_satuan_fmt || formatRupiah(it.harga_satuan), alignment: "right" },
      { text: it.satuan || "-", alignment: "center" },
      { text: fmtVolume(it.volume), alignment: "center" },
      { text: it.jumlah_fmt || formatRupiah(it.jumlah), alignment: "right" },
      { text: "", alignment: "center" },
    ]);
  }
  const totalVol = fmtVolume(b.total_volume ?? 0);
  const grandFmt = b.grand_total_fmt || formatRupiah(b.grand_total);
  body.push([
    { text: "Jumlah", bold: true, alignment: "right", colSpan: 4 },
    {},
    {},
    {},
    { text: totalVol, alignment: "center" },
    { text: grandFmt, bold: true, alignment: "right" },
    { text: "" },
  ]);
  body.push([
    { text: "Jumlah Total", bold: true, alignment: "right", colSpan: 4 },
    {},
    {},
    {},
    { text: "" },
    { text: grandFmt, bold: true, alignment: "right" },
    { text: "" },
  ]);

  content.push({
    table: { headerRows: 2, widths: [10, "*", 25, 15, 15, 25, 15], body },
    layout: {
      fillColor: (_, rowIndex) =>
        rowIndex >= body.length - 2 ? (rowIndex === body.length - 1 ? "#dfdfdf" : "#bfbfbf") : null,
    },
    fontSize: 9,
  });

  content.push({
    text: "Demikian Berita Acara Serah Terima Barang ini dibuat dalam rangkap 2 (dua) untuk digunakan sebagaimana mestinya.",
    fontSize: 11,
    margin: [0, 8, 0, 0],
    alignment: "justify",
  });

  // Tanda tangan: Penyedia (kiri) / Pengurus Barang (kanan) + Kepala Sekolah
  const kota = b.kota || ident.tempat_surat || "Jember";
  content.push({
    columns: [
      { text: "", width: "*" },
      { text: `${kota}, ${b.tgl_full || ""}`, width: "*", alignment: "center" },
    ],
    margin: [0, 10, 0, 0],
    fontSize: 11,
  });
  content.push({
    columns: [
      {
        stack: [
          { text: "Yang Menyerahkan", alignment: "center", fontSize: 11 },
          { text: "Penyedia Barang", alignment: "center", fontSize: 11 },
          { text: b.nama_penyedia || "-", bold: true, alignment: "center", fontSize: 11, margin: [0, 20, 0, 0] },
        ],
        width: "*",
      },
      {
        stack: [
          { text: "Yang Menerima", alignment: "center", fontSize: 11 },
          { text: b.jabatan_penerima || "Pengurus Barang", alignment: "center", fontSize: 11 },
          { text: b.nama_penerima || ident.nama_pengurus_barang || "-", bold: true, alignment: "center", fontSize: 11, margin: [0, 20, 0, 0] },
          { text: b.nip_penerima ? `NIP. ${b.nip_penerima}` : ident.nip_pengurus_barang ? `NIP. ${ident.nip_pengurus_barang}` : "", alignment: "center", fontSize: 11 },
        ],
        width: "*",
      },
    ],
    margin: [0, 2, 0, 0],
  });
  content.push({
    stack: [
      { text: "Mengetahui,", alignment: "center", fontSize: 11, margin: [0, 16, 0, 0] },
      { text: "Kepala Sekolah", alignment: "center", fontSize: 11 },
      ...ttdBlock(ident.nama_kepala_sekolah, ident.nip_kepala_sekolah, "center"),
    ],
    width: "50%",
    margin: [0, 0, 0, 0],
  });

  // ---- Halaman lampiran foto (opsional; tanpa kop — judul per halaman) ----
  const lamp = data.lampiran_foto || {};
  const urutan = [
    ["barang", "FOTO BARANG"],
    ["kegiatan", "FOTO KEGIATAN"],
    ["sebelum", "FOTO SEBELUM"],
    ["proses", "FOTO PROSES"],
    ["sesudah", "FOTO SESUDAH"],
  ];
  for (const [jenis, judul] of urutan) {
    const daftar = Array.isArray(lamp[jenis]) ? lamp[jenis] : [];
    if (!daftar.length) continue;
    content.push({ text: "", pageBreak: "before" });
    content.push({ text: `LAMPIRAN ${judul}`, bold: true, fontSize: 12, alignment: "center" });
    content.push({
      text: `Nomor Kwitansi : ${data.kwitansi.nomor_kwitansi || "-"}`,
      fontSize: 10,
      alignment: "center",
      margin: [0, 1, 0, 8],
    });
    // Foto diambil via URL statis /uploads — batasi ukuran tampilan (tinggi
    // maks ~70mm lewat fit) agar PDF tidak membengkak. available=false diberi
    // placeholder kotak agar mudah dilihat bahwa file tidak ditemukan.
    const imgs = [];
    for (const f of daftar) {
      const raw = typeof f === "string" ? f : f.path || "";
      const url = absoluteize(raw);
      const ok = (typeof f === "string" ? true : f.available !== false) && !!url;
      if (ok) {
        imgs.push({ image: url, fit: [85, 70], margin: [0, 0, 2, 2] });
      } else {
        imgs.push({
          canvas: [{ type: "rect", x: 0, y: 0, w: 50, h: 70, lineWidth: 0.5 }],
          margin: [0, 0, 2, 2],
        });
        imgs.push({ text: "Foto Tidak Ditemukan", italics: true, fontSize: 7, margin: [0, 0, 2, 2] });
      }
    }
    // susun per baris ~4 gambar
    for (let i = 0; i < imgs.length; i += 4) {
      content.push({ columns: imgs.slice(i, i + 4), margin: [0, 0, 0, 4] });
    }
  }

  return content;
}

// ---------------------------------------------------------------------------
// Bagian 3: RAB — tabel lebar, subtotal per kategori & total dari backend
// ---------------------------------------------------------------------------

export function buildRabSection(data) {
  const r = data.rab;
  const ident = data.identitas;
  const content = [];

  content.push(...kopStack(r.kop || data.document?.kop));
  content.push(...sectionTitle("RINCIAN ANGGARAN BIAYA (RAB)", r.kegiatan || ""));
  content.push({ text: "", fontSize: 6 });

  content.push(labelRow("Kegiatan", r.kegiatan || "-", 28));
  content.push(labelRow("Tahap", r.thp_label || "-", 28));
  content.push(labelRow("Tahun Anggaran", r.tahun || "-", 28));
  content.push(labelRow("Satuan Pendidikan", r.satuan_pendidikan || ident.nama_sekolah || "-", 28));

  const body = [
    [
      { text: "No", bold: true, alignment: "center" },
      { text: "Uraian Kegiatan", bold: true, alignment: "center" },
      { text: "Volume", bold: true, alignment: "center" },
      { text: "Satuan", bold: true, alignment: "center" },
      { text: "Harga Satuan", bold: true, alignment: "center" },
      { text: "Jumlah", bold: true, alignment: "center" },
      { text: "Jenis Belanja", bold: true, alignment: "center" },
      { text: "Keterangan", bold: true, alignment: "center" },
    ],
  ];
  for (const row of r.rows || []) {
    body.push([
      { text: String(row.no ?? ""), alignment: "center" },
      { text: row.uraian || "-", alignment: "left" },
      { text: fmtVolume(row.volume), alignment: "center" },
      { text: row.satuan || "", alignment: "center" },
      { text: row.harga_satuan_fmt || formatRupiah(row.harga_satuan), alignment: "right" },
      { text: row.jumlah_fmt || formatRupiah(row.jumlah), alignment: "right" },
      { text: row.jenis_belanja || "-", alignment: "left" },
      { text: row.keterangan || "", alignment: "left" },
    ]);
  }
  const grandFmt = r.grand_total_fmt || formatRupiah(r.grand_total);
  body.push([
    { text: "Jumlah Total", bold: true, alignment: "right", colSpan: 5 },
    {},
    {},
    {},
    {},
    { text: grandFmt, bold: true, alignment: "right" },
    { text: "", fillColor: "#e6e6e6" },
    { text: "", fillColor: "#e6e6e6" },
  ]);

  content.push({
    table: {
      headerRows: 1,
      widths: [10, "*", 15, 18, 28, 28, 32, 24],
      body,
    },
    layout: {
      fillColor: (_, rowIndex) => (rowIndex === body.length - 1 ? "#e6e6e6" : null),
    },
    fontSize: 9,
    margin: [0, 6, 0, 0],
  });

  // Blok tanda tangan SETELAH konten; keepTogether mencegah tabel memotong
  // ke atas nama (teks panjang tidak menimpa tanda tangan).
  content.push({
    stack: [
      { text: r.tanggal_surat || "", alignment: "right", fontSize: 11, margin: [0, 14, 0, 0] },
      { text: "Mengetahui,", alignment: "right", fontSize: 11 },
      { text: "Kepala Sekolah", alignment: "right", fontSize: 11 },
      { text: ident.nama_kepala_sekolah || ".................................", bold: true, alignment: "right", fontSize: 11, margin: [0, 22, 0, 0] },
      { text: ident.nip_kepala_sekolah ? `NIP. ${ident.nip_kepala_sekolah}` : "NIP. .............................", alignment: "right", fontSize: 11 },
    ],
    width: "50%",
    margin: [0, 0, 0, 0],
    preserveLeadingSpaces: true,
  });

  return content;
}

// ---------------------------------------------------------------------------
// Rakit definisi dokumen
// ---------------------------------------------------------------------------

export function buildSpjDocumentDefinition(data) {
  validateSpjPayload(data);

  const doc = data.document || {};
  const order = Array.isArray(doc.order) && doc.order.length ? doc.order : ["kwitansi", "bast", "rab"];
  const sec = data.sections || {};
  const included = (name) => {
    const s = sec[name];
    if (!s) return false;
    if (typeof s.included === "boolean") return s.included;
    return s.status === "included";
  };

  const content = [];
  let first = true;
  for (const name of order) {
    if (!included(name)) continue; // alasan skip sudah di-expose backend/UI
    let part;
    if (name === "kwitansi") part = buildKwitansiSection(data);
    else if (name === "bast") part = buildBastSection(data);
    else if (name === "rab") part = buildRabSection(data);
    else fail(`bagian tak dikenal pada document.order: ${name}`);
    if (!first) part.unshift({ text: "", pageBreak: "before" });
    content.push(...part);
    first = false;
  }
  if (first) fail("tidak ada bagian yang dapat dirender (semua ditandai skip)");

  const paper = doc.paper || {};
  return {
    pageSize: [num(paper.width_mm) || 215, num(paper.height_mm) || 330],
    pageMargins: [
      num(paper.margin_mm) || 15,
      num(paper.margin_mm) || 15,
      num(paper.margin_mm) || 15,
      num(paper.margin_bottom_mm) || 20,
    ],
    defaultStyle: { font: "Helvetica", fontSize: 10 },
    info: {
      title: doc.filename || "SPJ.pdf",
      creator: "Aplikasi SPJ (frontend pdfmake)",
    },
    content,
  };
}

/**
 * Render payload SPJ menjadi Blob PDF (async). Semua kegagalan (validasi,
 * render) dilempar sebagai Error agar pemanggil (app.js) menampilkannya.
 */
export function buildSpjPdf(data) {
  return new Promise((resolve, reject) => {
    let dd;
    try {
      dd = buildSpjDocumentDefinition(data);
    } catch (e) {
      reject(e);
      return;
    }
    try {
      pdfMake.createPdf(dd).getBlob((blob) => {
        if (!blob || blob.size === 0) {
          reject(new Error("Renderer menghasilkan PDF kosong"));
          return;
        }
        resolve(blob);
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
