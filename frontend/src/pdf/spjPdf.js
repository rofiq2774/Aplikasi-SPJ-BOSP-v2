// ============================================================================
// spjPdf.js — Renderer PDF SPJ di FRONTEND (pdfmake)
// ============================================================================

import pdfMake from "pdfmake/build/pdfmake";
import * as pdfFontsNs from "pdfmake/build/vfs_fonts";

const _vfsMod = pdfFontsNs?.default ?? pdfFontsNs;
const _vfs =
  _vfsMod?.pdfMake?.vfs ??
  _vfsMod?.vfs ??
  (typeof window !== "undefined" ? window.pdfMakeVfsFonts?.pdfMake?.vfs : null);
if (_vfs) pdfMake.vfs = _vfs;

pdfMake.fonts = {
  Arial: {
    normal: "Arial.ttf",
    bold: "Arial-Bold.ttf",
    italics: "Arial-Italic.ttf",
    bolditalics: "Arial-BoldItalic.ttf",
  },
  Roboto: {
    normal: "Roboto-Regular.ttf",
    bold: "Roboto-Medium.ttf",
    italics: "Roboto-Italic.ttf",
    bolditalics: "Roboto-MediumItalic.ttf",
  },
};

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
// Helper untuk menghapus background putih dari gambar via Canvas
// ---------------------------------------------------------------------------
function removeWhiteBackground(src) {
  return new Promise((resolve) => {
    if (!src || typeof src !== "string") return resolve(src);

    const fullUrl = absoluteize(src);
    const img = new Image();
    img.crossOrigin = "Anonymous";

    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];

          if (r > 240 && g > 240 && b > 240) {
            data[i + 3] = 0;
          }
        }

        ctx.putImageData(imageData, 0, 0);
        resolve(canvas.toDataURL("image/png"));
      } catch (e) {
        console.warn("Canvas terblokir CORS, fallback ke gambar asli", e);
        resolve(src);
      }
    };

    img.onerror = () => resolve(src);
    img.src = fullUrl;
  });
}

// ---------------------------------------------------------------------------
// Helper format bersama
// ---------------------------------------------------------------------------

export function formatRupiah(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "Rp 0";
  return `Rp ${Math.round(n).toLocaleString("de-DE")}`;
}

const BULAN_ID = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

const HARI_ID = {
  Monday: "Senin",
  Tuesday: "Selasa",
  Wednesday: "Rabu",
  Thursday: "Kamis",
  Friday: "Jumat",
  Saturday: "Sabtu",
  Sunday: "Minggu",
};

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
      return s;
    }
  }
  return `${Number(d)} ${BULAN_ID[Number(m) - 1]} ${y}`;
}

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

function fail(msg) {
  throw new Error(`Data SPJ tidak valid: ${msg}`);
}

