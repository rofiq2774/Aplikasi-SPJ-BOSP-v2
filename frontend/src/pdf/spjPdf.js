// ============================================================================
// spjPdf.js — Renderer PDF SPJ di FRONTEND (pdfmake)
// ============================================================================

import pdfMake from "pdfmake/build/pdfmake";
import { getJenisBelanjaConfig } from "../spjConfig.js";

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
        const sig =
          (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
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
        pdfMake.addFontContainer({
          fonts: { Arial: { ...ARIAL_VFS_NAMES } },
          vfs: fontFiles,
        });
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
          if (typeof pdfMake.vfs === "object" && pdfMake.vfs?.[filename])
            return true;
        } catch (e) {}
        return false;
      };
      const notReady = Object.values(ARIAL_VFS_NAMES).filter(
        (f) => !checkVfs(f),
      );
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
  let origin = _originGetter();
  if (!origin && typeof window !== "undefined") {
    if (window.__backendOrigin) origin = window.__backendOrigin;
    else if (
      window.location &&
      window.location.origin &&
      !window.location.origin.startsWith("file:")
    ) {
      origin = window.location.origin;
    }
  }
  if (!origin) return url;
  return `${origin}${String(url).startsWith("/") ? "" : "/"}${url}`;
}

const SUPPORTED_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Normalisasi gambar PDF; logo dapat menghapus latar putih tanpa mengubah warna.
// ---------------------------------------------------------------------------
function processPdfImage(src, { monochrome = true, removeWhite = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!src || typeof src !== "string") {
      reject(new Error("Sumber gambar hitam-putih tidak valid."));
      return;
    }

    const fullUrl = absoluteize(src);
    const img = new Image();
    img.crossOrigin = "Anonymous";

    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas 2D tidak tersedia.");
        ctx.drawImage(img, 0, 0);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];

          if (removeWhite && r > 240 && g > 240 && b > 240) {
            data[i + 3] = 0;
          } else if (monochrome) {
            const luminance = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
            data[i] = luminance;
            data[i + 1] = luminance;
            data[i + 2] = luminance;
          }
        }

        ctx.putImageData(imageData, 0, 0);
        resolve(canvas.toDataURL("image/png"));
      } catch (e) {
        reject(
          new Error(
            `Gambar tidak dapat diubah menjadi hitam-putih: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }
    };

    img.onerror = () => {
      // Fallback: fetch blob lalu baca sebagai Data URL via FileReader
      fetch(fullUrl)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.blob();
        })
        .then((blob) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const dataUrl = reader.result;
            const fallbackImg = new Image();
            fallbackImg.onload = () => {
              try {
                const canvas = document.createElement("canvas");
                canvas.width = fallbackImg.width;
                canvas.height = fallbackImg.height;
                const ctx = canvas.getContext("2d");
                ctx.drawImage(fallbackImg, 0, 0);
                resolve(canvas.toDataURL("image/png"));
              } catch (_) {
                resolve(dataUrl);
              }
            };
            fallbackImg.onerror = () => resolve(dataUrl);
            fallbackImg.src = dataUrl;
          };
          reader.onerror = () =>
            reject(new Error(`Gagal membaca blob gambar: ${fullUrl}`));
          reader.readAsDataURL(blob);
        })
        .catch((fetchErr) => {
          reject(
            new Error(
              `Gambar untuk PDF tidak dapat dibaca: ${fullUrl} (${fetchErr.message})`,
            ),
          );
        });
    };
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

export function formatNamaPenandatangan(rawNama) {
  if (!rawNama || typeof rawNama !== "string") {
    return ".................................";
  }
  const trimmed = rawNama.trim();
  if (trimmed === "" || trimmed === "-" || /^[\.\s]+$/.test(trimmed)) {
    return trimmed || ".................................";
  }

  // Regex gelar depan umum di Indonesia (case-insensitive saat mendeteksi,
  // tetapi teks gelar asli dari database tetap dipertahankan persis)
  const frontTitleRegex =
    /^(Prof\.|Dr\.|Drs\.|Dra\.|Ir\.|dr\.|drg\.|H\.|Hj\.|K\.H\.|KH\.|Ns\.)\s+/i;

  let namaPart = trimmed;
  let gelarBelakang = "";

  // 1. Jika terdapat koma, bagian setelah koma adalah gelar belakang
  const commaIdx = trimmed.indexOf(",");
  if (commaIdx !== -1) {
    namaPart = trimmed.slice(0, commaIdx).trim();
    gelarBelakang = trimmed.slice(commaIdx + 1).trim();
  }

  // 2. Ekstrak gelar depan jika ada (bisa lebih dari satu, misal: "Prof. Dr. Ir. H.")
  const frontTitles = [];
  let sisaNama = namaPart;

  while (frontTitleRegex.test(sisaNama)) {
    const match = sisaNama.match(frontTitleRegex);
    if (match) {
      frontTitles.push(match[1]); // ambil string asli gelar dari database
      sisaNama = sisaNama.slice(match[0].length).trim();
    } else {
      break;
    }
  }

  // 3. Nama pokok penanda tangan WAJIB kapital
  const namaKapital = sisaNama.toUpperCase();

  // 4. Gabungkan: Gelar Depan (asli db) + NAMA (kapital) + Gelar Belakang (asli db)
  const namaDenganGelarDepan =
    frontTitles.length > 0
      ? `${frontTitles.join(" ")} ${namaKapital}`
      : namaKapital;

  if (gelarBelakang) {
    return `${namaDenganGelarDepan}, ${gelarBelakang}`;
  }
  return namaDenganGelarDepan;
}

function toNumberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return Number.isInteger(number)
    ? String(number)
    : String(number).replace(".", ",");
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
  const kwitansi = data.kwitansi;
  for (const f of ["nomor_kwitansi", "tanggal", "jumlah"]) {
    if (kwitansi[f] === undefined || kwitansi[f] === null)
      fail(`kwitansi.${f} hilang`);
  }
  if (toNumberOrZero(kwitansi.jumlah) <= 0)
    fail("kwitansi.jumlah harus > 0");

  const sections = data.sections || {};
  const sectionStatus = (section) =>
    (section && (section.status || section.included)) || null;
  const isIncluded = (name) => {
    const status = sectionStatus(sections[name]);
    return status === true || status === "included";
  };
  if (!isIncluded("kwitansi")) fail("bagian kwitansi wajib");

  if (isIncluded("bast") && !data.bast)
    fail("sections.bast=included tetapi data bast kosong");
  if (isIncluded("rab") && !data.rab)
    fail("sections.rab=included tetapi data rab kosong");

  return { included: isIncluded };
}

// ---------------------------------------------------------------------------
// Blok presentasi bersama
// ---------------------------------------------------------------------------

const MM_TO_PT = 72 / 25.4;
const mmToPt = (millimeters) => millimeters * MM_TO_PT;
const PDF_COLORS = {
  ink: "black",
  navy: "black",
  muted: "black",
  border: "black",
  header: "white",
  total: "white",
};
const PAGE = {
  size: [mmToPt(215), mmToPt(330)],
  margins: [mmToPt(15), mmToPt(15), mmToPt(15), mmToPt(20)],
};
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

function kopStack(kop, orientation = "portrait") {
  // Logo proporsional: tinggi tetap, lebar menyesuaikan rasio
  const logoH = mmToPt(18);
  const logoFit = [mmToPt(22), logoH];
  const pageWidth = orientation === "landscape" ? PAGE.size[1] : PAGE.size[0];
  const kopTextWidth = pageWidth - PAGE.margins[0] - PAGE.margins[2];
  const hasL = !!kop?.logo_pemda;
  const hasR = !!kop?.logo_sekolah;
  const stack = [];

  // Wajib menggunakan font Arial pada KOP
  if (kop?.baris1) {
    stack.push({
      text: String(kop.baris1).toUpperCase(),
      font: "Arial",
      bold: true,
      fontSize: 12,
      alignment: "center",
      margin: [0, 0, 0, 2],
    });
  }
  if (kop?.baris2) {
    stack.push({
      text: String(kop.baris2).toUpperCase(),
      font: "Arial",
      bold: true,
      fontSize: 14,
      alignment: "center",
      margin: [0, 0, 0, 2],
    });
  }
  if (kop?.alamat) {
    stack.push({
      text: kop.alamat,
      font: "Arial",
      fontSize: 10,
      alignment: "center",
    });
  }

  return [
    {
      columns: [
        hasL
          ? {
              image: kop.logo_pemda,
              fit: logoFit,
              alignment: "center",
              width: mmToPt(24),
            }
          : { text: "", width: 0 },
        { stack, width: "*", margin: [4, 0, 4, 4] },
        hasR
          ? {
              image: kop.logo_sekolah,
              fit: logoFit,
              alignment: "center",
              width: mmToPt(24),
            }
          : { text: "", width: 0 },
      ],
    },
    {
      canvas: [
        { type: "line", x1: 0, y1: 0, x2: kopTextWidth, y2: 0, lineWidth: 1.8 },
        {
          type: "line",
          x1: 0,
          y1: 2.5,
          x2: kopTextWidth,
          y2: 2.5,
          lineWidth: 0.6,
        },
      ],
      margin: [0, 0, 0, 10],
    },
  ];
}

function sectionTitle(title, subtitle) {
  const out = [
    {
      text: title,
      bold: true,
      fontSize: 14,
      color: PDF_COLORS.navy,
      alignment: "center",
      margin: [0, 0, 0, 2],
    },
  ];
  if (subtitle) {
    out.push({
      text: subtitle,
      fontSize: 12,
      color: PDF_COLORS.muted,
      alignment: "center",
      margin: [0, 2, 0, 0],
    });
  }
  return out;
}

function reportTableLayout(headerRows = 1) {
  return {
    fillColor: (rowIndex, node) => {
      if (rowIndex < headerRows) return PDF_COLORS.header;
      if (rowIndex === node.table.body.length - 1) return PDF_COLORS.total;
      return null;
    },
    hLineWidth: (lineIndex) =>
      lineIndex === 0 || lineIndex === headerRows ? 0.8 : 0.45,
    vLineWidth: () => 0.45,
    hLineColor: () => PDF_COLORS.border,
    vLineColor: () => PDF_COLORS.border,
    paddingLeft: () => 5,
    paddingRight: () => 5,
    paddingTop: () => 4,
    paddingBottom: () => 4,
  };
}

function labelRow(label, value, labelW = 40) {
  return {
    columns: [
      { text: label, width: labelW, fontSize: 12, color: PDF_COLORS.muted },
      {
        text: `:  ${value ?? "-"}`,
        flex: {},
        colSpan: 1,
        fontSize: 12,
        color: PDF_COLORS.ink,
      },
    ],
    margin: [0, 2, 0, 3],
  };
}

// ---------------------------------------------------------------------------
// Bagian 1: KWITANSI (Tanda Terima Pembayaran) — TANPA KOP
// ---------------------------------------------------------------------------

export function buildKwitansiSection(data) {
  const kwitansi = data.kwitansi;
  const identitas = data.identitas;
  const content = [];

  // ATURAN PRODUK: KWITANSI TANPA KOP
  if (
    kwitansi?.kop ||
    data.document?.kop ||
    data.document?.kop_wajib
  ) {
    console.warn(
      "[spjPdf] Payload membawa metadata kop untuk kwitansi; diabaikan " +
        "sesuai aturan 'kwitansi tanpa kop'.",
    );
  }

  // Persiapan data teks
  const formattedAmount =
    kwitansi.jumlah_rupiah || formatRupiah(kwitansi.jumlah);
  let amountInWords = kwitansi.terbilang || "................ rupiah";
  amountInWords =
    amountInWords.charAt(0).toUpperCase() + amountInWords.slice(1);

  const receiptNumber =
    kwitansi.nomor_kwitansi || "....................................";
  const namaSekolah = `BENDAHARA BOSP ${(identitas.nama_sekolah || "").toUpperCase()}`;
  const uraian =
    kwitansi.uraian_pembayaran ||
    kwitansi.nama_kegiatan ||
    "....................................";
  const kota =
    kwitansi.kota_tempat_surat || identitas.tempat_surat || "Jember";
  const formattedDate = formatTanggalIndo(kwitansi.tanggal);

  // Susunan formulir mengikuti format kwitansi yang digunakan.
  const headerBox = {
    table: {
      widths: ["*"],
      body: [
        [
          {
            text: "KWITANSI",
            bold: true,
            fontSize: 14,
            color: PDF_COLORS.ink,
            alignment: "center",
            fillColor: "#f2f2f2",
            margin: [0, 5, 0, 5],
          },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0.9,
      vLineWidth: () => 0.9,
      hLineColor: () => PDF_COLORS.ink,
      vLineColor: () => PDF_COLORS.ink,
    },
  };

  // Font size kwitansi body — sedikit lebih kecil dari judul agar proporsional
  const KW_FS = 11;

  const valueCell = (text, options = {}) => ({
    text,
    fontSize: KW_FS,
    color: PDF_COLORS.ink,
    margin: [0, 4, 0, 4],
    border: [false, false, false, true],
    borderColor: [null, null, null, PDF_COLORS.ink],
    ...options,
  });

  const fieldLabel = (text) => ({
    text,
    fontSize: KW_FS,
    color: PDF_COLORS.muted,
    margin: [0, 4, 0, 4],
    border: [false, false, false, false],
  });

  const contentTable = {
    table: {
      widths: [130, 12, "*"],
      body: [
        [
          fieldLabel("Nomor"),
          {
            text: ":",
            fontSize: KW_FS,
            color: PDF_COLORS.ink,
            border: [false, false, false, false],
          },
          valueCell(receiptNumber, { bold: true }),
        ],
        [
          fieldLabel("Telah terima dari"),
          {
            text: ":",
            fontSize: KW_FS,
            color: PDF_COLORS.ink,
            border: [false, false, false, false],
          },
          valueCell(namaSekolah),
        ],
        [
          fieldLabel("Uang sejumlah"),
          {
            text: ":",
            fontSize: KW_FS,
            color: PDF_COLORS.ink,
            border: [false, false, false, false],
          },
          {
            ...valueCell(amountInWords, {
              fillColor: "#f2f2f2",
              border: [false, false, false, false],
              margin: [4, 5, 4, 5],
            }),
          },
        ],
        [
          fieldLabel("Untuk pembayaran"),
          {
            text: ":",
            fontSize: KW_FS,
            color: PDF_COLORS.ink,
            border: [false, false, false, false],
          },
          valueCell(uraian, { margin: [0, 4, 0, 22] }),
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0.6,
      vLineWidth: () => 0,
      hLineColor: () => PDF_COLORS.ink,
    },
  };

  const amountBlock = {
    columns: [
      {
        text: "Rp.",
        width: "auto",
        fontSize: KW_FS,
        bold: true,
        margin: [0, 5, 6, 0],
      },
      {
        table: {
          widths: [200],
          body: [
            [
              {
                text: formattedAmount.replace(/^Rp\s*/i, ""),
                bold: true,
                italics: true,
                alignment: "center",
                fontSize: KW_FS,
                fillColor: "#f2f2f2",
                margin: [0, 5, 0, 5],
              },
            ],
          ],
        },
        layout: {
          hLineWidth: () => 0.8,
          vLineWidth: () => 0,
          hLineColor: () => PDF_COLORS.ink,
        },
        width: "auto",
      },
    ],
    margin: [0, 10, 0, 0],
  };

  // -----------------------------------------------------------------------
  // Blok tanda tangan kwitansi — menggunakan TABLE agar setiap baris
  // (label baris 1, label baris 2, ruang tanda tangan, garis, nama, NIP)
  // selalu SEJAJAR secara horizontal, tidak peduli panjang teks berbeda.
  // -----------------------------------------------------------------------
  const sigCell = (text, opts = {}) => ({
    text,
    fontSize: KW_FS,
    alignment: "center",
    border: [false, false, false, false],
    margin: [0, 1, 0, 1],
    ...opts,
  });

  const sigLineCanvas = {
    canvas: [
      {
        type: "line",
        x1: 5,
        y1: 0,
        x2: 140,
        y2: 0,
        lineWidth: 0.6,
        lineColor: PDF_COLORS.ink,
      },
    ],
    alignment: "center",
    border: [false, false, false, false],
    margin: [0, 0, 0, 2],
  };

  const namaKepsek = formatNamaPenandatangan(identitas.nama_kepala_sekolah);
  const namaBendahara = formatNamaPenandatangan(identitas.nama_bendahara);
  const namaPenerima = formatNamaPenandatangan(
    kwitansi.nama_toko || "(...................)",
  );
  const nipKepsek = identitas.nip_kepala_sekolah
    ? `NIP. ${identitas.nip_kepala_sekolah}`
    : "NIP. .............................";
  const nipBendahara = identitas.nip_bendahara
    ? `NIP. ${identitas.nip_bendahara}`
    : "NIP. .............................";

  const signatures = {
    table: {
      widths: ["*", "*", "*"],
      body: [
        // Baris 1: judul / tanggal
        [
          sigCell("Setuju Dibayar"),
          sigCell(`Lunas Dibayar, ${formattedDate}`),
          sigCell(`${kota}, ${formattedDate}`),
        ],
        // Baris 2: jabatan
        [
          sigCell("Kepala Sekolah"),
          sigCell("Bendahara BOSP"),
          sigCell("Penerima"),
        ],
        // Baris 3: ruang tanda tangan (tinggi tetap, konten kosong)
        [
          sigCell("", { margin: [0, 48, 0, 0] }),
          sigCell("", { margin: [0, 48, 0, 0] }),
          sigCell("", { margin: [0, 48, 0, 0] }),
        ],
        // Baris 4: garis tanda tangan
        [sigLineCanvas, sigLineCanvas, sigLineCanvas],
        // Baris 5: nama penanda tangan
        [
          sigCell(namaKepsek, { bold: true }),
          sigCell(namaBendahara, { bold: true }),
          sigCell(namaPenerima, { bold: true }),
        ],
        // Baris 6: NIP
        [
          sigCell(nipKepsek, { fontSize: KW_FS - 1 }),
          sigCell(nipBendahara, { fontSize: KW_FS - 1 }),
          sigCell("", { fontSize: KW_FS - 1 }),
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: () => 0,
      paddingLeft: () => 4,
      paddingRight: () => 4,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
    margin: [0, 8, 0, 0],
  };

  // Posisi top center — kwitansi ditampilkan di tengah atas halaman
  content.push({
    table: {
      widths: ["*"],
      body: [
        [
          {
            stack: [
              headerBox,
              { text: "", margin: [0, 8, 0, 0] },
              contentTable,
              { text: "", margin: [0, 8, 0, 0] },
              signatures,
              amountBlock,
            ],
          },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0.8,
      vLineWidth: () => 0.8,
      hLineColor: () => PDF_COLORS.border,
      vLineColor: () => PDF_COLORS.border,
      paddingLeft: () => 14,
      paddingRight: () => 14,
      paddingTop: () => 12,
      paddingBottom: () => 12,
    },
    margin: [mmToPt(10), 0, mmToPt(10), 0],
  });

  return content;
}

// ---------------------------------------------------------------------------
// Bagian 2: BAST (Berita Acara Serah Terima)
// ---------------------------------------------------------------------------

export function buildBastSection(data) {
  const bast = data.bast;
  const identitas = data.identitas;
  const content = [];

  content.push({
    text: "FORMAT 2",
    bold: true,
    fontSize: 12,
    alignment: "right",
    margin: [0, 0, 0, 5],
  });
  content.push(...kopStack(bast.kop || data.document?.kop));
  content.push(
    ...sectionTitle(
      "BERITA ACARA SERAH TERIMA BARANG",
      "PENGADAAN / PEROLEHAN",
    ),
  );
  content.push({
    text: `Nomor: ${bast.nomor_surat || "-"}`,
    fontSize: 12,
    alignment: "center",
    margin: [0, 5, 0, 15],
  });

  const hari =
    bast.hari_ini ||
    hariIndo(data.kwitansi?.tanggal_nota || data.kwitansi?.tanggal);
  const pembuka =
    `Pada hari ini ${hari || "..."} tanggal ${bast.tgl_terbilang || "..."} ` +
    `bulan ${bast.bulan_indo || "..."} tahun ${bast.tahun_terbilang || "..."} ` +
    "yang bertanda tangan di bawah ini :";

  content.push({
    text: pembuka,
    fontSize: 12,
    alignment: "justify",
    margin: [0, 0, 0, 10],
  });
  content.push(
    labelRow(
      "Nama",
      formatNamaPenandatangan(
        bast.nama_penerima ||
          identitas.nama_pengurus_barang ||
          "(..............)",
      ),
      60,
    ),
  );
  content.push(
    labelRow("Jabatan", bast.jabatan_penerima || "Pengurus Barang", 60),
  );

  content.push({
    text:
      `Telah menerima barang persediaan yang diserahkan oleh ${bast.nama_penyedia || "(..............)"} ` +
      `sesuai dengan Faktur Pembelian / Nota Pembelian tanggal ${bast.tgl_full || "-"} ` +
      "sebagaimana daftar terlampir.",
    fontSize: 12,
    alignment: "justify",
    margin: [0, 10, 0, 10],
  });
  content.push({
    text: "Daftar barang yang diterima sebagai berikut :",
    fontSize: 12,
    margin: [0, 0, 0, 5],
  });

  const body = [
    [
      {
        text: "No",
        bold: true,
        fontSize: 12,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      {
        text: "Uraian Nama Barang",
        bold: true,
        fontSize: 12,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      {
        text: "Harga Satuan",
        bold: true,
        fontSize: 12,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      {
        text: "Satuan",
        bold: true,
        fontSize: 12,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      {
        text: "Volume",
        bold: true,
        fontSize: 12,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      {
        text: "Jumlah",
        bold: true,
        fontSize: 12,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      {
        text: "Ket",
        bold: true,
        fontSize: 12,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
    ],
    [
      { text: "(a)", italics: true, fontSize: 10, alignment: "center" },
      { text: "(b)", italics: true, fontSize: 10, alignment: "center" },
      { text: "(c)", italics: true, fontSize: 10, alignment: "center" },
      { text: "(d)", italics: true, fontSize: 10, alignment: "center" },
      { text: "(e)", italics: true, fontSize: 10, alignment: "center" },
      { text: "(f = c*e)", italics: true, fontSize: 10, alignment: "center" },
      { text: "(g)", italics: true, fontSize: 10, alignment: "center" },
    ],
  ];

  for (const item of bast.items || []) {
    body.push([
      {
        text: String(item.no ?? ""),
        fontSize: 12,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      {
        text: item.uraian || "-",
        fontSize: 12,
        alignment: "left",
        margin: [4, 4, 0, 4],
      },
      {
        text: item.harga_satuan_fmt || formatRupiah(item.harga_satuan),
        fontSize: 12,
        alignment: "right",
        margin: [0, 4, 4, 4],
      },
      {
        text: item.satuan || "-",
        fontSize: 12,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      {
        text: formatVolume(item.volume),
        fontSize: 12,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      {
        text: item.jumlah_fmt || formatRupiah(item.jumlah),
        fontSize: 12,
        alignment: "right",
        margin: [0, 4, 4, 4],
      },
      { text: "", fontSize: 12, alignment: "center" },
    ]);
  }

  const totalVolume = formatVolume(bast.total_volume ?? 0);
  const formattedGrandTotal =
    bast.grand_total_fmt || formatRupiah(bast.grand_total);

  body.push([
    {
      text: "Jumlah",
      bold: true,
      fontSize: 12,
      alignment: "right",
      colSpan: 4,
      margin: [0, 5, 5, 5],
    },
    {},
    {},
    {},
    {
      text: totalVolume,
      fontSize: 12,
      alignment: "center",
      margin: [0, 5, 0, 5],
    },
    {
      text: formattedGrandTotal,
      fontSize: 12,
      bold: true,
      alignment: "right",
      margin: [0, 5, 4, 5],
    },
    { text: "" },
  ]);

  body.push([
    {
      text: "Jumlah Total",
      bold: true,
      fontSize: 12,
      alignment: "right",
      colSpan: 4,
      margin: [0, 5, 5, 5],
    },
    {},
    {},
    {},
    { text: "" },
    {
      text: formattedGrandTotal,
      fontSize: 12,
      bold: true,
      alignment: "right",
      margin: [0, 5, 4, 5],
    },
    { text: "" },
  ]);

  content.push({
    table: { headerRows: 2, widths: [20, "*", 55, 35, 35, 60, 30], body },
    layout: {
      ...reportTableLayout(2),
    },
    fontSize: 12,
    margin: [0, 5, 0, 12],
  });

  content.push({
    text: "Demikian Berita Acara Serah Terima Barang ini dibuat dalam rangkap 2 (dua) untuk digunakan sebagaimana mestinya.",
    fontSize: 12,
    margin: [0, 10, 0, 20],
    alignment: "justify",
  });

  const kota = bast.kota || identitas.tempat_surat || "Jember";

  const BAST_FS = 12;
  const sigCell = (text, opts = {}) => ({
    text,
    fontSize: BAST_FS,
    alignment: "center",
    border: [false, false, false, false],
    margin: [0, 1, 0, 1],
    ...opts,
  });

  const namaPenyedia = formatNamaPenandatangan(
    bast.nama_penyedia || "(..............)",
  );
  const namaPenerima = formatNamaPenandatangan(
    bast.nama_penerima ||
      identitas.nama_pengurus_barang ||
      "(..............)",
  );

  const nipPenerima = bast.nip_penerima
    ? `NIP. ${bast.nip_penerima}`
    : identitas.nip_pengurus_barang
      ? `NIP. ${identitas.nip_pengurus_barang}`
      : "(..............)";

  content.push({
    table: {
      widths: ["*", "*"],
      body: [
        [
          sigCell(" "),
          sigCell(`${kota}, ${bast.tgl_full || "(..............)"}`),
        ],
        [sigCell("Yang Menyerahkan"), sigCell("Yang Menerima")],
        [
          sigCell("Penyedia Barang"),
          sigCell(bast.jabatan_penerima || "Pengurus Barang"),
        ],
        // Baris untuk nama diberi margin atas 48 sebagai ruang tanda tangan (menggantikan garis)
        [
          sigCell(namaPenyedia, { bold: true, margin: [0, 48, 0, 1] }),
          sigCell(namaPenerima, { bold: true, margin: [0, 48, 0, 1] }),
        ],
        // Baris NIP
        [
          sigCell(" ", { fontSize: BAST_FS - 2 }),
          sigCell(nipPenerima, { fontSize: BAST_FS - 2 }),
        ],
      ],
    },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: () => 0,
      paddingLeft: () => 4,
      paddingRight: () => 4,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
    margin: [0, 8, 0, 20],
    unbreakable: true,
  });

  return content;
}

function buildLampiranFotoSections(data) {
  const lamp = data.lampiran_foto || {};
  const allowedPhotos = new Set(getJenisBelanjaConfig(data.jenis_belanja).foto);
  const urutan = [
    ["barang", "FOTO BARANG"],
    ["kegiatan", "FOTO KEGIATAN"],
    ["ktp", "SALINAN KTP"],
    ["qr_master", "QR LINK FILE MASTER"],
    ["sebelum", "FOTO SEBELUM"],
    ["proses", "FOTO PROSES"],
    ["sesudah", "FOTO SESUDAH"],
  ];
  const content = [];

  for (const [jenis, judul] of urutan) {
    if (!allowedPhotos.has(jenis)) continue;
    const daftar = Array.isArray(lamp[jenis]) ? lamp[jenis] : [];
    if (!daftar.length) continue;
    content.push(
      { text: "", pageBreak: "before", pageOrientation: "portrait" },
      {
        text: `LAMPIRAN ${judul}`,
        bold: true,
        color: PDF_COLORS.navy,
        fontSize: 12,
        alignment: "center",
        margin: [0, 8, 0, 4],
      },
      {
        text: `Nomor Kwitansi : ${data.kwitansi.nomor_kwitansi || "-"}`,
        fontSize: 12,
        color: PDF_COLORS.muted,
        alignment: "center",
        margin: [0, 0, 0, 12],
      },
    );

    const photos = daftar.map((foto) => {
      const raw = typeof foto === "string" ? foto : foto.path || "";
      const url = absoluteize(raw);
      const available =
        (typeof foto === "string" || foto.available !== false) && !!url;
      return {
        stack: available
          ? [{ image: url, fit: [235, 175], alignment: "center" }]
          : [
              {
                canvas: [
                  {
                    type: "rect",
                    x: 0,
                    y: 0,
                    w: 220,
                    h: 150,
                    lineWidth: 0.6,
                    lineColor: PDF_COLORS.border,
                  },
                ],
                alignment: "center",
              },
              {
                text: "Foto tidak ditemukan",
                italics: true,
                fontSize: 10,
                color: PDF_COLORS.muted,
                alignment: "center",
                margin: [0, 5, 0, 0],
              },
            ],
        width: "*",
      };
    });

    for (let i = 0; i < photos.length; i += 2) {
      content.push({
        columns: photos.slice(i, i + 2),
        columnGap: 14,
        margin: [0, 0, 0, 16],
        unbreakable: true,
      });
    }
  }
  return content;
}

// Rakit dokumen lampiran sesuai jenis belanja; format khusus ditangani sebelum tabel umum.
function buildDataLampiranSections(data) {
  const config = getJenisBelanjaConfig(data.jenis_belanja);
  const formData = data.data_lampiran || {};
  const kwitansi = data.kwitansi || {};
  const identitas = data.identitas || {};
  const content = [];

  for (const dokumen of config.dokumen) {
    if (
      dokumen.optional &&
      !dokumen.fields.some(([key]) => String(formData[key] || "").trim())
    )
      continue;

    content.push({
      text: "",
      pageBreak: "before",
      pageOrientation:
        dokumen.recipientTable ||
        (dokumen.key === "daftar_hadir" && data.jenis_belanja === "jasa_tukang")
          ? "landscape"
          : "portrait",
    });
    if (dokumen.key === "surat_tugas") {
      const fieldValue = (key) => String(formData[key] || "").trim();
      const tanggalSurat = formatTanggalIndo(
        formData.surat_tugas_tanggal,
      );
      const noBorders = {
        hLineWidth: () => 0,
        vLineWidth: () => 0,
        paddingLeft: () => 0,
        paddingRight: () => 0,
        paddingTop: () => 2,
        paddingBottom: () => 2,
      };
      const detailRow = (label, value) => [
        { text: label, noWrap: true },
        { text: ":" },
        { text: value },
      ];

      content.push(
        ...kopStack(
          {
            baris1: identitas.nama_pemda || "",
            baris2: identitas.nama_sekolah || "",
            alamat: identitas.alamat_sekolah || "",
            logo_pemda: identitas.logo_pemda || "",
            logo_sekolah: identitas.logo_sekolah || "",
          },
          "portrait",
        ),
        ...sectionTitle("SURAT TUGAS"),
        {
          text: ["NOMOR", fieldValue("surat_tugas_nomor")]
            .filter(Boolean)
            .join(" "),
          alignment: "center",
          margin: [0, 0, 0, 34],
        },
        {
          table: {
            widths: [mmToPt(20), mmToPt(5), "*"],
            body: [detailRow("Dasar", fieldValue("surat_tugas_dasar"))],
          },
          layout: noBorders,
          margin: [0, 0, 0, 16],
        },
        {
          text: "MEMERINTAHKAN",
          alignment: "center",
          margin: [0, 0, 0, 10],
        },
        {
          table: {
            widths: [mmToPt(20), mmToPt(5), mmToPt(35), mmToPt(5), "*"],
            body: [
              [
                { text: "Kepada", noWrap: true },
                { text: ":" },
                { text: "1. Nama", noWrap: true },
                { text: ":" },
                { text: fieldValue("surat_tugas_petugas") },
              ],
              ["", "", "NIP", ":", fieldValue("surat_tugas_nip")],
              [
                "",
                "",
                "Pangkat/Gol.",
                ":",
                fieldValue("surat_tugas_pangkat_golongan"),
              ],
              ["", "", "Jabatan", ":", fieldValue("surat_tugas_jabatan")],
              [
                { text: "Untuk", noWrap: true },
                { text: ":" },
                "",
                "",
                { text: fieldValue("surat_tugas_tujuan") },
              ],
            ],
          },
          layout: noBorders,
        },
        {
          columns: [
            { width: "*", text: "" },
            {
              width: mmToPt(72),
              stack: [
                [identitas.tempat_surat || "Jember", tanggalSurat]
                  .filter(Boolean)
                  .join(", "),
                "Kepala Sekolah",
                { text: "", margin: [0, 0, 0, 48] },
                {
                  text: formatNamaPenandatangan(identitas.nama_kepala_sekolah),
                  bold: true,
                },
                formData.surat_tugas_pangkat_kepala_sekolah ||
                  identitas.pangkat_kepala_sekolah ||
                  "........................",
                identitas.nip_kepala_sekolah
                  ? `NIP. ${identitas.nip_kepala_sekolah}`
                  : "NIP. ........................",
              ],
            },
          ],
          margin: [0, 40, 0, 0],
          unbreakable: true,
        },
      );
      continue;
    }

    if (dokumen.key === "sppd") {
      const fieldValue = (key) => String(formData[key] || "").trim();
      const parseSppdDate = (value) => {
        const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) return null;
        const date = new Date(
          Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
        );
        return date.getUTCFullYear() === Number(match[1]) &&
          date.getUTCMonth() === Number(match[2]) - 1 &&
          date.getUTCDate() === Number(match[3])
          ? date
          : null;
      };
      const departure = parseSppdDate(formData.sppd_berangkat);
      const returnDate = parseSppdDate(formData.sppd_kembali);
      if (!departure || !returnDate || departure > returnDate) {
        fail("Tanggal berangkat dan kembali pada SPPD tidak valid.");
      }
      const departureLabel = formatTanggalIndo(formData.sppd_berangkat);
      const returnLabel = formatTanggalIndo(formData.sppd_kembali);
      const days = Math.floor((returnDate - departure) / 86400000) + 1;
      const empty = " ";
      const signatureCell = (roman, action, from, to, date) => {
        const routeRows =
          action === "Tiba"
            ? [["Tiba di", `: ${from || ""}`]]
            : [
                ["Berangkat dari", `: ${from || ""}`],
                ["Ke", `: ${to || ""}`],
              ];
        return {
          stack: [
            { text: `${roman}.`, bold: true, margin: [0, 0, 0, 4] },
            {
              table: {
                widths: [mmToPt(28), "*"],
                body: [
                  [{ text: action, colSpan: 2, bold: true }, {}],
                  ...routeRows,
                  ["Pada Tanggal", `: ${date}`],
                  ["Kepala", ":"],
                ],
              },
              layout: "noBorders",
              margin: [0, 0, 0, 30],
            },
            {
              canvas: [
                {
                  type: "line",
                  x1: 0,
                  y1: 0,
                  x2: mmToPt(48),
                  y2: 0,
                  lineWidth: 0.6,
                },
              ],
              margin: [0, 0, 0, 3],
            },
            { text: "NIP. ........................" },
          ],
          margin: [4, 4, 4, 4],
        };
      };
      const ppkName =
        fieldValue("sppd_ppk_nama") || identitas.nama_kepala_sekolah || "";
      const ppkNip =
        fieldValue("sppd_ppk_nip") || identitas.nip_kepala_sekolah || "";
      const ppkDetails = [
        `a. Nama     : ${ppkName}`,
        `b. NIP        : ${ppkNip}`,
        `c. Pangkat/Gol : ${fieldValue("sppd_ppk_pangkat_golongan")}`,
        `d. Jabatan : ${fieldValue("sppd_ppk_jabatan")}`,
      ].join("\n");
      const employeeDetails = [
        `a. Nama     : ${fieldValue("sppd_petugas")}`,
        `b. NIP        : ${fieldValue("sppd_nip")}`,
        `c. Pangkat/Gol : ${fieldValue("sppd_pangkat_golongan")}`,
        `d. Jabatan : ${fieldValue("sppd_jabatan")}`,
      ].join("\n");
      const origin = fieldValue("sppd_tempat_berangkat");
      const destination = fieldValue("sppd_tujuan");
      const noBorders = {
        hLineWidth: () => 0,
        vLineWidth: () => 0,
        paddingLeft: () => 0,
        paddingRight: () => 0,
        paddingTop: () => 1,
        paddingBottom: () => 1,
      };
      const pageOneRows = [
        [
          "1.",
          `Pejabat Pembuat Komitmen\na. Nama\nb. NIP\nc. Pangkat/Gol\nd. Jabatan`,
          ppkDetails,
        ],
        [
          "2.",
          `Pegawai yang melaksanakan perjalanan dinas\na. Nama\nb. NIP\nc. Pangkat/Gol\nd. Jabatan`,
          employeeDetails,
        ],
        ["3.", "Maksud perjalanan dinas", fieldValue("sppd_maksud")],
        ["4.", "Alat angkut yang dipergunakan", fieldValue("sppd_transportasi")],
        [
          "5.",
          "a. Tempat berangkat\nb. Tempat tujuan",
          `a. ${origin}\nb. ${destination}`,
        ],
        [
          "6.",
          "a. Lamanya perjalanan dinas\nb. Tanggal berangkat\nc. Tanggal harus kembali/tiba",
          `a. ${days} hari\nb. ${departureLabel}\nc. ${returnLabel}`,
        ],
        [
          "7.",
          {
            text: "Pengikut :",
            colSpan: 2,
          },
          {},
        ],
        [
          "",
          {
            table: {
              widths: ["*", "*", "*"],
              body: [
                [
                  { text: "Nama", bold: true },
                  { text: "Jabatan", bold: true },
                  { text: "Tugas", bold: true },
                ],
                [
                  fieldValue("sppd_pengikut_nama"),
                  fieldValue("sppd_pengikut_jabatan"),
                  fieldValue("sppd_pengikut_tugas"),
                ],
              ],
            },
            layout: "lightHorizontalLines",
            colSpan: 2,
          },
          {},
        ],
        [
          "8.",
          "Pembebanan Anggaran\na. Instansi\nb. Akun",
          `a. ${fieldValue("sppd_anggaran_instansi")}\nb. ${fieldValue("sppd_anggaran_akun")}`,
        ],
        ["9.", "Keterangan lain-lain", fieldValue("sppd_keterangan")],
      ];
      const issueDate = formatTanggalIndo(
        formData.sppd_tanggal_dikeluarkan,
      );
      const issueLocation = identitas.tempat_surat || "Jember";

      content.push(
        ...kopStack(
          {
            baris1: identitas.nama_pemda || "",
            baris2: identitas.nama_sekolah || "",
            alamat: identitas.alamat_sekolah || "",
            logo_pemda: identitas.logo_pemda || "",
            logo_sekolah: identitas.logo_sekolah || "",
          },
          "portrait",
        ),
        {
          table: {
            widths: [mmToPt(37), mmToPt(5), "*"],
            body: [
              [
                "Lampiran ke",
                ":",
                fieldValue("sppd_lampiran_ke"),
              ],
              [
                "Nomor Surat Tugas",
                ":",
                fieldValue("sppd_nomor_surat_tugas"),
              ],
            ],
          },
          layout: noBorders,
          margin: [mmToPt(65), 0, 0, 12],
        },
        {
          text: "SURAT PERINTAH PERJALANAN DINAS (SPPD)",
          fontSize: 13,
          bold: true,
          decoration: "underline",
          alignment: "center",
          margin: [0, 0, 0, 8],
        },
        {
          table: {
            widths: [mmToPt(9), mmToPt(67), "*"],
            body: pageOneRows,
          },
          layout: {
            hLineWidth: () => 0.6,
            vLineWidth: () => 0.6,
            hLineColor: () => PDF_COLORS.border,
            vLineColor: () => PDF_COLORS.border,
            paddingLeft: () => 4,
            paddingRight: () => 4,
            paddingTop: () => 3,
            paddingBottom: () => 3,
          },
          fontSize: 9,
        },
        {
          text: "*coret yang tidak perlu",
          fontSize: 9,
          margin: [0, 2, 0, 0],
        },
        {
          columns: [
            { width: "*", text: "" },
            {
              width: mmToPt(90),
              stack: [
                `Dikeluarkan di    : ${issueLocation}`,
                `Tanggal             : ${issueDate}`,
                "Pejabat Pembuat Komitmen",
                { text: "", margin: [0, 0, 0, 38] },
                {
                  text: formatNamaPenandatangan(ppkName),
                  bold: true,
                },
                fieldValue("sppd_ppk_pangkat_golongan"),
                ppkNip ? `NIP. ${ppkNip}` : "",
              ],
            },
          ],
          margin: [0, 10, 0, 0],
          unbreakable: true,
        },
        {
          text: "",
          pageBreak: "before",
          pageOrientation: "portrait",
        },
        {
          table: {
            widths: ["*", "*"],
            body: [
              [
                empty,
                signatureCell(
                  "I",
                  "Berangkat",
                  origin,
                  destination,
                  departureLabel,
                ),
              ],
              [
                signatureCell(
                  "II",
                  "Tiba",
                  destination,
                  "",
                  departureLabel,
                ),
                signatureCell(
                  "",
                  "Berangkat",
                  destination,
                  origin,
                  returnLabel,
                ),
              ],
              [
                signatureCell(
                  "III",
                  "Tiba",
                  origin,
                  "",
                  returnLabel,
                ),
                {
                  text: "Telah diperiksa, dengan keterangan bahwa perjalanan tersebut di atas benar dilakukan atas perintahnya dan semata-mata untuk kepentingan jabatan dalam waktu yang sesingkat-singkatnya.",
                  alignment: "justify",
                  margin: [6, 8, 6, 8],
                },
              ],
              [
                {
                  text: "IV.  Catatan lain-lain\n\n____________________________________________\n____________________________________________\n____________________________________________",
                  colSpan: 2,
                  margin: [4, 5, 4, 5],
                },
                {},
              ],
            ],
          },
          layout: {
            hLineWidth: () => 0.6,
            vLineWidth: () => 0.6,
            hLineColor: () => PDF_COLORS.border,
            vLineColor: () => PDF_COLORS.border,
            paddingLeft: () => 2,
            paddingRight: () => 2,
            paddingTop: () => 2,
            paddingBottom: () => 2,
          },
          fontSize: 9,
        },
        {
          columns: [
            { width: "*", text: "" },
            {
              width: mmToPt(90),
              stack: [
                "Pejabat Pembuat Komitmen",
                { text: "", margin: [0, 0, 0, 38] },
                {
                  text: formatNamaPenandatangan(ppkName),
                  bold: true,
                },
                fieldValue("sppd_ppk_pangkat_golongan"),
                ppkNip ? `NIP. ${ppkNip}` : "",
              ],
            },
          ],
          margin: [0, 12, 0, 0],
          unbreakable: true,
        },
      );
      continue;
    }

    if (
      dokumen.key === "daftar_hadir" &&
      data.jenis_belanja === "jasa_tukang"
    ) {
      const parseDate = (raw) => {
        const match = String(raw || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) return null;
        const date = new Date(
          Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
        );
        return date.getUTCFullYear() === Number(match[1]) &&
          date.getUTCMonth() === Number(match[2]) - 1 &&
          date.getUTCDate() === Number(match[3])
          ? date
          : null;
      };
      const startDate = parseDate(formData.hadir_tanggal_awal);
      const endDate = parseDate(formData.hadir_tanggal_akhir);
      if (!startDate || !endDate || startDate > endDate) {
        fail("Tanggal awal dan akhir Daftar Hadir Jasa Tukang tidak valid.");
      }
      const totalDays = Math.floor((endDate - startDate) / 86400000) + 1;
      if (totalDays > 366) {
        fail("Rentang tanggal Daftar Hadir Jasa Tukang maksimal 366 hari.");
      }
      const dates = Array.from(
        { length: totalDays },
        (_, index) => new Date(startDate.getTime() + index * 86400000),
      );
      const peserta = String(formData.hadir_peserta || "")
        .split(/\r?\n/)
        .map((nama) => nama.trim())
        .filter(Boolean);
      const kop = {
        baris1: identitas.nama_pemda || "",
        baris2: identitas.nama_sekolah || "",
        alamat: identitas.alamat_sekolah || "",
        logo_pemda: identitas.logo_pemda || "",
        logo_sekolah: identitas.logo_sekolah || "",
      };
      const dateLabel = (date) =>
        date.toLocaleDateString("id-ID", {
          day: "2-digit",
          month: "short",
          timeZone: "UTC",
        });
      for (let offset = 0; offset < dates.length; offset += 10) {
        const pageDates = dates.slice(offset, offset + 10);
        if (offset > 0) {
          content.push({
            text: "",
            pageBreak: "before",
            pageOrientation: "landscape",
          });
        }
        content.push(
          ...kopStack(kop, "landscape"),
          ...sectionTitle(
            "DAFTAR HADIR",
            `Nomor Kwitansi: ${kwitansi.nomor_kwitansi || "-"}`,
          ),
          {
            text: kwitansi.nama_kegiatan || kwitansi.uraian_pembayaran || "",
            alignment: "center",
            margin: [0, 4, 0, 6],
          },
          {
            text: `Tempat: ${formData.hadir_tempat || "-"}`,
            alignment: "center",
            margin: [0, 0, 0, 8],
          },
        );

        const attendanceBody = [
          [
            {
              text: "No.",
              rowSpan: 2,
              bold: true,
              alignment: "center",
              fillColor: "#f2f2f2",
            },
            {
              text: "Nama Peserta",
              rowSpan: 2,
              bold: true,
              alignment: "center",
              fillColor: "#f2f2f2",
            },
            ...pageDates.map((date) => ({
              text: dateLabel(date),
              bold: true,
              alignment: "center",
              fillColor: "#f2f2f2",
            })),
          ],
          [
            {},
            {},
            ...pageDates.map(() => ({
              text: "Tanda Tangan",
              bold: true,
              fontSize: 8,
              alignment: "center",
              fillColor: "#f2f2f2",
            })),
          ],
        ];
        for (let index = 0; index < Math.max(peserta.length, 1); index++) {
          attendanceBody.push([
            { text: String(index + 1), alignment: "center" },
            peserta[index] || "",
            ...pageDates.map(() => ({ text: "", margin: [0, 10, 0, 10] })),
          ]);
        }
        content.push({
          table: {
            headerRows: 2,
            widths: [25, "*", ...pageDates.map(() => 52)],
            body: attendanceBody,
            dontBreakRows: true,
          },
          layout: {
            hLineWidth: () => 0.6,
            vLineWidth: () => 0.6,
            hLineColor: () => PDF_COLORS.border,
            vLineColor: () => PDF_COLORS.border,
            paddingLeft: () => 4,
            paddingRight: () => 4,
            paddingTop: () => 5,
            paddingBottom: () => 5,
          },
          fontSize: 9,
          margin: [0, 0, 0, 12],
        });
      }
      continue;
    }

    if (dokumen.recipientTable) {
      const recipients =
        Array.isArray(formData.penerima_list) && formData.penerima_list.length
          ? formData.penerima_list
          : [
              {
                nama: formData.penerima_nama || "",
                jabatan: formData.penerima_jabatan || "",
                nuptk: "",
                npwp: "",
                honor: "",
                pph21: 0,
              },
            ];
      const nominal = (value) => {
        const amount = Number(value);
        return Number.isFinite(amount)
          ? Math.round(amount).toLocaleString("id-ID")
          : "0";
      };
      const hasAmounts = recipients.some(
        (row) => String(row.honor ?? "").trim() !== "",
      );
      const totalHonor = recipients.reduce(
        (total, row) => total + (Number(row.honor) || 0),
        0,
      );
      const totalPph = recipients.reduce(
        (total, row) => total + (Number(row.pph21) || 0),
        0,
      );
      const tanggal = String(kwitansi.tanggal || "");
      const isoTanggal = tanggal.match(/^(\d{4})-(\d{2})/);
      const lokalTanggal = tanggal.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
      const bulan = isoTanggal
        ? Number(isoTanggal[2])
        : Number(lokalTanggal?.[2]);
      const tahun = isoTanggal ? isoTanggal[1] : lokalTanggal?.[3];
      const bulanTahun =
        bulan >= 1 && bulan <= 12
          ? `${BULAN_ID[bulan - 1]} ${tahun}`
          : String(kwitansi.tahun || "");
      const namaKegiatan =
        kwitansi.nama_kegiatan || kwitansi.uraian_pembayaran || "-";
      const namaSekolah = identitas.nama_sekolah || "-";
      const headers = [
        "No",
        "Nama",
        "Jabatan",
        "NUPTK",
        "NPWP",
        "Honor",
        "PPh 21",
        "Penerimaan",
        "Tanda Tangan",
      ];
      const body = [
        [
          ...headers.map((text) => ({
            text,
            bold: true,
            alignment: "center",
            fillColor: "#f2f2f2",
            margin: [2, 8, 2, 8],
          })),
        ],
      ];
      recipients.forEach((row, index) => {
        const honor = Number(row.honor) || 0;
        const pph = Number(row.pph21) || 0;
        body.push([
          { text: String(index + 1), alignment: "center" },
          { text: row.nama || "" },
          { text: row.jabatan || "" },
          { text: row.nuptk || "" },
          { text: row.npwp || "" },
          {
            text: String(row.honor ?? "").trim() ? nominal(honor) : "-",
            alignment: "right",
          },
          { text: pph ? nominal(pph) : "-", alignment: "right" },
          {
            text: String(row.honor ?? "").trim() ? nominal(honor - pph) : "-",
            alignment: "right",
          },
          { text: "", margin: [0, 15, 0, 15] },
        ]);
      });
      body.push([
        {
          text: "JUMLAH",
          colSpan: 5,
          bold: true,
          alignment: "center",
          margin: [2, 7, 2, 7],
        },
        {},
        {},
        {},
        {},
        {
          text: hasAmounts ? nominal(totalHonor) : "-",
          bold: true,
          alignment: "right",
        },
        {
          text: totalPph ? nominal(totalPph) : "-",
          bold: true,
          alignment: "right",
        },
        {
          text: hasAmounts ? nominal(totalHonor - totalPph) : "-",
          bold: true,
          alignment: "right",
        },
        { text: "" },
      ]);

      const namaKepsek = formatNamaPenandatangan(identitas.nama_kepala_sekolah);
      const namaBendahara = formatNamaPenandatangan(identitas.nama_bendahara);
      const tanggalLunas =
        formatTanggalIndo(kwitansi.tanggal) || "........................";
      const signatureBlock = {
        columns: [
          {
            width: "*",
            stack: [
              { text: "Setuju Dibayar\nKepala Sekolah", margin: [0, 0, 0, 52] },
              {
                canvas: [
                  {
                    type: "line",
                    x1: 0,
                    y1: 0,
                    x2: 190,
                    y2: 0,
                    lineWidth: 0.6,
                  },
                ],
                margin: [0, 0, 0, 3],
              },
              { text: namaKepsek, bold: true },
              {
                text: identitas.nip_kepala_sekolah
                  ? `NIP. ${identitas.nip_kepala_sekolah}`
                  : "NIP. ........................",
              },
            ],
          },
          {
            width: "*",
            stack: [
              {
                text: `Lunas Dibayar, ${tanggalLunas}\nBendahara BOS`,
                margin: [0, 0, 0, 52],
              },
              {
                canvas: [
                  {
                    type: "line",
                    x1: 0,
                    y1: 0,
                    x2: 190,
                    y2: 0,
                    lineWidth: 0.6,
                  },
                ],
                margin: [0, 0, 0, 3],
              },
              { text: namaBendahara, bold: true },
              {
                text: identitas.nip_bendahara
                  ? `NIP. ${identitas.nip_bendahara}`
                  : "NIP. ........................",
              },
            ],
          },
        ],
        columnGap: mmToPt(20),
        margin: [mmToPt(12), 28, mmToPt(12), 0],
        unbreakable: true,
      };

      content.push(
        ...kopStack(
          {
            baris1: identitas.nama_pemda || "",
            baris2: namaSekolah,
            alamat: identitas.alamat_sekolah || "",
            logo_pemda: identitas.logo_pemda || "",
            logo_sekolah: identitas.logo_sekolah || "",
          },
          "landscape",
        ),
        {
          text: `Lampiran No. ${kwitansi.no_bukti || kwitansi.nomor_kwitansi || "-"}`,
          margin: [0, 0, 0, 14],
        },
        {
          text: [
            { text: "TANDA TERIMA PEMBAYARAN ", bold: true },
            { text: String(namaKegiatan), bold: true },
          ],
          fontSize: 16,
          alignment: "center",
          margin: [0, 0, 0, 3],
        },
        {
          text: [bulanTahun.toUpperCase(), String(namaSekolah).toUpperCase()]
            .filter(Boolean)
            .join("\n"),
          alignment: "center",
          margin: [0, 0, 0, 14],
        },
        {
          table: {
            headerRows: 1,
            widths: [24, "*", 75, 85, 80, 85, 65, 95, 115],
            body,
          },
          layout: {
            hLineWidth: () => 0.6,
            vLineWidth: () => 0.6,
            hLineColor: () => PDF_COLORS.border,
            vLineColor: () => PDF_COLORS.border,
            paddingLeft: () => 4,
            paddingRight: () => 4,
            paddingTop: () => 6,
            paddingBottom: () => 6,
          },
          fontSize: 9,
        },
        signatureBlock,
      );
      continue;
    }

    content.push(
      ...sectionTitle(
        dokumen.key === "ktp"
          ? "IDENTITAS PENERIMA (DATA KTP)"
          : dokumen.label.toUpperCase(),
        `Nomor Kwitansi: ${kwitansi.nomor_kwitansi || "-"}`,
      ),
    );
    content.push({
      text: kwitansi.nama_kegiatan || kwitansi.uraian_pembayaran || "",
      alignment: "center",
      margin: [0, 4, 0, 14],
    });

    if (dokumen.key !== "nota_pembelian") {
      let rows = [];
      if (dokumen.key === "tanda_terima") {
        rows = [
          ["Telah menerima uang sebesar", formatRupiah(kwitansi.jumlah)],
          ["Terbilang", kwitansi.terbilang || "-"],
          ["Untuk pembayaran", kwitansi.uraian_pembayaran || "-"],
          ...dokumen.fields.map(([key, label]) => [
            label,
            formData[key] || "................................",
          ]),
        ];
      } else {
        rows = dokumen.fields
          .filter(
            ([key]) =>
              !(
                dokumen.key === "daftar_hadir" &&
                ["honor_jasa", "makanan_minuman"].includes(data.jenis_belanja) &&
                key === "hadir_peserta"
              ),
          )
          .map(([key, label]) => [
            label,
            formData[key] || "................................",
          ]);
      }

      content.push({
        table: {
          widths: [145, "*"],
          body: rows.map(([label, value]) => [
            { text: label, bold: true },
            { text: String(value || "-") },
          ]),
        },
        layout: {
          hLineWidth: () => 0.6,
          vLineWidth: () => 0.6,
          hLineColor: () => PDF_COLORS.border,
          vLineColor: () => PDF_COLORS.border,
          paddingLeft: () => 7,
          paddingRight: () => 7,
          paddingTop: () => 6,
          paddingBottom: () => 6,
        },
        margin: [0, 0, 0, 16],
      });
    }

    if (dokumen.key === "daftar_hadir") {
      const peserta = String(formData.hadir_peserta || "")
        .split(/\r?\n/)
        .map((nama) => nama.trim())
        .filter(Boolean);
      const body = [
        [
          { text: "No.", bold: true, alignment: "center" },
          {
            text:
              ["honor_jasa", "makanan_minuman"].includes(data.jenis_belanja)
                ? "Nama"
                : "Nama Peserta",
            bold: true,
          },
          { text: "Tanda Tangan", bold: true, alignment: "center" },
        ],
      ];
      for (let index = 0; index < Math.max(peserta.length, 10); index++) {
        body.push([
          { text: String(index + 1), alignment: "center" },
          peserta[index] || "",
          "",
        ]);
      }
      content.push({
        table: { headerRows: 1, widths: [35, "*", 150], body },
        layout: "lightHorizontalLines",
      });
    }

    if (dokumen.key === "qr_master" && formData.qr_link) {
      content.push({
        qr: formData.qr_link,
        fit: 150,
        alignment: "center",
        margin: [0, 12, 0, 8],
      });
      content.push({
        text: formData.qr_link,
        ...(/^https?:\/\//i.test(formData.qr_link)
          ? { link: formData.qr_link }
          : {}),
        color: "blue",
        alignment: "center",
        margin: [0, 12, 0, 12],
      });
    }

    if (["tanda_terima", "surat_tugas", "sppd"].includes(dokumen.key)) {
      content.push({
        columns: [
          {
            text: "Mengetahui,\n\n\n\n________________________",
            alignment: "center",
          },
          {
            text: `${dokumen.key === "tanda_terima" ? "Penerima," : "Pelaksana,"}\n\n\n\n________________________`,
            alignment: "center",
          },
        ],
        margin: [0, 28, 0, 0],
      });
    }
  }
  return content;
}

// ---------------------------------------------------------------------------
// Bagian 3: RAB
// ---------------------------------------------------------------------------

export function buildRabSection(data) {
  const rab = data.rab;
  const identitas = data.identitas;
  const content = [];

  content.push(...kopStack(rab.kop || data.document?.kop, "landscape"));
  content.push(...sectionTitle("RINCIAN ANGGARAN BIAYA (RAB)"));
  content.push({ text: "", margin: [0, 10, 0, 0] });

  content.push(labelRow("Kegiatan", rab.kegiatan || "-", 80));
  content.push(labelRow("Tahap", rab.thp_label || "-", 80));
  content.push(labelRow("Tahun Anggaran", rab.tahun || "-", 80));
  content.push(
    labelRow(
      "Satuan Pendidikan",
      rab.satuan_pendidikan || identitas.nama_sekolah || "-",
      80,
    ),
  );
  content.push({ text: "", margin: [0, 10, 0, 0] });

  const body = [
    [
      {
        text: "No",
        bold: true,
        fontSize: 12,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      {
        text: "Uraian Kegiatan",
        bold: true,
        fontSize: 12,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      {
        text: "Volume",
        bold: true,
        fontSize: 12,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      {
        text: "Satuan",
        bold: true,
        fontSize: 12,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      {
        text: "Harga Satuan",
        bold: true,
        fontSize: 12,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      {
        text: "Jumlah",
        bold: true,
        fontSize: 12,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      {
        text: "Jenis Belanja",
        bold: true,
        fontSize: 12,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      {
        text: "Keterangan",
        bold: true,
        fontSize: 12,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
    ],
  ];
  for (const row of rab.rows || []) {
    body.push([
      {
        text: String(row.no ?? ""),
        fontSize: 12,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      {
        text: row.uraian || "-",
        fontSize: 12,
        alignment: "left",
        margin: [4, 4, 0, 4],
      },
      {
        text: formatVolume(row.volume),
        fontSize: 12,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      {
        text: row.satuan || "",
        fontSize: 12,
        alignment: "center",
        margin: [0, 4, 0, 4],
      },
      {
        text: row.harga_satuan_fmt || formatRupiah(row.harga_satuan),
        fontSize: 12,
        alignment: "right",
        margin: [0, 4, 4, 4],
      },
      {
        text: row.jumlah_fmt || formatRupiah(row.jumlah),
        fontSize: 12,
        alignment: "right",
        margin: [0, 4, 4, 4],
      },
      {
        text: row.jenis_belanja || "-",
        fontSize: 12,
        alignment: "left",
        margin: [4, 4, 0, 4],
      },
      {
        text: row.keterangan || "",
        fontSize: 12,
        alignment: "left",
        margin: [4, 4, 0, 4],
      },
    ]);
  }

  const formattedGrandTotal =
    rab.grand_total_fmt || formatRupiah(rab.grand_total);
  body.push([
    {
      text: "Jumlah Total",
      bold: true,
      fontSize: 12,
      alignment: "right",
      colSpan: 5,
      margin: [0, 5, 5, 5],
    },
    {},
    {},
    {},
    {},
    {
      text: formattedGrandTotal,
      fontSize: 12,
      bold: true,
      alignment: "right",
      margin: [0, 6, 4, 6],
    },
    { text: "" },
    { text: "" },
  ]);

  content.push({
    table: {
      headerRows: 1,
      widths: [24, "*", 42, 48, 75, 78, 80, 105],
      body,
    },
    layout: reportTableLayout(1),
    fontSize: 12,
    margin: [0, 5, 0, 12],
  });

  // -----------------------------------------------------------------------
  // Blok tanda tangan RAB — format TABLE konsisten dengan Kwitansi
  // -----------------------------------------------------------------------
  const RAB_FS = 12;
  const sigCell = (text, opts = {}) => ({
    text,
    fontSize: RAB_FS,
    alignment: "center",
    border: [false, false, false, false],
    margin: [0, 1, 0, 1],
    ...opts,
  });

  const sigLineCanvas = {
    canvas: [
      {
        type: "line",
        x1: 5,
        y1: 0,
        x2: 190,
        y2: 0,
        lineWidth: 0.6,
        lineColor: PDF_COLORS.ink,
      },
    ],
    alignment: "center",
    border: [false, false, false, false],
    margin: [0, 0, 0, 2],
  };

  const namaKepsek = formatNamaPenandatangan(identitas.nama_kepala_sekolah);
  const nipKepsek = identitas.nip_kepala_sekolah
    ? `NIP. ${identitas.nip_kepala_sekolah}`
    : "NIP. .............................";

  content.push({
    table: {
      widths: ["*", 240],
      body: [
        // Baris 1: tanggal surat
        [sigCell(""), sigCell(rab.tanggal_surat || "")],
        // Baris 2: judul
        [sigCell(""), sigCell("Mengetahui,")],
        // Baris 3: jabatan
        [sigCell(""), sigCell("Kepala Sekolah")],
        // Baris 4: ruang tanda tangan
        [sigCell(""), sigCell("", { margin: [0, 48, 0, 0] })],
        // Baris 6: nama penanda tangan
        [sigCell(""), sigCell(namaKepsek, { bold: true })],
        // Baris 7: NIP
        [sigCell(""), sigCell(nipKepsek, { fontSize: RAB_FS - 2 })],
      ],
    },
    layout: {
      hLineWidth: () => 0,
      vLineWidth: () => 0,
      paddingLeft: () => 4,
      paddingRight: () => 4,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
    margin: [0, 8, 0, 0],
    unbreakable: true,
  });

  return content;
}

// ---------------------------------------------------------------------------
// Rakit definisi dokumen & Async Builder
// ---------------------------------------------------------------------------

export function buildSpjDocumentDefinition(data) {
  validateSpjPayload(data);

  const documentData = data.document || {};
  const sectionOrder =
    Array.isArray(documentData.order) && documentData.order.length
      ? documentData.order
      : ["kwitansi", "bast", "rab"];
  const sections = data.sections || {};
  const jenisBelanjaConfig = getJenisBelanjaConfig(data.jenis_belanja);
  const isSectionIncluded = (name) => {
    if (name === "bast" && !jenisBelanjaConfig.bast) return false;
    if (name === "rab" && !jenisBelanjaConfig.rab) return false;
    const section = sections[name];
    if (!section) return false;
    if (typeof section.included === "boolean") return section.included;
    return section.status === "included";
  };

  const content = [];
  const firstSection = sectionOrder.find(isSectionIncluded);
  let isFirstRenderedSection = true;
  // Susun bagian sesuai urutan payload, lalu sisipkan jeda halaman dan lampiran.
  for (const name of sectionOrder) {
    if (!isSectionIncluded(name)) continue;
    let sectionContent;
    if (name === "kwitansi") {
      sectionContent = buildKwitansiSection(data);
      // Penjaga anti-kop: tidak boleh ada node kop/logo/garis kop yang
      // lolos ke subtree kwitansi, apa pun isi payload.
      stripKopNodes(sectionContent);
    } else if (name === "bast") {
      sectionContent = buildBastSection(data);
    } else if (name === "rab") {
      sectionContent = buildRabSection(data);
    } else {
      fail(`bagian tak dikenal pada document.order: ${name}`);
    }

    if (!isFirstRenderedSection) {
      sectionContent.unshift({
        text: "",
        pageBreak: "before",
        pageOrientation: name === "rab" ? "landscape" : "portrait",
      });
    }
    content.push(...sectionContent);
    isFirstRenderedSection = false;
  }
  content.push(...buildLampiranFotoSections(data));
  content.push(...buildDataLampiranSections(data));
  if (isFirstRenderedSection)
    fail("tidak ada bagian yang dapat dirender (semua ditandai skip)");

  const paperSettings = documentData.paper || {};
  return {
    pageSize: {
      width: mmToPt(toNumberOrZero(paperSettings.width_mm) || 215),
      height: mmToPt(toNumberOrZero(paperSettings.height_mm) || 330),
    },
    pageOrientation: firstSection === "rab" ? "landscape" : "portrait",
    pageMargins: [
      mmToPt(toNumberOrZero(paperSettings.margin_mm) || 15),
      mmToPt(toNumberOrZero(paperSettings.margin_mm) || 15),
      mmToPt(toNumberOrZero(paperSettings.margin_mm) || 15),
      mmToPt(toNumberOrZero(paperSettings.margin_bottom_mm) || 20),
    ],
    defaultStyle: { font: "Arial", fontSize: 12, lineHeight: 1.2 },
    info: {
      title: documentData.filename || "SPJ.pdf",
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
export function assertArialOnly(documentDefinition) {
  const bad = [];
  const inspectNode = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((child, index) =>
        inspectNode(child, `${path}[${index}]`),
      );
      return;
    }
    if (!node || typeof node !== "object") return;
    if (typeof node.font === "string" && node.font !== "Arial") {
      bad.push(`${path}.font=${node.font}`);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "font") continue;
      inspectNode(value, path ? `${path}.${key}` : key);
    }
  };
  inspectNode(documentDefinition.content, "content");
  if (documentDefinition.defaultStyle?.font !== "Arial") {
    bad.push(`defaultStyle.font=${documentDefinition.defaultStyle?.font}`);
  }
  for (const [name, style] of Object.entries(documentDefinition.styles || {})) {
    if (style?.font && style.font !== "Arial")
      bad.push(`styles.${name}.font=${style.font}`);
  }
  if (bad.length) {
    throw new Error(
      "Dokumen SPJ menyalahi aturan font Arial: " + bad.join(", "),
    );
  }
}

export async function buildSpjPdf(data) {
  await ensureArialFonts();

  // Siapkan logo dan foto sebelum membangun definisi yang akan dirender pdfmake.
  // Logo kop mempertahankan warna; foto lampiran tetap hitam-putih.
  const kops = new Set([data.document?.kop, data.bast?.kop, data.rab?.kop]);
  for (const kop of kops) {
    if (!kop) continue;
    if (kop.logo_pemda)
      kop.logo_pemda = await processPdfImage(kop.logo_pemda, {
        monochrome: false,
        removeWhite: true,
      });
    if (kop.logo_sekolah)
      kop.logo_sekolah = await processPdfImage(kop.logo_sekolah, {
        monochrome: false,
        removeWhite: true,
      });
  }

  for (const photoList of Object.values(data.lampiran_foto || {})) {
    if (!Array.isArray(photoList)) continue;
    for (let index = 0; index < photoList.length; index++) {
      const photo = photoList[index];
      try {
        if (typeof photo === "string") {
          photoList[index] = await processPdfImage(photo, {
            monochrome: false,
          });
        } else if (photo?.available !== false && photo?.path) {
          photo.path = await processPdfImage(photo.path, {
            monochrome: false,
          });
        }
      } catch (err) {
        console.warn("[spjPdf] Gagal memproses gambar lampiran:", err);
        if (typeof photo === "object" && photo !== null) {
          photo.available = false;
        } else {
          photoList[index] = { available: false, path: "" };
        }
      }
    }
  }

  const documentDefinition = buildSpjDocumentDefinition(data);
  // Penjaga font: seluruh definisi dokumen WAJIB Arial — tolak render
  // sebelum pdfmake bekerja jika ada override font lain yang lolos.
  assertArialOnly(documentDefinition);

  try {
    const blob = await pdfMake.createPdf(documentDefinition).getBlob();
    if (!blob || blob.size === 0) {
      throw new Error("Renderer menghasilkan PDF kosong");
    }
    return blob;
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}
