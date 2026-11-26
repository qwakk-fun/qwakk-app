import assert from "node:assert/strict";
import test from "node:test";

import { allocation, compareHoldings, formatBps, formatPoolShare, portfolioTotal, tokenValueUqor } from "../lib/qwakk-portfolio";

test("values a holding in uqor with exact string math, truncated", () => {
  // 2 tokens (6 decimals) at 1.5 QOR each: 3 QOR.
  assert.equal(tokenValueUqor("2000000", 6, "1.5"), BigInt(3_000_000));
  // 18 decimals: 1.234 tokens at 0.000001 QOR is 0.000001234 QOR, truncated to 1 uqor.
  assert.equal(tokenValueUqor("1234000000000000000", 18, "0.000001"), BigInt(1));
  assert.equal(tokenValueUqor("5", 0, "2"), BigInt(10_000_000));
  assert.equal(tokenValueUqor("1", 6, "0.0000001"), BigInt(0));
  assert.equal(tokenValueUqor("100", null, "1"), null);
  assert.equal(tokenValueUqor("100", 6, null), null);
  assert.equal(tokenValueUqor("100", 6, "-1"), null);
  assert.equal(tokenValueUqor("abc", 6, "1"), null);
});

test("adds up the total and counts tokens without a price", () => {
  assert.deepEqual(portfolioTotal([{ denom: "uqor", uqor: BigInt(5) }, { denom: "a", uqor: null }, { denom: "b", uqor: BigInt(7) }]), { totalUqor: BigInt(12), unpriced: 1 });
  assert.deepEqual(portfolioTotal([]), { totalUqor: BigInt(0), unpriced: 0 });
});

test("splits the total into slices, largest first, folding small ones", () => {
  assert.deepEqual(allocation([{ denom: "uqor", uqor: BigInt(10) }]), []);
  assert.deepEqual(allocation([{ denom: "uqor", uqor: BigInt(10) }, { denom: "a", uqor: null }]), []);
  const slices = allocation([
    { denom: "uqor", uqor: BigInt(600) },
    { denom: "a", uqor: BigInt(300) },
    { denom: "b", uqor: BigInt(95) },
    { denom: "c", uqor: BigInt(4) },
    { denom: "d", uqor: BigInt(1) },
  ]);
  assert.deepEqual(slices.map((slice) => [slice.key, slice.bps]), [["uqor", 6000], ["a", 3000], ["b", 950], ["other", 50]]);
  assert.deepEqual(slices[3].denoms, ["c", "d"]);
  // A single leftover keeps its own name.
  const two = allocation([{ denom: "uqor", uqor: BigInt(999) }, { denom: "a", uqor: BigInt(1) }]);
  assert.deepEqual(two.map((slice) => slice.key), ["uqor", "a"]);
});

test("formats shares as short percents", () => {
  assert.equal(formatBps(6000), "60%");
  assert.equal(formatBps(950), "9.5%");
  assert.equal(formatBps(50), "0.5%");
  assert.equal(formatBps(3), "0.03%");
  assert.equal(formatBps(0), "0%");
});

test("formats a pool share from LP balance and supply", () => {
  assert.equal(formatPoolShare("125", "1000"), "12.5%");
  assert.equal(formatPoolShare("1", "3"), "33.3%");
  assert.equal(formatPoolShare("34", "100000"), "0.034%");
  assert.equal(formatPoolShare("1", "1000000000"), "< 0.001%");
  assert.equal(formatPoolShare("1000", "1000"), "100%");
  assert.equal(formatPoolShare("5", "0"), null);
  assert.equal(formatPoolShare("0", "10"), null);
  assert.equal(formatPoolShare("x", "10"), null);
});

test("orders holdings: QOR, then value, then symbol", () => {
  const rows = [
    { denom: "b", uqor: null, symbol: "BEE" },
    { denom: "a", uqor: BigInt(5), symbol: "ANT" },
    { denom: "uqor", uqor: BigInt(1), symbol: "QOR" },
    { denom: "c", uqor: BigInt(9), symbol: "CAT" },
    { denom: "d", uqor: null, symbol: "ANT2" },
  ];
  assert.deepEqual([...rows].sort(compareHoldings).map((row) => row.symbol), ["QOR", "CAT", "ANT", "ANT2", "BEE"]);
});
