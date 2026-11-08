import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { mapArkasBudgetRows } = require("../arkasReader.cjs");

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

test("rejects ARKAS budget periods outside the known annual period range", () => {
  assert.throws(
    () => mapArkasBudgetRows([{ itemId: 1, periodId: 99 }]),
    /Periode anggaran ARKAS tidak dikenali/,
  );
});
