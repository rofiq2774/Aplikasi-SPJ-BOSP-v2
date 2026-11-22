import test from "node:test";
import assert from "node:assert/strict";
import { JENIS_BELANJA_SPJ } from "../src/spjConfig.js";

test("fotokopi does not require photo evidence", () => {
  assert.deepEqual(JENIS_BELANJA_SPJ.fotokopi.foto, []);
  assert.equal(JENIS_BELANJA_SPJ.fotokopi.bast, true);
  assert.deepEqual(
    JENIS_BELANJA_SPJ.fotokopi.dokumen.map(({ key }) => key),
    ["nota_pembelian", "qr_master"],
  );
});

test("biaya registrasi only requires activity photo", () => {
  assert.equal(JENIS_BELANJA_SPJ.biaya_registrasi.label, "Biaya Registrasi");
  assert.deepEqual(JENIS_BELANJA_SPJ.biaya_registrasi.foto, ["kegiatan"]);
  assert.deepEqual(JENIS_BELANJA_SPJ.biaya_registrasi.dokumen, []);
  assert.equal(JENIS_BELANJA_SPJ.biaya_registrasi.bast, false);
  assert.equal(JENIS_BELANJA_SPJ.biaya_registrasi.rab, false);
});
