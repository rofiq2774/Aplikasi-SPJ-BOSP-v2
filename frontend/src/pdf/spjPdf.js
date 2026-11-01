// ============================================================================
// spjPdf.js — Renderer PDF SPJ di FRONTEND (pdfmake)
// ============================================================================
// Alur: backend HANYA mengirim JSON (GET /api/kwitansi/{id}/spj-data);
// seluruh pembuatan PDF terjadi di sini. Tidak ada permintaan/ respons
// application/pdf dari backend untuk alur SPJ.
//
// FONT: semua teks WAJIB Arial. Empat variasi (normal/bold/italics/
// bolditalics) dimuat saat runtime dari berkas font Arial yang terpasang di
// Windows melalui IPC Electron yang sempit (ipcMain "get-arial-pdf-fonts"
// hanya membaca 4 nama file tetap dari %WINDIR%\Fonts — tanpa path arbitrer
// dari renderer, tanpa menyalin/mengemas font proprietary ke dalam installer).
// VFS bawaan pdfmake (Roboto) TIDAK dimuat sama sekali: jika font Arial tidak
// tersedia, render GAGAL dengan error jelas — tidak ada fallback diam-diam.
//
// Dev browser murni (vite tanpa Electron): karena jendela utama selalu dibuka
// setelah backend/Electron siap, kegagalan font harus terlihat sebagai error
// nyata — tetapi agar modul ini tetap dapat diuji/dijalankan di browser biasa,
// tersedia jembatan dev eksplisit `window.__spjGetArialFonts` (lihat
// ensureArialFonts). Tidak pernah ada unduhan font diam-diam dari internet.

import pdfMake from "pdfmake/build/pdfmake";

// Peta nama -> base64 diisi oleh ensureArialFonts() dari IPC Electron main.
const ARIAL_VFS_NAMES = {
  normal: "Arial.ttf",
  bold: "Arial-Bold.ttf",
  italics: "Arial-Italic.ttf",
  bolditalics: "Arial-BoldItalic.ttf",
};

pdfMake.fonts = {
  Arial: { ...ARIAL_VFS_NAMES },
};

let _arialFontsPromise = null;
export async function ensureArialFonts() {
  if (!_arialFontsPromise) {
    _arialFontsPromise = (async () => {
      // Sumber resmi: IPC Electron main (build & dev dalam aplikasi desktop).
      let getFonts =
        typeof window !== "undefined" && window.electronAPI?.getArialPdfFonts;
      // Jembatan dev/test browser non-Elektron (mis. vitest atau debugging
      // langsung di browser). Ini bukan fallback diam-diam: bila tidak ada
      // sumber font sama sekali, error di bawah tetap muncul.
      if (typeof getFonts !== "function") {
        getFonts =
          typeof window !== "undefined" ? window.__spjGetArialFonts : undefined;
      }
      if (typeof getFonts !== "function") {
        throw new Error(
          "Font Arial untuk PDF tidak tersedia: jalankan aplikasi lewat " +
            "Electron (npm start di root) agar berkas Arial dari Windows " +
            "Fonts dapat dibaca melalui IPC, atau sediakan jembatan dev " +
            "window.__spjGetArialFonts.",
        );
      }

      const fonts = await getFonts();
      const fontFiles = {
        [ARIAL_VFS_NAMES.normal]: fonts?.regular,
        [ARIAL_VFS_NAMES.bold]: fonts?.bold,
        [ARIAL_VFS_NAMES.italics]: fonts?.italics,
        [ARIAL_VFS_NAMES.bolditalics]: fonts?.bolditalics,
      };
      const missing = Object.entries(fontFiles)
        .filter(([, b64]) => !b64)
        .map(([name]) => name);
      if (missing.length) {
        throw new Error(
          `Berkas font Arial lengkap tidak ditemukan di Windows (kurang: ${missing.join(", ")}).`,
        );
      }

      // SENGAJA tidak menggabungkan VFS Roboto bawaan pdfmake: satu-satunya
      // font yang boleh ada di VFS adalah keempat varian Arial, sehingga
      // mustahil ada teks yang diam-diam dirender dengan font lain.
      //
      // BUGFIX "Cannot read 'Arial.ttf': file paths are not supported outside
      // of Node": pada pdfmake 0.3.x build browser, `pdfMake.vfs = {...}` TIDAK
      // memindahkan isi ke virtual file system (hanya objek biasa; metode
      // addVirtualFileSystem() milik kelas turunan browser hanya dipanggil lewat
      // addFontContainer(), dan createPdf() membaca font dari this.virtualfs).
      // Akibatnya provideFont() tidak menemukan nama font di VFS lalu jatuh ke
      // fs.readFileSync('Arial.ttf') -> error path lokal. Solusi: panggil
      // addFontContainer() resmi bila tersedia; jika tidak, tulis langsung ke
      // pdfMake.virtualfs dengan Uint8Array hasil decode base64 (format yang
      // didukung VirtualFileSystem.writeFileSync), plus penjaga pasca-render.
      const decoded = {};
      for (const [name, b64] of Object.entries(fontFiles)) {
        const bin = atob(String(b64));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        // PDFKit menolak font yang bukan TTF/OTF — validasi dini agar kegagalan
        // berkas font dilaporkan jelas, bukan error kabur saat layout.
        const sig = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
        if (sig !== 0x00010000 && sig !== 0x4f54544f && sig !== 0x74727565) {
          throw new Error(
            `Berkas font ${name} bukan TrueType/OpenType valid (kemungkinan rusak atau salah berkas).`,
          );
        }
        decoded[name] = bytes;
      }
      if (typeof pdfMake.addFontContainer === "function") {
        // Jalur resmi pdfmake 0.3.x (browser build): menyalin data base64 ke
        // VFS internal + mendaftarkan font descriptors Arial saja.
        pdfMake.addFontContainer({ fonts: { Arial: { ...ARIAL_VFS_NAMES } }, vfs: fontFiles });
      } else {
        pdfMake.vfs = fontFiles;
        const vfs = pdfMake.virtualfs;
        if (!vfs || typeof vfs.writeFileSync !== "function") {
          throw new Error(
            "Integrasi font pdfmake tidak dikenali: API VFS tidak tersedia.",
          );
        }
        for (const [name, bytes] of Object.entries(decoded)) {
          vfs.writeFileSync(name, bytes);
        }
      }

      // Penjaga: pastikan KEDUA mekanisme lookup font pdfmake benar-benar
      // berisi keempat varian Arial sebelum render apa pun dimulai.
      const checkVfs = (filename) => {
        try {
          if (pdfMake.virtualfs?.existsSync?.(filename)) return true;
        } catch (e) {}
        try {
          if (typeof pdfMake.vfs === "object" && pdfMake.vfs?.[filename]) return true;
        } catch (e) {}
        return false;
      };
      const notReady = Object.values(ARIAL_VFS_NAMES).filter((f) => !checkVfs(f));
      if (notReady.length) {
        throw new Error(
          `Font Arial gagal dipasang ke VFS pdfmake: ${notReady.join(", ")}. ` +
            "PDF ditolak dibuat agar tidak ada teks yang dirender dengan font lain.",
        );
      }
    })().catch((error) => {
      _arialFontsPromise = null;
      throw error;
    });
  }
  await _arialFontsPromise;
}

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

