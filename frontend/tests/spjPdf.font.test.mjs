// ============================================================================
// Tes integrasi font PDF SPJ (node --test)
// -------------------------------------------------------------------------------
// Membuktikan perbaikan error:
//   "Cannot read 'Arial.ttf': file paths are not supported outside of Node."
// dengan menjalankan renderer nyata (src/pdf/spjPdf.js) terhadap pdfmake 0.3.x
// ASLI dari node_modules di lingkungan browser-like (tanpa fs Node).
//
// Jalankan:  node --test tests/            (dari folder frontend)
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);

// --- Muat pdfmake build BROWSER secara terpisah (instance bersih per muat) ---
// instance ini TIDAK punya process.version -> jalur "outside of Node" aktif,
// persis seperti runtime renderer Electron/browser tempat error terjadi.
async function loadBrowserPdfMake() {
  const out = await esbuild.build({
    entryPoints: [require.resolve("pdfmake/build/pdfmake")],
    bundle: true,
    platform: "neutral",
    format: "cjs",
    write: false,
    define: { "process.env.NODE_ENV": '"development"' },
  });
  const code = out.outputFiles[0].text;
  const mod = { exports: {} };
  new Function("module", "exports", "globalThis", code)(mod, mod.exports, globalThis);
  return mod.exports.default ?? mod.exports;
}

// --- Muat spjPdf.js hasil bundel vite-style dengan pdfMake DI-INJECT ------
// src/pdf/spjPdf.js meng-import "pdfmake/build/pdfmake". Kita bundel ulang
// modul itu dengan alias ke stub yang mengembalikan instance browser pdfmake
// yang sama dipakai assertion, sehingga tidak ada dua salinan VFS.
async function loadSpjPdfWith(pdfMakeInstance) {
  globalThis.__TEST_PDFMAKE__ = pdfMakeInstance;
  const stubPath = join(tmpdir(), "pdfmake-stub.mjs");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    stubPath,
    `const m = globalThis.__TEST_PDFMAKE__; export default m;\n`,
  );
  const out = await esbuild.build({
    entryPoints: ["src/pdf/spjPdf.js"],
    bundle: true,
    platform: "neutral",
    format: "esm",
    write: false,
    alias: { "pdfmake/build/pdfmake": stubPath },
    define: { "process.env.NODE_ENV": '"development"' },
  });
  const code = out.outputFiles[0].text;
  const blobUrl = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  return import(blobUrl);
}

const FONT_FIXTURE = JSON.parse(
  await readFile(new URL("./fixtures/arial-fonts.json", import.meta.url), "utf8"),
);

function minimalPayload() {
  return {
    schema_version: 1,
    document: { kwitansi_tanpa_kop: true },
    kwitansi: {
      include: true,
      no_bukti: "001/SPJ/XI/2026",
      tanggal: "2026-11-01",
      uraian: "Belanja alat tulis kantor",
      jumlah: 150000,
      penyelia: "Nama Penyelia",
      bendahara: "Bendahara",
      kop: null, // backend tidak boleh mengirim kop kwitansi
    },
    bast: { include: false },
    rab: { include: false },
  };
}

test("regresi: pdfMake.vfs = {...} saja menghasilkan error path lokal (bukti akar masalah)", async () => {
  const pm = await loadBrowserPdfMake();
  // Cara lama: hanya menaruh base64 di properti .vfs (tidak masuk virtualfs internal)
  pm.fonts = {
    Arial: {
      normal: "Arial.ttf",
      bold: "Arial-Bold.ttf",
      italics: "Arial-Italic.ttf",
      bolditalics: "Arial-BoldItalic.ttf",
    },
  };
  pm.vfs = { ...FONT_FIXTURE };
  let msg = "";
  try {
    const doc = await pm.createPdf({
      content: [{ text: "uji", font: "Arial" }],
      defaultStyle: { font: "Arial" },
    }).getBufferPromise?.() ?? pm.createPdf({ content: [] });
    if (doc?.getBufferPromise) {
      await doc.getBufferPromise();
    }
  } catch (e) {
    msg = String(e && e.message ? e.message : e);
  }
  assert.match(
    msg,
    /file paths are not supported outside of Node|Cannot read 'Arial\.tf|not found in virtual file system/,
    `Expected error path-lokal/VFS pada cara lama, dapat: "${msg}"`,
  );
});

