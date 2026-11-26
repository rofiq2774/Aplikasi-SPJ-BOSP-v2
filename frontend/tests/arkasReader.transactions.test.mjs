import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildQuery } = require("../arkasReader.cjs");

const schema = {
  kas_umum: [
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
    "last_update",
    "create_date",
  ],
  kas_umum_nota: [
    "id_kas_nota",
    "no_bukti",
    "soft_delete",
    "tanggal_nota",
    "nama_toko",
    "alamat_toko",
    "no_telp",
    "npwp",
    "no_nota",
    "details",
  ],
  rapbs_periode: ["id_rapbs_periode", "id_rapbs", "satuan"],
  rapbs: ["id_rapbs", "id_anggaran", "id_ref_kode", "kode_rekening", "uraian"],
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
  ref_rekening: ["kode_rekening", "tahun", "rekening"],
  ref_kode: [
    "id_ref_kode",
    "id_kode",
    "tahun",
    "sumber_dana_id",
    "bentuk_pendidikan_id",
    "uraian_kode",
  ],
};

function createSchemaDb() {
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

test("reads stable item identity and last-update time for ARKAS transactions", () => {
  const db = createSchemaDb();
  buildQuery(db, {
    fiscalYear: 2026,
    sourceFundId: "fund-1",
    budgetId: "budget-1",
  });

  const { sql, parameters } = db.queries[0];
  assert.match(sql, /r\."id_rapbs" AS "arkasItemId"/);
  assert.match(
    sql,
    /MAX\(COALESCE\(ku\."last_update", ku\."create_date"\)\) AS "sourceUpdatedAt"/,
  );
  assert.deepEqual(parameters, [2026, "fund-1", "budget-1"]);
});
