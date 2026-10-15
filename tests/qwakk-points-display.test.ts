import assert from "node:assert/strict";
import test from "node:test";

import { loadPointsConfig } from "../indexer/points-config";
import { POINTS_CATEGORIES, POINTS_DAYS, POINTS_FAQ, POINTS_POOLS, POINTS_RULES, POINTS_STATS, POINTS_UPDATED } from "../lib/qwakk-points-copy";
import { formatCount, formatPointsDay, formatPointsDecimal, pointsShare, pointsUpdatedLine, shortPointsAddress } from "../lib/qwakk-points-display";

test("formats exact decimal points without float drift", () => {
  assert.equal(formatPointsDecimal("0"), "0");
  assert.equal(formatPointsDecimal("1400"), "1,400");
  assert.equal(formatPointsDecimal("1234567.891234"), "1,234,567.89");
  // Truncated, never rounded up past the real score.
  assert.equal(formatPointsDecimal("0.999999"), "0.99");
  assert.equal(formatPointsDecimal("12.300000"), "12.3");
  assert.equal(formatPointsDecimal("12.000001"), "12");
  assert.equal(formatPointsDecimal("9007199254740993.5"), "9,007,199,254,740,993.5");
  assert.equal(formatPointsDecimal("0007"), "7");
  assert.equal(formatPointsDecimal("240.123456", 6), "240.123456");
  assert.equal(formatPointsDecimal(42), "42");
  for (const bad of ["", "-1", "1e5", "abc", "1.2.3", null, undefined, Number.NaN]) assert.equal(formatPointsDecimal(bad), "0");
});

test("formats counts, days and addresses for display", () => {
  assert.equal(formatCount(12345), "12,345");
  assert.equal(formatPointsDay("2026-10-14"), "Oct 14, 2026");
  assert.equal(formatPointsDay("not a day"), "not a day");
  const address = `qor1${"a".repeat(38)}`;
  assert.equal(shortPointsAddress(address), `${address.slice(0, 9)}…${address.slice(-6)}`);
});

test("picks the updated line from the season's computedAt", () => {
  const base = Date.parse("2026-10-15T12:00:00Z");
  const at = (minutesAgo: number) => new Date(base - minutesAgo * 60_000).toISOString();
  assert.equal(pointsUpdatedLine(null, base), POINTS_UPDATED.pending);
  assert.equal(pointsUpdatedLine(null, 0), POINTS_UPDATED.pending);
  assert.equal(pointsUpdatedLine(at(3), 0), "", "nothing before the page mounts");
  assert.equal(pointsUpdatedLine(at(0.5), base), POINTS_UPDATED.now);
  assert.equal(pointsUpdatedLine(at(1), base), POINTS_UPDATED.one);
  assert.equal(pointsUpdatedLine(at(7), base), "Updated 7 min ago");
  assert.equal(pointsUpdatedLine(at(59.9), base), "Updated 59 min ago");
  assert.equal(pointsUpdatedLine(at(60), base), POINTS_UPDATED.hours);
  assert.equal(pointsUpdatedLine(at(600), base), POINTS_UPDATED.hours);
});

test("bar shares stay between 0 and 100", () => {
  assert.equal(pointsShare("50", "200"), 25);
  assert.equal(pointsShare("0", "0"), 0);
  assert.equal(pointsShare("10", "5"), 100);
  assert.equal(pointsShare("x", "5"), 0);
});

test("points copy has no em dashes", () => {
  const text = JSON.stringify([POINTS_RULES, POINTS_CATEGORIES, POINTS_FAQ, POINTS_DAYS, POINTS_UPDATED, POINTS_STATS.liquidityHours, POINTS_POOLS.status.locked.tooltip("5")]);
  assert.doesNotMatch(text, /—/);
});

/**
 * The rules copy quotes the indexer's default config. This fails when a
 * default in indexer/points-config.ts changes without the copy changing too.
 * A QWAKK_POINTS_* override in a deployment is not covered: keep the copy in
 * step with those by hand.
 */
test("rules copy matches the indexer's default points config", () => {
  const { config } = loadPointsConfig({});
  const qor = (uqor: bigint) => new Intl.NumberFormat("en-US").format(Number(uqor) / 1e6);
  const rate = (ppm: bigint) => String(Number(ppm) / 1e6);
  const pct = (bps: bigint) => `${Number(bps) / 100}%`;
  const rules = JSON.stringify(POINTS_RULES);
  const faq = JSON.stringify(POINTS_FAQ);
  const categories = JSON.stringify(POINTS_CATEGORIES);

  assert.match(rules, new RegExp(`${rate(config.swapPointsPerQorPpm)} point for every QOR`));
  assert.match(rules, new RegExp(`at least ${qor(config.minSwapUqor)} QOR`));
  assert.ok(rules.includes(`first ${qor(config.swapDailyFullUqor)} QOR, ${pct(config.swapExcessFactorBps)} from ${qor(config.swapDailyFullUqor)} to ${qor(config.swapDailyMaxUqor)} QOR`));
  assert.ok(rules.includes(`within ${config.roundTripWindowSeconds / 60} minutes and both swaps count at ${pct(config.roundTripFactorBps)}`));
  assert.ok(rules.includes(`${rate(config.lpPointsPerQorHourPpm)} points per QOR of liquidity`));
  assert.ok(rules.includes(`at least ${config.lpMinHoldHours} hours in a row`));
  assert.ok(rules.includes(`first ${qor(config.lpHourlyFullUqor)} QOR you hold, ${pct(config.lpExcessFactorBps)} from ${qor(config.lpHourlyFullUqor)} to ${qor(config.lpHourlyMaxUqor)} QOR`));
  assert.ok(rules.includes(`${rate(config.poolBonusPointsPpm)} points for creating a pool, once ${config.poolBonusMinTraders} other wallets`));
  assert.ok(rules.includes(`Up to ${config.poolBonusMaxPerAddress} pool bonuses`));
  assert.ok(rules.includes(`${rate(config.activeDayPointsPpm)} points for every day`));
  assert.ok(rules.includes(`at least ${qor(config.minActionUqor)} QOR`));
  assert.ok(faq.includes(`above ${qor(config.swapDailyMaxUqor)} QOR in one day`));
  assert.ok(faq.includes(`after ${config.lpMinHoldHours} hours held`));
  assert.ok(faq.includes(`you get ${rate(config.poolBonusPointsPpm)} points. Up to ${config.poolBonusMaxPerAddress} per wallet`));
  assert.ok(categories.includes(`${rate(config.poolBonusPointsPpm)} points for each pool you created that ${config.poolBonusMinTraders} other wallets`));
  assert.ok(categories.includes(`${rate(config.activeDayPointsPpm)} points for each day`));
  assert.ok(POINTS_STATS.poolsUnlocked.value("1").endsWith(`of ${config.poolBonusMaxPerAddress}`));
  assert.equal(POINTS_DAYS.activeYes, `+${rate(config.activeDayPointsPpm)}`);
});