// ---------------------------------------------------------------------------
// Penjaga anti-kop kwitansi (aturan produk: halaman KWITANSI TANPA KOP)
// ---------------------------------------------------------------------------

// Buang properti "kop" dari SEMUA node pada subtree definisi dokumen. Dipakai
// sebagai penjaga struktural terakhir untuk bagian kwitansi: seandainya ada
// regresi yang menyisipkan kop (langsung maupun bersarang), kop terbuang dan
// error dikumpulkan agar tidak pernah tampil diam-diam di PDF.
export function stripKopNodes(nodes) {
  if (Array.isArray(nodes)) {
    for (const n of nodes) stripKopNodes(n);
    return nodes;
  }
  if (nodes && typeof nodes === "object") {
    delete nodes.kop;
    for (const v of Object.values(nodes)) {
      if (v && typeof v === "object") stripKopNodes(v);
    }
  }
  return nodes;
}

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

  // ATURAN PRODUK: KWITANSI TANPA KOP. Sengaja TIDAK memanggil kopStack()
  // dan tidak menggambar logo/baris identitas/garis kop apa pun pada halaman
  // ini — bahkan jika payload lama masih mengirim kwitansi.kop atau
  // document.kop_wajib, metadata itu diabaikan (penjaga struktural
  // stripKopNodes diterapkan oleh buildSpjDocumentDefinition).
  if (kw?.kop || data.document?.kop || data.document?.kop_wajib) {
    console.warn(
      "[spjPdf] Payload membawa metadata kop untuk kwitansi; diabaikan " +
        "sesuai aturan 'kwitansi tanpa kop'.",
    );
  }
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
    if (name === "kwitansi") {
      part = buildKwitansiSection(data);
      // Penjaga anti-kop: tidak boleh ada node kop/logo/garis kop yang
      // lolos ke subtree kwitansi, apa pun isi payload.
      stripKopNodes(part);
    } else if (name === "bast") part = buildBastSection(data);
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

// ---------------------------------------------------------------------------
// Penjaga font Arial (level definisi dokumen)
// ---------------------------------------------------------------------------
// Semua teks pada semua bagian (kwitansi, BAST, RAB, judul, tabel, tanda
// tangan, lampiran, fallback, bold/italic) wajib Arial. defaultStyle saja
// tidak cukup — fungsi ini memindai SELURUH document definition dan menolak
// properti `font` apa pun selain "Arial", serta style kustom yang mengganti
// fontFamily. Roboto/serif tidak punya jalan masuk: VFS hanya berisi Arial.
export function assertArialOnly(dd) {
  const bad = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, `${path}[${i}]`));
      return;
    }
    if (!node || typeof node !== "object") return;
    if (typeof node.font === "string" && node.font !== "Arial") {
      bad.push(`${path}.font=${node.font}`);
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "font") continue;
      walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(dd.content, "content");
  if (dd.defaultStyle?.font !== "Arial") {
    bad.push(`defaultStyle.font=${dd.defaultStyle?.font}`);
  }
  for (const [name, st] of Object.entries(dd.styles || {})) {
    if (st?.font && st.font !== "Arial") bad.push(`styles.${name}.font=${st.font}`);
  }
  if (bad.length) {
    throw new Error(
      "Dokumen SPJ menyalahi aturan font Arial: " + bad.join(", "),
    );
  }
}

export async function buildSpjPdf(data) {
  await ensureArialFonts();

  // PROSES PRE-RENDER: Hapus background putih pada logo sebelum merakit dokumen
  try {
    // Hanya kop BAST & RAB — kwitansi tanpa kop, dan document.kop sudah tidak
    // dikirim backend (aturan anti-kop kwitansi).
    const kops = [data.bast?.kop, data.rab?.kop];
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
      // Penjaga font: seluruh definisi dokumen WAJIB Arial — tolak render
      // sebelum pdfmake bekerja jika ada override font lain yang lolos.
      assertArialOnly(dd);
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
