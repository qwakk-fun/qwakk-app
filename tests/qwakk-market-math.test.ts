import assert from "node:assert/strict";
import test from "node:test";

import { priceBPerA, toDisplayUnits } from "../indexer/market-math";

test("prices token A in token B across different decimals", () => {
  // 2 QOR (6 decimals) for 5 TEST (0 decimals) is 2.5 TEST per QOR.
  assert.equal(priceBPerA("2000000", 6, "5", 0), "2.5");
  assert.equal(priceBPerA("3", 0, "1", 0), "0.333333333333333333");
});

test("keeps precision on amounts beyond the safe float range", () => {
  assert.equal(priceBPerA("123456789012345678901", 6, "246913578024691357802", 6), "2");
  assert.equal(toDisplayUnits("123456789012345678901", 6), "123456789012345.678901");
});

test("formats display units without trailing zeros", () => {
  assert.equal(toDisplayUnits("1500000", 6), "1.5");
  assert.equal(toDisplayUnits("7", 6), "0.000007");
  assert.equal(toDisplayUnits("42", 0), "42");
});

test("rejects unusable swap amounts", () => {
  assert.equal(priceBPerA("0", 6, "5", 6), null);
  assert.throws(() => priceBPerA("1.5", 6, "5", 6), /non-negative integers/);
  assert.throws(() => toDisplayUnits("5", -1), /Decimals/);
});
