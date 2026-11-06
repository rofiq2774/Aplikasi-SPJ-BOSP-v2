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

function buildQuery(db, filters) {
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
    "soft_delete",
    "is_approve",
    "is_revisi",
    "is_aktif",
  ]);
  const sourceColumns = getTableColumns(db, "ref_sumber_dana");
  requireColumns("ref_sumber_dana", sourceColumns, [
    "id_ref_sumber_dana",
    "nama_sumber_dana",
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
    'INNER JOIN "ref_sumber_dana" rsd ON rsd."id_ref_sumber_dana" = a."id_ref_sumber_dana"',
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
    'a."tahun_anggaran" AS "fiscalYear"',
    'a."id_ref_sumber_dana" AS "sourceFundId"',
    'rsd."nama_sumber_dana" AS "sourceFundName"',
    'a."id_anggaran" AS "budgetId"',
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
    'a."tahun_anggaran"',
    'a."id_ref_sumber_dana"',
    'rsd."nama_sumber_dana"',
    'a."id_anggaran"',
    'rr."kode_rekening"',
    'ku."uraian"',
    'rp."satuan"',
  ];

  const predicates = [
    "ku.\"soft_delete\" = 0",
    "kun.\"soft_delete\" = 0",
    "ku.\"id_ref_bku\" IN (4, 24, 15, 35)",
    "upper(trim(kun.\"no_bukti\")) LIKE 'BPU%'",
    'a."soft_delete" = 0',
    'a."is_approve" = 1',
    'a."is_aktif" = 1',
    `a."is_revisi" = (
      SELECT MAX(ar."is_revisi") FROM "anggaran" ar
       WHERE ar."tahun_anggaran" = a."tahun_anggaran"
         AND ar."id_ref_sumber_dana" = a."id_ref_sumber_dana"
         AND ar."soft_delete" = 0
         AND ar."is_approve" = 1
         AND ar."is_aktif" = 1
    )`,
    'ku."id_anggaran" = a."id_anggaran"',
  ];
  const parameters = [];
  if (filters.fiscalYear != null) {
    predicates.push('a."tahun_anggaran" = ?');
    parameters.push(filters.fiscalYear);
  }
  if (filters.sourceFundId) {
    predicates.push('a."id_ref_sumber_dana" = ?');
    parameters.push(filters.sourceFundId);
  }
  if (filters.budgetId) {
    predicates.push('a."id_anggaran" = ?');
    parameters.push(filters.budgetId);
  }

  return db.query(
    `SELECT ${fields.join(", ")}
       FROM "kas_umum" ku
       ${joins.join("\n")}
       WHERE ${predicates.join("\n         AND ")}
       GROUP BY ${groupColumns.join(", ")}
       ORDER BY ku."tanggal_transaksi" DESC, ku."id_kas_umum" DESC`,
    parameters,
  );
}

