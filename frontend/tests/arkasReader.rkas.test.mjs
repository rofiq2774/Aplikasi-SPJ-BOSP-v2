import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildActivitiesQuery,
  buildArkasActivityContextsQuery,
  buildArkasReferenceBarangQuery,
  mapArkasBudgetRows,
} = require("../arkasReader.cjs");

const arkasSchema = {
  anggaran: [
    "id_anggaran",
    "tahun_anggaran",
    "id_ref_sumber_dana",
    "sekolah_id",
    "soft_delete",
    "is_approve",
    "is_revisi",
    "is_aktif",
  ],
  ref_sumber_dana: ["id_ref_sumber_dana", "nama_sumber_dana"],
  ref_kode: [
    "id_ref_kode",
    "id_kode",
    "parent_kode",
    "tahun",
    "sumber_dana_id",
    "bentuk_pendidikan_id",
    "uraian_kode",
    "expired_date",
  ],
  ref_acuan_barang: [
    "id_barang",
    "kode_rekening",
    "nama_barang",
    "satuan",
    "batas_bawah",
    "batas_atas",
    "expired_date",
    "tahun",
  ],
};

function createSchemaDb(schema) {
  const queries = [];
  return {
    queries,
    query(sql, parameters = []) {
      if (sql.includes("sqlite_master")) {
        const tableName = parameters[0].toLowerCase();
        return schema[tableName] ? [{ name: tableName }] : [];
      }
      if (sql.startsWith("PRAGMA table_info")) {
        const tableName = sql.match(/"([^"]+)"/)[1].toLowerCase();
        return (schema[tableName] || []).map((name) => ({ name }));
      }
      queries.push({ sql, parameters });
      return [];
    },
  };
}

test("maps ARKAS budget period ids to calendar months", () => {
  const items = mapArkasBudgetRows([
    {
      itemId: 20,
      activityCode: "02.01",
      activityName: "Kegiatan",
      accountCode: "5.1.02",
      accountName: "Belanja Barang",
      description: "Alat tulis",
      periodId: 81,
      volume: 2,
      unit: "paket",
      unitPrice: 100000,
      amount: 200000,
    },
    {
      itemId: 20,
      activityCode: "02.01",
      activityName: "Kegiatan",
      accountCode: "5.1.02",
      accountName: "Belanja Barang",
      description: "Alat tulis",
      periodId: 92,
      volume: 1,
      unit: "paket",
      unitPrice: 50000,
      amount: 50000,
    },
  ]);

  assert.deepEqual(
    items.map(({ month, amount }) => ({ month, amount })),
    [
      { month: 1, amount: 200000 },
      { month: 12, amount: 50000 },
    ],
  );
  assert.equal(items[0].item_id, "20");
  assert.equal(items[0].description, "Alat tulis");
});

test("keeps the newest active row for duplicate RKAS item and month", () => {
  const items = mapArkasBudgetRows([
    {
      itemId: "item-1",
      periodRowId: "period-old",
      periodUpdatedAt: "2026-03-10 10:00:00",
      periodId: 85,
      volume: 2,
      unit: "paket",
      unitPrice: 100000,
      amount: 200000,
    },
    {
      itemId: "item-1",
      periodRowId: "period-new",
      periodUpdatedAt: "2026-03-10 11:00:00",
      periodId: 85,
      volume: 1,
      unit: "paket",
      unitPrice: 50000,
      amount: 50000,
    },
    {
      itemId: "item-1",
      periodRowId: "period-dec",
      periodUpdatedAt: "2026-03-10 12:00:00",
      periodId: 92,
      volume: 3,
      unit: "paket",
      unitPrice: 25000,
      amount: 75000,
    },
  ]);

  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map(({ month, volume, amount }) => ({ month, volume, amount })),
    [
      { month: 5, volume: 1, amount: 50000 },
      { month: 12, volume: 3, amount: 75000 },
    ],
  );
});

test("rejects ARKAS budget periods outside the known annual period range", () => {
  assert.throws(
    () => mapArkasBudgetRows([{ itemId: 1, periodId: 99 }]),
    /Periode anggaran ARKAS tidak dikenali/,
  );
});

test("includes draft budgets in the activity reference query", () => {
  const db = createSchemaDb(arkasSchema);
  buildActivitiesQuery(db, { fiscalYear: 2026 });

  const query = db.queries[0].sql;
  assert.doesNotMatch(query, /a\."is_approve"\s*=\s*1/);
  assert.doesNotMatch(query, /ar\."is_approve"\s*=\s*1/);
});

test("reads active ARKAS item references with the selected fiscal year", () => {
  const db = createSchemaDb(arkasSchema);
  buildArkasReferenceBarangQuery(db, {
    fiscalYear: 2026,
    sourceFundId: "fund-1",
  });

  const { sql, parameters } = db.queries[0];
  assert.match(sql, /FROM "ref_acuan_barang"/);
  assert.match(sql, /"tahun" = \?/);
  assert.match(sql, /"expired_date" IS NULL/);
  assert.match(sql, /"batas_bawah" AS "lowestPrice"/);
  assert.match(sql, /"batas_atas" AS "highestPrice"/);
  assert.deepEqual(parameters, [2026]);
});

test("requires both fiscal year and source fund for item reference queries", () => {
  const db = createSchemaDb(arkasSchema);
  assert.throws(
    () => buildArkasReferenceBarangQuery(db, { fiscalYear: 2026 }),
    /Pilih tahun anggaran dan sumber dana/,
  );
});

test("includes draft budgets in the activity context query", () => {
  const db = createSchemaDb(arkasSchema);
  buildArkasActivityContextsQuery(db);

  const query = db.queries[0].sql;
  assert.doesNotMatch(query, /a\."is_approve"\s*=\s*1/);
  assert.doesNotMatch(query, /ar\."is_approve"\s*=\s*1/);
});