test("perbaikan: ensureArialFonts memasang 4 varian Arial ke virtualfs pdfmake", async () => {
  const pm = await loadBrowserPdfMake();
  const mod = await loadSpjPdfWith(pm);
  globalThis.window = {
    __spjGetArialFonts: async () => ({ ...FONT_FIXTURE }),
  };
  await mod.ensureArialFonts();
  for (const name of ["Arial.ttf", "Arial-Bold.ttf", "Arial-Italic.ttf", "Arial-BoldItalic.ttf"]) {
    assert.ok(
      pm.virtualfs.existsSync(name),
      `${name} harus ada di pdfMake.virtualfs sebelum createPdf`,
    );
  }
  assert.deepEqual(Object.keys(pm.fonts), ["Arial"], "Font family lain (Roboto) tidak boleh terdaftar");
});

test("renderer nyata membuat PDF tanpa error path; font tertanam Arial", async () => {
  const pm = await loadBrowserPdfMake();
  const mod = await loadSpjPdfWith(pm);
  globalThis.window = {
    __spjGetArialFonts: async () => ({ ...FONT_FIXTURE }),
  };
  const blob = await mod.buildSpjPdf(minimalPayload());
  assert.ok(blob && blob.size > 0, "Blob PDF harus non-kosong");
  const buf = Buffer.from(await blob.arrayBuffer());
  assert.equal(buf.subarray(0, 5).toString(), "%PDF-", "Output harus PDF valid");
  // Font tertanam: nama PostScript/UTF-16 "Arial" muncul sebagai BaseFont pada objek font PDF
  const ascii = buf.toString("latin1");
  const utf16Arial = Buffer.from([0x00, 0x41, 0x00, 0x72, 0x00, 0x69, 0x00, 0x61, 0x00, 0x6c]);
  const hasArialTag =
    /\/BaseFont\s*\/[^>\s]*Arial/i.test(ascii) ||
    buf.includes(utf16Arial) ||
    /Arial/.test(ascii);
  assert.ok(hasArialTag, "PDF harus memuat referensi font Arial yang tertanam");
  assert.ok(!/Roboto/.test(ascii), "PDF tidak boleh berisi Roboto");
});

test("kwitansi tanpa kop: halaman kwitansi tidak memuat logo/garis kop", async () => {
  const pm = await loadBrowserPdfMake();
  const mod = await loadSpjPdfWith(pm);
  const dd = mod.buildSpjDocumentDefinition(minimalPayload());
  const serialized = JSON.stringify(dd.content);
  const kwSection = dd.content.find(
    (c) => c && (c.stack || c.table) && serialized.length > 0 && JSON.stringify(c).includes("KWITANSI"),
  );
  const target = kwSection ? JSON.stringify(kwSection) : serialized;
  assert.ok(!/"image"/.test(target), "Bagian kwitansi tidak boleh berisi elemen image/logo");
  assert.ok(!target.includes("kop_wajib"), "Metadata kop_wajib tidak boleh muncul di bagian kwitansi");
});

