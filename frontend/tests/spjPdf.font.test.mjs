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
  const stubPath = "/tmp/pdfmake-stub.mjs";
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