function buildActivitiesQuery(db, filters) {
  const anggaranColumns = getTableColumns(db, "anggaran");
  requireColumns("anggaran", anggaranColumns, [
    "id_anggaran",
    "tahun_anggaran",
    "id_ref_sumber_dana",
    "sekolah_id",
    "soft_delete",
    "is_approve",
    "is_revisi",
    "is_aktif",
  ]);
  const sourceColumns = getTableColumns(db, "ref_sumber_dana");
  requireColumns("ref_sumber_dana", sourceColumns, [
    "id_ref_sumber_dana",
    "nama_sumber_dana",
  ]);
  const kegiatanColumns = getTableColumns(db, "ref_kode");
  requireColumns("ref_kode", kegiatanColumns, [
    "id_ref_kode",
    "id_kode",
    "parent_kode",
    "tahun",
    "sumber_dana_id",
    "bentuk_pendidikan_id",
    "uraian_kode",
    "expired_date",
  ]);

  const historyColumns = getTableColumns(db, "sekolah_history");
  const hasSchoolHistory =
    historyColumns?.has("sekolah_id") &&
    historyColumns.has("tahun") &&
    historyColumns.has("bentuk_pendidikan_id");
  const historyJoin = hasSchoolHistory
    ? `LEFT JOIN "sekolah_history" sh
         ON a."sekolah_id" = sh."sekolah_id"
        AND a."tahun_anggaran" = sh."tahun"`
    : "";
  const predicates = [
    'rk3."tahun" = ?',
    'rk2."tahun" = ?',
    'rk1."tahun" = ?',
    'a."soft_delete" = 0',
    'a."is_approve" = 1',
    'a."is_aktif" = 1',
    `a."is_revisi" = (
      SELECT MAX(ar."is_revisi") FROM "anggaran" ar
       WHERE ar."tahun_anggaran" = a."tahun_anggaran"
         AND ar."id_ref_sumber_dana" = a."id_ref_sumber_dana"
         AND ar."soft_delete" = 0
         AND ar."is_approve" = 1
         AND ar."is_aktif" = 1
    )`,
    'rk3."expired_date" IS NULL',
    'rk2."expired_date" IS NULL',
    'rk1."expired_date" IS NULL',
    'rk3."bentuk_pendidikan_id" IS NOT NULL',
    'a."tahun_anggaran" = rk3."tahun"',
  ];
  const parameters = [
    filters.fiscalYear,
    filters.fiscalYear,
    filters.fiscalYear,
    filters.fiscalYear,
    filters.fiscalYear,
  ];
  if (hasSchoolHistory) {
    predicates.push('rk3."bentuk_pendidikan_id" = sh."bentuk_pendidikan_id"');
  }
  if (filters.sourceFundId) {
    predicates.push('a."id_ref_sumber_dana" = ?');
    parameters.push(filters.sourceFundId);
  }

  return db.query(
    `SELECT DISTINCT
        trim(CAST(rk3."id_kode" AS TEXT)) AS "kodeKegiatan",
        trim(rk3."uraian_kode") AS "namaKegiatan",
        a."tahun_anggaran" AS "fiscalYear",
        a."id_ref_sumber_dana" AS "sourceFundId",
        rsd."nama_sumber_dana" AS "sourceFundName"
       FROM "ref_kode" rk3
       INNER JOIN "ref_kode" rk2
         ON rk3."parent_kode" = rk2."id_ref_kode"
        AND rk2."tahun" = ?
        AND rk2."sumber_dana_id" = rk3."sumber_dana_id"
        AND rk2."expired_date" IS NULL
       INNER JOIN "ref_kode" rk1
         ON rk2."parent_kode" = rk1."id_ref_kode"
        AND rk1."tahun" = ?
        AND rk1."expired_date" IS NULL
       INNER JOIN "anggaran" a
         ON a."tahun_anggaran" = rk3."tahun"
        AND a."id_ref_sumber_dana" = rk3."sumber_dana_id"
       INNER JOIN "ref_sumber_dana" rsd
         ON rsd."id_ref_sumber_dana" = a."id_ref_sumber_dana"
       ${historyJoin}
       WHERE ${predicates.join("\n         AND ")}
         AND (
           rk1."sumber_dana_id" = a."id_ref_sumber_dana"
           OR (
             rk1."sumber_dana_id" = 1
             AND NOT EXISTS (
               SELECT 1
                 FROM "ref_kode" p2
                WHERE p2."id_kode" = rk1."id_kode"
                  AND p2."tahun" = ?
                  AND p2."sumber_dana_id" = a."id_ref_sumber_dana"
                  AND p2."expired_date" IS NULL
             )
           )
         )
         AND trim(CAST(rk3."id_kode" AS TEXT)) <> ''
         AND trim(rk3."uraian_kode") <> ''
       ORDER BY "kodeKegiatan"`,
    [...parameters, filters.fiscalYear],
  );
}