test("jenis belanja membangun lampiran PDF yang sesuai kategori", async () => {
  const pm = await loadBrowserPdfMake();
  const mod = await loadSpjPdfWith(pm);
  const data = {
    schema_version: 1,
    document: { order: ["kwitansi"], paper: { width_mm: 215, height_mm: 330 } },
    sections: { kwitansi: { status: "included" } },
    kwitansi: {
      nomor_kwitansi: "KW-001",
      tanggal: "2026-11-03",
      jumlah: 100000,
      nama_kegiatan: "Perbaikan ruang kelas",
      uraian_pembayaran: "Jasa tukang",
      terbilang: "seratus ribu rupiah",
    },
    identitas: {
      nama_pemda: "Pemerintah Kabupaten Jember",
      nama_sekolah: "SDN Contoh",
      alamat_sekolah: "Jl. Contoh",
      tempat_surat: "Jember",
    },
    jenis_belanja: "jasa_tukang",
    data_lampiran: {
      penerima_nama: "Nama Tukang",
      ktp_nama: "Nama Tukang",
      ktp_nik: "1234567890123456",
      hadir_tanggal_awal: "2026-11-03",
      hadir_tanggal_akhir: "2026-11-04",
      hadir_tempat: "SDN Contoh",
      hadir_peserta: "Nama Tukang",
    },
    lampiran_foto: {},
  };
  const dd = mod.buildSpjDocumentDefinition(data);
  const renderedText = JSON.stringify(dd.content);
  assert.match(renderedText, /TANDA TERIMA PEMBAYARAN/);
  assert.doesNotMatch(renderedText, /IDENTITAS PENERIMA \(DATA KTP\)/);
  assert.match(renderedText, /DAFTAR HADIR/);
  assert.doesNotMatch(renderedText, /SURAT TUGAS/);
  const daftarHadirTitle = dd.content.findIndex(
    (node) => node?.text === "DAFTAR HADIR",
  );
  assert.ok(daftarHadirTitle > 0);
  assert.ok(
    dd.content.slice(0, daftarHadirTitle).reverse()
      .some((node) => node?.columns?.some((column) =>
        column?.stack?.some((line) => line.text === "PEMERINTAH KABUPATEN JEMBER"),
      )),
    "Daftar Hadir Jasa Tukang harus memakai kop instansi",
  );
  const attendanceTable = dd.content.slice(daftarHadirTitle + 1).find(
    (node) => node?.table?.body?.[0]?.some((cell) => cell?.text === "03 Nov"),
  );
  assert.ok(attendanceTable, "Daftar hadir harus dirender sebagai tabel");
  assert.equal(attendanceTable.table.headerRows, 2);
  assert.equal(attendanceTable.table.body[1][2].text, "Tanda Tangan");
  assert.equal(attendanceTable.table.body[2][1], "Nama Tukang");
  assert.equal(attendanceTable.table.body[0].length, 4);
  assert.equal(attendanceTable.table.body[0][3].text, "04 Nov");

  const qrData = {
    ...data,
    jenis_belanja: "fotokopi",
    data_lampiran: { qr_link: "https://example.test/file-master" },
  };
  const qrDefinition = JSON.stringify(mod.buildSpjDocumentDefinition(qrData));
  assert.match(qrDefinition, /"qr":"https:\/\/example\.test\/file-master"/);

  const notaData = {
    ...data,
    jenis_belanja: "makanan_minuman",
    kwitansi: {
      ...data.kwitansi,
      nama_kegiatan: "Nama Kegiatan Nota",
      uraian_detail: "RINCIAN-RAHASIA-NOTA",
    },
    sections: {
      kwitansi: { status: "included" },
      bast: { status: "included" },
      rab: { status: "included" },
    },
    bast: {},
    rab: {},
    data_lampiran: {
      nota_nomor: "NOTA-01",
      nota_keterangan: "Konsumsi kegiatan",
      hadir_tanggal: "2026-11-03",
      hadir_tempat: "SDN Contoh",
      hadir_peserta: "Peserta satu",
    },
  };
  const notaDefinition = mod.buildSpjDocumentDefinition(notaData);
  const notaTitleIndex = notaDefinition.content.findIndex(
    (node) => node?.text === "NOTA PEMBELIAN",
  );
  assert.ok(notaTitleIndex > 0, "Halaman nota harus ada di PDF");
  assert.equal(
    notaDefinition.content[notaTitleIndex - 1].pageOrientation,
    "portrait",
    "Halaman nota wajib portrait",
  );
  assert.equal(
    notaDefinition.content[notaTitleIndex + 1].text,
    "Nomor Kwitansi: KW-001",
  );
  assert.equal(
    notaDefinition.content[notaTitleIndex + 2].text,
    "Nama Kegiatan Nota",
  );
  const nextNotaPage = notaDefinition.content.findIndex(
    (node, index) => index > notaTitleIndex && node?.pageBreak === "before",
  );
  const notaSection = notaDefinition.content.slice(
    notaTitleIndex,
    nextNotaPage === -1 ? undefined : nextNotaPage,
  );
  assert.equal(
    notaSection.some((node) => node?.table),
    false,
    "Halaman nota tidak boleh berisi tabel rincian",
  );
  assert.doesNotMatch(JSON.stringify(notaSection), /RINCIAN-RAHASIA-NOTA/);
  const mealText = JSON.stringify(notaDefinition.content);
  assert.doesNotMatch(mealText, /RINCIAN ANGGARAN BIAYA \(RAB\)|BERITA ACARA SERAH TERIMA/);

  const mealAttendanceData = {
    ...notaData,
    data_lampiran: {
      hadir_tanggal: "2026-11-03",
      hadir_tempat: "SDN Contoh",
      hadir_peserta: "Peserta Satu\nPeserta Dua",
    },
  };
  for (const jenis of ["honor_jasa", "makanan_minuman"]) {
    const attendanceDefinition = mod.buildSpjDocumentDefinition({
      ...mealAttendanceData,
      jenis_belanja: jenis,
    });
    const attendanceTable = attendanceDefinition.content.find(
      (node) =>
        node?.table?.body?.[0]?.[0]?.text === "No." &&
        node.table.body[0]?.[1]?.text === "Nama",
    );
    assert.ok(attendanceTable, `Tabel hadir ${jenis} memakai judul kolom Nama`);
    assert.equal(attendanceTable.table.body[1][1], "Peserta Satu");
    assert.equal(attendanceTable.table.body[2][1], "Peserta Dua");
    const pesertaDetailRow = attendanceDefinition.content
      .filter((node) => node?.table?.body)
      .flatMap((node) => node.table.body)
      .find((row) => row.some((cell) => cell?.text === "Daftar peserta (satu nama per baris)"));
    assert.equal(pesertaDetailRow, undefined, `Daftar peserta ${jenis} tidak diduplikasi sebagai rincian judul`);
  }

  const tandaTerimaData = {
    ...data,
    jenis_belanja: "honor_jasa",
    kwitansi: {
      ...data.kwitansi,
      no_bukti: "BPU11",
      tanggal: "2026-01-30",
      nama_kegiatan: "JASA Pelatih Ekstrakurikuler Kepramukaan",
    },
    identitas: {
      nama_sekolah: "SDN SUKOKERTO 01",
      nama_pemda: "PEMERINTAH KABUPATEN JEMBER",
      nama_kepala_sekolah: "Ani Budiartiningsih, S.Pd",
      nip_kepala_sekolah: "198212092014122002",
      nama_bendahara: "Atikah Nur Rochima, S.Pd",
      nip_bendahara: "198408312010012008",
    },
    data_lampiran: {
      penerima_list: [
        {
          nama: "INDAH PUTRI",
          jabatan: "Pelatih",
          nuptk: "12345",
          npwp: "67890",
          honor: 150000,
          pph21: 10000,
        },
        {
          nama: "PENERIMA KEDUA",
          jabatan: "Pelatih",
          honor: 100000,
          pph21: 5000,
        },
      ],
    },
  };
  const tandaTerima = mod.buildSpjDocumentDefinition(tandaTerimaData);
  const lampiranIndex = tandaTerima.content.findIndex(
    (node) => node?.text === "Lampiran No. BPU11",
  );
  assert.ok(lampiranIndex > 0, "Nomor lampiran harus dicetak");
  assert.equal(
    tandaTerima.content.slice(0, lampiranIndex).reverse()
      .find((node) => node?.pageBreak === "before")?.pageOrientation,
    "landscape",
  );
  const tandaTerimaTitle = tandaTerima.content.find(
    (node) => Array.isArray(node?.text) && node.text.some((part) => part.text === "TANDA TERIMA PEMBAYARAN "),
  );
  assert.equal(
    tandaTerimaTitle.text.map((part) => part.text).join(""),
    "TANDA TERIMA PEMBAYARAN JASA Pelatih Ekstrakurikuler Kepramukaan",
  );
  assert.match(JSON.stringify(tandaTerima.content), /JANUARI 2026/);
  const tandaTerimaTable = tandaTerima.content.find(
    (node) => node?.table?.body?.[0]?.some((cell) => cell?.text === "NUPTK"),
  ).table.body;
  assert.equal(tandaTerimaTable.length, 4, "Tabel berisi header, dua penerima, dan jumlah");
  assert.equal(tandaTerimaTable[1][7].text, "140.000");
  assert.equal(tandaTerimaTable[2][7].text, "95.000");
  assert.equal(tandaTerimaTable[3][5].text, "250.000");
  assert.equal(tandaTerimaTable[3][6].text, "15.000");
  assert.equal(tandaTerimaTable[3][7].text, "235.000");
  const signatureBlock = tandaTerima.content.find(
    (node) => node?.unbreakable && Array.isArray(node.columns),
  );
  assert.ok(signatureBlock, "Blok tanda tangan pejabat harus utuh saat pindah halaman");
  assert.equal(signatureBlock.columns.length, 2);
  assert.match(JSON.stringify(signatureBlock), /ANI BUDIARTININGSIH/);
  assert.match(JSON.stringify(signatureBlock), /ATIKAH NUR ROCHIMA/);

  for (const jenis of ["perjalanan_dinas", "jasa_tukang"]) {
    const categoryDefinition = mod.buildSpjDocumentDefinition({
      ...tandaTerimaData,
      jenis_belanja: jenis,
      data_lampiran: {
        sppd_berangkat: "2026-11-03",
        sppd_kembali: "2026-11-04",
        hadir_tanggal_awal: "2026-11-03",
        hadir_tanggal_akhir: "2026-11-04",
        penerima_list: [{
          nama: "PENERIMA UJI",
          jabatan: "Pelaksana",
          honor: 50000,
          pph21: 0,
        }],
      },
    });
    const categoryTable = categoryDefinition.content.find(
      (node) => node?.table?.body?.[0]?.some((cell) => cell?.text === "NUPTK"),
    );
    assert.ok(categoryTable, `${jenis} harus menggunakan tabel penerima Tanda Terima`);
    assert.ok(categoryTable.table.body.some((row) =>
      row.some((cell) => cell?.text === "PENERIMA UJI"),
    ));
  }

  const tukangPhotos = mod.buildSpjDocumentDefinition({
    ...data,
    jenis_belanja: "jasa_tukang",
    sections: { kwitansi: { status: "included" } },
    data_lampiran: {
      hadir_tanggal_awal: "2026-11-03",
      hadir_tanggal_akhir: "2026-11-04",
    },
    lampiran_foto: {
      ktp: [{ path: "data:image/png;base64,a2Rw", available: true }],
      sebelum: [{ path: "data:image/png;base64,c2ViZWx1bQ==", available: true }],
      proses: [{ path: "data:image/png;base64,cHJvc2Vz", available: true }],
      sesudah: [{ path: "data:image/png;base64,c2Vz", available: true }],
    },
  });
  const tukangJson = JSON.stringify(tukangPhotos.content);
  for (const heading of ["LAMPIRAN SALINAN KTP", "LAMPIRAN FOTO SEBELUM", "LAMPIRAN FOTO PROSES", "LAMPIRAN FOTO SESUDAH"]) {
    assert.ok(tukangJson.includes(heading), `${heading} must be present even without BAST`);
  }
  assert.equal((tukangJson.match(/"image":/g) || []).length, 4);
  assert.doesNotMatch(tukangJson, /IDENTITAS PENERIMA \(DATA KTP\)/);

  const longRange = mod.buildSpjDocumentDefinition({
    ...data,
    data_lampiran: {
      hadir_tanggal_awal: "2026-11-01",
      hadir_tanggal_akhir: "2026-11-12",
      hadir_peserta: "Nama Tukang",
    },
  });
  const attendanceTables = longRange.content.filter(
    (node) => node?.table?.body?.[0]?.some((cell) =>
      ["01 Nov", "11 Nov"].includes(cell?.text),
    ),
  );
  assert.equal(attendanceTables.length, 2, "Rentang lebih dari 10 hari dibagi menjadi beberapa lembar");
  assert.equal(attendanceTables[0].table.body[0].length, 12);
  assert.equal(attendanceTables[1].table.body[0][2].text, "11 Nov");
});

