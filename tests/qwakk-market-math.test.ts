import assert from "node:assert/strict";
import test from "node:test";

import { eventValues, parseSwapEvent } from "../indexer/amm-events";
import { applyTradeToCandles, bucketStart, CANDLE_INTERVALS, CANDLE_ROLLUPS, CHART_WINDOWS, marketSummary, priceBPerA, priceChangePercent, rollUpCandles, swapTrade, toDisplayUnits, type Candle } from "../indexer/market-math";
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

test("serves exactly the candle intervals the indexer writes, with 4h in place of 6h", () => {
  assert.deepEqual(Object.keys(CANDLE_INTERVALS), ["1m", "5m", "1h", "4h", "1d"]);
  assert.deepEqual(Object.keys(CHART_WINDOWS), Object.keys(CANDLE_INTERVALS));
  for (const interval of CHART_INTERVALS) assert.ok(Object.hasOwn(CHART_WINDOWS, interval), `app accepts ${interval} but the indexer rejects it`);
  assert.equal(CANDLE_INTERVALS["4h"], 14_400);
  assert.equal(CHART_WINDOWS["4h"], "60 days");
  // Retired: no longer written or served, so /pools/:id?interval=6h answers 400.
  assert.equal(Object.hasOwn(CHART_WINDOWS, "6h"), false);
});

test("aligns 4h candles on 00, 04, 08, 12, 16 and 20 UTC", () => {
  const seconds = CANDLE_INTERVALS["4h"];
  assert.equal(bucketStart(new Date("2026-11-18T00:00:00Z"), seconds).toISOString(), "2026-11-18T00:00:00.000Z");
  assert.equal(bucketStart(new Date("2026-11-18T03:59:59.999Z"), seconds).toISOString(), "2026-11-18T00:00:00.000Z");
  assert.equal(bucketStart(new Date("2026-11-18T04:00:00Z"), seconds).toISOString(), "2026-11-18T04:00:00.000Z");
  assert.equal(bucketStart(new Date("2026-11-18T14:37:12Z"), seconds).toISOString(), "2026-11-18T12:00:00.000Z");
  assert.equal(bucketStart(new Date("2026-11-18T23:59:59Z"), seconds).toISOString(), "2026-11-18T20:00:00.000Z");
  // Every hour of a day lands in one of six buckets, each on a UTC hour divisible by 4.
  const starts = new Set(Array.from({ length: 24 }, (_, hour) => bucketStart(new Date(Date.UTC(2026, 10, 18, hour, 30)), seconds).getUTCHours()));
  assert.deepEqual([...starts], [0, 4, 8, 12, 16, 20]);
});

test("backfills 4h candles from 1h candles exactly as live indexing would write them", () => {
  for (const { target, source } of CANDLE_ROLLUPS) {
    assert.ok(CANDLE_INTERVALS[target] && CANDLE_INTERVALS[source], `${source} to ${target} must both be written intervals`);
    assert.equal(CANDLE_INTERVALS[target] % CANDLE_INTERVALS[source], 0, `${source} must divide ${target}`);
    // 1m and 5m are pruned by retention, so they cannot rebuild history.
    assert.ok(!["1m", "5m"].includes(source), `${source} candles are pruned`);
  }
  assert.deepEqual(CANDLE_ROLLUPS, [{ target: "4h", source: "1h" }]);

  // Sparse trades across two days, including bucket edges and a quiet stretch.
  const trades: Array<[string, string, string | null, string | null]> = [
    ["2026-11-17T03:10:00Z", "1.5", "10", "10"],
    ["2026-11-17T03:59:59Z", "1.7", "2.5", "2.5"],
    ["2026-11-17T04:00:00Z", "1.6", "4", "4"],
    ["2026-11-17T06:45:00Z", "1.9", "1", "1"],
    ["2026-11-17T07:15:00Z", "1.4", "3", "3"],
    ["2026-11-18T13:00:00Z", "2.25", "7", "7"],
    ["2026-11-18T15:30:00Z", "2.1", null, "0.5"],
  ];
  const live = new Map<string, Candle>();
  for (const [at, price, volumeQor, volumeQuote] of trades) applyTradeToCandles(live, new Date(at), price, volumeQor, volumeQuote);
  const hourly = [...live.values()].filter((candle) => candle.interval === "1h");
  const expected = [...live.values()].filter((candle) => candle.interval === "4h").sort((a, b) => a.startTime.localeCompare(b.startTime));

  // Feed the hours out of order: the backfill must order by start time itself.
  const backfilled = rollUpCandles([...hourly].reverse(), "4h", CANDLE_INTERVALS["4h"]);
  assert.deepEqual(backfilled, expected);
  assert.deepEqual(backfilled.map((candle) => candle.startTime), [
    "2026-11-17T00:00:00.000Z", "2026-11-17T04:00:00.000Z", "2026-11-18T12:00:00.000Z",
  ]);
  assert.deepEqual(backfilled[1], { interval: "4h", startTime: "2026-11-17T04:00:00.000Z", open: "1.6", high: "1.9", low: "1.4", close: "1.4", volumeQor: "8", volumeQuote: "8", transactions: 3 });
  // An hour with no QOR leg keeps the QOR volume of the others and still adds its quote volume.
  assert.deepEqual(backfilled[2], { interval: "4h", startTime: "2026-11-18T12:00:00.000Z", open: "2.25", high: "2.25", low: "2.1", close: "2.1", volumeQor: "7", volumeQuote: "7.5", transactions: 2 });
});

test("backfill reads legacy 1h rows without volume_quote as their QOR volume", () => {
  const legacy: Candle[] = [
    { interval: "1h", startTime: "2026-10-01T08:00:00.000Z", open: "2", high: "2.4", low: "1.9", close: "2.2", volumeQor: "5", transactions: 2 },
    { interval: "1h", startTime: "2026-10-01T09:00:00.000Z", open: "2.2", high: "2.3", low: "2.0", close: "2.05", volumeQor: "1.5", volumeQuote: null, transactions: 1 },
    { interval: "1h", startTime: "2026-10-01T10:00:00.000Z", open: "2.05", high: "2.05", low: "1.8", close: "1.85", volumeQor: null, volumeQuote: null, transactions: 1 },
  ];
  assert.deepEqual(rollUpCandles(legacy, "4h", CANDLE_INTERVALS["4h"]), [
    { interval: "4h", startTime: "2026-10-01T08:00:00.000Z", open: "2", high: "2.4", low: "1.8", close: "1.85", volumeQor: "6.5", volumeQuote: "6.5", transactions: 4 },
  ]);
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
  assert.equal(byKey("4h", "2026-10-15T08:00:00.000Z")?.volumeQor, "31");
  assert.equal(byKey("4h", "2026-10-14T08:00:00.000Z")?.close, "2");
  assert.equal([...candles.values()].some((candle) => candle.interval === "6h"), false);
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