function buildTaxRecapQuery(db, filters) {
  const kasColumns = getTableColumns(db, "kas_umum");
  requireColumns("kas_umum", kasColumns, [
    "id_kas_umum",
    "id_kas_nota",
    "parent_id_kas_umum",
    "id_ref_bku",
    "id_anggaran",
    "tanggal_transaksi",
    "no_bukti",
    "uraian",
    "uraian_pajak",
    "saldo",
    "is_sspd",
    "soft_delete",
    "status_bku",
  ]);
  const taxNoteColumns = getTableColumns(db, "kas_umum_nota_pajak");
  requireColumns("kas_umum_nota_pajak", taxNoteColumns, [
    "id_kas_nota",
    "ntpn",
    "soft_delete",
  ]);
  const notaColumns = getTableColumns(db, "kas_umum_nota");
  requireColumns("kas_umum_nota", notaColumns, [
    "id_kas_nota",
    "is_beli_di_siplah",
    "soft_delete",
  ]);
  const anggaranColumns = getTableColumns(db, "anggaran");
  requireColumns("anggaran", anggaranColumns, [
    "id_anggaran",
    "tahun_anggaran",
    "id_ref_sumber_dana",
    "soft_delete",
    "is_approve",
    "is_revisi",
    "is_aktif",
  ]);
  const sourceColumns = getTableColumns(db, "ref_sumber_dana");
  requireColumns("ref_sumber_dana", sourceColumns, [
    "id_ref_sumber_dana",
    "nama_sumber_dana",
  ]);

  const fields = [
    'tax."id_kas_umum" AS "idKasUmum"',
    'tax."tanggal_transaksi" AS "tanggalTransaksi"',
    'tax."no_bukti" AS "noBukti"',
    'tax."uraian" AS "uraianPajak"',
    'tax."uraian_pajak" AS "uraianPajakTooltip"',
    'tax."saldo" AS "nominalPajak"',
    'tax."id_kas_nota" AS "idKasNota"',
    'tax."parent_id_kas_umum" AS "parentIdKasUmum"',
    'parent."no_bukti" AS "parentNoBukti"',
    'parent."uraian" AS "parentUraian"',
    'parent."saldo" AS "parentNominal"',
    'parent."status_bku" AS "parentStatusBku"',
    'kun."is_beli_di_siplah" AS "isBeliDiSiplah"',
    `CASE
       WHEN parent."status_bku" = 'S'
         OR COALESCE(kun."is_beli_di_siplah", 0) = 1 THEN 0
       ELSE COALESCE(setoran."nominalWajibDisetor", 0)
     END AS "nominalWajibDisetor"`,
    'a."tahun_anggaran" AS "fiscalYear"',
    'a."id_ref_sumber_dana" AS "sourceFundId"',
    'rsd."nama_sumber_dana" AS "sourceFundName"',
    'a."id_anggaran" AS "budgetId"',
    'ntpn."ntpn" AS "ntpn"',
    selectColumn("tax", "is_ppn", "isPpn", kasColumns),
    selectColumn("tax", "is_pph_21", "isPph21", kasColumns),
    selectColumn("tax", "is_pph_22", "isPph22", kasColumns),
    selectColumn("tax", "is_pph_23", "isPph23", kasColumns),
    selectColumn("tax", "is_pph_4", "isPph4", kasColumns),
    selectColumn("tax", "is_sspd", "isSspd", kasColumns),
  ];
  const predicates = [
    'tax."soft_delete" = 0',
    'tax."id_ref_bku" IN (10, 30)',
    'tax."parent_id_kas_umum" IS NOT NULL',
    'a."soft_delete" = 0',
    'a."is_approve" = 1',
    'a."is_aktif" = 1',
    `a."is_revisi" = (
      SELECT MAX(ar."is_revisi") FROM "anggaran" ar
       WHERE ar."tahun_anggaran" = a."tahun_anggaran"
         AND ar."id_ref_sumber_dana" = a."id_ref_sumber_dana"
         AND ar."soft_delete" = 0
         AND ar."is_approve" = 1
         AND ar."is_aktif" = 1
    )`,
    'tax."id_anggaran" = a."id_anggaran"',
  ];
  const parameters = [];
  if (filters.fiscalYear != null) {
    predicates.push('a."tahun_anggaran" = ?');
    parameters.push(filters.fiscalYear);
  }
  if (filters.sourceFundId) {
    predicates.push('a."id_ref_sumber_dana" = ?');
    parameters.push(filters.sourceFundId);
  }
  if (filters.budgetId) {
    predicates.push('a."id_anggaran" = ?');
    parameters.push(filters.budgetId);
  }

  return db.query(
    `SELECT ${fields.join(", ")}
       FROM "kas_umum" tax
       LEFT JOIN "kas_umum" parent
         ON parent."id_kas_umum" = tax."parent_id_kas_umum"
        AND parent."soft_delete" = 0
       LEFT JOIN "kas_umum_nota" kun
         ON kun."id_kas_nota" = parent."id_kas_nota"
        AND kun."soft_delete" = 0
       INNER JOIN "anggaran" a
         ON a."id_anggaran" = tax."id_anggaran"
       INNER JOIN "ref_sumber_dana" rsd
         ON rsd."id_ref_sumber_dana" = a."id_ref_sumber_dana"
       LEFT JOIN (
         SELECT "parent_id_kas_umum",
                trim(replace("uraian", 'Setor ', '')) AS "jenisPajak",
                SUM("saldo") AS "nominalWajibDisetor"
           FROM "kas_umum"
          WHERE "soft_delete" = 0
            AND "id_ref_bku" IN (11, 31)
            AND "is_sspd" IS NOT 1
            AND "uraian_pajak" IS NOT 'Dipungut oleh penyedia'
          GROUP BY "parent_id_kas_umum",
                   trim(replace("uraian", 'Setor ', ''))
       ) setoran
         ON setoran."parent_id_kas_umum" = tax."parent_id_kas_umum"
        AND setoran."jenisPajak" = trim(replace(tax."uraian", 'Terima ', ''))
       LEFT JOIN (
         SELECT "id_kas_nota", group_concat(DISTINCT "ntpn") AS "ntpn"
           FROM "kas_umum_nota_pajak"
          WHERE "soft_delete" = 0
          GROUP BY "id_kas_nota"
       ) ntpn ON ntpn."id_kas_nota" = tax."id_kas_nota"
       WHERE ${predicates.join("\n         AND ")}
       ORDER BY parent."no_bukti" COLLATE NOCASE ASC,
                tax."id_kas_umum" ASC`,
    parameters,
  );
}