test("Surat Tugas Honor dan Perjalanan Dinas mengikuti format surat resmi", async () => {
  const pm = await loadBrowserPdfMake();
  const mod = await loadSpjPdfWith(pm);
  const data = {
    schema_version: 1,
    document: {
      order: ["kwitansi"],
      paper: { width_mm: 215, height_mm: 330 },
    },
    sections: { kwitansi: { status: "included" } },
    kwitansi: {
      nomor_kwitansi: "KW-001",
      tanggal: "2026-11-03",
      jumlah: 100000,
      nama_kegiatan: "Kegiatan Uji",
    },
    identitas: {
      nama_pemda: "Pemerintah Kabupaten Jember",
      nama_sekolah: "SD Negeri Sukokerto 01",
      alamat_sekolah: "Jl. Imam Musthofa No. 29",
      tempat_surat: "Jember",
      nama_kepala_sekolah: "Suliayun, S.Pd.",
      pangkat_kepala_sekolah: "Penata Tingkat I, III/d",
      nip_kepala_sekolah: "197605132000022001",
    },
    data_lampiran: {
      surat_tugas_nomor: "094/123/310.01.01.201/2026",
      surat_tugas_tanggal: "2026-11-03",
      surat_tugas_dasar: "Surat undangan kegiatan",
      surat_tugas_petugas: "Nama Petugas",
      surat_tugas_nip: "198001012010011001",
      surat_tugas_pangkat_golongan: "Penata, III/c",
      surat_tugas_jabatan: "Guru",
      surat_tugas_pangkat_kepala_sekolah: "Penata Tingkat I, III/d",
      surat_tugas_tujuan: "Mengikuti kegiatan di Jember",
      sppd_berangkat: "2026-11-03",
      sppd_kembali: "2026-11-04",
    },
  };

  for (const jenis of ["honor_jasa", "perjalanan_dinas"]) {
    const definition = mod.buildSpjDocumentDefinition({
      ...data,
      jenis_belanja: jenis,
    });
    const titleIndex = definition.content.findIndex(
      (node) => node?.text === "SURAT TUGAS",
    );
    assert.ok(titleIndex > 0, `${jenis} harus memuat Surat Tugas`);
    assert.equal(
      definition.content[titleIndex + 1].text,
      "NOMOR 094/123/310.01.01.201/2026",
    );

    const suratTables = definition.content
      .slice(titleIndex + 1)
      .filter((node) => node?.table?.body);
    const basisTable = suratTables.find((node) =>
      node.table.body.some((row) => row[0]?.text === "Dasar"),
    );
    assert.equal(basisTable.table.body[0][2].text, "Surat undangan kegiatan");
    const recipientTable = suratTables.find((node) =>
      node.table.body.some((row) => row[2] === "Pangkat/Gol."),
    );
    assert.ok(recipientTable, "Rincian petugas memuat Pangkat/Golongan");
    assert.deepEqual(
      recipientTable.table.body.slice(0, 4).map((row) => row[4]),
      [
        { text: "Nama Petugas" },
        "198001012010011001",
        "Penata, III/c",
        "Guru",
      ],
    );
    assert.equal(recipientTable.table.body[4][0].text, "Untuk");
    assert.equal(
      recipientTable.table.body[4][4].text,
      "Mengikuti kegiatan di Jember",
    );
    const signature = definition.content.find(
      (node) =>
        node?.unbreakable &&
        JSON.stringify(node).includes("Jember, 3 November 2026"),
    );
    assert.match(JSON.stringify(signature), /Jember, 3 November 2026/);
    assert.match(JSON.stringify(signature), /SULIAYUN, S\.Pd\./);
    assert.match(JSON.stringify(signature), /Penata Tingkat I, III\/d/);
    assert.match(JSON.stringify(signature), /NIP\. 197605132000022001/);
  }
});

