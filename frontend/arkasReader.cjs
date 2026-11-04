"use strict";

const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { initSQLite } = require("@7mind.io/sqlcipher-wasm");

const DEFAULT_FALLBACK_KEY = "SzNtZDFrYnVkUklTM240eWFu";
let sqliteInitialization;

function isStandardSqliteDatabase(databasePath) {
  const file = fs.openSync(databasePath, "r");
  const header = Buffer.alloc(16);
  let bytesRead;
  try {
    bytesRead = fs.readSync(file, header, 0, header.length, 0);
  } finally {
    fs.closeSync(file);
  }

  const sqliteHeader = Buffer.from("SQLite format 3\u0000", "ascii");
  return (
    bytesRead === sqliteHeader.length &&
    header.subarray(0, bytesRead).equals(sqliteHeader)
  );
}

function getTableColumns(db, tableName) {
  const table = db.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND lower(name) = lower(?)",
    [tableName],
  )[0];
  if (!table) return null;

  return new Set(
    db
      .query(`PRAGMA table_info("${tableName}")`)
      .map((column) => column.name.toLowerCase()),
  );
}

function requireColumns(tableName, columns, requiredColumns) {
  if (!columns) {
    throw new Error(`Tabel wajib "${tableName}" tidak ditemukan.`);
  }

  const missing = requiredColumns.filter(
    (column) => !columns.has(column.toLowerCase()),
  );
  if (missing.length > 0) {
    throw new Error(
      `Tabel "${tableName}" tidak memiliki kolom wajib: ${missing.join(", ")}.`,
    );
  }
}

function selectColumn(alias, column, resultName, columns) {
  if (!columns || !columns.has(column.toLowerCase())) {
    return `NULL AS "${resultName}"`;
  }
  return `${alias}."${column}" AS "${resultName}"`;
}

function openDatabase(sqlite, virtualPath, encrypted) {
  const db = sqlite.open(virtualPath);
  try {
    if (encrypted) {
      const key = process.env.ARKAS_DB_KEY
        ? process.env.ARKAS_DB_KEY
        : Buffer.from(DEFAULT_FALLBACK_KEY, "base64").toString("ascii");
      db.exec("PRAGMA cipher = 'sqlcipher'; PRAGMA legacy = 4;");
      db.setKey(key);
    }

    db.exec("PRAGMA query_only = ON;");
    db.query("SELECT count(*) FROM sqlite_master");
    return db;
  } catch (error) {
    db.close();
    if (encrypted) {
      throw new Error(
        "Tidak dapat membuka database ARKAS. Periksa kunci database dan kompatibilitas cipher.",
        { cause: error },
      );
    }
    throw error;
  }
}

function formatDate(value) {
  if (value === null || value === undefined || value === "") return "";
  const text = String(value).trim();
  const isoDate = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoDate) return `${isoDate[3]}-${isoDate[2]}-${isoDate[1]}`;
  return text;
}

function toAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function buildQuery(db, year) {
  const kasColumns = getTableColumns(db, "kas_umum");
  requireColumns("kas_umum", kasColumns, [
    "id_kas_umum",
    "id_kas_nota",
    "id_rapbs_periode",
    "id_ref_bku",
    "id_anggaran",
    "tanggal_transaksi",
    "no_bukti",
    "uraian",
    "soft_delete",
    "kode_rekening",
    "volume",
    "saldo",
  ]);
  const notaColumns = getTableColumns(db, "kas_umum_nota");
  requireColumns("kas_umum_nota", notaColumns, [
    "id_kas_nota",
    "no_bukti",
    "soft_delete",
  ]);
  const periodeColumns = getTableColumns(db, "rapbs_periode");
  requireColumns("rapbs_periode", periodeColumns, [
    "id_rapbs_periode",
    "id_rapbs",
    "satuan",
  ]);
  const rapbsColumns = getTableColumns(db, "rapbs");
  requireColumns("rapbs", rapbsColumns, [
    "id_rapbs",
    "id_anggaran",
    "id_ref_kode",
    "kode_rekening",
    "uraian",
  ]);
  const anggaranColumns = getTableColumns(db, "anggaran");
  requireColumns("anggaran", anggaranColumns, [
    "id_anggaran",
    "tahun_anggaran",
    "id_ref_sumber_dana",
    "sekolah_id",
  ]);
  const rekeningColumns = getTableColumns(db, "ref_rekening");
  requireColumns("ref_rekening", rekeningColumns, [
    "kode_rekening",
    "tahun",
    "rekening",
  ]);
  const kegiatanColumns = getTableColumns(db, "ref_kode");
  requireColumns("ref_kode", kegiatanColumns, [
    "id_ref_kode",
    "id_kode",
    "tahun",
    "sumber_dana_id",
    "bentuk_pendidikan_id",
    "uraian_kode",
  ]);

  const historyColumns = getTableColumns(db, "sekolah_history");
  const hasSchoolHistory =
    historyColumns?.has("sekolah_id") &&
    historyColumns.has("tahun") &&
    historyColumns.has("bentuk_pendidikan_id");

  const joins = [
    'INNER JOIN "kas_umum_nota" kun ON kun."id_kas_nota" = ku."id_kas_nota"',
    'INNER JOIN "rapbs_periode" rp ON ku."id_rapbs_periode" = rp."id_rapbs_periode"',
    'INNER JOIN "rapbs" r ON rp."id_rapbs" = r."id_rapbs"',
    'INNER JOIN "anggaran" a ON a."id_anggaran" = r."id_anggaran"',
  ];
  if (hasSchoolHistory) {
    joins.push(
      'LEFT JOIN "sekolah_history" sh ON a."sekolah_id" = sh."sekolah_id" AND a."tahun_anggaran" = sh."tahun"',
    );
  }
  joins.push(
    'INNER JOIN "ref_rekening" rr ON ku."kode_rekening" = rr."kode_rekening" AND rr."tahun" = a."tahun_anggaran"',
    `INNER JOIN "ref_kode" rk ON r."id_ref_kode" = rk."id_ref_kode"
      AND rk."tahun" = a."tahun_anggaran"
      AND rk."sumber_dana_id" = a."id_ref_sumber_dana"${
        hasSchoolHistory
          ? ' AND (sh."bentuk_pendidikan_id" IS NULL OR rk."bentuk_pendidikan_id" = sh."bentuk_pendidikan_id")'
          : ""
      }`,
  );

  const fields = [
    'kun."no_bukti" AS "noBukti"',
    selectColumn("kun", "tanggal_nota", "tanggalNota", notaColumns),
    selectColumn("ku", "tanggal_transaksi", "tanggalTransaksi", kasColumns),
    'rk."id_kode" AS "kodeKegiatan"',
    'rk."uraian_kode" AS "namaKegiatan"',
    'rr."kode_rekening" AS "kodeRekening"',
    selectColumn("ku", "uraian", "uraian", kasColumns),
    'SUM(ku."volume") AS "volume"',
    'rp."satuan" AS "satuan"',
    'SUM(ku."saldo") AS "harga"',
    selectColumn("kun", "nama_toko", "namaToko", notaColumns),
    selectColumn("kun", "alamat_toko", "alamatToko", notaColumns),
    selectColumn("kun", "no_telp", "noTelp", notaColumns),
    selectColumn("kun", "npwp", "npwpToko", notaColumns),
    selectColumn("kun", "no_nota", "noNota", notaColumns),
    selectColumn("kun", "details", "details", notaColumns),
  ];
  const groupColumns = [
    'r."id_rapbs"',
    'r."id_ref_kode"',
    'r."kode_rekening"',
    'r."uraian"',
    ...[
      "id_kas_nota",
      "no_bukti",
      "tanggal_nota",
      "nama_toko",
      "alamat_toko",
      "no_telp",
      "npwp",
      "no_nota",
      "details",
    ]
      .filter((column) => notaColumns.has(column))
      .map((column) => `kun."${column}"`),
    'ku."tanggal_transaksi"',
    'rk."id_kode"',
    'rk."uraian_kode"',
    'rr."kode_rekening"',
    'ku."uraian"',
    'rp."satuan"',
  ];

  return db.query(
    `SELECT ${fields.join(", ")}
       FROM "kas_umum" ku
       ${joins.join("\n")}
       WHERE ku."soft_delete" = 0
         AND kun."soft_delete" = 0
         AND ku."id_ref_bku" IN (4, 24, 15, 35)
         AND upper(trim(kun."no_bukti")) LIKE 'BPU%'
         AND a."tahun_anggaran" = ?
         AND ku."id_anggaran" = a."id_anggaran"
       GROUP BY ${groupColumns.join(", ")}
       ORDER BY ku."tanggal_transaksi" DESC, ku."id_kas_umum" DESC`,
    [year],
  );
}

function parseDetails(value) {
  if (!value || typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

async function readArkasTransactions(
  databasePath,
  fiscalYear = new Date().getFullYear(),
) {
  if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 9999) {
    throw new Error("Tahun anggaran ARKAS tidak valid.");
  }
  sqliteInitialization ||= initSQLite();
  const sqlite = await sqliteInitialization;
  const module = sqlite.getModule();
  const virtualPath = `/arkas-${randomUUID()}.db`;
  const encrypted = !isStandardSqliteDatabase(databasePath);
  let db;
  try {
    module.FS.writeFile(virtualPath, fs.readFileSync(databasePath));
    db = openDatabase(sqlite, virtualPath, encrypted);
    const rows = buildQuery(db, fiscalYear);
    const transactions = rows.map((row) => {
      const volume = toAmount(row.volume);
      const harga = toAmount(row.harga);
      const details = parseDetails(row.details);
      return {
        no_bukti: String(row.noBukti || "").trim(),
        tanggal: formatDate(row.tanggalTransaksi),
        kode_kegiatan: String(row.kodeKegiatan ?? ""),
        nama_kegiatan: String(row.namaKegiatan || "").trim(),
        kode_rekening: String(row.kodeRekening || "").trim(),
        uraian: String(row.uraian || "").trim(),
        volume,
        satuan: String(row.satuan || "").trim(),
        harga_satuan: volume ? harga / volume : 0,
        pengeluaran: harga,
        nama_toko: String(row.namaToko || details.storeName || "").trim(),
        alamat_toko: String(row.alamatToko || details.storeAddress || "").trim(),
        no_telp_toko: String(
          row.noTelp || details.storeTelephone || "",
        ).trim(),
        npwp_toko: String(row.npwpToko || details.storeNPWP || "").trim(),
        no_nota: String(row.noNota || "").trim(),
        tanggal_nota: formatDate(row.tanggalNota),
      };
    });

    return { transactions, returned: transactions.length, fiscalYear };
  } finally {
    try {
      db?.close();
    } finally {
      if (module.FS.analyzePath(virtualPath).exists) {
        module.FS.unlink(virtualPath);
      }
    }
  }
}

module.exports = { readArkasTransactions };