export function validateSpjPayload(data) {
  if (!data || typeof data !== "object") fail("payload kosong/bukan objek");
  if (data.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    fail(`schema_version ${data.schema_version} tidak didukung.`);
  }
  for (const key of ["kwitansi", "identitas", "sections"]) {
    if (!data[key] || typeof data[key] !== "object")
      fail(`field '${key}' hilang`);
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
  if (!included("kwitansi")) fail("bagian kwitansi wajib");

  if (included("bast") && !data.bast)
    fail("sections.bast=included tetapi data bast kosong");
  if (included("rab") && !data.rab)
    fail("sections.rab=included tetapi data rab kosong");

  return { included };
}

// ---------------------------------------------------------------------------
// Blok presentasi bersama
// ---------------------------------------------------------------------------

const PAGE = { size: [215, 330], margins: [15, 15, 15, 20] };
const KOP_TEXT_W = PAGE.size[0] - PAGE.margins[0] - PAGE.margins[2] - 2 * 28;

function kopStack(kop) {
  const logoStyle = { width: 24, height: 20 };
  const hasL = !!kop?.logo_pemda;
  const hasR = !!kop?.logo_sekolah;
  const stack = [];

  // Wajib menggunakan font Arial pada KOP
  if (kop?.baris1) {
    stack.push({
      text: String(kop.baris1).toUpperCase(),
      font: "Arial",
      bold: true,
      fontSize: 13,
      alignment: "center",
      margin: [0, 0, 0, 2],
    });
  }
  if (kop?.baris2) {
    stack.push({
      text: String(kop.baris2).toUpperCase(),
      font: "Arial",
      bold: true,
      fontSize: 16,
      alignment: "center",
      margin: [0, 0, 0, 2],
    });
  }
  if (kop?.alamat) {
    stack.push({
      text: kop.alamat,
      font: "Arial",
      fontSize: 9,
      alignment: "center",
    });
  }

  return [
    {
      columns: [
        hasL ? { image: kop.logo_pemda, ...logoStyle } : { text: "", width: 0 },
        { stack, width: "*", margin: [2, 0, 2, 4] },
        hasR
          ? { image: kop.logo_sekolah, ...logoStyle }
          : { text: "", width: 0 },
      ],
      columnWidths: [hasL ? 24 : 0, "*", hasR ? 24 : 0],
    },
    {
      canvas: [
        { type: "line", x1: 0, y1: 0, x2: KOP_TEXT_W, y2: 0, lineWidth: 1.8 },
        {
          type: "line",
          x1: 0,
          y1: 2.5,
          x2: KOP_TEXT_W,
          y2: 2.5,
          lineWidth: 0.6,
        },
      ],
      margin: [0, 0, 0, 10],
    },
  ];
}

function sectionTitle(title, subtitle) {
  const out = [{ text: title, bold: true, fontSize: 15, alignment: "center" }];
  if (subtitle) {
    out.push({
      text: subtitle,
      fontSize: 11,
      alignment: "center",
      margin: [0, 3, 0, 0],
    });
  }
  return out;
}

function labelRow(label, value, labelW = 40) {
  return {
    columns: [
      { text: label, width: labelW, fontSize: 11 },
      { text: `:  ${value ?? "-"}`, flex: {}, colSpan: 1, fontSize: 11 },
    ],
    margin: [0, 2, 0, 2],
  };
}

function ttdBlock(name, nip, align = "left") {
  return [
    {
      text: name || ".................................",
      bold: true,
      fontSize: 11,
      alignment: align,
      margin: [0, 45, 0, 2],
    },
    {
      text: nip ? `NIP. ${nip}` : "NIP. .............................",
      fontSize: 11,
      alignment: align,
    },
  ];
}

// ---------------------------------------------------------------------------
// Bagian 1: KWITANSI (Tanda Terima Pembayaran) — TANPA KOP
// ---------------------------------------------------------------------------

export function buildKwitansiSection(data) {
  const kw = data.kwitansi;
  const ident = data.identitas;
  const content = [];

  // Sengaja tidak memangil kopStack() untuk bagian Kwitansi
  content.push({ text: "", margin: [0, 20, 0, 0] });
  content.push(
    ...sectionTitle("KWITANSI", `Nomor: ${kw.nomor_kwitansi || "-"}`),
  );
  content.push({ text: "", margin: [0, 10, 0, 0] });

  const jumlahFmt = kw.jumlah_rupiah || formatRupiah(kw.jumlah);
  const terbilang = kw.terbilang || "................ rupiah";

  content.push(
    labelRow(
      "Telah terima dari",
      `BENDAHARA BOSP ${(ident.nama_sekolah || "").toUpperCase()}`,
      110,
    ),
  );
  content.push(labelRow("Uang sejumlah", `${terbilang} (${jumlahFmt})`, 110));
  content.push(
    labelRow(
      "Untuk pembayaran",
      kw.uraian_pembayaran || kw.nama_kegiatan || "-",
      110,
    ),
  );
  if (kw.no_bast) content.push(labelRow("No. BAST", kw.no_bast, 110));
  if (kw.nama_toko)
    content.push(
      labelRow(
        "Penyedia",
        `${kw.nama_toko}${kw.npwp_toko ? ` (NPWP: ${kw.npwp_toko})` : ""}`,
        110,
      ),
    );
  if (kw.alamat_toko) content.push(labelRow("Alamat", kw.alamat_toko, 110));

  content.push({ text: "", margin: [0, 10, 0, 0] });

  const rows = [
    [
      { text: "No", bold: true, alignment: "center", margin: [0, 4, 0, 4] },
      {
        text: "Rincian Barang/Jasa",
        bold: true,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      { text: "Jumlah", bold: true, alignment: "center", margin: [0, 4, 0, 4] },
    ],
  ];

  const items = Array.isArray(data.transaksi_bast) ? data.transaksi_bast : [];
  if (items.length) {
    items.forEach((it) => {
      rows.push([
        {
          text: String(it.no ?? ""),
          alignment: "center",
          margin: [0, 4, 0, 4],
        },
        { text: it.uraian || "-", alignment: "left", margin: [4, 4, 0, 4] },
        {
          text: it.jumlah_fmt || formatRupiah(it.jumlah),
          alignment: "right",
          margin: [0, 4, 4, 4],
        },
      ]);
    });
  } else {
    rows.push([
      { text: "1", alignment: "center", margin: [0, 4, 0, 4] },
      {
        text: kw.uraian_detail || kw.uraian_pembayaran || "-",
        alignment: "left",
        margin: [4, 4, 0, 4],
      },
      { text: jumlahFmt, alignment: "right", margin: [0, 4, 4, 4] },
    ]);
  }

  rows.push([
    { text: "", border: [false, false, false, false] },
    { text: "JUMLAH", bold: true, alignment: "right", margin: [0, 6, 4, 6] },
    { text: jumlahFmt, bold: true, alignment: "right", margin: [0, 6, 4, 6] },
  ]);

  content.push({
    table: {
      headerRows: 1,
      widths: [25, "*", 100],
      body: rows,
    },
    layout: {
      fillColor: (_, rowIndex) =>
        rowIndex === 0 || rowIndex === rows.length - 1 ? "#f5f5f5" : null,
    },
    fontSize: 10,
    margin: [0, 10, 0, 15],
  });

  content.push({
    table: {
      widths: ["*", 120],
      body: [
        [
          { text: "", border: [false, false, false, false] },
          {
            text: `Rp. ${jumlahFmt.replace("Rp ", "")}`,
            bold: true,
            alignment: "center",
            fontSize: 12,
            margin: [0, 6, 0, 6],
            fillColor: "#f0f0f0",
          },
        ],
      ],
    },
    layout: {
      hLineWidth: (i, node) =>
        i === 0 || i === node.table.body.length ? 0 : 0.5,
      vLineWidth: (i) => (i === 1 ? 0.5 : 0),
      hLineColor: () => "#000",
      vLineColor: () => "#000",
    },
    margin: [0, 0, 0, 30],
  });

  const kota = kw.kota_tempat_surat || ident.tempat_surat || "Jember";
  const tgl = formatTanggalIndo(kw.tanggal);
  content.push({
    columns: [
      {
        stack: [
          {
            text: "Setuju Dibayar",
            fontSize: 11,
            alignment: "center",
            bold: true,
          },
          {
            text: "Kepala Sekolah",
            fontSize: 11,
            alignment: "center",
            margin: [0, 0, 0, 5],
          },
          ...ttdBlock(
            ident.nama_kepala_sekolah,
            ident.nip_kepala_sekolah,
            "center",
          ),
        ],
        width: "*",
      },
      {
        stack: [
          {
            text: "Lunas Dibayar",
            fontSize: 11,
            alignment: "center",
            bold: true,
          },
          {
            text: "Bendahara BOSP",
            fontSize: 11,
            alignment: "center",
            margin: [0, 0, 0, 5],
          },
          ...ttdBlock(ident.nama_bendahara, ident.nip_bendahara, "center"),
        ],
        width: "*",
      },
      {
        stack: [
          {
            text: `${kota}, ${tgl}`,
            fontSize: 11,
            alignment: "center",
            bold: true,
          },
          {
            text: "Penerima",
            fontSize: 11,
            alignment: "center",
            margin: [0, 0, 0, 5],
          },
          {
            text: kw.nama_toko || ".................................",
            bold: true,
            fontSize: 11,
            alignment: "center",
            margin: [0, 45, 0, 2],
          },
        ],
        width: "*",
      },
    ],
    margin: [0, 10, 0, 0],
    preserveLeadingSpaces: true,
  });

  return content;
}

// ---------------------------------------------------------------------------
// Bagian 2: BAST (Berita Acara Serah Terima)
// ---------------------------------------------------------------------------

export function buildBastSection(data) {
  const b = data.bast;
  const ident = data.identitas;
  const content = [];

  content.push({
    text: "FORMAT 2",
    bold: true,
    fontSize: 10,
    alignment: "right",
    margin: [0, 0, 0, 5],
  });
  content.push(...kopStack(b.kop || data.document?.kop));
  content.push(
    ...sectionTitle(
      "BERITA ACARA SERAH TERIMA BARANG",
      "PENGADAAN / PEROLEHAN",
    ),
  );
  content.push({
    text: `Nomor: ${b.nomor_surat || "-"}`,
    fontSize: 11,
    alignment: "center",
    margin: [0, 5, 0, 15],
  });

  const hari =
    b.hari_ini ||
    hariIndo(data.kwitansi?.tanggal_nota || data.kwitansi?.tanggal);
  const pembuka =
    `Pada hari ini ${hari || "..."} tanggal ${b.tgl_terbilang || "..."} ` +
    `bulan ${b.bulan_indo || "..."} tahun ${b.tahun_terbilang || "..."} ` +
    "yang bertanda tangan di bawah ini :";

  content.push({
    text: pembuka,
    fontSize: 11,
    alignment: "justify",
    margin: [0, 0, 0, 10],
  });
  content.push(
    labelRow("Nama", b.nama_penerima || ident.nama_pengurus_barang || "-", 60),
  );
  content.push(
    labelRow("Jabatan", b.jabatan_penerima || "Pengurus Barang", 60),
  );

  content.push({
    text:
      `Telah menerima barang persediaan yang diserahkan oleh ${b.nama_penyedia || "-"} ` +
      `sesuai dengan Faktur Pembelian / Nota Pembelian tanggal ${b.tgl_full || "-"} ` +
      "sebagaimana daftar terlampir.",
    fontSize: 11,
    alignment: "justify",
    margin: [0, 10, 0, 10],
  });
  content.push({
    text: "Daftar barang yang diterima sebagai berikut :",
    fontSize: 11,
    margin: [0, 0, 0, 5],
  });

  const body = [
    [
      { text: "No", bold: true, alignment: "center", margin: [0, 4, 0, 4] },
      {
        text: "Uraian Nama Barang",
        bold: true,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      {
        text: "Harga Satuan",
        bold: true,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      { text: "Satuan", bold: true, alignment: "center", margin: [0, 4, 0, 4] },
      { text: "Volume", bold: true, alignment: "center", margin: [0, 4, 0, 4] },
      { text: "Jumlah", bold: true, alignment: "center", margin: [0, 4, 0, 4] },
      { text: "Ket", bold: true, alignment: "center", margin: [0, 4, 0, 4] },
    ],
    [
      { text: "(a)", italics: true, fontSize: 9, alignment: "center" },
      { text: "(b)", italics: true, fontSize: 9, alignment: "center" },
      { text: "(c)", italics: true, fontSize: 9, alignment: "center" },
      { text: "(d)", italics: true, fontSize: 9, alignment: "center" },
      { text: "(e)", italics: true, fontSize: 9, alignment: "center" },
      { text: "(f = c*e)", italics: true, fontSize: 9, alignment: "center" },
      { text: "(g)", italics: true, fontSize: 9, alignment: "center" },
    ],
  ];

  for (const it of b.items || []) {
    body.push([
      { text: String(it.no ?? ""), alignment: "center", margin: [0, 4, 0, 4] },
      { text: it.uraian || "-", alignment: "left", margin: [4, 4, 0, 4] },
      {
        text: it.harga_satuan_fmt || formatRupiah(it.harga_satuan),
        alignment: "right",
        margin: [0, 4, 4, 4],
      },
      { text: it.satuan || "-", alignment: "center", margin: [0, 4, 0, 4] },
      { text: fmtVolume(it.volume), alignment: "center", margin: [0, 4, 0, 4] },
      {
        text: it.jumlah_fmt || formatRupiah(it.jumlah),
        alignment: "right",
        margin: [0, 4, 4, 4],
      },
      { text: "", alignment: "center" },
    ]);
  }

  const totalVol = fmtVolume(b.total_volume ?? 0);
  const grandFmt = b.grand_total_fmt || formatRupiah(b.grand_total);

  body.push([
    {
      text: "Jumlah",
      bold: true,
      alignment: "right",
      colSpan: 4,
      margin: [0, 5, 5, 5],
    },
    {},
    {},
    {},
    { text: totalVol, alignment: "center", margin: [0, 5, 0, 5] },
    { text: grandFmt, bold: true, alignment: "right", margin: [0, 5, 4, 5] },
    { text: "" },
  ]);

  body.push([
    {
      text: "Jumlah Total",
      bold: true,
      alignment: "right",
      colSpan: 4,
      margin: [0, 5, 5, 5],
    },
    {},
    {},
    {},
    { text: "" },
    { text: grandFmt, bold: true, alignment: "right", margin: [0, 5, 4, 5] },
    { text: "" },
  ]);

  content.push({
    table: { headerRows: 2, widths: [15, "*", 45, 30, 30, 50, 25], body },
    layout: {
      fillColor: (_, rowIndex) =>
        rowIndex >= body.length - 2
          ? rowIndex === body.length - 1
            ? "#eaeaea"
            : "#f5f5f5"
          : null,
    },
    fontSize: 9,
    margin: [0, 5, 0, 15],
  });

  content.push({
    text: "Demikian Berita Acara Serah Terima Barang ini dibuat dalam rangkap 2 (dua) untuk digunakan sebagaimana mestinya.",
    fontSize: 11,
    margin: [0, 10, 0, 20],
    alignment: "justify",
  });

  const kota = b.kota || ident.tempat_surat || "Jember";
  content.push({
    columns: [
      { text: "", width: "*" },
      { text: `${kota}, ${b.tgl_full || ""}`, width: "*", alignment: "center" },
    ],
    margin: [0, 0, 0, 5],
    fontSize: 11,
  });

  content.push({
    columns: [
      {
        stack: [
          {
            text: "Yang Menyerahkan",
            alignment: "center",
            fontSize: 11,
            bold: true,
          },
          {
            text: "Penyedia Barang",
            alignment: "center",
            fontSize: 11,
            margin: [0, 0, 0, 5],
          },
          {
            text: b.nama_penyedia || "-",
            bold: true,
            alignment: "center",
            fontSize: 11,
            margin: [0, 45, 0, 2],
          },
        ],
        width: "*",
      },
      {
        stack: [
          {
            text: "Yang Menerima",
            alignment: "center",
            fontSize: 11,
            bold: true,
          },
          {
            text: b.jabatan_penerima || "Pengurus Barang",
            alignment: "center",
            fontSize: 11,
            margin: [0, 0, 0, 5],
          },
          {
            text: b.nama_penerima || ident.nama_pengurus_barang || "-",
            bold: true,
            alignment: "center",
            fontSize: 11,
            margin: [0, 45, 0, 2],
          },
          {
            text: b.nip_penerima
              ? `NIP. ${b.nip_penerima}`
              : ident.nip_pengurus_barang
                ? `NIP. ${ident.nip_pengurus_barang}`
                : "",
            alignment: "center",
            fontSize: 11,
          },
        ],
        width: "*",
      },
    ],
    margin: [0, 0, 0, 25],
  });

  content.push({
    stack: [
      { text: "Mengetahui,", alignment: "center", fontSize: 11, bold: true },
      {
        text: "Kepala Sekolah",
        alignment: "center",
        fontSize: 11,
        margin: [0, 0, 0, 5],
      },
      ...ttdBlock(
        ident.nama_kepala_sekolah,
        ident.nip_kepala_sekolah,
        "center",
      ),
    ],
    width: "50%",
    margin: [0, 0, 0, 0],
    relativePosition: { x: 130, y: 0 },
  });

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
    content.push({
      text: `LAMPIRAN ${judul}`,
      bold: true,
      fontSize: 14,
      alignment: "center",
      margin: [0, 10, 0, 5],
    });
    content.push({
      text: `Nomor Kwitansi : ${data.kwitansi.nomor_kwitansi || "-"}`,
      fontSize: 11,
      alignment: "center",
      margin: [0, 0, 0, 15],
    });
    const imgs = [];
    for (const f of daftar) {
      const raw = typeof f === "string" ? f : f.path || "";
      const url = absoluteize(raw);
      const ok =
        (typeof f === "string" ? true : f.available !== false) && !!url;
      if (ok) {
        imgs.push({ image: url, fit: [100, 85], margin: [0, 0, 5, 5] });
      } else {
        imgs.push({
          canvas: [{ type: "rect", x: 0, y: 0, w: 60, h: 85, lineWidth: 0.5 }],
          margin: [0, 0, 5, 5],
        });
        imgs.push({
          text: "Foto Tidak Ditemukan",
          italics: true,
          fontSize: 8,
          margin: [0, 0, 5, 5],
        });
      }
    }
    for (let i = 0; i < imgs.length; i += 4) {
      content.push({ columns: imgs.slice(i, i + 4), margin: [0, 0, 0, 10] });
    }
  }

  return content;
}

// ---------------------------------------------------------------------------
// Bagian 3: RAB
// ---------------------------------------------------------------------------

export function buildRabSection(data) {
  const r = data.rab;
  const ident = data.identitas;
  const content = [];

  content.push(...kopStack(r.kop || data.document?.kop));
  content.push(
    ...sectionTitle("RINCIAN ANGGARAN BIAYA (RAB)", r.kegiatan || ""),
  );
  content.push({ text: "", margin: [0, 15, 0, 0] });

  content.push(labelRow("Kegiatan", r.kegiatan || "-", 80));
  content.push(labelRow("Tahap", r.thp_label || "-", 80));
  content.push(labelRow("Tahun Anggaran", r.tahun || "-", 80));
  content.push(
    labelRow(
      "Satuan Pendidikan",
      r.satuan_pendidikan || ident.nama_sekolah || "-",
      80,
    ),
  );
  content.push({ text: "", margin: [0, 10, 0, 0] });

  const body = [
    [
      { text: "No", bold: true, alignment: "center", margin: [0, 4, 0, 4] },
      {
        text: "Uraian Kegiatan",
        bold: true,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      { text: "Volume", bold: true, alignment: "center", margin: [0, 4, 0, 4] },
      { text: "Satuan", bold: true, alignment: "center", margin: [0, 4, 0, 4] },
      {
        text: "Harga Satuan",
        bold: true,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      { text: "Jumlah", bold: true, alignment: "center", margin: [0, 4, 0, 4] },
      {
        text: "Jenis Belanja",
        bold: true,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      {
        text: "Keterangan",
        bold: true,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
    ],
  ];
  for (const row of r.rows || []) {
    body.push([
      { text: String(row.no ?? ""), alignment: "center", margin: [0, 4, 0, 4] },
      { text: row.uraian || "-", alignment: "left", margin: [4, 4, 0, 4] },
      {
        text: fmtVolume(row.volume),
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      { text: row.satuan || "", alignment: "center", margin: [0, 4, 0, 4] },
      {
        text: row.harga_satuan_fmt || formatRupiah(row.harga_satuan),
        alignment: "right",
        margin: [0, 4, 4, 4],
      },
      {
        text: row.jumlah_fmt || formatRupiah(row.jumlah),
        alignment: "right",
        margin: [0, 4, 4, 4],
      },
      {
        text: row.jenis_belanja || "-",
        alignment: "left",
        margin: [4, 4, 0, 4],
      },
      { text: row.keterangan || "", alignment: "left", margin: [4, 4, 0, 4] },
    ]);
  }

  const grandFmt = r.grand_total_fmt || formatRupiah(r.grand_total);
  body.push([
    {
      text: "Jumlah Total",
      bold: true,
      alignment: "right",
      colSpan: 5,
      margin: [0, 6, 5, 6],
    },
    {},
    {},
    {},
    {},
    { text: grandFmt, bold: true, alignment: "right", margin: [0, 6, 4, 6] },
    { text: "", fillColor: "#f0f0f0" },
    { text: "", fillColor: "#f0f0f0" },
  ]);

  content.push({
    table: {
      headerRows: 1,
      widths: [15, "*", 30, 35, 55, 60, 50, 45],
      body,
    },
    layout: {
      fillColor: (_, rowIndex) =>
        rowIndex === 0 || rowIndex === body.length - 1 ? "#f5f5f5" : null,
    },
    fontSize: 9,
    margin: [0, 5, 0, 15],
  });

  content.push({
    stack: [
      {
        text: r.tanggal_surat || "",
        alignment: "right",
        fontSize: 11,
        margin: [0, 20, 0, 5],
        bold: true,
      },
      { text: "Mengetahui,", alignment: "right", fontSize: 11, bold: true },
      {
        text: "Kepala Sekolah",
        alignment: "right",
        fontSize: 11,
        margin: [0, 0, 0, 5],
      },
      {
        text: ident.nama_kepala_sekolah || ".................................",
        bold: true,
        alignment: "right",
        fontSize: 11,
        margin: [0, 45, 0, 2],
      },
      {
        text: ident.nip_kepala_sekolah
          ? `NIP. ${ident.nip_kepala_sekolah}`
          : "NIP. .............................",
        alignment: "right",
        fontSize: 11,
      },
    ],
    width: "50%",
    margin: [0, 0, 0, 0],
    preserveLeadingSpaces: true,
  });

  return content;
}

// ---------------------------------------------------------------------------
// Rakit definisi dokumen & Async Builder
// ---------------------------------------------------------------------------

export function buildSpjDocumentDefinition(data) {
  validateSpjPayload(data);

  const doc = data.document || {};
  const order =
    Array.isArray(doc.order) && doc.order.length
      ? doc.order
      : ["kwitansi", "bast", "rab"];
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
    if (!included(name)) continue;
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
    defaultStyle: { font: "Arial", fontSize: 10, lineHeight: 1.2 },
    info: {
      title: doc.filename || "SPJ.pdf",
      creator: "Aplikasi SPJ (frontend pdfmake)",
    },
    content,
  };
}

export async function buildSpjPdf(data) {
  // PROSES PRE-RENDER: Hapus background putih pada logo sebelum merakit dokumen
  try {
    const kops = [data.bast?.kop, data.rab?.kop, data.document?.kop];
    for (const kop of kops) {
      if (kop) {
        if (kop.logo_pemda)
          kop.logo_pemda = await removeWhiteBackground(kop.logo_pemda);
        if (kop.logo_sekolah)
          kop.logo_sekolah = await removeWhiteBackground(kop.logo_sekolah);
      }
    }
  } catch (err) {
    console.warn("Gagal memproses transparansi gambar:", err);
  }

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
