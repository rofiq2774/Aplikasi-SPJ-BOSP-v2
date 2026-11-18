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