test("SPPD mengikuti format dua halaman dan tanggal pada kotak perjalanan", async () => {
  const pm = await loadBrowserPdfMake();
  const mod = await loadSpjPdfWith(pm);
  const data = {
    schema_version: 1,
    document: {
      order: ["kwitansi"],
      paper: { width_mm: 215, height_mm: 330 },
    },
    sections: { kwitansi: { status: "included" } },
    kwitansi: {
      nomor_kwitansi: "KW-001",
      tanggal: "2026-11-03",
      jumlah: 100000,
      nama_kegiatan: "Perjalanan Dinas",
    },
    identitas: {
      nama_pemda: "Pemerintah Kabupaten Jember",
      nama_sekolah: "SD Negeri Sukokerto 01",
      alamat_sekolah: "Jl. Imam Musthofa No. 29",
      tempat_surat: "Jember",
      nama_kepala_sekolah: "Suliayun, S.Pd.",
      nip_kepala_sekolah: "197605132000022001",
    },
    jenis_belanja: "perjalanan_dinas",
    data_lampiran: {
      sppd_lampiran_ke: "1",
      sppd_nomor_surat_tugas: "094/123/2026",
      sppd_ppk_pangkat_golongan: "Penata Tingkat I, III/d",
      sppd_ppk_jabatan: "Kepala Sekolah",
      sppd_petugas: "Nama Pegawai",
      sppd_nip: "198001012010011001",
      sppd_pangkat_golongan: "Penata, III/c",
      sppd_jabatan: "Guru",
      sppd_maksud: "Mengikuti kegiatan",
      sppd_transportasi: "Kendaraan umum",
      sppd_tempat_berangkat: "Jember",
      sppd_tujuan: "Banyuwangi",
      sppd_berangkat: "2026-11-03",
      sppd_kembali: "2026-11-05",
      sppd_pengikut_nama: "Nama Pengikut",
      sppd_pengikut_jabatan: "Guru",
      sppd_pengikut_tugas: "Pendamping",
      sppd_anggaran_instansi: "SD Negeri Sukokerto 01",
      sppd_anggaran_akun: "5.1.02",
      sppd_keterangan: "Tidak ada",
      sppd_tanggal_dikeluarkan: "2026-11-02",
    },
  };
  const definition = mod.buildSpjDocumentDefinition(data);
  const titleIndex = definition.content.findIndex(
    (node) => node?.text === "SURAT PERINTAH PERJALANAN DINAS (SPPD)",
  );
  assert.ok(titleIndex > 0, "Halaman pertama memuat judul SPPD");
  assert.equal(definition.content[titleIndex + 1].table.body.length, 10);
  const pageTwoBreak = definition.content.findIndex(
    (node, index) => index > titleIndex && node?.pageBreak === "before",
  );
  assert.ok(pageTwoBreak > titleIndex, "Halaman tanda tangan dimulai pada halaman baru");
  const signatureGrid = definition.content[pageTwoBreak + 1];
  assert.ok(signatureGrid.table, "Halaman kedua memakai kotak perjalanan");
  const signatureBoxes = signatureGrid.table.body
    .flat()
    .filter((cell) => cell?.stack?.some((node) => node?.text === "NIP. ........................"));
  assert.equal(signatureBoxes.length, 4);
  for (const index of [0, 1]) {
    assert.match(
      JSON.stringify(signatureBoxes[index]),
      /3 November 2026/,
      "Kotak keberangkatan/kedatangan pertama memakai tanggal berangkat",
    );
    assert.doesNotMatch(JSON.stringify(signatureBoxes[index]), /5 November 2026/);
  }
  for (const index of [2, 3]) {
    assert.match(
      JSON.stringify(signatureBoxes[index]),
      /5 November 2026/,
      "Kotak perjalanan pulang memakai tanggal kembali",
    );
    assert.doesNotMatch(JSON.stringify(signatureBoxes[index]), /3 November 2026/);
  }
  const definitionText = JSON.stringify(definition.content);
  assert.match(definitionText, /3 hari/);
  assert.match(definitionText, /Nama Pengikut/);
  assert.match(definitionText, /Banyuwangi/);

  assert.throws(
    () =>
      mod.buildSpjDocumentDefinition({
        ...{
          schema_version: 1,
          document: {
            order: ["kwitansi"],
            paper: { width_mm: 215, height_mm: 330 },
          },
          sections: { kwitansi: { status: "included" } },
          kwitansi: {
            nomor_kwitansi: "KW-001",
            tanggal: "2026-11-03",
            jumlah: 100000,
          },
          identitas: {},
          jenis_belanja: "perjalanan_dinas",
          data_lampiran: {
            sppd_berangkat: "2026-11-05",
            sppd_kembali: "2026-11-03",
          },
        },
      }),
    /Tanggal berangkat dan kembali pada SPPD tidak valid/,
  );
});

