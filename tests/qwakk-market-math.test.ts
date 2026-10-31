import assert from "node:assert/strict";
import test from "node:test";

import { eventValues, parseSwapEvent } from "../indexer/amm-events";
import { applyTradeToCandles, CANDLE_INTERVALS, CHART_WINDOWS, marketSummary, priceBPerA, priceChangePercent, swapTrade, toDisplayUnits, type Candle } from "../indexer/market-math";
import { CHART_INTERVALS } from "../lib/qwakk-chart";

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

test("serves every candle interval the indexer writes, including 6h", () => {
  for (const interval of Object.keys(CANDLE_INTERVALS)) assert.ok(CHART_WINDOWS[interval], `missing chart window for ${interval}`);
  for (const interval of CHART_INTERVALS) assert.ok(CHART_WINDOWS[interval], `app accepts ${interval} but the indexer rejects it`);
  assert.equal(CHART_WINDOWS["6h"], "90 days");
});

/** amm_swap events as CometBFT 0.38 returns them in block_results, plain string attributes. */
function swapEvent(attributes: Record<string, string>) {
  return { type: "amm_swap", attributes: Object.entries(attributes).map(([key, value]) => ({ key, value, index: true })) };
}

test("turns a day of amm_swap events into candles, 24h volume and price change", () => {
  const pool = { tokenA: "uqor", tokenB: "utest", decimalsA: 6, decimalsB: 6 };
  const now = new Date("2026-10-15T12:00:00Z");
  const fixture = [
    // 25.5 hours ago: 100 QOR for 200 TEST, price 2. Outside the 24h volume, but the 24h ago reference price.
    { at: "2026-10-14T10:30:00Z", event: swapEvent({ pool_id: "1", sender: "qor1traderaaaaaaaaaaaaaaaaaaaaaaa", denom_in: "uqor", amount_in: "100000000", denom_out: "utest", amount_out: "200000000", fee_bps: "30" }) },
    // 10 QOR for 21 TEST, price 2.1.
    { at: "2026-10-15T10:10:00Z", event: swapEvent({ pool_id: "1", sender: "qor1traderbbbbbbbbbbbbbbbbbbbbbbb", denom_in: "uqor", amount_in: "10000000", denom_out: "utest", amount_out: "21000000", fee_bps: "30" }) },
    // 42 TEST for 20 QOR, price 2.1, the reverse direction.
    { at: "2026-10-15T10:40:00Z", event: swapEvent({ pool_id: "1", sender: "qor1tradercccccccccccccccccccccccc", denom_in: "utest", amount_in: "42000000", denom_out: "uqor", amount_out: "20000000", fee_bps: "30" }) },
    // Same minute: 1 QOR for 2.2 TEST, price 2.2.
    { at: "2026-10-15T10:40:20Z", event: swapEvent({ pool_id: "1", sender: "qor1traderaaaaaaaaaaaaaaaaaaaaaaa", denom_in: "uqor", amount_in: "1000000", denom_out: "utest", amount_out: "2200000", fee_bps: "30" }) },
    // Not a usable swap: zero output. It must not create a candle.
    { at: "2026-10-15T11:00:00Z", event: swapEvent({ pool_id: "1", denom_in: "uqor", amount_in: "1000000", denom_out: "utest", amount_out: "0" }) },
  ];

  const candles = new Map<string, Candle>();
  for (const { at, event } of fixture) {
    const swap = parseSwapEvent(eventValues(event));
    if (!swap) continue;
    const { price, volumeQor, volumeQuote } = swapTrade(swap, pool);
    assert.ok(price);
    applyTradeToCandles(candles, new Date(at), price, volumeQor, volumeQuote);
  }
  const byKey = (interval: string, start: string) => candles.get(`${interval}|${start}`);

  assert.equal([...candles.values()].filter((candle) => candle.interval === "1m").length, 3);
  assert.deepEqual(byKey("1m", "2026-10-15T10:40:00.000Z"), { interval: "1m", startTime: "2026-10-15T10:40:00.000Z", open: "2.1", high: "2.2", low: "2.1", close: "2.2", volumeQor: "21", volumeQuote: "44.2", transactions: 2 });
  assert.deepEqual(byKey("1h", "2026-10-15T10:00:00.000Z"), { interval: "1h", startTime: "2026-10-15T10:00:00.000Z", open: "2.1", high: "2.2", low: "2.1", close: "2.2", volumeQor: "31", volumeQuote: "65.2", transactions: 3 });
  assert.equal(byKey("6h", "2026-10-15T06:00:00.000Z")?.volumeQor, "31");
  assert.equal(byKey("6h", "2026-10-14T06:00:00.000Z")?.close, "2");
  assert.equal(byKey("1d", "2026-10-14T00:00:00.000Z")?.volumeQor, "100");
  assert.equal(byKey("5m", "2026-10-15T10:10:00.000Z")?.open, "2.1");

  const summary = marketSummary([...candles.values()], now);
  assert.equal(summary.volumeQor24h, "31");
  // The pool has no quote side set, so token B (TEST) is the quote: 21 + 42 + 2.2 TEST.
  assert.equal(summary.volumeQuote24h, "65.2");
  assert.equal(summary.transactions24h, 3);
  assert.equal(summary.price, "2.2");
  assert.equal(summary.price24hAgo, "2");
  assert.equal(summary.priceChangePercent, "10");
});

test("reports no QOR volume for pools without a uqor side", () => {
  const trade = swapTrade({ denomIn: "ufoo", amountIn: "5", denomOut: "ubar", amountOut: "10" }, { tokenA: "ubar", tokenB: "ufoo", decimalsA: 0, decimalsB: 0 });
  assert.equal(trade.price, "0.5");
  assert.equal(trade.volumeQor, null);
  assert.equal(priceChangePercent("1.9", "2"), "-5");
  assert.equal(priceChangePercent("1", "0"), null);
});
