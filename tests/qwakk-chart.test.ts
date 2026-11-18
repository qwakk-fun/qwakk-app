import assert from "node:assert/strict";
import test from "node:test";

import { CHART_INTERVALS, CHART_MIN_SLOTS, buildChartSlots, chartPriceDecimals, formatChartPrice, formatChartVolume, isChartBar, isChartInterval, type ChartBar } from "../lib/qwakk-chart";

const at = (iso: string) => Date.parse(iso);

test("offers 4h instead of 6h", () => {
  assert.deepEqual([...CHART_INTERVALS], ["1m", "5m", "1h", "4h", "1d"]);
  assert.ok(isChartInterval("4h"));
  assert.ok(!isChartInterval("6h"));
});

test("fills quiet buckets flat at the last price and runs the axis up to now", () => {
  const slots = buildChartSlots([
    { start_time: "2026-11-18T10:00:00.000Z", open: "2", high: "2.5", low: "2", close: "2.4", volume: "10" },
    { start_time: "2026-11-18T13:00:00.000Z", open: "2.6", high: "2.6", low: "2.6", close: "2.6", volume: "4" },
  ], "1h", at("2026-11-18T15:20:00.000Z"));
  const bars = slots.filter(isChartBar);
  assert.equal(slots.length, CHART_MIN_SLOTS);
  assert.deepEqual(bars.map((bar) => bar.traded), [true, false, false, true, false, false]);
  // Quiet buckets hold the last close; the next trade opens there, so the path is continuous.
  assert.deepEqual(bars.slice(1, 3).map((bar) => [bar.open, bar.close]), [[2.4, 2.4], [2.4, 2.4]]);
  assert.deepEqual([bars[3].open, bars[3].low, bars[3].close], [2.4, 2.4, 2.6]);
  assert.equal(bars[bars.length - 1].time, at("2026-11-18T15:00:00.000Z") / 1000);
  assert.equal(bars[1].volume, null);
});

test("pads a new pool with blank slots before its first trade, on the interval grid", () => {
  const slots = buildChartSlots([{ start_time: "2026-11-18T18:00:00.000Z", open: "0.0001", high: "0.0001", low: "0.0001", close: "0.0001" }], "4h", at("2026-11-18T18:50:00.000Z"));
  assert.equal(slots.length, CHART_MIN_SLOTS);
  assert.equal(slots.filter(isChartBar).length, 1);
  assert.equal(slots[slots.length - 1].time - slots[slots.length - 2].time, 14_400);
  assert.ok(slots.every((slot, index) => index === 0 || slot.time > slots[index - 1].time));
});

test("keeps the newest 1500 buckets and skips unreadable candles", () => {
  const slots = buildChartSlots([
    { start_time: "2026-11-16T00:00:00.000Z", open: "1", high: "1", low: "1", close: "1" },
    { start_time: "nonsense", open: "1", high: "1", low: "1", close: "1" },
    { start_time: "2026-11-18T00:00:00.000Z", open: "x", high: "1", low: "1", close: "1" },
  ], "1m", at("2026-11-18T00:00:00.000Z"));
  assert.equal(slots.length, 1_500);
  // The trimmed candle still sets the price the window opens at.
  assert.equal((slots[0] as ChartBar).close, 1);
  assert.deepEqual(buildChartSlots([], "1h"), []);
});

test("picks price decimals that never round a small price to 0.00", () => {
  // QWAKK/QOR around 0.0001
  const small = chartPriceDecimals([0.000099789789, 0.000100350852]);
  assert.equal(small, 8);
  assert.equal(formatChartPrice(0.000099789789, small), "0.00009979");
  assert.equal(formatChartPrice(0.000100350852, small), "0.00010035");
  assert.equal(chartPriceDecimals([14.6, 20.34]), 2);
  assert.equal(chartPriceDecimals([2635.0, 2817.51]), 2);
  assert.equal(chartPriceDecimals([812_261, 1_853_323]), 0);
  assert.equal(formatChartPrice(1_853_323.2, 0), "1,853,323");
  assert.equal(chartPriceDecimals([]), 2);
});

test("folds long runs of leading zeros into a subscript count", () => {
  assert.equal(formatChartPrice(0.000000012345, 12), "0.0₇12345");
  assert.equal(formatChartPrice(0.00001234, 8), "0.00001234");
  assert.equal(formatChartPrice(Number.NaN, 2), "");
});

test("formats bucket volume compactly", () => {
  assert.equal(formatChartVolume(9.999969), "10");
  assert.equal(formatChartVolume(699.3), "699.3");
  assert.equal(formatChartVolume(5119.665507), "5.12K");
});