test("font hilang/IPC gagal -> error jelas, bukan fallback diam-diam", async () => {
  const pm = await loadBrowserPdfMake();
  const mod = await loadSpjPdfWith(pm);
  globalThis.window = {
    __spjGetArialFonts: async () => {
      const partial = { ...FONT_FIXTURE };
      delete partial.bold;
      return partial;
    },
  };
  await assert.rejects(
    () => mod.buildSpjPdf(minimalPayload()),
    /Arial-Bold\.ttf/,
    "Kehilangan satu varian harus menyebut berkas yang kurang",
  );
});

test("tanpa sumber font sama sekali -> pesan actionable", async () => {
  const pm = await loadBrowserPdfMake();
  const mod = await loadSpjPdfWith(pm);
  globalThis.window = {};
  await assert.rejects(
    () => mod.buildSpjPdf(minimalPayload()),
    /Electron|window\.__spjGetArialFonts/,
  );
});

test("assertArialOnly menolak override font non-Arial di document definition", async () => {
  const pm = await loadBrowserPdfMake();
  const mod = await loadSpjPdfWith(pm);
  assert.throws(
    () => mod.assertArialOnly({ content: [{ text: "x", font: "Times-Roman" }], defaultStyle: { font: "Arial" } }),
    /Arial/,
  );
  mod.assertArialOnly({ content: [{ text: "x", bold: true }], defaultStyle: { font: "Arial" } });
});
