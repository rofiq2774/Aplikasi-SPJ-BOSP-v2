import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { mapTaxRecapRow, normalizeFilters } = require("../arkasReader.cjs");

test("maps ARKAS tax rows to tax recap fields and extracts stated rates", () => {
  const row = mapTaxRecapRow({
    tanggalTransaksi: "2026-03-12",
    uraianPajak: "Terima PPh 23 2%",
    parentUraian: "Belanja jasa pemeliharaan",
    parentNoBukti: "BPU-026",
    noBukti: "BPU-026",
    nominalPajak: 20000,
    parentNominal: 1000000,
    ntpn: "NTPN-123",
    nominalWajibDisetor: 15000,
    fiscalYear: 2026,
    sourceFundId: "1",
    sourceFundName: "BOSP Reguler",
    budgetId: "budget-1",
  });

  assert.deepEqual(
    {
      tanggal: row.tanggal,
      uraian: row.uraian,
      no_bukti: row.no_bukti,
      jenis_pajak: row.jenis_pajak,
      persentase_pajak: row.persentase_pajak,
      nominal_pajak: row.nominal_pajak,
      nominal_wajib_disetor: row.nominal_wajib_disetor,
      ntpn: row.ntpn,
    },
    {
      tanggal: "12-03-2026",
      uraian: "Belanja jasa pemeliharaan",
      no_bukti: "BPU-026",
      jenis_pajak: "PPh 23",
      persentase_pajak: 2,
      nominal_pajak: 20000,
      nominal_wajib_disetor: 15000,
      ntpn: "NTPN-123",
    },
  );
});

test("normalizes the fiscal scope filter shape used by the recap UI", () => {
  assert.deepEqual(
    normalizeFilters({
      fiscal_year: "2026",
      source_fund_id: "1",
      budget_id: "budget-1",
    }),
    {
      fiscalYear: 2026,
      sourceFundId: "1",
      budgetId: "budget-1",
    },
  );
});

test("infers the effective rate for ARKAS tax labels without a rate", () => {
  const row = mapTaxRecapRow({
    uraianPajak: "Terima PPh 21",
    nominalPajak: 50000,
    parentNominal: 1000000,
    isPph21: 1,
  });

  assert.equal(row.jenis_pajak, "PPh 21");
  assert.equal(row.persentase_pajak, 5);
});