function mapTaxRecapRow(row) {
  const taxDescription = String(row.uraianPajak || "")
    .replace(/^(?:Terima|Setor)\s+/i, "")
    .trim();
  const percentageMatch = `${taxDescription} ${row.uraianPajakTooltip || ""}`.match(
    /(\d+(?:[.,]\d+)?)\s*%/,
  );
  const nominal = toAmount(row.nominalPajak);
  const parentNominal = Math.abs(toAmount(row.parentNominal));
  const percentage = percentageMatch
    ? Number(percentageMatch[1].replace(",", "."))
    : parentNominal > 0
      ? (Math.abs(nominal) / parentNominal) * 100
      : null;
  const jenisPajak =
    taxDescription.replace(/\s*\d+(?:[.,]\d+)?\s*%/g, "").trim() ||
    [
      ["isPpn", "PPN"],
      ["isPph21", "PPh 21"],
      ["isPph22", "PPh 22"],
      ["isPph23", "PPh 23"],
      ["isPph4", "PPh 4"],
      ["isSspd", "SSPD"],
    ].find(([field]) => Number(row[field]) === 1)?.[1] ||
    "Pajak";

  return {
    tanggal: formatDate(row.tanggalTransaksi),
    uraian: String(row.parentUraian || taxDescription).trim(),
    no_bukti: String(row.parentNoBukti || row.noBukti || "").trim(),
    jenis_pajak: jenisPajak,
    persentase_pajak:
      percentage === null ? null : Math.round(percentage * 10000) / 10000,
    nominal_pajak: nominal,
    nominal_wajib_disetor: toAmount(row.nominalWajibDisetor),
    ntpn: String(row.ntpn || "").trim(),
    fiscal_year: Number(row.fiscalYear),
    source_fund_id: String(row.sourceFundId ?? ""),
    source_fund_name: String(row.sourceFundName || "").trim(),
    budget_id: String(row.budgetId ?? ""),
  };
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

function normalizeFilters(value) {
  if (Number.isInteger(value)) return { fiscalYear: value };
  const filters = value && typeof value === "object" ? value : {};
  const fiscalYearValue = filters.fiscalYear ?? filters.fiscal_year;
  const fiscalYear =
    fiscalYearValue === undefined ||
    fiscalYearValue === "" ||
    fiscalYearValue === "all"
      ? null
      : Number(fiscalYearValue);
  if (fiscalYear !== null &&
      (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 9999)) {
    throw new Error("Tahun anggaran ARKAS tidak valid.");
  }
  return {
    fiscalYear,
    sourceFundId: String(filters.sourceFundId ?? filters.source_fund_id ?? "").trim(),
    budgetId: String(filters.budgetId ?? filters.budget_id ?? "").trim(),
  };
}

async function readArkasTransactions(
  databasePath,
  selectedFilters = new Date().getFullYear(),
) {
  const filters = normalizeFilters(selectedFilters);
  sqliteInitialization ||= initSQLite();
  const sqlite = await sqliteInitialization;
  const module = sqlite.getModule();
  const virtualPath = `/arkas-${randomUUID()}.db`;
  const encrypted = !isStandardSqliteDatabase(databasePath);
  let db;
  try {
    module.FS.writeFile(virtualPath, fs.readFileSync(databasePath));
    db = openDatabase(sqlite, virtualPath, encrypted);
    const rows = buildQuery(db, filters);
    const transactions = rows.map((row) => {
      const volume = toAmount(row.volume);
      const harga = toAmount(row.harga);
      const details = parseDetails(row.details);
      return {
        no_bukti: String(row.noBukti || "").trim(),
        tanggal: formatDate(row.tanggalTransaksi),
        kode_kegiatan: String(row.kodeKegiatan ?? ""),
        nama_kegiatan: String(row.namaKegiatan || "").trim(),
        fiscal_year: Number(row.fiscalYear),
        source_fund_id: String(row.sourceFundId ?? ""),
        source_fund_name: String(row.sourceFundName || "").trim(),
        budget_id: String(row.budgetId ?? ""),
        budget_name: "",
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

    return {
      transactions,
      returned: transactions.length,
      fiscalYear: filters.fiscalYear,
      filters,
    };
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

async function readArkasTaxRecap(databasePath, selectedFilters = {}) {
  const filters = normalizeFilters(selectedFilters);
  sqliteInitialization ||= initSQLite();
  const sqlite = await sqliteInitialization;
  const module = sqlite.getModule();
  const virtualPath = `/arkas-tax-recap-${randomUUID()}.db`;
  const encrypted = !isStandardSqliteDatabase(databasePath);
  let db;
  try {
    module.FS.writeFile(virtualPath, fs.readFileSync(databasePath));
    db = openDatabase(sqlite, virtualPath, encrypted);
    const taxes = buildTaxRecapQuery(db, filters)
      .map(mapTaxRecapRow)
      .sort((left, right) =>
        left.no_bukti.localeCompare(right.no_bukti, "id", {
          numeric: true,
          sensitivity: "base",
        }),
      );
    return {
      taxes,
      returned: taxes.length,
      fiscalYear: filters.fiscalYear,
      filters,
    };
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

async function readArkasActivities(
  databasePath,
  selectedFilters = new Date().getFullYear(),
) {
  const filters = normalizeFilters(selectedFilters);
  if (!filters.fiscalYear) {
    throw new Error("Pilih tahun anggaran sebelum menyinkronkan kegiatan ARKAS.");
  }
  sqliteInitialization ||= initSQLite();
  const sqlite = await sqliteInitialization;
  const module = sqlite.getModule();
  const virtualPath = `/arkas-activities-${randomUUID()}.db`;
  const encrypted = !isStandardSqliteDatabase(databasePath);
  let db;
  try {
    module.FS.writeFile(virtualPath, fs.readFileSync(databasePath));
    db = openDatabase(sqlite, virtualPath, encrypted);
    const activities = buildActivitiesQuery(db, filters).map((row) => ({
      kode_kegiatan: String(row.kodeKegiatan || "").trim(),
      nama_kegiatan: String(row.namaKegiatan || "").trim(),
      fiscal_year: Number(row.fiscalYear),
      source_fund_id: String(row.sourceFundId ?? ""),
      source_fund_name: String(row.sourceFundName || "").trim(),
    }));
    return {
      activities,
      returned: activities.length,
      fiscalYear: filters.fiscalYear,
      filters,
    };
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

async function readArkasContexts(databasePath) {
  const sqlite = await (sqliteInitialization ||= initSQLite());
  const module = sqlite.getModule();
  const virtualPath = `/arkas-contexts-${randomUUID()}.db`;
  const encrypted = !isStandardSqliteDatabase(databasePath);
  let db;
  try {
    module.FS.writeFile(virtualPath, fs.readFileSync(databasePath));
    db = openDatabase(sqlite, virtualPath, encrypted);
    const anggaranColumns = getTableColumns(db, "anggaran");
    requireColumns("anggaran", anggaranColumns, [
      "id_anggaran",
      "tahun_anggaran",
      "id_ref_sumber_dana",
      "soft_delete",
      "is_approve",
      "is_revisi",
      "is_aktif",
    ]);
    const sourceColumns = getTableColumns(db, "ref_sumber_dana");
    requireColumns("ref_sumber_dana", sourceColumns, [
      "id_ref_sumber_dana",
      "nama_sumber_dana",
    ]);
    const rows = db.query(
      `SELECT a."tahun_anggaran" AS "fiscalYear",
              a."id_ref_sumber_dana" AS "sourceFundId",
              rsd."nama_sumber_dana" AS "sourceFundName",
              a."id_anggaran" AS "budgetId",
              a."is_revisi" AS "revision"
         FROM "anggaran" a
         INNER JOIN "ref_sumber_dana" rsd
           ON rsd."id_ref_sumber_dana" = a."id_ref_sumber_dana"
        WHERE a."soft_delete" = 0
          AND a."is_approve" = 1
          AND a."is_aktif" = 1
          AND a."is_revisi" = (
            SELECT MAX(ar."is_revisi") FROM "anggaran" ar
             WHERE ar."tahun_anggaran" = a."tahun_anggaran"
               AND ar."id_ref_sumber_dana" = a."id_ref_sumber_dana"
               AND ar."soft_delete" = 0
               AND ar."is_approve" = 1
               AND ar."is_aktif" = 1
          )
        ORDER BY a."tahun_anggaran" DESC,
                 rsd."nama_sumber_dana",
                 a."id_anggaran"`,
    );
    const contexts = rows.map((row) => ({
      fiscal_year: Number(row.fiscalYear),
      source_fund_id: String(row.sourceFundId ?? ""),
      source_fund_name: String(row.sourceFundName || "").trim(),
      budget_id: String(row.budgetId ?? ""),
      budget_name: "",
      revision: Number(row.revision || 0),
    }));
    return {
      contexts,
      years: [...new Set(contexts.map((item) => item.fiscal_year))],
      sources: [...new Map(
        contexts.map((item) => [
          `${item.fiscal_year}:${item.source_fund_id}`,
          {
            fiscal_year: item.fiscal_year,
            source_fund_id: item.source_fund_id,
            source_fund_name: item.source_fund_name,
          },
        ]),
      ).values()],
      budgets: contexts.map(({ budget_id, budget_name, ...rest }) => ({
        ...rest,
        budget_id,
        budget_name,
      })),
    };
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

module.exports = {
  readArkasActivities,
  readArkasContexts,
  readArkasTaxRecap,
  readArkasTransactions,
  mapTaxRecapRow,
  normalizeFilters,
};
